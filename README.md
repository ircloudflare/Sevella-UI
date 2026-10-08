# VLESS + Xray + multi-client dashboard (Sevalla-ready)

A single container with:

- **Xray-core** running a **VLESS + WebSocket** inbound on the fixed path **`/parsaw`**, bound to `127.0.0.1` only (not directly reachable from outside).
- A **Node.js** server that:
  - Has a real **login page** protected by a single **password** (no username).
  - Serves a **multi-client dashboard**: create as many configs/UUIDs as you want from the browser, each with its own link and QR code, each independently deletable.
  - Shows **per-config data usage** (upload/download/total), read live from Xray's built-in stats API.
  - Exposes a **combined subscription link** (`/sub/<token>`, all configs) and a **per-config subscription link** (`/sub/<token>/<clientId>`, just that one) — paste either into a client app's "subscription URL" field.
  - Proxies WebSocket traffic on `/parsaw` to the local Xray process.

Adding or removing a client automatically rewrites Xray's config and restarts it (a brief drop for active connections is expected).

## Environment variables

| Key | Description | Default |
|---|---|---|
| `DASH_PASS` | The only password needed to log in | `change-me` — **change this** |
| `WS_PATH` | WebSocket path | `parsaw` |
| `XRAY_INTERNAL_PORT` | Internal Xray port (loopback only) | `10086` |
| `PORT` | Public port; Sevalla sets this automatically | `8080` |

## Local test

```bash
docker build -t vless-dashboard .
docker run -p 8080:8080 -e DASH_PASS=mysecret vless-dashboard
```

Open `http://localhost:8080`, you'll be redirected to `/login`, enter `mysecret`.

## Deploying on Sevalla

1. Push this project to a Git repository.
2. Sevalla panel → **Application Hosting** → **Add application** → pick the repo (a `Dockerfile` is in the root, so it's auto-detected).
3. Add one environment variable:

   | Key | Value |
   |---|---|
   | `DASH_PASS` | a strong password of your choice |

   (No need to set `PORT`; `WS_PATH` already defaults to `parsaw`.)

4. Deploy. Sevalla gives you a `*.sevalla.app` domain served over HTTPS via Cloudflare — exactly what `security=tls` in the VLESS link needs.
5. Visit the domain, log in with your password, click **Create** to generate configs, and either copy each `vless://` link / QR code individually, or copy the **subscription link** and paste it into your client's subscription-URL field.

## How usage tracking works

Xray's own stats counters reset to zero every time the process restarts — and it restarts whenever you add or delete a config, since the client list is baked into its config file. To show a running total anyway, the server reads each client's counters right before killing the old Xray process and folds them into a persisted `usedBytesBaseline` per client (stored in `data/clients.json`). The number shown in the dashboard is always `baseline + live`, so it survives config changes. It does **not** survive a full container redeploy unless you attach persistent storage (see below), since the whole `data/` directory is reset then.

Usage numbers refresh automatically every 15 seconds, or on demand via the "Refresh usage" button.

## Persistence note

The client list and usage counters live in `data/clients.json` **inside the container**. Unless you attach a **Persistent Storage** volume mounted at `/app/data` in Sevalla's app settings, this resets on every redeploy and users will need new configs. Attach persistent storage at `/app/data` if you want it to survive redeploys.

## Security notes

- Change `DASH_PASS` and keep it private — anyone with it can create, view, or delete configs.
- The subscription link's token is derived from `DASH_PASS`; if you rotate the password, the subscription URL changes too (old subscription links stop working).
- `/parsaw` is fixed per your request; if you ever want it random/unguessable, just override `WS_PATH`.
- Xray only listens on `127.0.0.1` — the only way in from outside is through `/parsaw` behind the Node proxy.
