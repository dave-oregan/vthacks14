import Foundation

actor NetworkRelayService {
    private let client = WebSocketClient()
    private var reconnectTask: Task<Void, Never>?
    private var healthTask: Task<Void, Never>?
    private var eventPumpTask: Task<Void, Never>?
    private var shouldReconnect = false
    private var backoffSeconds: Double = 0.5
    private var currentURL: URL?
    private var sessionId: String = ""
    private var onState: (@Sendable (BackendConnectionState) -> Void)?
    private var onLatency: (@Sendable (Int?) -> Void)?
    private var onText: (@Sendable (String) -> Void)?
    private var lastPingSentAt: Date?

    private(set) var state: BackendConnectionState = .disconnected
    private(set) var lastError: String?

    // Pending video: keep at most one latest frame while encoding/sending.
    private var pendingVideo: Data?
    private var videoSendInFlight = false
    private var videoSequence: UInt32 = 0
    private var audioSequence: UInt32 = 0
    private var motionSequence: UInt32 = 0
    private var locationSequence: UInt32 = 0

    private(set) var videoStats = VideoStats()
    private(set) var audioChunksSent: UInt64 = 0
    private var bytesWindow: [(Date, Int)] = []
    private var framesWindow: [(Date, Int)] = []

    func setHandlers(
        onState: @escaping @Sendable (BackendConnectionState) -> Void,
        onLatency: @escaping @Sendable (Int?) -> Void,
        onText: @escaping @Sendable (String) -> Void
    ) {
        self.onState = onState
        self.onLatency = onLatency
        self.onText = onText
    }

    func start(url: URL, sessionId: String) async {
        self.sessionId = sessionId
        currentURL = url
        shouldReconnect = true
        backoffSeconds = 0.5
        resetSessionCounters()
        await connectNow(url: url)
        startEventPump()
        startHealthLoop()
    }

    func stop() async {
        shouldReconnect = false
        reconnectTask?.cancel()
        reconnectTask = nil
        healthTask?.cancel()
        healthTask = nil
        eventPumpTask?.cancel()
        eventPumpTask = nil
        await client.disconnect(reason: "user_stop")
        await setState(.disconnected)
    }

    func sendHello(_ hello: HelloMessage) async {
        // Retry briefly — connect confirmation (ping) may still be in flight.
        for attempt in 1...5 {
            do {
                try await client.sendCodable(hello)
                AppLog.info("Sent hello session=\(hello.sessionId)")
                return
            } catch {
                if attempt == 5 {
                    AppLog.error("Failed to send hello: \(error.localizedDescription)")
                } else {
                    try? await Task.sleep(nanoseconds: 200_000_000)
                }
            }
        }
    }

    func sendStreamEvent(_ event: StreamEventMessage) async {
        do {
            try await client.sendCodable(event)
        } catch {
            AppLog.warn("Failed stream_event \(event.event): \(error.localizedDescription)")
        }
    }

    func sendMotion(_ sample: MotionSample, sessionId: String) async {
        guard state == .connected || state == .degraded else { return }
        motionSequence &+= 1
        let message = MotionMessage(
            sessionId: sessionId,
            sequence: motionSequence,
            timestampMs: sample.timestampMs,
            source: MediaSource.iphone.rawValue,
            attitude: sample.attitude,
            rotationRateRadPerSec: sample.rotationRateRadPerSec,
            gravityG: sample.gravityG,
            userAccelerationG: sample.userAccelerationG,
            magneticField: sample.magneticField,
            magneticAccuracy: sample.magneticAccuracy
        )
        do {
            try await client.sendCodable(message)
        } catch {
            AppLog.warn("Motion send failed: \(error.localizedDescription)")
        }
    }

    func sendLocation(_ sample: LocationSample, sessionId: String) async {
        guard state == .connected || state == .degraded else { return }
        locationSequence &+= 1
        let message = LocationMessage(
            sessionId: sessionId,
            sequence: locationSequence,
            timestampMs: sample.timestampMs,
            source: MediaSource.iphone.rawValue,
            latitude: sample.latitude,
            longitude: sample.longitude,
            altitudeMeters: sample.altitudeMeters,
            horizontalAccuracyMeters: sample.horizontalAccuracyMeters,
            verticalAccuracyMeters: sample.verticalAccuracyMeters,
            speedMetersPerSecond: sample.speedMetersPerSecond,
            courseDegrees: sample.courseDegrees,
            magneticHeadingDegrees: sample.magneticHeadingDegrees,
            trueHeadingDegrees: sample.trueHeadingDegrees,
            headingAccuracyDegrees: sample.headingAccuracyDegrees
        )
        do {
            try await client.sendCodable(message)
        } catch {
            AppLog.warn("Location send failed: \(error.localizedDescription)")
        }
    }

    /// Latest-frame-wins video enqueue. Drops intermediates when busy.
    func enqueueVideoJPEG(
        jpeg: Data,
        metadata: VideoPacketMetadata,
        timestampMs: UInt64
    ) async {
        guard state == .connected || state == .degraded else {
            videoStats.framesDropped &+= 1
            return
        }

        videoSequence &+= 1
        let sequence = videoSequence
        do {
            let packet = try BinaryPacketEncoder.encodeVideo(
                timestampMs: timestampMs,
                sequence: sequence,
                metadata: metadata,
                jpeg: jpeg
            )
            if videoSendInFlight {
                if pendingVideo != nil {
                    videoStats.framesDropped &+= 1
                }
                pendingVideo = packet
                return
            }
            await transmitVideo(packet)
        } catch {
            videoStats.framesDropped &+= 1
            AppLog.warn("Video encode failed: \(error.localizedDescription)")
        }
    }

    func sendAudioPCM(
        pcm: Data,
        metadata: AudioPacketMetadata,
        timestampMs: UInt64
    ) async {
        guard state == .connected || state == .degraded else { return }
        audioSequence &+= 1
        do {
            let packet = try BinaryPacketEncoder.encodeAudio(
                timestampMs: timestampMs,
                sequence: audioSequence,
                metadata: metadata,
                pcm: pcm
            )
            try await client.sendBinary(packet)
            audioChunksSent &+= 1
            recordBytes(packet.count)
        } catch {
            AppLog.warn("Audio send failed: \(error.localizedDescription)")
        }
    }

    func noteFrameReceived() {
        videoStats.framesReceived &+= 1
    }

    func noteFrameEncoded() {
        videoStats.framesEncoded &+= 1
    }

    func snapshotStats() -> (VideoStats, UInt64, String?) {
        refreshThroughput()
        return (videoStats, audioChunksSent, lastError)
    }

    // MARK: - Private

    private func transmitVideo(_ packet: Data) async {
        videoSendInFlight = true
        defer {
            videoSendInFlight = false
        }
        do {
            try await client.sendBinary(packet)
            videoStats.framesTransmitted &+= 1
            recordBytes(packet.count)
            recordFrame()
            if let next = pendingVideo {
                pendingVideo = nil
                await transmitVideo(next)
            }
        } catch {
            videoStats.framesDropped &+= 1
            pendingVideo = nil
            AppLog.warn("Video send failed: \(error.localizedDescription)")
            await handleTransportFailure(error.localizedDescription)
        }
    }

    private func connectNow(url: URL) async {
        await setState(state == .disconnected || state == .failed ? .connecting : .reconnecting)
        await client.connect(url: url)
    }

    private func startEventPump() {
        eventPumpTask?.cancel()
        eventPumpTask = Task {
            let stream = await client.events()
            for await event in stream {
                await handleClientEvent(event)
            }
        }
    }

    private func handleClientEvent(_ event: WebSocketClient.Event) async {
        switch event {
        case .connected:
            backoffSeconds = 0.5
            lastError = nil
            await setState(.connected)
        case .disconnected(let reason):
            lastError = reason
            await setState(.disconnected)
            await scheduleReconnectIfNeeded()
        case .failed(let message):
            lastError = message
            await setState(.failed)
            await scheduleReconnectIfNeeded()
        case .text(let text):
            await handleIncomingText(text)
            onText?(text)
        }
    }

    private func handleIncomingText(_ text: String) async {
        guard let data = text.data(using: .utf8) else { return }
        if let ping = try? JSONDecoder().decode(PingMessage.self, from: data), ping.type == "ping" {
            let pong = PongMessage(
                timestampMs: Time.timestampMs(),
                receivedTimestampMs: ping.timestampMs
            )
            try? await client.sendCodable(pong)
            if let sent = lastPingSentAt {
                let latency = Int(Date().timeIntervalSince(sent) * 1000)
                onLatency?(latency)
            }
            return
        }
        if let pong = try? JSONDecoder().decode(PongMessage.self, from: data), pong.type == "pong" {
            let latency = Int(Time.timestampMs() &- pong.receivedTimestampMs)
            onLatency?(max(0, latency))
        }
    }

    private func scheduleReconnectIfNeeded() async {
        guard shouldReconnect, let url = currentURL else { return }
        reconnectTask?.cancel()
        let delay = backoffSeconds
        backoffSeconds = min(backoffSeconds * 2.0, 10.0)
        reconnectTask = Task {
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled, shouldReconnect else { return }
            await connectNow(url: url)
        }
    }

    private func startHealthLoop() {
        healthTask?.cancel()
        healthTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                guard shouldReconnect, state == .connected || state == .degraded else { continue }
                lastPingSentAt = Date()
                let ping = PingMessage(type: "ping", timestampMs: Time.timestampMs())
                try? await client.sendCodable(ping)
                let health = HealthMessage(
                    sessionId: sessionId,
                    timestampMs: Time.timestampMs(),
                    backendState: state.rawValue,
                    videoSource: "unknown",
                    audioSource: "unknown",
                    framesSent: videoStats.framesTransmitted,
                    framesDropped: videoStats.framesDropped,
                    audioChunksSent: audioChunksSent,
                    latencyMs: nil
                )
                try? await client.sendCodable(health)
            }
        }
    }

    private func handleTransportFailure(_ message: String) async {
        lastError = message
        if state == .connected {
            await setState(.degraded)
        }
    }

    private func setState(_ newState: BackendConnectionState) async {
        state = newState
        onState?(newState)
    }

    private func resetSessionCounters() {
        videoSequence = 0
        audioSequence = 0
        motionSequence = 0
        locationSequence = 0
        videoStats = VideoStats()
        audioChunksSent = 0
        pendingVideo = nil
        videoSendInFlight = false
        bytesWindow.removeAll()
        framesWindow.removeAll()
    }

    private func recordBytes(_ count: Int) {
        let now = Date()
        bytesWindow.append((now, count))
        bytesWindow.removeAll { now.timeIntervalSince($0.0) > 1.0 }
        videoStats.bytesPerSecond = Double(bytesWindow.reduce(0) { $0 + $1.1 })
    }

    private func recordFrame() {
        let now = Date()
        framesWindow.append((now, 1))
        framesWindow.removeAll { now.timeIntervalSince($0.0) > 1.0 }
        videoStats.outgoingFPS = Double(framesWindow.count)
    }

    private func refreshThroughput() {
        let now = Date()
        bytesWindow.removeAll { now.timeIntervalSince($0.0) > 1.0 }
        framesWindow.removeAll { now.timeIntervalSince($0.0) > 1.0 }
        videoStats.bytesPerSecond = Double(bytesWindow.reduce(0) { $0 + $1.1 })
        videoStats.outgoingFPS = Double(framesWindow.count)
    }
}
