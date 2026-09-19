import Foundation

struct StreamConfigurationSettings: Equatable, Sendable {
    var backendHost: String
    var backendPort: Int
    var useSecureWebSocket: Bool
    var videoSourceMode: VideoSourceMode
    var audioInputMode: AudioInputMode
    var relayFPS: RelayFPS
    var jpegQuality: Double
    var motionTransmitHz: MotionTransmitHz
    var enableVideo: Bool
    var enableAudio: Bool
    var enableLocation: Bool
    var enableMotion: Bool
    var phoneFallbackEnabled: Bool

    static let `default` = StreamConfigurationSettings(
        backendHost: "192.168.1.100",
        backendPort: 8000,
        useSecureWebSocket: false,
        videoSourceMode: .auto,
        audioInputMode: .auto,
        relayFPS: .twelve,
        jpegQuality: 0.65,
        motionTransmitHz: .twenty,
        enableVideo: true,
        enableAudio: true,
        enableLocation: true,
        enableMotion: true,
        phoneFallbackEnabled: true
    )

    /// True when the operator explicitly chose phone camera + mic (no Meta required).
    var isIPhoneMediaMode: Bool {
        videoSourceMode == .iphone && audioInputMode == .iphone
    }

    var webSocketURL: URL? {
        RelayProtocol.makeRelayURL(host: backendHost, port: backendPort, secure: useSecureWebSocket)
    }

    var webSocketURLString: String {
        webSocketURL?.absoluteString ?? ""
    }
}

enum StreamConfigurationStore {
    private static let defaults = UserDefaults.standard
    private static let hostKey = "sightline.backend.host"
    private static let portKey = "sightline.backend.port"
    private static let secureKey = "sightline.backend.secure"
    private static let videoModeKey = "sightline.video.mode"
    private static let audioModeKey = "sightline.audio.mode"
    private static let fpsKey = "sightline.video.fps"
    private static let motionHzKey = "sightline.motion.hz"
    private static let phoneFallbackKey = "sightline.video.phoneFallback"
    private static let installIdKey = "sightline.install.id"

    static func load() -> StreamConfigurationSettings {
        var settings = StreamConfigurationSettings.default
        if let host = defaults.string(forKey: hostKey), !host.isEmpty {
            settings.backendHost = host
        }
        let port = defaults.integer(forKey: portKey)
        if port > 0 {
            settings.backendPort = port
        }
        if defaults.object(forKey: secureKey) != nil {
            settings.useSecureWebSocket = defaults.bool(forKey: secureKey)
        }
        if let mode = defaults.string(forKey: videoModeKey),
           let parsed = VideoSourceMode(rawValue: mode) {
            settings.videoSourceMode = parsed
        }
        if let audioMode = defaults.string(forKey: audioModeKey),
           let parsed = AudioInputMode(rawValue: audioMode) {
            settings.audioInputMode = parsed
        }
        let fps = defaults.integer(forKey: fpsKey)
        if let parsed = RelayFPS(rawValue: fps) {
            settings.relayFPS = parsed
        }
        let motionHz = defaults.integer(forKey: motionHzKey)
        if let parsed = MotionTransmitHz(rawValue: motionHz) {
            settings.motionTransmitHz = parsed
        }
        if defaults.object(forKey: phoneFallbackKey) != nil {
            settings.phoneFallbackEnabled = defaults.bool(forKey: phoneFallbackKey)
        }
        return settings
    }

    static func save(_ settings: StreamConfigurationSettings) {
        defaults.set(settings.backendHost, forKey: hostKey)
        defaults.set(settings.backendPort, forKey: portKey)
        defaults.set(settings.useSecureWebSocket, forKey: secureKey)
        defaults.set(settings.videoSourceMode.rawValue, forKey: videoModeKey)
        defaults.set(settings.audioInputMode.rawValue, forKey: audioModeKey)
        defaults.set(settings.relayFPS.rawValue, forKey: fpsKey)
        defaults.set(settings.motionTransmitHz.rawValue, forKey: motionHzKey)
        defaults.set(settings.phoneFallbackEnabled, forKey: phoneFallbackKey)
    }

    static func installId() -> String {
        if let existing = defaults.string(forKey: installIdKey), !existing.isEmpty {
            return existing
        }
        let id = UUID().uuidString
        defaults.set(id, forKey: installIdKey)
        return id
    }
}
