# Auntie OS — Cloudflare Tunnel Setup

Exposes the web UI at `https://auntie.tribetailspetcare.com` with zero port forwarding.
All traffic is TLS-encrypted end-to-end through Cloudflare's network.

---

## Prerequisites

- A Cloudflare account (free tier works)
- `tribetailspetcare.com` domain managed in Cloudflare (nameservers pointing to Cloudflare)
- `cloudflared` installed on the Mac running Auntie OS

---

## Step 1 — Install cloudflared

```bash
brew install cloudflared
```

Verify:
```bash
cloudflared --version
```

---

## Step 2 — Authenticate to Cloudflare

```bash
cloudflared tunnel login
```

This opens a browser window. Log in and authorize the `tribetailspetcare.com` zone.
A cert is saved to `~/.cloudflared/cert.pem`.

---

## Step 3 — Create the tunnel

```bash
cloudflared tunnel create auntie-os
```

This creates a tunnel and saves credentials to:
```
~/.cloudflared/<TUNNEL_ID>.json
```

Note the Tunnel ID from the output (looks like `abc12345-...`).

---

## Step 4 — Write the tunnel config file

Save this as `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /Users/sydeast/.cloudflared/<TUNNEL_ID>.json

ingress:
  # Auntie OS Web UI
  - hostname: auntie.tribetailspetcare.com
    service: http://localhost:51004

  # Catch-all (required by cloudflared)
  - service: http_status:404
```

**Replace `<TUNNEL_ID>` with the actual ID from Step 3.**

Or run this to generate it (after Step 3, fill in TUNNEL_ID):

```bash
TUNNEL_ID="your-tunnel-id-here"
cat > ~/.cloudflared/config.yml << EOF
tunnel: ${TUNNEL_ID}
credentials-file: /Users/sydeast/.cloudflared/${TUNNEL_ID}.json

ingress:
  - hostname: auntie.tribetailspetcare.com
    service: http://localhost:51004
  - service: http_status:404
EOF
echo "Config written."
```

---

## Step 5 — Create DNS record

```bash
cloudflared tunnel route dns auntie-os auntie.tribetailspetcare.com
```

This creates a CNAME in Cloudflare DNS pointing `auntie.tribetailspetcare.com` → `<TUNNEL_ID>.cfargotunnel.com`.

Verify in Cloudflare Dashboard → DNS → should see:
```
auntie  CNAME  <TUNNEL_ID>.cfargotunnel.com  (Proxied)
```

---

## Step 6 — Test the tunnel manually

Make sure `web_server.py` is running first:
```bash
python3 /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/web_server.py &
```

Then start the tunnel:
```bash
cloudflared tunnel run auntie-os
```

Visit `https://auntie.tribetailspetcare.com` in any browser.

---

## Step 7 — Run as a launchd service (auto-start on Mac login)

```bash
sudo cloudflared service install
```

This installs a launchd plist at `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist`
that starts the tunnel automatically on boot.

To stop/start manually:
```bash
sudo launchctl stop com.cloudflare.cloudflared
sudo launchctl start com.cloudflare.cloudflared
```

To check status:
```bash
sudo launchctl list | grep cloudflared
```

---

## Step 8 — Run web_server.py as a launchd service

Save this as `/Library/LaunchDaemons/com.tribetails.auntie-ui.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.tribetails.auntie-ui</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>/Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/web_server.py</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/auntie-ui.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/auntie-ui.err</string>
</dict>
</plist>
```

Load it:
```bash
sudo launchctl load /Library/LaunchDaemons/com.tribetails.auntie-ui.plist
```

---

## Full startup summary (manual, no services)

```bash
# Terminal 1 — Web UI
python3 /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/web_server.py

# Terminal 2 — Cloudflare Tunnel
cloudflared tunnel run auntie-os

# n8n and Baserow start automatically (Docker)
# Verify: docker ps | grep -E "n8n|baserow"
```

---

## Security notes

- The UI is publicly accessible at `auntie.tribetailspetcare.com` — anyone with the URL can reach it
- **To restrict access**, add Cloudflare Access:
  1. Cloudflare Dashboard → Zero Trust → Access → Applications → Add Application
  2. Self-hosted → hostname `auntie.tribetailspetcare.com`
  3. Policy: "Allow" → Rule: Emails → add `tribetails@tribetails.com`
  4. Now only that email (via OTP or Google login) can reach the UI
- This is recommended before exposing to the internet long-term

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Tunnel starts but site shows 502 | `web_server.py` not running — start it first |
| DNS not resolving | Wait 1-2 min after `cloudflared tunnel route dns` |
| `cloudflared: command not found` | Run `brew install cloudflared` |
| `cert.pem` not found | Re-run `cloudflared tunnel login` |
| Connection refused on mobile (Tasker) | Tasker uses LAN IP directly, not the tunnel — that's expected |
