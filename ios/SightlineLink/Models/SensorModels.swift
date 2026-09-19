import Foundation

struct Vector3: Codable, Equatable, Sendable {
    var x: Double
    var y: Double
    var z: Double
}

struct Quaternion: Codable, Equatable, Sendable {
    var x: Double
    var y: Double
    var z: Double
    var w: Double
}

struct AttitudePayload: Codable, Equatable, Sendable {
    var quaternion: Quaternion
}

struct MotionSample: Equatable, Sendable {
    var timestampMs: UInt64
    var attitude: AttitudePayload
    var rotationRateRadPerSec: Vector3
    var gravityG: Vector3
    var userAccelerationG: Vector3
    var magneticField: Vector3?
    var magneticAccuracy: Int?
}

struct LocationSample: Equatable, Sendable {
    var timestampMs: UInt64
    var latitude: Double
    var longitude: Double
    var altitudeMeters: Double?
    var horizontalAccuracyMeters: Double
    var verticalAccuracyMeters: Double?
    var speedMetersPerSecond: Double?
    var courseDegrees: Double?
    var magneticHeadingDegrees: Double?
    var trueHeadingDegrees: Double?
    var headingAccuracyDegrees: Double?
}

struct DeviceContextSnapshot: Equatable, Sendable {
    var batteryLevel: Float?
    var batteryState: String
    var networkConnected: Bool
    var networkInterface: String
    var networkExpensive: Bool
    var networkConstrained: Bool
    var appVersion: String
    var buildNumber: String
    var osVersion: String
    var installId: String
}
