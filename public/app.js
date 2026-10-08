let META = null;
let USAGE_SOCKET = null;
let RECONNECT_TIMER = null;
let LOGGING_OUT = false;

// Card list is fully rebuilt every ~5s from the usage websocket, which would
// otherwise snap any open "edit limit" box shut and wipe unsaved input while
// the admin is mid-edit. These track which editors are open and what's been
// typed into them so render() can restore that state across rebuilds.
const OPEN_LIMIT_EDITORS = new Set();
const LIMIT_DRAFTS = new Map(); // clientId -> { value: string, unit: "MB"|"GB"|"TB" }

// The QR code now lives in a single modal appended to <body>, outside the
// #list subtree that render() tears down and rebuilds every ~5s. That means
// opening it once is enough — it survives every subsequent websocket refresh
// on its own, with nothing to track per-card.
let QR_MODAL = null;
let QR_MODAL_BODY = null;
let QR_MODAL_LABEL = null;

// If a websocket "usage" refresh lands while the admin has a limit-editor
// input focused or has text selected inside the list, applying it right away
// would blow away focus/selection (rebuilding the DOM always does that, even
// though the *value* is preserved via LIMIT_DRAFTS). So we hold the latest
// snapshot here and flush it once the admin is done interacting.
let PENDING_RENDER = null;

const UNIT_BYTES = { MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

function bytesToUnit(bytes) {
  if (bytes == null) return { value: "", unit: "GB" };
  if (bytes >= UNIT_BYTES.TB) return { value: round2(bytes / UNIT_BYTES.TB), unit: "TB" };
  if (bytes >= UNIT_BYTES.GB) return { value: round2(bytes / UNIT_BYTES.GB), unit: "GB" };
  return { value: round2(bytes / UNIT_BYTES.MB), unit: "MB" };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function api(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("unauthorized");
  }
  return res;
}

async function loadMeta() {
  const res = await api("/api/meta");
  META = await res.json();
}

function buildLink(uuid, label) {
  const host = location.hostname;
  const remark = encodeURIComponent(label || "VLESS");
  return `vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&host=${host}&path=${encodeURIComponent(
    META.wsPath
  )}#${remark}`;
}

function formatBytes(bytes) {
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

// One-shot REST fetch — used for the very first paint and as a manual
// "Refresh usage" fallback. Ongoing live updates come from the websocket.
async function loadClients() {
  const [clientsRes, usageRes] = await Promise.all([api("/api/clients"), api("/api/usage")]);
  const clients = await clientsRes.json();
  const usage = await usageRes.json();
  render(clients, usage);
}

function flashCopied(btn, labelEl) {
  const oldLabel = labelEl ? labelEl.textContent : null;
  const oldHtml = btn.innerHTML;
  if (labelEl) {
    labelEl.textContent = "Copied";
    btn.style.color = "var(--success)";
  } else {
    btn.innerHTML = "Copied";
  }
  btn.disabled = true;
  setTimeout(() => {
    if (labelEl) {
      labelEl.textContent = oldLabel;
      btn.style.color = "";
    } else {
      btn.innerHTML = oldHtml;
    }
    btn.disabled = false;
  }, 1200);
}

function copyToClipboard(text, btn, labelEl) {
  navigator.clipboard
    .writeText(text)
    .then(() => flashCopied(btn, labelEl))
    .catch(() => {
      window.prompt("Copy this:", text);
    });
}

const ICONS = {
  qrcode:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect><line x1="14" y1="14" x2="14" y2="21"></line><line x1="21" y1="14" x2="21" y2="14.01"></line><line x1="14" y1="17.5" x2="17.5" y2="17.5"></line><line x1="21" y1="21" x2="17.5" y2="21"></line><line x1="17.5" y1="17.5" x2="17.5" y2="21"></line></svg>',
  copy:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path></svg>',
  link:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>',
  trash:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7"></line><path d="M6 7V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v3"></path><path d="M19 7l-1 13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 7"></path></svg>',
};

function iconBtn({ icon, label, ariaLabel, extraClass }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon-btn" + (extraClass ? " " + extraClass : "");
  btn.setAttribute("aria-label", ariaLabel || label);
  btn.title = ariaLabel || label;
  const iconWrap = document.createElement("span");
  iconWrap.innerHTML = icon;
  const labelEl = document.createElement("span");
  labelEl.textContent = label;
  btn.appendChild(iconWrap);
  btn.appendChild(labelEl);
  return { btn, labelEl };
}

// A client counts as "active" for the status dot when the server detected
// new traffic between the last two 5s snapshots (see getUsageSnapshot's
// trackActivity logic in server.js) — genuinely transient, not lifetime total.
function isActive(clientUsage) {
  return !!clientUsage.active;
}

function renderStatChips(clients, usage) {
  const chips = document.getElementById("statChips");
  if (!chips) return;
  const total = clients.length;
  const active = clients.filter((c) => isActive(usage[c.id] || {})).length;
  const capped = clients.filter((c) => c.capped).length;
  const totalBytes = clients.reduce((sum, c) => sum + ((usage[c.id] || {}).total || 0), 0);

  chips.innerHTML = "";
  const items = [
    { label: "configs", value: String(total) },
    { label: "active now", value: String(active), live: active > 0 },
    { label: "total usage", value: formatBytes(totalBytes) },
  ];
  if (capped > 0) items.push({ label: "capped", value: String(capped) });
  items.forEach((item) => {
    const chip = document.createElement("div");
    chip.className = "stat-chip" + (item.live ? " is-live" : "");
    chip.innerHTML = `<strong>${item.value}</strong><span>${item.label}</span>`;
    chips.appendChild(chip);
  });
}

// ---------- QR code modal (single instance, lives outside #list) ----------
function ensureQrModal() {
  if (QR_MODAL) return;

  const overlay = document.createElement("div");
  overlay.className = "qr-modal-overlay";

  const modal = document.createElement("div");
  modal.className = "qr-modal";

  const head = document.createElement("div");
  head.className = "qr-modal-head";
  const label = document.createElement("span");
  label.className = "label";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "qr-modal-close";
  closeBtn.innerHTML = "&times;";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.addEventListener("click", closeQrModal);
  head.appendChild(label);
  head.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "qr-modal-body";

  modal.appendChild(head);
  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // click on the dim backdrop (not the modal itself) closes it
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeQrModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("is-open")) closeQrModal();
  });

  QR_MODAL = overlay;
  QR_MODAL_BODY = body;
  QR_MODAL_LABEL = label;
}

function openQrModal(link, label) {
  ensureQrModal();
  QR_MODAL_LABEL.textContent = label || "QR code";
  QR_MODAL_BODY.innerHTML = "";
  try {
    // eslint-disable-next-line no-undef
    new QRCode(QR_MODAL_BODY, { text: link, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.L });
  } catch (err) {
    console.error("QR generation failed:", err);
    QR_MODAL_BODY.textContent = "Couldn't generate QR code — use the copy button instead.";
  }
  QR_MODAL.classList.add("is-open");
}

function closeQrModal() {
  if (QR_MODAL) QR_MODAL.classList.remove("is-open");
}

// ---------- interaction guard: don't let background refreshes clobber
// an in-progress edit or a manual text selection inside the client list ----------
function isInteractingWithList() {
  const list = document.getElementById("list");
  if (!list) return false;

  const active = document.activeElement;
  if (active && list.contains(active) && (active.tagName === "INPUT" || active.tagName === "SELECT")) {
    return true;
  }

  const sel = window.getSelection();
  if (sel && sel.toString().length > 0 && sel.anchorNode && list.contains(sel.anchorNode)) {
    return true;
  }

  return false;
}

// Every render driven by the background usage websocket goes through here
// instead of calling render() directly. If the admin is mid-edit or has
// text selected, we hold onto the latest data and apply it once they're done,
// instead of yanking the DOM out from under them every ~5s.
function scheduleRender(clients, usage) {
  if (isInteractingWithList()) {
    PENDING_RENDER = { clients, usage };
    return;
  }
  render(clients, usage);
}

function flushPendingRenderIfIdle() {
  if (PENDING_RENDER && !isInteractingWithList()) {
    const { clients, usage } = PENDING_RENDER;
    PENDING_RENDER = null;
    render(clients, usage);
  }
}

function render(clients, usage) {
  renderStatChips(clients, usage);

  const list = document.getElementById("list");
  list.className = "client-list";
  list.innerHTML = "";

  if (!clients.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No configs yet — add one above to generate a link and QR code.";
    list.appendChild(empty);
    return;
  }

  clients.forEach((c) => {
    const link = buildLink(c.uuid, c.label);
    const clientUsage = usage[c.id] || { uplink: 0, downlink: 0, total: 0, active: false };
    const capped = !!c.capped;

    const card = document.createElement("div");
    card.className = "client-card" + (capped ? " capped" : "");

    const head = document.createElement("div");
    head.className = "client-head";

    const dot = document.createElement("span");
    dot.className =
      "status-dot" + (capped ? " capped" : isActive(clientUsage) ? " active" : "");

    const labelWrap = document.createElement("div");
    const label = document.createElement("p");
    label.className = "client-label";
    label.textContent = c.label;
    const uuidShort = document.createElement("p");
    uuidShort.className = "client-uuid";
    uuidShort.textContent = c.uuid.split("-")[0];
    labelWrap.appendChild(label);
    labelWrap.appendChild(uuidShort);

    head.appendChild(dot);
    head.appendChild(labelWrap);

    const stats = document.createElement("div");
    stats.className = "client-stats";

    const down = document.createElement("div");
    down.innerHTML = `<span class="stat-label">Download</span><span class="stat-value">${formatBytes(
      clientUsage.downlink
    )}</span>`;
    const up = document.createElement("div");
    up.innerHTML = `<span class="stat-label">Upload</span><span class="stat-value">${formatBytes(
      clientUsage.uplink
    )}</span>`;
    const total = document.createElement("div");
    total.innerHTML = `<span class="stat-label">Total</span><span class="stat-value">${formatBytes(
      clientUsage.total
    )}</span>`;

    stats.appendChild(down);
    stats.appendChild(up);
    stats.appendChild(total);

    // ---- usage-vs-cap progress bar (only meaningful when a limit is set) ----
    let usageBarTrack = null;
    if (c.dataLimitBytes != null) {
      const ratio = Math.min(1, clientUsage.total / c.dataLimitBytes);
      usageBarTrack = document.createElement("div");
      usageBarTrack.className = "usage-bar-track";
      const fill = document.createElement("div");
      fill.className =
        "usage-bar-fill" + (capped ? " is-capped" : ratio >= 0.85 ? " is-warn" : "");
      fill.style.width = `${Math.max(2, ratio * 100)}%`;
      usageBarTrack.appendChild(fill);
    }

    // ---- data limit row ----
    const limitRow = document.createElement("div");
    limitRow.className = "client-limit-row";

    const limitLabel = document.createElement("span");
    if (c.dataLimitBytes == null) {
      limitLabel.textContent = "Unlimited";
    } else if (capped) {
      limitLabel.textContent = "Limit reached";
      const badge = document.createElement("span");
      badge.className = "capped-badge";
      badge.textContent = ` · ${formatBytes(c.dataLimitBytes)}`;
      limitLabel.appendChild(badge);
    } else {
      const remaining = Math.max(0, c.dataLimitBytes - clientUsage.total);
      limitLabel.textContent = `${formatBytes(remaining)} remaining of ${formatBytes(c.dataLimitBytes)}`;
    }

    const limitEditLink = document.createElement("button");
    limitEditLink.className = "limit-edit-link";
    limitEditLink.type = "button";
    limitEditLink.textContent = "Edit";
    limitEditLink.addEventListener("click", () => {
      if (OPEN_LIMIT_EDITORS.has(c.id)) {
        OPEN_LIMIT_EDITORS.delete(c.id);
        LIMIT_DRAFTS.delete(c.id);
      } else {
        OPEN_LIMIT_EDITORS.add(c.id);
        if (!LIMIT_DRAFTS.has(c.id)) LIMIT_DRAFTS.set(c.id, bytesToUnit(c.dataLimitBytes));
      }
      editorBox.style.display = OPEN_LIMIT_EDITORS.has(c.id) ? "flex" : "none";
    });

    limitRow.appendChild(limitLabel);
    limitRow.appendChild(limitEditLink);

    const editorBox = document.createElement("div");
    editorBox.className = "limit-editor";
    const isOpen = OPEN_LIMIT_EDITORS.has(c.id);
    editorBox.style.display = isOpen ? "flex" : "none";
    const draft = LIMIT_DRAFTS.get(c.id) || bytesToUnit(c.dataLimitBytes);

    const valueInput = document.createElement("input");
    valueInput.type = "number";
    valueInput.min = "0";
    valueInput.step = "any";
    valueInput.placeholder = "Unlimited";
    valueInput.className = "limit-value-input";
    valueInput.value = draft.value;
    valueInput.addEventListener("input", () => {
      LIMIT_DRAFTS.set(c.id, { value: valueInput.value, unit: unitSelect.value });
    });

    const unitSelect = document.createElement("select");
    unitSelect.className = "limit-unit-select";
    ["MB", "GB", "TB"].forEach((u) => {
      const opt = document.createElement("option");
      opt.value = u;
      opt.textContent = u;
      if (u === draft.unit) opt.selected = true;
      unitSelect.appendChild(opt);
    });
    unitSelect.addEventListener("change", () => {
      LIMIT_DRAFTS.set(c.id, { value: valueInput.value, unit: unitSelect.value });
    });

    const saveLimitBtn = document.createElement("button");
    saveLimitBtn.type = "button";
    saveLimitBtn.textContent = "Save";
    saveLimitBtn.addEventListener("click", () =>
      saveLimit(c.id, valueInput.value.trim(), unitSelect.value, saveLimitBtn)
    );

    const clearLimitBtn = document.createElement("button");
    clearLimitBtn.className = "secondary";
    clearLimitBtn.type = "button";
    clearLimitBtn.textContent = "Unlimited";
    clearLimitBtn.addEventListener("click", () => saveLimit(c.id, "", unitSelect.value, clearLimitBtn));

    editorBox.appendChild(valueInput);
    editorBox.appendChild(unitSelect);
    editorBox.appendChild(saveLimitBtn);
    editorBox.appendChild(clearLimitBtn);

    // ---- actions: icon + visible label, so first-time users know what each does ----
    const actions = document.createElement("div");
    actions.className = "client-actions";

    const { btn: qrBtn } = iconBtn({ icon: ICONS.qrcode, label: "QR", ariaLabel: "Show QR code" });
    const { btn: copyBtn, labelEl: copyLabelEl } = iconBtn({
      icon: ICONS.copy,
      label: "Copy",
      ariaLabel: "Copy config link",
    });
    copyBtn.addEventListener("click", () => copyToClipboard(link, copyBtn, copyLabelEl));

    const { btn: subBtn, labelEl: subLabelEl } = iconBtn({
      icon: ICONS.link,
      label: "Subscribe",
      ariaLabel: "Copy subscription link",
    });
    subBtn.addEventListener("click", () => copyToClipboard(`${META.subBase}/${c.id}`, subBtn, subLabelEl));

    const { btn: deleteBtn } = iconBtn({
      icon: ICONS.trash,
      label: "Delete",
      ariaLabel: "Delete this config",
      extraClass: "icon-btn-danger",
    });
    deleteBtn.addEventListener("click", () => deleteClient(c.id));

    actions.appendChild(qrBtn);
    actions.appendChild(copyBtn);
    actions.appendChild(subBtn);
    actions.appendChild(deleteBtn);

    const resetRow = document.createElement("div");
    resetRow.className = "actions";
    resetRow.style.marginTop = "8px";
    const resetBtn = document.createElement("button");
    resetBtn.className = "secondary";
    resetBtn.type = "button";
    resetBtn.style.width = "100%";
    resetBtn.textContent = "Reset usage";
    resetBtn.addEventListener("click", () => resetUsage(c.id, resetBtn));
    resetRow.appendChild(resetBtn);

    qrBtn.addEventListener("click", () => openQrModal(link, c.label));

    card.appendChild(head);
    card.appendChild(stats);
    if (usageBarTrack) card.appendChild(usageBarTrack);
    card.appendChild(limitRow);
    card.appendChild(editorBox);
    card.appendChild(actions);
    card.appendChild(resetRow);
    list.appendChild(card);
  });
}

async function saveLimit(clientId, rawValue, unit, btn) {
  btn.disabled = true;
  try {
    const dataLimitBytes = rawValue ? Math.round(parseFloat(rawValue) * UNIT_BYTES[unit]) : null;
    if (rawValue && (!Number.isFinite(dataLimitBytes) || dataLimitBytes <= 0)) {
      alert("Enter a valid positive number.");
      return;
    }
    await api("/api/clients/" + clientId, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataLimitBytes }),
    });
    OPEN_LIMIT_EDITORS.delete(clientId);
    LIMIT_DRAFTS.delete(clientId);
    await loadClients();
  } finally {
    btn.disabled = false;
  }
}

async function resetUsage(clientId, btn) {
  if (!confirm("Reset usage for this config? If it was capped, it will reconnect immediately.")) return;
  btn.disabled = true;
  try {
    await api("/api/clients/" + clientId + "/reset-usage", { method: "POST" });
    await loadClients();
  } finally {
    btn.disabled = false;
  }
}

async function createClient() {
  const input = document.getElementById("newLabel");
  const label = input.value.trim();
  const limitValueInput = document.getElementById("newLimitValue");
  const limitUnitSelect = document.getElementById("newLimitUnit");
  const rawLimit = limitValueInput.value.trim();
  const dataLimitBytes = rawLimit
    ? Math.round(parseFloat(rawLimit) * UNIT_BYTES[limitUnitSelect.value])
    : null;
  if (rawLimit && (!Number.isFinite(dataLimitBytes) || dataLimitBytes <= 0)) {
    alert("Enter a valid positive limit, or leave it empty for unlimited.");
    return;
  }
  const btn = document.getElementById("createBtn");
  btn.disabled = true;
  try {
    await api("/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, dataLimitBytes }),
    });
    input.value = "";
    limitValueInput.value = "";
    // the server pushes an updated snapshot over the websocket right away;
    // this REST call is just a fast fallback in case the socket is down.
    await loadClients();
  } finally {
    btn.disabled = false;
  }
}

async function deleteClient(id) {
  if (!confirm("Delete this config? Anyone using it will be disconnected.")) return;
  await api("/api/clients/" + id, { method: "DELETE" });
  await loadClients();
}

// ---------- live usage websocket ----------
function connectUsageSocket() {
  if (RECONNECT_TIMER) {
    clearTimeout(RECONNECT_TIMER);
    RECONNECT_TIMER = null;
  }

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const path = (META && META.usageWsPath) || "/ws/usage";
  const socket = new WebSocket(`${proto}//${location.host}${path}`);
  USAGE_SOCKET = socket;

  socket.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "usage") {
      scheduleRender(msg.clients, msg.usage);
    }
  });

  socket.addEventListener("close", () => {
    // if we got logged out, don't loop forever reconnecting to a 401
    if (!LOGGING_OUT && !RECONNECT_TIMER) {
      RECONNECT_TIMER = setTimeout(() => {
        RECONNECT_TIMER = null;
        connectUsageSocket();
      }, 3000);
    }
  });

  socket.addEventListener("error", () => {
    socket.close();
  });
}

document.getElementById("createBtn").addEventListener("click", createClient);
document.getElementById("newLabel").addEventListener("keydown", (e) => {
  if (e.key === "Enter") createClient();
});
document.getElementById("refreshBtn").addEventListener("click", () => loadClients());
document.getElementById("logoutBtn").addEventListener("click", async () => {
  LOGGING_OUT = true;
  if (USAGE_SOCKET) USAGE_SOCKET.close();
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login";
});

// Flush a deferred background refresh as soon as the admin stops interacting
// with the list — on blur, once a selection is cleared, and as a periodic
// safety net in case neither of those fires (e.g. they just stop typing).
document.addEventListener("focusout", () => setTimeout(flushPendingRenderIfIdle, 0));
document.addEventListener("selectionchange", () => {
  if (window.getSelection().toString().length === 0) flushPendingRenderIfIdle();
});
setInterval(flushPendingRenderIfIdle, 3000);

(async function init() {
  await loadMeta();
  await loadClients();
  // live usage now streams in every 5s over the websocket instead of polling
  connectUsageSocket();
})();
