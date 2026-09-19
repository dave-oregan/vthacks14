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
    @Published private(set) var streamStateText = "stopped"
    @Published private(set) var cameraPermissionGranted = false
    @Published private(set) var isStreaming = false
    @Published private(set) var previewImage: UIImage?
    @Published private(set) var lastError: String?
    @Published private(set) var framesReceived: UInt64 = 0

    private var wearables: WearablesInterface?
    private var deviceSelector: AutoDeviceSelector?
    private var deviceSession: DeviceSession?
    private var camera: MWDATCamera.Camera?
    private var registrationTask: Task<Void, Never>?
    private var deviceMonitorTask: Task<Void, Never>?
    private let sessionTokenBag = ListenerTokenBag()
    private let streamTokenBag = ListenerTokenBag()

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

    func startSessionAndStream() async {
        guard let wearables, let deviceSelector else {
            lastError = "Wearables SDK not configured"
            return
        }

        await refreshCameraPermission()
        if !cameraPermissionGranted {
            let granted = await requestCameraPermission()
            guard granted else {
                lastError = "Ray-Ban camera permission denied"
                onSessionEvent?("camera_permission_denied")
                return
            }
        }

        if deviceSession == nil {
            do throws(DeviceSessionError) {
                let session = try wearables.createSession(deviceSelector: deviceSelector)
                deviceSession = session
                observeSession(session)
                try session.start()
                sessionStateText = "starting"
            } catch {
                lastError = error.localizedDescription
                onSessionEvent?("rayban_session_failed")
                AppLog.error("DeviceSession failed: \(error.localizedDescription)")
                return
            }
        }

        for _ in 0..<40 {
            if deviceSession?.state == .started { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }

        guard let session = deviceSession, session.state == .started else {
            lastError = "Wearable session did not start — is a device connected?"
            return
        }

        beginStream(on: session)
    }

    func stopStreamAndSession() {
        streamTokenBag.clear()
        camera?.stop()
        camera = nil
        deviceSession?.stop()
        deviceSession = nil
        sessionTokenBag.clear()
        isStreaming = false
        streamStateText = "stopped"
        sessionStateText = "idle"
        previewImage = nil
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

    private func observeSession(_ session: DeviceSession) {
        session.statePublisher.listen { [weak self] state in
            Task { @MainActor in
                self?.sessionStateText = String(describing: state)
                if state == .stopped {
                    self?.cleanupSession()
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

    private func beginStream(on session: DeviceSession) {
        guard camera == nil else { return }

        let config = StreamConfiguration(
            videoCodec: .raw,
            resolution: .low,
            frameRate: 24
        )

        do {
            guard let newCamera = try session.addCamera(config: config) else {
                lastError = "Could not create wearable camera"
                return
            }
            camera = newCamera
            setupStreamListeners(for: newCamera.stream)
            streamStateText = "starting"
            newCamera.stream.start()
            onSessionEvent?("video_started")
        } catch {
            camera = nil
            lastError = error.localizedDescription
            AppLog.error("addCamera failed: \(error.localizedDescription)")
        }
    }

    private func setupStreamListeners(for stream: MWDATCamera.Stream) {
        stream.statePublisher.listen { [weak self] state in
            Task { @MainActor in
                self?.streamStateText = String(describing: state)
                self?.isStreaming = (state == .streaming)
                if state == .stopped {
                    self?.clearStreamResources()
                }
            }
        }.store(in: streamTokenBag)

        stream.videoFramePublisher.listen { [weak self] frame in
            guard let self else { return }
            guard let image = frame.makeUIImage() else { return }
            let width = Int(image.size.width * image.scale)
            let height = Int(image.size.height * image.scale)

            Task { @MainActor in
                self.framesReceived &+= 1
                self.previewImage = image

                let now = Date()
                if let last = self.lastRelayDate, now.timeIntervalSince(last) < self.relayInterval {
                    return
                }
                self.lastRelayDate = now
                self.onFrame?(image, width, height)
            }
        }.store(in: streamTokenBag)

        stream.errorPublisher.listen { [weak self] error in
            Task { @MainActor in
                self?.lastError = error.localizedDescription
                AppLog.warn("Stream error: \(error.localizedDescription)")
            }
        }.store(in: streamTokenBag)
    }

    private func clearStreamResources() {
        streamTokenBag.clear()
        camera?.stop()
        camera = nil
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
