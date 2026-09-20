# SIGHTLINE // SIDEKICK

**This project is standalone and does not need the main SIGHTLINE iOS app or Mission Control to be running.**

> What would your AI glasses learn about you?

A ~45-second personality experience: answer 3 questions, and **HokieAI**
generates a personalized *SIGHTLINE Profile* — an AI-glasses archetype, playful
telemetry scores, a diagnosis (nice or roast), the SIGHTLINE capability that
fits you best, and a one-line verdict. Results render as a shareable
1080×1350 card.

It is visually inspired by **SIGHTLINE** (the main project in this repo — an AI
perception and memory system for smart glasses), but shares **no code, no
backend, and no infrastructure** with it.

## Run it

```bash
cd sidekick
npm install
npm run dev
```

Open **http://localhost:3100**

No env vars are required to demo — without credentials the app uses a
built-in deterministic generator (marked `DEV MODE` on the result screen).
With `GEMINI_API_KEY` set it generates real profiles via Gemini; when HokieAI
credentials are configured they take precedence.

Production:

```bash
npm run build && npm start
```

## Environment variables

Copy `.env.example` → `.env.local`. Provider chain is
**HokieAI → Gemini → local fallback** — first configured provider wins,
a failure degrades to the next so the demo keeps working.

| Variable | Purpose |
|---|---|
| `HOKIEAI_BASE_URL` | Base URL of the HokieAI gateway |
| `HOKIEAI_API_KEY` | Bearer token / API key |
| `HOKIEAI_MODEL` | Model identifier to request |
| `HOKIEAI_CHAT_PATH` | (optional) default `/chat/completions` |
| `HOKIEAI_TIMEOUT_MS` | (optional) default `12000` |
| `GEMINI_API_KEY` | Interim provider — used when HokieAI isn't configured |
| `GEMINI_MODEL` | (optional) default `gemini-flash-latest` |
| `GEMINI_TIMEOUT_MS` | (optional) default `12000` |
| `SIDEKICK_FORCE_FALLBACK` | `true` forces the local generator even when keys exist |

Secrets live only in `.env.local` (gitignored). `.env.example` is safe to commit.

## How the HokieAI request works

`POST /api/analyze` (server-side only — the key never reaches the browser):

```jsonc
// request
{ "answer1": "My keys", "answer2": "Basically all the time",
  "answer3": "Coding / building", "tone": "roast" }
```

The route calls `POST {HOKIEAI_BASE_URL}/chat/completions` with an
OpenAI-compatible `Authorization: Bearer` body (system prompt + the three
answers, `response_format: json_object`, temperature 0.95). The response is
parsed defensively, **validated and sanitized server-side** (scores clamped
0–100, ability ID whitelisted to the five SIGHTLINE capabilities: RECALL,
MEMORY, GUARDIAN, MISSION, VOICE), then returned as strict JSON.

On any failure — network error, non-200, malformed JSON — the route degrades
to the next provider (HokieAI → Gemini → fallback) instead of crashing; the
`_source` field on the response reports which engine answered (`hokieai` /
`gemini` / `fallback`).

### If the endpoint differs

The exact HokieAI API shape wasn't available in the repo at build time. If the
sponsor-provided gateway uses a different path, auth header, or request body,
edit `callHokieAI` in `src/lib/hokieai.ts` — prompting, validation, and the
fallback stay unchanged. Set `HOKIEAI_CHAT_PATH` first if it's just a different path.

### Dev fallback

When `HOKIEAI_API_KEY`/`HOKIEAI_BASE_URL` are unset, `/api/analyze` uses
`src/lib/fallback.ts` — a deterministic, hash-based generator (no network) so
the full UI is demoable offline. It is clearly marked development-only in code
and flagged on the result screen.

## Demo / judging notes

- `/` always starts fresh — no login, no stored state. Hand the device to a
  judge, tap **ANALYZE ME**, done in under a minute.
- **TRY AGAIN** on the result screen resets instantly.
- **SHARE MY PROFILE** uses the Web Share API on mobile; on desktop it
  downloads the 1080×1350 PNG card. **SAVE RESULT** always downloads.
- Tone toggle (BE NICE / ROAST ME) lives in the top bar throughout — roast is
  the default because it shares better.

## Deploy

Any Next.js-capable host works (Vercel, Netlify, a VPS):

1. Push the `sidekick/` directory (it is self-contained).
2. `npm install && npm run build`, serve with `npm start` (port 3100), or
   import into Vercel — it detects Next.js automatically.
3. Set the `HOKIEAI_*` env vars in the host's dashboard.
4. Without env vars it still deploys fine and runs on the dev fallback.

## Structure

```
sidekick/
  src/app/page.tsx              # state machine: landing → quiz → analyzing → result
  src/app/api/analyze/route.ts  # server-side endpoint (HokieAI → Gemini → fallback)
  src/lib/hokieai.ts            # prompt, OpenAI-compatible client, JSON validation
  src/lib/gemini.ts             # interim provider — Gemini REST, same prompt/validation
  src/lib/fallback.ts           # deterministic dev generator (no network)
  src/lib/shareCard.ts          # canvas → 1080×1350 PNG share card
  src/lib/questions.ts          # the 3 questions
  src/lib/types.ts              # profile types + ability whitelist
  src/components/               # Analyzing, Result, ToneToggle
```
