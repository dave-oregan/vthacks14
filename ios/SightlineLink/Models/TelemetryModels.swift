import Foundation

struct RelayCapabilities: Codable, Equatable, Sendable {
    var raybanCamera: Bool
    var phoneCamera: Bool
    var audio: Bool
    var location: Bool
    var motion: Bool
    var heading: Bool
}

struct ActiveSources: Codable, Equatable, Sendable {
    var video: String
    var audio: String
    var location: String
    var motion: String
}

struct AppIdentity: Codable, Equatable, Sendable {
    var name: String
    var version: String
    var build: String
}

struct PlatformIdentity: Codable, Equatable, Sendable {
    var os: String
    var osVersion: String
}

struct HelloMessage: Codable, Equatable, Sendable {
    var type: String = "hello"
    var protocolVersion: Int = RelayProtocol.version
    var sessionId: String
    var timestampMs: UInt64
    var app: AppIdentity
    var platform: PlatformIdentity
    var capabilities: RelayCapabilities
    var activeSources: ActiveSources
}

struct MotionMessage: Codable, Equatable, Sendable {
    var type: String = "motion"
    var protocolVersion: Int = RelayProtocol.version
    var sessionId: String
    var sequence: UInt32
    var timestampMs: UInt64
    var source: String
    var attitude: AttitudePayload
    var rotationRateRadPerSec: Vector3
    var gravityG: Vector3
    var userAccelerationG: Vector3
    var magneticField: Vector3?
    var magneticAccuracy: Int?
}

struct LocationMessage: Codable, Equatable, Sendable {
    var type: String = "location"
    var protocolVersion: Int = RelayProtocol.version
    var sessionId: String
    var sequence: UInt32
    var timestampMs: UInt64
    var source: String
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

struct StreamEventMessage: Codable, Equatable, Sendable {
    var type: String = "stream_event"
    var event: String
    var timestampMs: UInt64
    var sessionId: String?
    var source: String?
    var from: String?
    var to: String?
    var reason: String?
    var protocolVersion: Int = RelayProtocol.version
}

struct HealthMessage: Codable, Equatable, Sendable {
    var type: String = "health"
    var protocolVersion: Int = RelayProtocol.version
    var sessionId: String
    var timestampMs: UInt64
    var backendState: String
    var videoSource: String
    var audioSource: String
    var framesSent: UInt64
    var framesDropped: UInt64
    var audioChunksSent: UInt64
    var latencyMs: Int?
}

struct PingMessage: Codable, Equatable, Sendable {
    var type: String
    var timestampMs: UInt64
}

struct PongMessage: Codable, Equatable, Sendable {
    var type: String = "pong"
    var timestampMs: UInt64
    var receivedTimestampMs: UInt64
}

struct VideoPacketMetadata: Codable, Equatable, Sendable {
    var protocolVersion: Int = RelayProtocol.version
    var sessionId: String
    var mediaType: String = "video"
    var encoding: String = "jpeg"
    var source: String
    var width: Int
    var height: Int
    var quality: Double
}

struct AudioPacketMetadata: Codable, Equatable, Sendable {
    var protocolVersion: Int = RelayProtocol.version
    var sessionId: String
    var mediaType: String = "audio"
    var encoding: String = "pcm_s16le"
    var source: String
    var sampleRate: Int
    var channels: Int
    var frameCount: Int
}

struct VideoStats: Equatable, Sendable {
    var framesReceived: UInt64 = 0
    var framesEncoded: UInt64 = 0
    var framesTransmitted: UInt64 = 0
    var framesDropped: UInt64 = 0
    var outgoingFPS: Double = 0
    var bytesPerSecond: Double = 0
}
