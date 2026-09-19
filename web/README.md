# SIGHTLINE Web — Mission Control + Relay Backend

Laptop side of SIGHTLINE. Links to **SIGHTLINE Link** (iOS) over the existing relay protocol, runs computer vision, stores geo last-seen memory, and hosts Mission Control.

```
iPhone (Sightline Link)
        │  ws://<mac-lan-ip>:8000/ws/relay
        ▼
   /web backend
        ├─ JPEG → COCO-SSD (+ optional Gemini descriptors)
        ├─ SQLite memory (object + last seen + lat/lng)
        ├─ Track / leave-behind missions
        ├─ ANS trust gate demo
        └─ Mission Control UI
```

## Quick start

```bash
cd web
cp .env.example .env
npm install
npm run build:dashboard
npm run dev
```

Open **http://localhost:8000**

### Link the iPhone (no manual IP needed)

1. Keep Mission Control open — it shows a **QR code** and advertises via Bonjour (`_sightline._tcp`).
2. On the iPhone (same Wi‑Fi):
   - Scan the QR with Camera → open in **SIGHTLINE Link** (auto-starts relay), **or**
   - Open SIGHTLINE Link → **Find Mission Control** → **LINK & START**
3. Status on the laptop flips to **PHONE LINKED** / **LIVE**.

Manual IP is still available on the phone under **Manual IP (fallback)**.


## Protocol (must match iOS)

| Path | Role |
|------|------|
| `ws://host:8000/ws/relay` | iOS Link ingest (`hello`, `motion`, `location`, JPEG `0x01`, PCM `0x02`) |
| `ws://host:8000/ws/dashboard` | Mission Control live state |
| `GET /api/state` | Snapshot JSON |
| `POST /api/missions/track` | `{ "target": "phone" }` |
| `POST /api/recall` | `{ "query": "Where is my black case phone?" }` |
| `POST /api/ans/verify` | ANS gate |
| `POST /api/demo/reset` | Clear demo memory |

See `../ios/PROTOCOL.md`.

## What it does

1. **Ingest** — accepts the iOS binary/text relay protocol after link
2. **Vision** — COCO-SSD detects phone / laptop / backpack / bottle / person / etc.
3. **Descriptors** — with `GEMINI_API_KEY`, enriches to phrases like “black case phone”
4. **Geo memory** — each sighting stores time + last GPS from the phone + crop thumbnail
5. **Track mission** — watch a target; if you move away and it’s gone → leave-behind alert
6. **Recall** — ask where an object was last seen
7. **ANS** — verified team agents vs simulated unknown (blocked)
8. **Mission Control** — live POV, boxes, memory cards, agents, timeline

## Optional env

```bash
GEMINI_API_KEY=...          # richer descriptors + recall phrasing
ELEVENLABS_API_KEY=...      # spoken alerts (else logs text)
ELEVENLABS_VOICE_ID=...
ANS_TEAM_DOMAIN=sightline.local
```

## Notes

- Vision model downloads on first detection (needs network once).
- SQLite file lives in `web/data/sightline.sqlite`.
- iOS signing stays on **David O'Regan** — this folder does not change `/ios` signing.
- AI reasoning stays on the laptop; the phone remains a sensor gateway.
