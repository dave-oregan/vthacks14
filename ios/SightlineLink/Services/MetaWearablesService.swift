import Foundation
import MWDATCamera
import MWDATCore
import UIKit

#if DEBUG
import MWDATMockDevice
#endif

@MainActor
final class MetaWearablesService: ObservableObject {
    @Published private(set) var registrationState: MetaRegistrationUIState = .unavailable
    @Published private(set) var sdkConfigured = false
    @Published private(set) var configureError: String?
    @Published private(set) var hasActiveDevice = false
    @Published private(set) var sessionStateText = "idle"
    @Published private(set) var cameraStateText = "idle"
    @Published private(set) var streamStateText = "stopped"
    @Published private(set) var cameraPermissionGranted = false
    @Published private(set) var isStreaming = false
    @Published private(set) var previewImage: UIImage?
    @Published private(set) var lastError: String?
    @Published private(set) var framesReceived: UInt64 = 0
    @Published private(set) var lastFrameTimestamp: Date?

    private var wearables: WearablesInterface?
    private var deviceSelector: AutoDeviceSelector?
    private var deviceSession: DeviceSession?
    private var camera: MWDATCamera.Camera?
    private var stream: MWDATCamera.Stream?
    private var registrationTask: Task<Void, Never>?
    private var deviceMonitorTask: Task<Void, Never>?
    private let sessionTokenBag = ListenerTokenBag()
    private let streamTokenBag = ListenerTokenBag()
    private var didRequestStream = false
    private var didLogFirstFrame = false

    private var onFrame: ((UIImage, Int, Int) -> Void)?
    private var onSessionEvent: ((String) -> Void)?
    private var lastRelayDate: Date?
    private var relayInterval: TimeInterval = 1.0 / 12.0
    private var jpegQuality: CGFloat = 0.65

    func configureSDK() {
        do {
            try Wearables.configure()
            sdkConfigured = true
            AppLog.info("Wearables SDK configured")
        } catch {
            // Already configured or recoverable configure failure — continue if shared is usable.
            sdkConfigured = true
            configureError = error.localizedDescription
            AppLog.warn("Wearables.configure: \(error.localizedDescription)")
        }

        let shared = Wearables.shared
        wearables = shared
        deviceSelector = AutoDeviceSelector(wearables: shared)
        mapRegistration(shared.registrationState)
        startObservers()
    }

    #if DEBUG
    func startMockDeviceKit() {
        MockDeviceKit.shared.enable(config: MockDeviceKitConfig(initiallyRegistered: false))
        AppLog.info("MockDeviceKit enabled")
    }
    #endif

    func setHandlers(
        onFrame: @escaping (UIImage, Int, Int) -> Void,
        onSessionEvent: @escaping (String) -> Void
    ) {
        self.onFrame = onFrame
        self.onSessionEvent = onSessionEvent
    }

    func setRelayParameters(fps: RelayFPS, jpegQuality: Double) {
        relayInterval = 1.0 / Double(fps.rawValue)
        self.jpegQuality = CGFloat(jpegQuality)
    }

    func handleCallbackURL(_ url: URL) async {
        guard let wearables else { return }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.queryItems?.contains(where: { $0.name == "metaWearablesAction" }) == true else {
            return
        }
        do {
            _ = try await wearables.handleUrl(url)
            AppLog.info("Handled Meta callback URL")
        } catch {
            lastError = error.localizedDescription
            AppLog.error("Meta URL handle failed: \(error.localizedDescription)")
        }
    }

    func startRegistration() async {
        guard let wearables else {
            lastError = "Wearables SDK not configured"
            return
        }
        guard registrationState != .registering else { return }
        do {
            try await wearables.startRegistration()
        } catch {
            lastError = error.localizedDescription
            registrationState = .error
            AppLog.error("Registration failed: \(error.localizedDescription)")
        }
    }

    func startUnregistration() async {
        guard let wearables else { return }
        do {
            try await wearables.startUnregistration()
        } catch {
            lastError = error.localizedDescription
        }
    }

    func refreshCameraPermission() async {
        guard let wearables else { return }
        do {
            let status = try await wearables.checkPermissionStatus(.camera)
            cameraPermissionGranted = (status == .granted)
        } catch {
            AppLog.warn("checkPermissionStatus: \(error.localizedDescription)")
        }
    }

    func requestCameraPermission() async -> Bool {
        guard let wearables else { return false }
        do {
            let status = try await wearables.requestPermission(.camera)
            cameraPermissionGranted = (status == .granted)
            return cameraPermissionGranted
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    /// Official DAT 0.9 sequence: createSession → start() → await .started →
    /// addCamera → subscribe to stream publishers → stream.start().
    /// Returns true once the camera is attached and `stream.start()` was issued;
    /// false means the session genuinely failed (callers may fall back).
    @discardableResult
    func startSessionAndStream() async -> Bool {
        guard let wearables, let deviceSelector else {
            lastError = "Wearables SDK not configured"
            AppLog.error("startSessionAndStream: Wearables SDK not configured")
            return false
        }

        await refreshCameraPermission()
        if !cameraPermissionGranted {
            let granted = await requestCameraPermission()
            guard granted else {
                lastError = "Ray-Ban camera permission denied"
                AppLog.error("Ray-Ban camera permission denied")
                onSessionEvent?("camera_permission_denied")
                return false
            }
        }

        for id in wearables.devices {
            if let device = wearables.deviceForIdentifier(id) {
                AppLog.info("Device \(device.nameOrId()): link=\(device.linkState) compat=\(device.compatibility()) type=\(device.deviceType().rawValue)")
            }
        }
        AppLog.info("Active device: \(deviceSelector.activeDevice ?? "none")")

        if deviceSession == nil {
            do throws(DeviceSessionError) {
                let session = try wearables.createSession(deviceSelector: deviceSelector)
                deviceSession = session
                observeSession(session)
                AppLog.info("DeviceSession created (deviceId=\(session.deviceId))")
                sessionStateText = "starting"
                AppLog.info("DeviceSession starting…")
                try session.start()
            } catch {
                lastError = error.localizedDescription
                AppLog.error("DeviceSession create/start failed: \(error.localizedDescription)")
                onSessionEvent?("rayban_session_failed")
                deviceSession = nil
                sessionStateText = "idle"
                return false
            }
        }

        guard let session = deviceSession else { return false }

        if session.state != .started {
            let started = await waitForSessionStart(session)
            guard started else {
                lastError = "Wearable session did not reach .started"
                AppLog.error("DeviceSession did not start (state=\(session.state))")
                onSessionEvent?("rayban_session_failed")
                return false
            }
        }
        AppLog.info("DeviceSession started")

        return beginStream(on: session)
    }

    func stopStreamAndSession() {
        AppLog.info("Stopping DAT stream/session")
        didRequestStream = false
        streamTokenBag.clear()
        camera?.stop()
        camera = nil
        stream = nil
        deviceSession?.stop()
        deviceSession = nil
        sessionTokenBag.clear()
        isStreaming = false
        streamStateText = "stopped"
        cameraStateText = "stopped"
        sessionStateText = "idle"
        previewImage = nil
        lastFrameTimestamp = nil
    }

    // MARK: - Private

    private func startObservers() {
        guard let wearables, let deviceSelector else { return }

        registrationTask?.cancel()
        registrationTask = Task {
            for await state in wearables.registrationStateStream() {
                mapRegistration(state)
            }
        }

        deviceMonitorTask?.cancel()
        deviceMonitorTask = Task {
            for await deviceId in deviceSelector.activeDeviceStream() {
                let active = deviceId != nil
                let wasActive = hasActiveDevice
                hasActiveDevice = active
                if active && !wasActive {
                    onSessionEvent?("rayban_connected")
                } else if !active && wasActive {
                    onSessionEvent?("rayban_disconnected")
                }
            }
        }
    }

    private func mapRegistration(_ state: RegistrationState) {
        switch state {
        case .unavailable:
            registrationState = .unavailable
        case .available:
            registrationState = .available
        case .registering:
            registrationState = .registering
        case .registered:
            registrationState = .registered
        @unknown default:
            registrationState = .error
        }
    }

    /// Await `.started` via `stateStream()` (official sample pattern), with a
    /// state-polling deadline so a stuck session fails instead of hanging.
    private func waitForSessionStart(_ session: DeviceSession) async -> Bool {
        if session.state == .started { return true }
        return await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                for await state in session.stateStream() {
                    if state == .started { return true }
                    if state == .stopped { return false }
                }
                return session.state == .started
            }
            group.addTask {
                for _ in 0..<80 {
                    if session.state == .started { return true }
                    if session.state == .stopped { return false }
                    try? await Task.sleep(nanoseconds: 250_000_000)
                }
                return session.state == .started
            }
            let result = await group.next() ?? false
            group.cancelAll()
            return result
        }
    }

    private func observeSession(_ session: DeviceSession) {
        sessionStateText = String(describing: session.state)
        session.statePublisher.listen { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                self.sessionStateText = String(describing: state)
                AppLog.info("DeviceSession state → \(state)")
                if state == .stopped {
                    AppLog.info("DeviceSession stopped — cleaning up")
                    self.cleanupSession()
                }
            }
        }.store(in: sessionTokenBag)

        session.errorPublisher.listen { [weak self] error in
            Task { @MainActor in
                self?.lastError = error.localizedDescription
                AppLog.error("DeviceSession error: \(error.localizedDescription)")
            }
        }.store(in: sessionTokenBag)
    }

    private func observeCamera(_ camera: MWDATCamera.Camera) {
        cameraStateText = String(describing: camera.state)
        camera.statePublisher.listen { [weak self] state in
            Task { @MainActor in
                self?.cameraStateText = String(describing: state)
                AppLog.info("Camera state → \(state)")
            }
        }.store(in: streamTokenBag)
    }

    private func beginStream(on session: DeviceSession) -> Bool {
        guard camera == nil else { return true }

        // Conservative initial config per DAT docs (valid fps: 2/7/15/24/30).
        let config = StreamConfiguration(
            videoCodec: .raw,
            resolution: .low,
            frameRate: 15
        )

        do throws(DeviceSessionError) {
            guard let newCamera = try session.addCamera(config: config) else {
                lastError = "addCamera returned nil"
                AppLog.error("addCamera failed: returned nil")
                return false
            }
            camera = newCamera
            AppLog.info("addCamera success — camera attached")
            observeCamera(newCamera)
            setupStreamListeners(for: newCamera.stream)
            framesReceived = 0
            lastFrameTimestamp = nil
            didLogFirstFrame = false
            didRequestStream = true
            AppLog.info("Stream start requested (codec=raw resolution=low fps=15)")
            newCamera.stream.start()
            return true
        } catch {
            camera = nil
            lastError = error.localizedDescription
            AppLog.error("addCamera failed: \(error.localizedDescription)")
            return false
        }
    }

    private func setupStreamListeners(for stream: MWDATCamera.Stream) {
        self.stream = stream
        streamStateText = String(describing: stream.state)

        stream.statePublisher.listen { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                self.streamStateText = String(describing: state)
                self.isStreaming = (state == .streaming)
                AppLog.info("Stream state → \(state)")
                switch state {
                case .streaming:
                    self.onSessionEvent?("video_started")
                case .stopped:
                    let unexpected = self.didRequestStream
                    self.clearStreamResources()
                    if unexpected {
                        AppLog.error("Stream stopped unexpectedly")
                        self.onSessionEvent?("rayban_stream_failed")
                    }
                default:
                    break
                }
            }
        }.store(in: streamTokenBag)

        stream.videoFramePublisher.listen { [weak self] frame in
            guard let image = frame.makeUIImage() else { return }
            let width = Int(image.size.width * image.scale)
            let height = Int(image.size.height * image.scale)

            Task { @MainActor in
                guard let self else { return }
                self.framesReceived &+= 1
                let now = Date()
                self.lastFrameTimestamp = now
                self.previewImage = image

                if !self.didLogFirstFrame {
                    self.didLogFirstFrame = true
                    AppLog.info("First Ray-Ban frame received (\(width)x\(height))")
                } else if self.framesReceived % 30 == 0 {
                    AppLog.info("Ray-Ban frames received: \(self.framesReceived)")
                }

                if let last = self.lastRelayDate, now.timeIntervalSince(last) < self.relayInterval {
                    return
                }
                self.lastRelayDate = now
                self.onFrame?(image, width, height)
            }
        }.store(in: streamTokenBag)

        stream.errorPublisher.listen { [weak self] error in
            Task { @MainActor in
                guard let self else { return }
                self.lastError = error.localizedDescription
                AppLog.error("Stream error: \(error.localizedDescription)")
                if error != .photoCaptureFailed {
                    self.onSessionEvent?("rayban_stream_failed")
                }
            }
        }.store(in: streamTokenBag)
    }

    private func clearStreamResources() {
        didRequestStream = false
        streamTokenBag.clear()
        camera?.stop()
        camera = nil
        stream = nil
        isStreaming = false
        streamStateText = "stopped"
    }

    private func cleanupSession() {
        clearStreamResources()
        sessionTokenBag.clear()
        deviceSession = nil
        sessionStateText = "stopped"
    }
}
