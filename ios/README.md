# SIGHTLINE Link (iOS Gateway)

Thin iPhone sensor bridge for **SIGHTLINE**.

```
Ray-Ban Meta (+ iPhone sensors) → SIGHTLINE Link → WebSocket → laptop backend
```

This app does **not** run Gemini, object detection, ANS, or Mission Control. It only captures, normalizes, and relays.

## Prerequisites

- macOS with **Xcode 15+** (Meta DAT 0.9.0 requires **iOS 17.2+**; this project targets 17.2)
- Physical **iPhone** (simulator cannot fully exercise Ray-Ban / Bluetooth audio)
- **Meta AI** app installed and signed in
- **Ray-Ban Meta** glasses paired in Meta AI
- **Developer Mode** enabled in Meta AI (Settings → Your glasses → Developer Mode)
- Laptop + iPhone on the **same Wi‑Fi / LAN**
- SIGHTLINE backend listening for the relay WebSocket

## Setup

1. Open `ios/SightlineLink.xcodeproj` in Xcode.
2. Select the **SightlineLink** target → **Signing & Capabilities**.
3. Choose your **Team** and adjust the bundle id if needed (`com.sightline.link` by default).
4. Wait for Swift Package Manager to resolve:
   - Package: `https://github.com/facebook/meta-wearables-dat-ios`
   - Products: `MWDATCore`, `MWDATCamera`, `MWDATMockDevice`
5. Plug in a physical iPhone, select it as the run destination, and **Run**.

Display name on the home screen: **SIGHTLINE Link**.

### Regenerating the Xcode project

If you edit `project.yml`:

```bash
cd ios
xcodegen generate
```

## Meta setup

1. Pair Ray-Bans with the Meta AI app.
2. Enable **Developer Mode** for the glasses.
3. Launch **SIGHTLINE Link**.
4. Tap **REGISTER WITH META AI**, approve in Meta AI, and return via the `sightlinelink://` callback.
5. When prompted, approve **camera** access for the wearable stream (Meta AI may open again).

URL scheme / DAT callback: `sightlinelink://`  
Developer Mode Meta App ID: `0` (see `Info.plist` → `MWDAT`).

## Network setup

1. Start Mission Control on the Mac (`cd web && npm run dev`).
2. Put phone + Mac on the **same Wi‑Fi**.
3. Pair using one of:
   - **QR**: scan the code on Mission Control (auto-fills host and starts relay)
   - **Bonjour**: in SIGHTLINE Link tap **Find Mission Control** → **LINK & START**
   - **Manual**: expand Manual IP and enter the Mac LAN IP / port `8000`
4. Live POV should appear on the laptop.

Deep link format:

```text
sightlinelink://link?host=<MAC_LAN_IP>&port=8000&autoStart=1
```


## Testing checklist

1. Start relay.
2. Confirm local Ray-Ban (or phone fallback) preview.
3. Confirm backend receives `hello`.
4. Confirm binary JPEG video packets (`0x01`).
5. Confirm binary PCM16 audio packets (`0x02`).
6. Confirm `motion` JSON from the **iPhone**.
7. Confirm `location` JSON from the **iPhone** (if permitted).

## Source provenance (do not lie)

| Stream   | Preferred source                         | Fallback              |
|----------|------------------------------------------|-----------------------|
| Video    | Ray-Ban Meta (DAT camera)                | iPhone rear camera    |
| Audio    | Ray-Ban Bluetooth HFP mic (AVAudioSession route) | iPhone mic     |
| Location | iPhone CoreLocation                      | unavailable           |
| Motion   | iPhone CoreMotion                        | unavailable           |

There is **no invented Ray-Ban IMU API**. Motion/GPS are always phone-sourced unless Meta later documents otherwise.

## Troubleshooting

| Symptom | Likely fix |
|---------|------------|
| Meta AI does not open | Install Meta AI; confirm `LSApplicationQueriesSchemes` includes `fb-viewapp`; Developer Mode on |
| Registration stuck | Force-quit Meta AI + Link; re-register; check `sightlinelink://` URL types |
| Glasses not detected | Glasses on, paired, nearby; registration = registered; wait for active device |
| Camera permission denied | Request again from UI; approve in Meta AI |
| Backend cannot connect | Same Wi‑Fi; correct LAN IP; backend listening; iOS Local Network permission |
| Local network permission | Allow when prompted; Settings → SIGHTLINE Link → Local Network |
| Audio shows iPhone mic | Bluetooth HFP route not active; reconnect glasses audio; check Debug route string |
| Simulator | OK for UI/protocol unit tests; **not** for real Ray-Ban camera |

## Debug builds

Debug configuration links `MWDATMockDevice`. Expand **Debug / Diagnostics** → **Enable MockDeviceKit** to work without monopolizing physical glasses.

## Unit tests

```bash
cd ios
xcodebuild test -scheme SightlineLink -destination 'platform=iOS Simulator,name=iPhone 16'
```

Tests cover binary packet encoding, telemetry JSON, and backend URL validation — no glasses required.

## Architecture (high level)

```
MetaWearablesService  → glasses video frames
PhoneCameraService    → fallback video
AudioCaptureService   → PCM16 @ 16 kHz mono
LocationService       → CoreLocation
MotionService         → CoreMotion (~30 Hz capture, 20 Hz relay default)
NetworkRelayService   → WebSocket + backpressure
TelemetryCoordinator  → lifecycle / source selection
```
