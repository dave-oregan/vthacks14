# SIGHTLINE

VTHacks 14 — AI OS for the physical world.

| Path | Role |
|------|------|
| [`/ios`](./ios) | **SIGHTLINE Link** — iPhone sensor gateway (Ray-Ban / phone camera → WebSocket) |
| [`/web`](./web) | Laptop backend + Mission Control (relay ingest, vision, geo memory, ANS) |

## Link the phone (streamlined)

1. On Mac: `cd web && npm run dev` → open http://localhost:8000
2. On iPhone (same Wi‑Fi), either:
   - **Scan the QR** on Mission Control (opens SIGHTLINE Link and auto-starts relay), or
   - Tap **Find Mission Control** → **LINK & START**
3. Live POV should appear on the laptop

Manual IP entry remains under **Manual IP (fallback)** if Bonjour is blocked.

Relay URL: `ws://<mac-ip>:8000/ws/relay` — see [`ios/PROTOCOL.md`](./ios/PROTOCOL.md).
Bonjour service: `_sightline._tcp` · Deep link: `sightlinelink://link?host=…&port=8000&autoStart=1`
