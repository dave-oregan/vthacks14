# SIGHTLINE

VTHacks 14 — AI OS for the physical world.

| Path | Role |
|------|------|
| [`/ios`](./ios) | **SIGHTLINE Link** — iPhone sensor gateway (Ray-Ban / phone camera → WebSocket) |
| [`/web`](./web) | Laptop backend + Mission Control (relay ingest, vision, geo memory, ANS) |
| [`/docs`](./docs) | Public landing page for **[sightline.surf](https://sightline.surf)** (GitHub Pages) |

## Link the phone (streamlined)

1. On Mac: `cd web && npm run dev` → open http://localhost:8000
2. On iPhone (same Wi‑Fi), either:
   - **Scan the QR** on Mission Control (opens SIGHTLINE Link and auto-starts relay), or
   - Tap **Find Mission Control** → **LINK & START**
3. Live POV should appear on the laptop

Manual IP entry remains under **Manual IP (fallback)** if Bonjour is blocked.

Relay URL: `ws://<mac-ip>:8000/ws/relay` — see [`ios/PROTOCOL.md`](./ios/PROTOCOL.md).
Bonjour service: `_sightline._tcp` · Deep link: `sightlinelink://link?host=…&port=8000&autoStart=1`

## Public site (sightline.surf)

Static landing lives in [`docs/`](./docs) (GitHub Pages + custom domain).

1. **GitHub → Settings → Pages**
   - Source: Deploy from a branch
   - Branch: `main` · folder: `/docs`
2. **Custom domain:** `sightline.surf` (CNAME file already in `docs/CNAME`)
3. **DNS** at your registrar for `sightline.surf`:

| Type | Name | Value |
|------|------|--------|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| AAAA | `@` | `2606:50c0:8000::153` |
| AAAA | `@` | `2606:50c0:8001::153` |
| AAAA | `@` | `2606:50c0:8002::153` |
| AAAA | `@` | `2606:50c0:8003::153` |
| CNAME | `www` | `dave-oregan.github.io` |

Enable **Enforce HTTPS** in Pages once DNS has propagated.

The landing **Enter Mission Control** button probes the local session (`127.0.0.1:8000` / `localhost:8000`) and opens it when live; otherwise it shows a calm “session unavailable” state.
