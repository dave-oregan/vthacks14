# SIGHTLINE Link Relay Protocol

**Protocol version:** `1`  
**Transport:** one WebSocket connection  
**Text frames:** JSON telemetry / control  
**Binary frames:** media with SIGHTLINE envelope

## WebSocket URL

```text
ws://<host>:<port>/ws/relay
```

Optional TLS:

```text
wss://<host>:<port>/ws/relay
```

Default hackathon values in the iOS app:

- host: `192.168.1.100` (editable)
- port: `8000`
- path: `/ws/relay`

## Connection lifecycle

1. Client connects.
2. Client sends `hello` (JSON text).
3. Client streams JSON telemetry + binary media.
4. Either side may send `ping`; peer replies `pong`.
5. On unexpected disconnect, the iOS app auto-reconnects with exponential backoff:
   `0.5s → 1s → 2s → 4s → 8s → max 10s`, then resets after a stable connection.
6. After reconnect, the client resumes **live** data (no historical media replay).

---

## Text JSON messages

All timestamps are **Unix epoch milliseconds** (`timestampMs`).

### `hello`

Sent immediately after connect / reconnect.

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "sessionId": "<uuid>",
  "timestampMs": 0,
  "app": {
    "name": "SIGHTLINE Link",
    "version": "1.0.0",
    "build": "1"
  },
  "platform": {
    "os": "iOS",
    "osVersion": "18.0"
  },
  "capabilities": {
    "raybanCamera": true,
    "phoneCamera": true,
    "audio": true,
    "location": true,
    "motion": true,
    "heading": true
  },
  "activeSources": {
    "video": "rayban",
    "audio": "iphone",
    "location": "iphone",
    "motion": "iphone"
  }
}
```

`activeSources.video`: `rayban` | `iphone` | `none`  
`activeSources.audio`: `rayban_bluetooth` | `iphone` | `system_default` | `none`

### `motion`

Source is always `iphone` for v1.

```json
{
  "type": "motion",
  "protocolVersion": 1,
  "sessionId": "...",
  "sequence": 572,
  "timestampMs": 1789840000123,
  "source": "iphone",
  "attitude": {
    "quaternion": { "x": 0.01, "y": -0.11, "z": 0.02, "w": 0.99 }
  },
  "rotationRateRadPerSec": { "x": 0.1, "y": -0.2, "z": 0.05 },
  "gravityG": { "x": 0.0, "y": -0.98, "z": -0.18 },
  "userAccelerationG": { "x": 0.03, "y": 0.01, "z": -0.08 },
  "magneticField": { "x": 0.0, "y": 0.0, "z": 0.0 },
  "magneticAccuracy": 0
}
```

`magneticField` / `magneticAccuracy` are optional.

Default transmit rate: **20 Hz** (configurable).

### `location`

```json
{
  "type": "location",
  "protocolVersion": 1,
  "sessionId": "...",
  "sequence": 84,
  "timestampMs": 1789840000123,
  "source": "iphone",
  "latitude": 37.0,
  "longitude": -80.0,
  "altitudeMeters": 620.2,
  "horizontalAccuracyMeters": 5.1,
  "verticalAccuracyMeters": 7.8,
  "speedMetersPerSecond": 1.3,
  "courseDegrees": 181.4,
  "magneticHeadingDegrees": 180.0,
  "trueHeadingDegrees": 181.0,
  "headingAccuracyDegrees": 5.0
}
```

Optional fields may be omitted when CoreLocation does not provide them.

### `stream_event`

```json
{
  "type": "stream_event",
  "protocolVersion": 1,
  "event": "video_source_changed",
  "timestampMs": 1789840000123,
  "sessionId": "...",
  "source": "iphone",
  "from": "rayban",
  "to": "iphone",
  "reason": "wearable_disconnected"
}
```

Common `event` values:

- `rayban_connected`
- `rayban_disconnected`
- `video_started`
- `video_source_changed`
- `audio_route_changed`
- `location_permission_denied`
- `camera_permission_denied`

### `health`

Periodic (~5 s) status from the phone:

```json
{
  "type": "health",
  "protocolVersion": 1,
  "sessionId": "...",
  "timestampMs": 0,
  "backendState": "connected",
  "videoSource": "unknown",
  "audioSource": "unknown",
  "framesSent": 0,
  "framesDropped": 0,
  "audioChunksSent": 0,
  "latencyMs": null
}
```

### `ping` / `pong`

Backend or phone may send:

```json
{ "type": "ping", "timestampMs": 123 }
```

Peer responds:

```json
{
  "type": "pong",
  "timestampMs": 456,
  "receivedTimestampMs": 123
}
```

---

## Binary media packet format (v1)

Every binary WebSocket message:

| Offset | Size | Field |
|--------|------|-------|
| 0 | 1 | packet type |
| 1–8 | 8 | `timestampMs` uint64 **big-endian** |
| 9–12 | 4 | sequence uint32 **big-endian** |
| 13–16 | 4 | metadata JSON byte length uint32 **big-endian** |
| 17… | N | UTF-8 JSON metadata |
| 17+N… | rest | media payload |

### Packet types

| Value | Meaning |
|-------|---------|
| `0x01` | JPEG video |
| `0x02` | PCM signed 16-bit LE audio |

Do **not** assume native Swift/C struct packing. Encode fields explicitly big-endian.

### Video metadata JSON (`0x01`)

```json
{
  "protocolVersion": 1,
  "sessionId": "...",
  "mediaType": "video",
  "encoding": "jpeg",
  "source": "rayban",
  "width": 640,
  "height": 480,
  "quality": 0.65
}
```

`source`: `rayban` | `iphone`  
Payload: raw JPEG bytes (not base64).

Default relay FPS: **12** (capture from glasses may be ~24). Frames are dropped under backpressure (latest-frame-wins, ~1 pending).

### Audio metadata JSON (`0x02`)

```json
{
  "protocolVersion": 1,
  "sessionId": "...",
  "mediaType": "audio",
  "encoding": "pcm_s16le",
  "source": "rayban_bluetooth",
  "sampleRate": 16000,
  "channels": 1,
  "frameCount": 320
}
```

Payload: interleaved PCM s16le samples.  
Target format: **mono 16 kHz**. Chunks are typically ~20–40 ms.

`source` is derived from `AVAudioSession.currentRoute`, not guessed.

---

## Sequence numbers

Independent monotonic counters per relay session:

- video
- audio
- motion
- location

Reset when a new relay session UUID is created.

---

## Backend implementation notes

1. Accept WebSocket at `/ws/relay`.
2. Parse first text message as `hello`; store `sessionId`.
3. For text frames: switch on `type`.
4. For binary frames: read header → parse metadata JSON → consume payload.
5. Prefer **recency** for video; expect dropped frames.
6. Never assume missing `source` fields — reject or quarantine unlabeled media.

This document alone should be enough to implement a Python/Node receiver.
