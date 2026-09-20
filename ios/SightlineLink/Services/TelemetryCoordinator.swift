import Foundation
import UIKit

@MainActor
final class TelemetryCoordinator: ObservableObject {
    let meta: MetaWearablesService
    let phoneCamera: PhoneCameraService
    let audio: AudioCaptureService
    let location: LocationService
    let motion: MotionService
    let networkMonitor: NetworkMonitorService
    let discovery = BackendDiscoveryService()
    let relay = NetworkRelayService()

    @Published var settings: StreamConfigurationSettings
    @Published private(set) var isRelaying = false
    @Published private(set) var sessionId: String = ""
    @Published private(set) var backendState: BackendConnectionState = .disconnected
    @Published private(set) var latencyMs: Int?
    @Published private(set) var activeVideoSource: MediaSource = .none
    @Published private(set) var videoStats = VideoStats()
    @Published private(set) var lastError: String?
    @Published private(set) var previewImage: UIImage?
    @Published private(set) var statusMessage: String = "Idle"

    private var healthUITask: Task<Void, Never>?
    private var encodeBusy = false
    private var latestPendingFrame: (UIImage, Int, Int, MediaSource)?
    private var expectingRayBan = false
    private var raybanRetriesLeft = 0
    private var raybanFailureHandling = false
    private var lastRayBanAutoRetry = Date.distantPast
    private var audioModeForcedByFallback = false

    init() {
        settings = StreamConfigurationStore.load()
        meta = MetaWearablesService()
        phoneCamera = PhoneCameraService()
        audio = AudioCaptureService()
        location = LocationService()
        motion = MotionService()
        networkMonitor = NetworkMonitorService()
    }

    func bootstrap() {
        // Avoid Meta DAT / ExternalAccessory bring-up while XCTest hosts the app.
        if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil {
            AppLog.info("XCTest host detected — skipping Wearables configure")
            networkMonitor.start()
            wireHandlersWithoutMeta()
            return
        }
        meta.configureSDK()
        networkMonitor.start()
        discovery.start()
        wireHandlers()
        Task { await meta.refreshCameraPermission() }
    }

    /// Apply host/port from discovery or QR deep link.
    func applyBackendLink(host: String, port: Int, autoStart: Bool) {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, port > 0, port <= 65535 else {
            statusMessage = "Invalid link target"
            return
        }
        settings.backendHost = trimmed
        settings.backendPort = port
        settings.useSecureWebSocket = false
        saveSettings()
        statusMessage = "Linked to \(trimmed):\(port)"
        AppLog.info("Applied backend link \(trimmed):\(port) autoStart=\(autoStart)")

        if autoStart {
            Task { await startRelay() }
        }
    }

    func linkToDiscovered(_ backend: DiscoveredBackend, autoStart: Bool = true) {
        applyBackendLink(host: backend.host, port: backend.port, autoStart: autoStart)
    }

    private func wireHandlersWithoutMeta() {
        phoneCamera.setFrameHandler { [weak self] image, width, height in
            self?.handleVideoFrame(image, width: width, height: height, source: .iphone)
        }
        // Minimal wiring so the process stays alive for logic tests.
        Task {
            await relay.setHandlers(
                onState: { [weak self] state in
                    Task { @MainActor in self?.backendState = state }
                },
                onLatency: { [weak self] latency in
                    Task { @MainActor in self?.latencyMs = latency }
                },
                onText: { _ in }
            )
        }
    }

    func saveSettings() {
        StreamConfigurationStore.save(settings)
    }

    /// One-tap demo mode: iPhone rear camera + built-in mic (Meta not required).
    func enableIPhoneCameraAndMicMode() {
        settings.videoSourceMode = .iphone
        settings.audioInputMode = .iphone
        settings.phoneFallbackEnabled = true
        settings.enableVideo = true
        settings.enableAudio = true
        audioModeForcedByFallback = false
        saveSettings()
        statusMessage = "iPhone camera + mic mode"
        AppLog.info("Enabled iPhone camera/mic fallback mode")
    }

    func enableAutoRayBanMode() {
        settings.videoSourceMode = .auto
        settings.audioInputMode = .auto
        settings.phoneFallbackEnabled = true
        audioModeForcedByFallback = false
        saveSettings()
        statusMessage = "Auto mode (Ray-Ban preferred, iPhone fallback on)"
    }

    /// Re-evaluate the preferred video source while a relay is live — used when
    /// the user re-selects Auto/Ray-Ban or the glasses recover after a fallback.
    func retryPreferredVideo() async {
        guard isRelaying, settings.enableVideo else { return }
        if settings.videoSourceMode == .iphone {
            await switchToIPhoneMediaFallback(reason: "user_selected_iphone_mode")
            return
        }
        let before = activeVideoSource
        await startPreferredVideo(sessionId: sessionId)
        // Restore the preferred audio route when wearable video actually took over.
        if activeVideoSource == .rayban, before != .rayban {
            if audioModeForcedByFallback {
                audioModeForcedByFallback = false
                settings.audioInputMode = .auto
            }
            if settings.enableAudio, settings.audioInputMode == .auto, audio.source != .raybanBluetooth {
                await audio.start(sessionId: sessionId, preferBuiltInMic: false)
            }
        }
    }

    /// Switch live relay onto phone camera + mic without stopping the backend session.
    func switchToIPhoneMediaFallback(reason: String) async {
        expectingRayBan = false
        settings.videoSourceMode = .iphone
        settings.audioInputMode = .iphone
        saveSettings()
        guard isRelaying else { return }

        await switchVideoSource(to: .iphone, reason: reason)
        if settings.enableAudio {
            await audio.start(sessionId: sessionId, preferBuiltInMic: true)
            await emitStreamEvent(
                "audio_route_changed",
                source: MediaSource.iphone.rawValue,
                reason: reason
            )
        }
        statusMessage = "Using iPhone camera + mic"
    }

    func startRelay() async {
        saveSettings()
        guard !isRelaying else { return }

        guard let url = settings.webSocketURL else {
            statusMessage = "Invalid backend host/port"
            lastError = statusMessage
            return
        }

        // Avoid racing a prior Connect/Reconnect socket (cancels in-flight hello).
        await relay.stop()

        let session = UUID().uuidString
        sessionId = session
        isRelaying = true
        raybanRetriesLeft = 1
        lastRayBanAutoRetry = .distantPast
        statusMessage = "Connecting…"
        UIApplication.shared.isIdleTimerDisabled = true

        await relay.start(url: url, sessionId: session)

        if settings.enableLocation {
            location.start()
        }
        if settings.enableMotion {
            motion.start(transmitHz: settings.motionTransmitHz)
        }
        if settings.enableAudio {
            let forcePhoneMic = settings.audioInputMode == .iphone
                || settings.videoSourceMode == .iphone
            await audio.start(sessionId: session, preferBuiltInMic: forcePhoneMic)
        }
        if settings.enableVideo {
            await startPreferredVideo(sessionId: session)
        }

        // Wait for a real open socket (ping-confirmed) before hello.
        for _ in 0..<50 {
            if backendState == .connected { break }
            if backendState == .failed { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }

        if backendState == .connected {
            let hello = makeHello(sessionId: session)
            await relay.sendHello(hello)
            statusMessage = "Relay live"
        } else {
            statusMessage = "Backend unreachable — sensors still running, reconnecting…"
            lastError = "WebSocket not connected to \(url.absoluteString). Check laptop IP/port and that the backend is listening."
            AppLog.warn(lastError ?? "backend unreachable")
        }
        startStatsPolling()
    }

    func stopRelay() async {
        guard isRelaying else { return }
        isRelaying = false
        statusMessage = "Stopping…"
        healthUITask?.cancel()
        healthUITask = nil

        await relay.stop()
        expectingRayBan = false
        audioModeForcedByFallback = false
        meta.stopStreamAndSession()
        phoneCamera.stop()
        audio.stop()
        location.stop()
        motion.stop()
        activeVideoSource = .none
        previewImage = nil
        UIApplication.shared.isIdleTimerDisabled = false
        statusMessage = "Idle"
    }

    func connectBackendOnly() async {
        saveSettings()
        guard let url = settings.webSocketURL else {
            lastError = "Invalid backend URL"
            return
        }
        let session = sessionId.isEmpty ? UUID().uuidString : sessionId
        sessionId = session
        await relay.start(url: url, sessionId: session)
        await relay.sendHello(makeHello(sessionId: session))
    }

    func disconnectBackendOnly() async {
        await relay.stop()
    }

    // MARK: - Wiring

    private func wireHandlers() {
        meta.setHandlers(
            onFrame: { [weak self] image, width, height in
                self?.handleVideoFrame(image, width: width, height: height, source: .rayban)
            },
            onSessionEvent: { [weak self] event in
                Task { await self?.emitStreamEvent(event) }
                if event == "rayban_disconnected" {
                    Task { await self?.handleGlassesDisconnect() }
                } else if event == "rayban_connected" {
                    Task { await self?.handleGlassesReconnected() }
                } else if event == "rayban_stream_failed" || event == "rayban_session_failed" {
                    Task { await self?.handleRayBanStreamFailure(reason: event) }
                }
            }
        )
        meta.setRelayParameters(fps: settings.relayFPS, jpegQuality: settings.jpegQuality)

        phoneCamera.setFrameHandler { [weak self] image, width, height in
            self?.handleVideoFrame(image, width: width, height: height, source: .iphone)
        }
        phoneCamera.setRelayFPS(settings.relayFPS)

        audio.setHandlers(
            onChunk: { [weak self] data, metadata, timestamp in
                Task {
                    await self?.relay.sendAudioPCM(pcm: data, metadata: metadata, timestampMs: timestamp)
                }
            },
            onRouteChanged: { [weak self] source, _ in
                Task {
                    await self?.emitStreamEvent(
                        "audio_route_changed",
                        source: source.rawValue
                    )
                }
            }
        )

        location.setHandlers(
            onSample: { [weak self] sample in
                guard let self, self.settings.enableLocation, self.isRelaying else { return }
                Task { await self.relay.sendLocation(sample, sessionId: self.sessionId) }
            },
            onDenied: { [weak self] in
                Task { await self?.emitStreamEvent("location_permission_denied") }
            }
        )

        motion.setHandler { [weak self] sample in
            guard let self, self.settings.enableMotion, self.isRelaying else { return }
            Task { await self.relay.sendMotion(sample, sessionId: self.sessionId) }
        }

        Task {
            await relay.setHandlers(
                onState: { [weak self] state in
                    Task { @MainActor in
                        self?.backendState = state
                    }
                },
                onLatency: { [weak self] latency in
                    Task { @MainActor in
                        self?.latencyMs = latency
                    }
                },
                onText: { _ in }
            )
        }
    }

    private func startPreferredVideo(sessionId: String) async {
        meta.setRelayParameters(fps: settings.relayFPS, jpegQuality: settings.jpegQuality)
        phoneCamera.setRelayFPS(settings.relayFPS)

        switch settings.videoSourceMode {
        case .iphone:
            await switchVideoSource(to: .iphone, reason: "user_forced_iphone")
            statusMessage = "iPhone camera active"
        case .rayban:
            expectingRayBan = true
            let started = await meta.startSessionAndStream()
            if started {
                await switchVideoSource(to: .rayban, reason: "user_forced_rayban", startPhone: false)
                statusMessage = "Ray-Ban stream starting…"
            } else if settings.phoneFallbackEnabled {
                await fallBackToIPhoneMedia(reason: meta.lastError ?? "wearable_unavailable")
            } else {
                statusMessage = "Waiting for Ray-Ban Meta…"
                activeVideoSource = .none
            }
        case .auto:
            // Skip Meta entirely when not registered — go straight to phone fallback.
            if meta.registrationState != .registered {
                if settings.phoneFallbackEnabled {
                    await fallBackToIPhoneMedia(reason: "meta_not_registered")
                } else {
                    statusMessage = "Meta registration required (phone fallback off)"
                    activeVideoSource = .none
                }
                return
            }

            // Ray-Ban first: stream startup legitimately passes through
            // waitingForDevice/starting, so no timed fallback here. Fallback is
            // driven by rayban_stream_failed / rayban_disconnected events only.
            expectingRayBan = true
            let started = await meta.startSessionAndStream()
            if started {
                await switchVideoSource(to: .rayban, reason: "rayban_preferred", startPhone: false)
                statusMessage = "Ray-Ban stream starting…"
            } else if settings.phoneFallbackEnabled {
                await fallBackToIPhoneMedia(reason: meta.lastError ?? "wearable_unavailable")
            } else {
                statusMessage = "No video source available"
            }
        }
    }

    private func fallBackToIPhoneMedia(reason: String) async {
        AppLog.info("Falling back to iPhone camera/mic reason=\(reason)")
        expectingRayBan = false
        if settings.audioInputMode != .iphone {
            settings.audioInputMode = .iphone
            audioModeForcedByFallback = true
        }
        await switchVideoSource(to: .iphone, reason: reason)
        if isRelaying, settings.enableAudio {
            await audio.start(sessionId: sessionId, preferBuiltInMic: true)
            await emitStreamEvent(
                "audio_route_changed",
                source: MediaSource.iphone.rawValue,
                reason: reason
            )
        }
        statusMessage = "iPhone fallback active (\(reason))"
        lastError = reason
    }

    /// Genuine DAT failure (stream error/stopped, session failure) while
    /// Ray-Ban is the active/intended source — retry once, then fall back.
    private func handleRayBanStreamFailure(reason: String) async {
        guard isRelaying, settings.enableVideo, settings.videoSourceMode != .iphone else { return }
        guard activeVideoSource == .rayban || expectingRayBan else { return }
        guard !raybanFailureHandling else { return }
        raybanFailureHandling = true
        defer { raybanFailureHandling = false }
        AppLog.warn("Ray-Ban stream failed (\(reason))")

        if raybanRetriesLeft > 0, reason != "camera_permission_denied" {
            raybanRetriesLeft -= 1
            AppLog.info("Retrying Ray-Ban stream before fallback")
            meta.stopStreamAndSession()
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if isRelaying {
                expectingRayBan = true
                if await meta.startSessionAndStream() {
                    await switchVideoSource(to: .rayban, reason: "rayban_retry")
                    statusMessage = "Ray-Ban stream starting…"
                    return
                }
            }
        }

        expectingRayBan = false
        if settings.phoneFallbackEnabled {
            await fallBackToIPhoneMedia(reason: reason)
        } else {
            activeVideoSource = .none
            statusMessage = "VIDEO SOURCE LOST"
        }
    }

    /// Debounced: the device selector can flap while a session is coming up, so
    /// only fall back if the glasses are still gone after a short grace period.
    private func handleGlassesDisconnect() async {
        guard isRelaying, settings.enableVideo else { return }
        if settings.videoSourceMode == .iphone { return }
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        guard isRelaying, settings.enableVideo else { return }
        guard !meta.hasActiveDevice else {
            AppLog.info("Glasses disconnect was transient — keeping current source")
            return
        }
        if settings.phoneFallbackEnabled {
            await fallBackToIPhoneMedia(reason: "wearable_disconnected")
        } else {
            activeVideoSource = .none
            statusMessage = "VIDEO SOURCE LOST"
        }
    }

    /// Glasses (re)appeared while relaying — take another shot at wearable video.
    private func handleGlassesReconnected() async {
        guard isRelaying, settings.enableVideo else { return }
        guard settings.videoSourceMode != .iphone else { return }
        guard activeVideoSource == .iphone || activeVideoSource == .none else { return }
        guard Date().timeIntervalSince(lastRayBanAutoRetry) > 15 else { return }
        lastRayBanAutoRetry = Date()
        AppLog.info("Glasses connected — retrying wearable video")
        await retryPreferredVideo()
    }

    private func switchVideoSource(to source: MediaSource, reason: String, startPhone: Bool = true) async {
        let from = activeVideoSource
        if source == .iphone {
            meta.stopStreamAndSession()
            if startPhone {
                await phoneCamera.start(relayFPS: settings.relayFPS)
            }
        } else if source == .rayban {
            phoneCamera.stop()
        }
        activeVideoSource = source
        await emitStreamEvent(
            "video_source_changed",
            source: source.rawValue,
            from: from.rawValue,
            to: source.rawValue,
            reason: reason
        )
    }

    private func handleVideoFrame(_ image: UIImage, width: Int, height: Int, source: MediaSource) {
        guard isRelaying, settings.enableVideo else { return }
        guard source == activeVideoSource || activeVideoSource == .none || settings.videoSourceMode == .auto else {
            return
        }
        if activeVideoSource == .none {
            activeVideoSource = source
        }
        // Prefer matching the declared active source; allow auto takeover to rayban.
        if source == .rayban, activeVideoSource == .iphone, settings.videoSourceMode == .auto {
            phoneCamera.stop()
            activeVideoSource = .rayban
            expectingRayBan = true
            Task {
                await emitStreamEvent(
                    "video_source_changed",
                    from: MediaSource.iphone.rawValue,
                    to: MediaSource.rayban.rawValue,
                    reason: "wearable_reconnected"
                )
            }
        }

        previewImage = image
        Task { await relay.noteFrameReceived() }

        if encodeBusy {
            latestPendingFrame = (image, width, height, source)
            Task { await relay.noteFrameReceived(); /* drop accounted in relay when send busy */ }
            return
        }

        encodeBusy = true
        let quality = settings.jpegQuality
        let session = sessionId
        Task {
            defer { Task { @MainActor in self.finishEncodeCycle() } }
            guard let encoded = await GlassesVideoService.encodeJPEGAsync(image: image, quality: quality) else {
                return
            }
            await relay.noteFrameEncoded()
            let metadata = VideoPacketMetadata(
                sessionId: session,
                source: source.rawValue,
                width: encoded.1,
                height: encoded.2,
                quality: quality
            )
            await relay.enqueueVideoJPEG(
                jpeg: encoded.0,
                metadata: metadata,
                timestampMs: Time.timestampMs()
            )
        }
    }

    private func finishEncodeCycle() {
        encodeBusy = false
        if let pending = latestPendingFrame {
            latestPendingFrame = nil
            handleVideoFrame(pending.0, width: pending.1, height: pending.2, source: pending.3)
        }
    }

    private func emitStreamEvent(
        _ event: String,
        source: String? = nil,
        from: String? = nil,
        to: String? = nil,
        reason: String? = nil
    ) async {
        let message = StreamEventMessage(
            event: event,
            timestampMs: Time.timestampMs(),
            sessionId: sessionId.isEmpty ? nil : sessionId,
            source: source,
            from: from,
            to: to,
            reason: reason
        )
        await relay.sendStreamEvent(message)
    }

    private func makeHello(sessionId: String) -> HelloMessage {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return HelloMessage(
            sessionId: sessionId,
            timestampMs: Time.timestampMs(),
            app: AppIdentity(name: "SIGHTLINE Link", version: version, build: build),
            platform: PlatformIdentity(os: "iOS", osVersion: UIDevice.current.systemVersion),
            capabilities: RelayCapabilities(
                raybanCamera: meta.registrationState == .registered,
                phoneCamera: true,
                audio: audio.permissionGranted || true,
                location: location.isAuthorized,
                motion: motion.isAvailable,
                heading: true
            ),
            activeSources: ActiveSources(
                video: activeVideoSource == .none ? "none" : activeVideoSource.rawValue,
                audio: audio.source == .none ? "none" : audio.source.rawValue,
                location: settings.enableLocation && location.isAuthorized ? "iphone" : "none",
                motion: settings.enableMotion && motion.isAvailable ? "iphone" : "none"
            )
        )
    }

    private func startStatsPolling() {
        healthUITask?.cancel()
        healthUITask = Task {
            while !Task.isCancelled, isRelaying {
                let (stats, _, error) = await relay.snapshotStats()
                videoStats = stats
                if let error { lastError = error }
                // Sync preview from active source if coordinator preview is empty.
                if previewImage == nil {
                    previewImage = meta.previewImage ?? phoneCamera.previewImage
                }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
    }
}
