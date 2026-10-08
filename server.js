const express = require("express");
const httpProxy = require("http-proxy");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const cookie = require("cookie");
const WebSocket = require("ws");
const { spawn, execFileSync } = require("child_process");

const PORT = process.env.PORT || 8080;
const WS_PATH = "/" + (process.env.WS_PATH || "parsaw").replace(/^\//, "");
const XRAY_INTERNAL_PORT = process.env.XRAY_INTERNAL_PORT || 10086;
const XRAY_API_PORT = process.env.XRAY_API_PORT || 10087;
const DASH_PASS = process.env.DASH_PASS || "change-me";

// Path the dashboard's live-usage websocket listens on. Kept separate from
// WS_PATH (the VLESS inbound path) so the two can never collide.
const USAGE_WS_PATH = "/ws/usage";
// How often (ms) we push a fresh usage snapshot to connected dashboards.
const USAGE_PUSH_INTERVAL_MS = 5000;

const DATA_DIR = path.join(__dirname, "data");
const CLIENTS_FILE = path.join(DATA_DIR, "clients.json");
const XRAY_CONFIG_PATH = path.join(__dirname, "xray-config.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- auth helpers ----------
const SESSION_COOKIE = "vless_session";
const SESSION_TOKEN = crypto.createHmac("sha256", DASH_PASS).update("session-v1").digest("hex");
const SUB_TOKEN = crypto.createHmac("sha256", DASH_PASS).update("sub-token-v1").digest("hex").slice(0, 20);

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function isAuthed(req) {
  const cookies = cookie.parse(req.headers.cookie || "");
  return !!cookies[SESSION_COOKIE] && safeEqual(cookies[SESSION_COOKIE], SESSION_TOKEN);
}

function requireAuthPage(req, res, next) {
  if (isAuthed(req)) return next();
  return res.redirect("/login");
}

function requireAuthApi(req, res, next) {
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: "unauthorized" });
}

// ---------- client storage ----------
// Each client: { id, uuid, label, createdAt, usedBytesBaseline, dataLimitBytes }
// usedBytesBaseline = total bytes used across *previous* Xray process
// lifetimes (Xray's own counters reset to 0 every time we restart it after
// adding/removing a client, so we fold the last-known value in before restarting).
// dataLimitBytes = optional hard cap in bytes; null/undefined means unlimited.
function loadClients() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CLIENTS_FILE, "utf8"));
    // backfill dataLimitBytes for client records saved before this field existed
    return parsed.map((c) => ({ dataLimitBytes: null, ...c }));
  } catch {
    return [];
  }
}

function saveClients(list) {
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify(list, null, 2));
}

// A client is "capped" once its known usage (as of the last Xray restart)
// has reached its limit. This is intentionally based on usedBytesBaseline
// (not live traffic) because usedBytesBaseline is only ever updated during
// restartXray(), right before buildXrayConfig() runs — so by construction,
// whatever this returns is exactly what the *current* running Xray config
// reflects (capped clients are already excluded from it).
function isCapped(c) {
  return c.dataLimitBytes != null && (c.usedBytesBaseline || 0) >= c.dataLimitBytes;
}

// Parses a raw dataLimitBytes value from a request body.
// Returns: a non-negative integer, null (explicitly unlimited), or the
// string "invalid" if the value is present but not a usable positive number.
function parseDataLimitBytes(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return "invalid";
  return Math.round(n);
}

let clients = loadClients();
if (clients.length === 0) {
  clients.push({
    id: crypto.randomUUID(),
    uuid: crypto.randomUUID(),
    label: "default",
    createdAt: new Date().toISOString(),
    usedBytesBaseline: 0,
    dataLimitBytes: null,
  });
  saveClients(clients);
}

function buildVlessLink(host, uuid, label) {
  const remark = encodeURIComponent(label || "VLESS");
  return `vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&host=${host}&path=${encodeURIComponent(
    WS_PATH
  )}#${remark}`;
}

// True when the request looks like a normal browser tab (not a subscription
// client or curl-style fetch): browsers explicitly prefer text/html.
//
// NOTE: this used to be `req.accepts(["html", "text/plain"]) === "html"`.
// That looks right but isn't: when a client sends "Accept: */*" (or no
// Accept header at all) — which is exactly what v2rayN, v2rayNG, v2Box,
// NekoBox, Shadowrocket, etc. do when fetching a subscription URL —
// Express/negotiator resolves the tie between "html" and "text/plain" by
// falling back to the order of the array you passed in, and "html" was
// listed first. So real subscription clients were silently getting the
// HTML landing page (with no Subscription-Userinfo header and no base64
// body) instead of the plain-text config, which is why the app showed no
// imported configs. Only treat it as a browser if "text/html" is
// explicitly present in the Accept header, the way real browsers send it.
function wantsHtml(req) {
  const accept = req.headers.accept || "";
  return accept.toLowerCase().includes("text/html");
}

function formatBytesServer(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

// Same usage-vs-cap bar as the dashboard (see public/app.js) — only rendered
// when the client actually has a limit set.
function usageBarHtml(entry) {
  if (entry.dataLimitBytes == null) return "";
  const ratio = Math.min(1, entry.totalBytes / entry.dataLimitBytes);
  const fillClass = entry.capped ? " is-capped" : ratio >= 0.85 ? " is-warn" : "";
  const width = Math.max(2, ratio * 100);
  return `
      <div class="usage-bar-track">
        <div class="usage-bar-fill${fillClass}" style="width:${width}%;"></div>
      </div>`;
}

// Same "X remaining of Y" / "Unlimited" (+ "Limit reached" badge) row as the
// dashboard, minus the Edit link — a subscription link is a read-only view
// for the client.
function limitRowHtml(entry) {
  let limitLabel;
  let cappedBadge = "";
  if (entry.dataLimitBytes == null) {
    limitLabel = "Unlimited";
  } else if (entry.capped) {
    limitLabel = `Limit reached`;
    cappedBadge = ` <span class="capped-badge">&middot; ${formatBytesServer(entry.dataLimitBytes)}</span>`;
  } else {
    const remaining = Math.max(0, entry.dataLimitBytes - entry.totalBytes);
    limitLabel = `${formatBytesServer(remaining)} remaining of ${formatBytesServer(entry.dataLimitBytes)}`;
  }
  return `
      <div class="client-limit-row">
        <span>${limitLabel}${cappedBadge}</span>
      </div>`;
}

function subClientCardHtml(entry) {
  return `
    <div class="card${entry.capped ? " capped" : ""}">
      <div class="card-head"><div class="label">${escapeHtml(entry.label)}</div></div>
      <div class="client-stats">
        <div><span class="stat-label">Download</span><span class="stat-value">${entry.downloadFmt}</span></div>
        <div><span class="stat-label">Upload</span><span class="stat-value">${entry.uploadFmt}</span></div>
        <div><span class="stat-label">Total</span><span class="stat-value">${entry.totalFmt}</span></div>
      </div>
      ${usageBarHtml(entry)}
      ${limitRowHtml(entry)}
      <div class="qr-box" style="display:flex" data-qr="${escapeHtml(entry.configLink)}"></div>
      <p class="sub" style="margin:14px 0 6px;">Subscription link</p>
      <div class="link-box">${escapeHtml(entry.subLink)}</div>
      <div class="actions" style="margin-bottom:14px;">
        <button class="secondary copy-btn" data-copy="${escapeHtml(entry.subLink)}">Copy subscription link</button>
      </div>
      <p class="sub" style="margin:0 0 6px;">Config link</p>
      <div class="link-box">${escapeHtml(entry.configLink)}</div>
      <div class="actions">
        <button class="secondary copy-btn" data-copy="${escapeHtml(entry.configLink)}">Copy config link</button>
      </div>
    </div>`;
}

// Minimal page shown when a /sub/:token/:clientId link is opened directly
// in a browser (instead of dumping the raw base64 payload). Client apps
// that fetch the same URL never see this — they still get the base64
// body as before.
function subLandingPage(title, intro, entries) {
  const cards = entries.map(subClientCardHtml).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/style.css" />
<script src="/qrcode.min.js"></script>
</head>
<body>
  <div class="wrap">
    <h1>${escapeHtml(title)}</h1>
    <p class="sub">${escapeHtml(intro)}</p>
    ${cards}
  </div>
<script>
function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(function () {
    var old = btn.textContent;
    btn.textContent = "Copied";
    btn.disabled = true;
    setTimeout(function () {
      btn.textContent = old;
      btn.disabled = false;
    }, 1200);
  }).catch(function () {
    window.prompt("Copy this:", text);
  });
}
document.querySelectorAll(".copy-btn").forEach(function (btn) {
  btn.addEventListener("click", function () {
    copyText(btn.dataset.copy, btn);
  });
});
document.querySelectorAll("[data-qr]").forEach(function (el) {
  try {
    // eslint-disable-next-line no-undef
    new QRCode(el, { text: el.dataset.qr, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.L });
  } catch (e) {
    el.textContent = "QR unavailable";
  }
});
</script>
</body>
</html>`;
}

// ---------- xray stats ----------
// Reads live (since-last-restart) per-user traffic from Xray's built-in
// StatsService. Client "email" in the Xray config is set to our internal
// client id, so stat names look like: user>>>{clientId}>>>traffic>>>uplink
function queryLiveStats() {
  let out;
  try {
    out = execFileSync(
      "/usr/local/bin/xray",
      ["api", "statsquery", `--server=127.0.0.1:${XRAY_API_PORT}`, "-pattern", ""],
      { timeout: 4000 }
    ).toString();
  } catch (err) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return {};
  }

  const map = {};
  (parsed.stat || []).forEach((s) => {
    const m = /^user>>>(.+?)>>>traffic>>>(uplink|downlink)$/.exec(s.name || "");
    if (!m) return;
    const [, clientId, dir] = m;
    if (!map[clientId]) map[clientId] = { uplink: 0, downlink: 0 };
    map[clientId][dir] = Number(s.value) || 0;
  });
  return map;
}

// Tracks the previous per-client live counters and which client ids showed
// new traffic since the last periodic check — used for the "active now" dot.
let lastLiveStats = {};
let activeClientIds = new Set();

// trackActivity=true (only from the periodic 5s websocket tick) compares
// this reading against the previous one to decide who's "active right now".
// Other callers (REST /api/usage, the /sub landing page) pass false and just
// read the last-known set, so they don't corrupt the delta baseline with an
// out-of-cadence read.
function getUsageSnapshot(trackActivity = false) {
  const live = queryLiveStats();

  if (trackActivity) {
    const nextActive = new Set();
    Object.keys(live).forEach((id) => {
      const prev = lastLiveStats[id] || { uplink: 0, downlink: 0 };
      const curr = live[id];
      if (curr.uplink > prev.uplink || curr.downlink > prev.downlink) {
        nextActive.add(id);
      }
    });
    activeClientIds = nextActive;
    lastLiveStats = live;
  }

  const result = {};
  clients.forEach((c) => {
    const baseline = c.usedBytesBaseline || 0;
    const liveEntry = live[c.id] || { uplink: 0, downlink: 0 };
    const liveTotal = liveEntry.uplink + liveEntry.downlink;
    result[c.id] = {
      uplink: liveEntry.uplink,
      downlink: liveEntry.downlink,
      total: baseline + liveTotal,
      active: activeClientIds.has(c.id),
    };
  });
  return result;
}

function publicClientList() {
  return clients.map((c) => ({
    id: c.id,
    uuid: c.uuid,
    label: c.label,
    createdAt: c.createdAt,
    dataLimitBytes: c.dataLimitBytes ?? null,
    capped: isCapped(c),
  }));
}

// Builds the "Subscription-Userinfo" header a lot of client apps (v2rayNG,
// NekoBox, Shadowrocket, ...) read to show usage next to a subscription.
// We don't have a data cap concept, so we deliberately omit total/expire —
// sending a fake cap would make apps show a misleading "remaining" bar.
function subscriptionUserinfoHeader(usageEntries) {
  let upload = 0;
  let download = 0;
  usageEntries.forEach((u) => {
    upload += u.uplink || 0;
    download += u.downlink || 0;
  });
  return `upload=${upload}; download=${download}`;
}

// ---------- xray process management ----------
let xrayProcess = null;

function buildXrayConfig() {
  return {
    log: { loglevel: "warning" },
    api: {
      tag: "api",
      listen: `127.0.0.1:${XRAY_API_PORT}`,
      services: ["StatsService"],
    },
    stats: {},
    policy: {
      levels: {
        0: { statsUserUplink: true, statsUserDownlink: true },
      },
    },
    inbounds: [
      {
        listen: "127.0.0.1",
        port: Number(XRAY_INTERNAL_PORT),
        protocol: "vless",
        settings: {
          // email must be unique -> use our internal client id, not the label.
          // Clients that have hit their data cap are deliberately left out —
          // this is the actual enforcement mechanism (see isCapped/enforceDataLimits).
          clients: clients
            .filter((c) => !isCapped(c))
            .map((c) => ({ id: c.uuid, level: 0, email: c.id })),
          decryption: "none",
        },
        streamSettings: {
          network: "ws",
          wsSettings: { path: WS_PATH },
        },
        sniffing: { enabled: true, destOverride: ["http", "tls"] },
      },
    ],
    outbounds: [
      { protocol: "freedom", settings: {} },
      { protocol: "blackhole", tag: "blocked" },
    ],
  };
}

function restartXray() {
  // Fold whatever the outgoing Xray process has counted so far into each
  // client's persisted baseline, so displayed usage survives the restart.
  if (xrayProcess) {
    const live = queryLiveStats();
    let changed = false;
    clients.forEach((c) => {
      const entry = live[c.id];
      if (entry) {
        c.usedBytesBaseline = (c.usedBytesBaseline || 0) + entry.uplink + entry.downlink;
        changed = true;
      }
    });
    if (changed) saveClients(clients);
  }

  // reset activity tracking — Xray's live counters are about to restart from 0,
  // so any stale "active" state or delta baseline would give a false reading
  lastLiveStats = {};
  activeClientIds = new Set();

  fs.writeFileSync(XRAY_CONFIG_PATH, JSON.stringify(buildXrayConfig(), null, 2));

  const old = xrayProcess;
  xrayProcess = spawn("/usr/local/bin/xray", ["run", "-c", XRAY_CONFIG_PATH], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  xrayProcess.on("exit", (code, signal) => {
    console.log(`[xray] exited (code=${code}, signal=${signal})`);
  });

  if (old) old.kill("SIGTERM");

  console.log(`[xray] (re)started with ${clients.length} client(s)`);
}

restartXray();

process.on("SIGTERM", () => {
  if (xrayProcess) xrayProcess.kill("SIGTERM");
  process.exit(0);
});
process.on("SIGINT", () => {
  if (xrayProcess) xrayProcess.kill("SIGTERM");
  process.exit(0);
});

// ---------- http server ----------
const app = express();
app.set("trust proxy", true); // Sevalla/Cloudflare sit in front, so respect X-Forwarded-Proto
app.use(express.json());

// index:false so express.static never auto-serves index.html for "/" — we gate that manually
app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/api/login", (req, res) => {
  const password = req.body && req.body.password;
  if (password && safeEqual(password, DASH_PASS)) {
    res.setHeader(
      "Set-Cookie",
      cookie.serialize(SESSION_COOKIE, SESSION_TOKEN, {
        httpOnly: true,
        sameSite: "lax",
        secure: req.protocol === "https",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      })
    );
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Wrong password" });
});

app.post("/api/logout", (req, res) => {
  res.setHeader(
    "Set-Cookie",
    cookie.serialize(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 })
  );
  res.json({ ok: true });
});

// Subscription link: token-protected (not cookie-protected), meant to be
// pasted straight into a client app's "subscription URL" field. Only a
// single client's link is ever served — there is intentionally no
// "all configs combined" endpoint, since /sub/:token alone (with the
// clientId stripped off) would otherwise hand out every user's config to
// anyone who guesses to trim the URL.
app.get("/sub/:token/:clientId", (req, res) => {
  if (!safeEqual(req.params.token, SUB_TOKEN)) {
    return res.status(404).send("Not found");
  }
  const client = clients.find((c) => c.id === req.params.clientId);
  if (!client) return res.status(404).send("Not found");
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(":")[0];
  if (wantsHtml(req)) {
    const usage = getUsageSnapshot(false)[client.id] || { uplink: 0, downlink: 0, total: 0 };
    const entry = {
      label: client.label,
      configLink: buildVlessLink(host, client.uuid, client.label),
      subLink: `${req.protocol}://${host}/sub/${SUB_TOKEN}/${client.id}`,
      downloadFmt: formatBytesServer(usage.downlink),
      uploadFmt: formatBytesServer(usage.uplink),
      totalFmt: formatBytesServer(usage.total),
      totalBytes: usage.total,
      dataLimitBytes: client.dataLimitBytes,
      capped: isCapped(client),
    };
    return res
      .set("Content-Type", "text/html; charset=utf-8")
      // .send(subLandingPage(client.label, "Scan the QR code or copy a link into your client app.", [entry]));
      .send(subLandingPage("","", [entry]));
  }
  const link = buildVlessLink(host, client.uuid, client.label);
  const body = Buffer.from(link, "utf8").toString("base64");
  const usage = getUsageSnapshot(false)[client.id] || { uplink: 0, downlink: 0 };
  res.set("Subscription-Userinfo", subscriptionUserinfoHeader([usage]));
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.send(body);
});

app.use("/api", requireAuthApi);

app.get("/api/meta", (req, res) => {
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(":")[0];
  res.json({
    wsPath: WS_PATH,
    usageWsPath: USAGE_WS_PATH,
    // append "/<clientId>" client-side for a single config's sub link —
    // there is no combined "all configs" sub link anymore (see /sub/:token/:clientId)
    subBase: `${req.protocol}://${host}/sub/${SUB_TOKEN}`,
  });
});

app.get("/api/clients", (req, res) => {
  res.json(publicClientList());
});

app.get("/api/usage", (req, res) => {
  res.json(getUsageSnapshot(false));
});

app.post("/api/clients", (req, res) => {
  const label = (req.body && req.body.label ? String(req.body.label) : "").trim() || "New config";
  const limitResult = parseDataLimitBytes(req.body && req.body.dataLimitBytes);
  if (limitResult === "invalid") {
    return res.status(400).json({ error: "dataLimitBytes must be a positive number or null" });
  }
  const client = {
    id: crypto.randomUUID(),
    uuid: crypto.randomUUID(),
    label,
    createdAt: new Date().toISOString(),
    usedBytesBaseline: 0,
    dataLimitBytes: limitResult,
  };
  clients.push(client);
  saveClients(clients);
  restartXray();
  broadcastUsage(); // let connected dashboards see the new config immediately
  res.status(201).json({
    id: client.id,
    uuid: client.uuid,
    label: client.label,
    createdAt: client.createdAt,
    dataLimitBytes: client.dataLimitBytes,
    capped: false,
  });
});

// Updates a client's data cap. Passing dataLimitBytes: null makes it
// unlimited again. Always restarts Xray so the new limit is evaluated
// immediately against isCapped() — this is what lets an admin either raise
// a capped client's limit to bring it back online, or lower a client's
// limit below its current usage to cut it off right away.
app.patch("/api/clients/:id", (req, res) => {
  const client = clients.find((c) => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: "not found" });

  const limitResult = parseDataLimitBytes(req.body && req.body.dataLimitBytes);
  if (limitResult === "invalid") {
    return res.status(400).json({ error: "dataLimitBytes must be a positive number or null" });
  }

  client.dataLimitBytes = limitResult;
  saveClients(clients);
  restartXray();
  broadcastUsage();
  res.json({ id: client.id, dataLimitBytes: client.dataLimitBytes, capped: isCapped(client) });
});

// Zeroes a client's usage counter and, if it was capped, brings it back
// into Xray's config (via restartXray -> buildXrayConfig -> isCapped).
app.post("/api/clients/:id/reset-usage", (req, res) => {
  const client = clients.find((c) => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: "not found" });

  client.usedBytesBaseline = 0;
  saveClients(clients);
  restartXray();
  broadcastUsage();
  res.json({ id: client.id, dataLimitBytes: client.dataLimitBytes, capped: isCapped(client) });
});

app.delete("/api/clients/:id", (req, res) => {
  const before = clients.length;
  clients = clients.filter((c) => c.id !== req.params.id);
  if (clients.length === before) {
    return res.status(404).json({ error: "not found" });
  }
  saveClients(clients);
  restartXray();
  broadcastUsage(); // let connected dashboards drop the deleted config immediately
  res.status(204).end();
});

app.get("/", requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = http.createServer(app);

const proxy = httpProxy.createProxyServer({
  target: { host: "127.0.0.1", port: Number(XRAY_INTERNAL_PORT) },
  ws: true,
});
proxy.on("error", (err) => console.error("[proxy] error:", err.message));

// ---------- live usage over websocket ----------
// Separate WebSocket server (noServer mode) just for pushing usage snapshots
// to logged-in dashboard tabs. Kept fully independent from the VLESS proxy
// upgrade handling below.
const usageWss = new WebSocket.Server({ noServer: true });
const usageSockets = new Set();

function usageSnapshotPayload() {
  return JSON.stringify({
    type: "usage",
    ts: Date.now(),
    clients: publicClientList(),
    // This is the only place that reads with trackActivity=true — it runs on
    // the fixed 5s interval, so the delta between calls is a meaningful
    // "traffic happened in the last ~5s" signal.
    usage: getUsageSnapshot(true),
  });
}

// Checks whether any not-yet-capped client's usage has newly crossed its own
// data limit, and if so, restarts Xray so its config (built by
// buildXrayConfig, which filters on isCapped) excludes them — cutting any
// live connection immediately. Runs on every periodic tick, independent of
// whether a dashboard tab is currently connected, so caps are enforced even
// with the dashboard closed.
function enforceDataLimits() {
  const live = queryLiveStats();
  const newlyCapped = clients.filter((c) => {
    if (c.dataLimitBytes == null || isCapped(c)) return false; // no cap, or already excluded
    const liveEntry = live[c.id] || { uplink: 0, downlink: 0 };
    const total = (c.usedBytesBaseline || 0) + liveEntry.uplink + liveEntry.downlink;
    return total >= c.dataLimitBytes;
  });

  if (newlyCapped.length > 0) {
    console.log(
      `[limits] hit data cap, restarting without: ${newlyCapped.map((c) => c.label).join(", ")}`
    );
    restartXray();
  }
}

function broadcastUsage() {
  enforceDataLimits();
  if (usageSockets.size === 0) return;
  const payload = usageSnapshotPayload();
  usageSockets.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  });
}

setInterval(broadcastUsage, USAGE_PUSH_INTERVAL_MS);

usageWss.on("connection", (ws) => {
  usageSockets.add(ws);
  // send an immediate snapshot so the UI isn't stuck waiting for the next tick
  ws.send(usageSnapshotPayload());
  ws.on("close", () => usageSockets.delete(ws));
  ws.on("error", () => usageSockets.delete(ws));
});

server.on("upgrade", (req, socket, head) => {
  const urlPath = (req.url || "").split("?")[0];

  if (urlPath === USAGE_WS_PATH) {
    if (!isAuthed(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    usageWss.handleUpgrade(req, socket, head, (ws) => {
      usageWss.emit("connection", ws, req);
    });
    return;
  }

  if (req.url && req.url.startsWith(WS_PATH)) {
    proxy.ws(req, socket, head);
    return;
  }

  socket.destroy();
});

server.listen(PORT, () => {
  console.log(`[server] dashboard + vless proxy listening on :${PORT}`);
  console.log(`[server] vless ws path: ${WS_PATH}`);
  console.log(`[server] live usage ws path: ${USAGE_WS_PATH} (push every ${USAGE_PUSH_INTERVAL_MS}ms)`);
});
