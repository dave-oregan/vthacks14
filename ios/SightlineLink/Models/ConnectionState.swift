import Foundation

enum BackendConnectionState: String, Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case reconnecting
    case degraded
    case failed
}

enum MetaRegistrationUIState: String, Equatable, Sendable {
    case unavailable
    case available
    case registering
    case registered
    case error
}

enum VideoSourceMode: String, CaseIterable, Identifiable, Codable, Sendable {
    case auto
    case rayban
    case iphone

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .auto: return "Auto"
        case .rayban: return "Ray-Ban"
        case .iphone: return "iPhone"
        }
    }
}

enum AudioInputMode: String, CaseIterable, Identifiable, Codable, Sendable {
    /// Prefer Ray-Ban / Bluetooth HFP when available; otherwise iPhone mic.
    case auto
    /// Always use the iPhone built-in microphone.
    case iphone

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .auto: return "Auto (prefer Ray-Ban)"
        case .iphone: return "iPhone Mic"
        }
    }
}

enum MediaSource: String, Codable, Sendable {
    case rayban
    case raybanBluetooth = "rayban_bluetooth"
    case iphone
    case systemDefault = "system_default"
    case none
}

enum RelayFPS: Int, CaseIterable, Identifiable, Sendable {
    case five = 5
    case eight = 8
    case ten = 10
    case twelve = 12
    case fifteen = 15
    case twentyFour = 24

    var id: Int { rawValue }
}

enum MotionTransmitHz: Int, CaseIterable, Identifiable, Sendable {
    case ten = 10
    case fifteen = 15
    case twenty = 20
    case thirty = 30

    var id: Int { rawValue }
}
