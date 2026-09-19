import XCTest

final class BinaryPacketEncoderTests: XCTestCase {
    func testBigEndianIntegerEncoding() {
        var data = Data()
        data.appendUInt8(0x01)
        data.appendUInt64BE(0x0102030405060708)
        data.appendUInt32BE(0x0A0B0C0D)
        data.appendUInt32BE(5)

        XCTAssertEqual(data[0], 0x01)
        XCTAssertEqual(Array(data[1...8]), [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])
        XCTAssertEqual(Array(data[9...12]), [0x0A, 0x0B, 0x0C, 0x0D])
        XCTAssertEqual(Array(data[13...16]), [0x00, 0x00, 0x00, 0x05])
    }

    func testVideoPacketTypeAndMetadataLength() throws {
        let metadata = VideoPacketMetadata(
            sessionId: "session-1",
            source: "rayban",
            width: 640,
            height: 480,
            quality: 0.65
        )
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xD9])
        let packet = try BinaryPacketEncoder.encodeVideo(
            timestampMs: 1_700_000_000_000,
            sequence: 42,
            metadata: metadata,
            jpeg: jpeg
        )

        XCTAssertEqual(packet[0], RelayProtocol.packetTypeJPEGVideo)
        let metaLen = UInt32(packet[13]) << 24
            | UInt32(packet[14]) << 16
            | UInt32(packet[15]) << 8
            | UInt32(packet[16])
        let metadataJSON = packet.subdata(in: 17..<(17 + Int(metaLen)))
        let payload = packet.subdata(in: (17 + Int(metaLen))..<packet.count)
        XCTAssertEqual(payload, jpeg)

        let decoded = try JSONDecoder().decode(VideoPacketMetadata.self, from: metadataJSON)
        XCTAssertEqual(decoded.sessionId, "session-1")
        XCTAssertEqual(decoded.source, "rayban")
        XCTAssertEqual(decoded.width, 640)
        XCTAssertEqual(decoded.height, 480)
        XCTAssertEqual(decoded.encoding, "jpeg")
    }

    func testAudioPacketTypeAndSequence() throws {
        let metadata = AudioPacketMetadata(
            sessionId: "session-2",
            source: "iphone",
            sampleRate: 16000,
            channels: 1,
            frameCount: 320
        )
        let pcm = Data(repeating: 0x11, count: 640)
        let packet = try BinaryPacketEncoder.encodeAudio(
            timestampMs: 123,
            sequence: 7,
            metadata: metadata,
            pcm: pcm
        )

        XCTAssertEqual(packet[0], RelayProtocol.packetTypePCM16Audio)
        let sequence = UInt32(packet[9]) << 24
            | UInt32(packet[10]) << 16
            | UInt32(packet[11]) << 8
            | UInt32(packet[12])
        XCTAssertEqual(sequence, 7)

        let metaLen = UInt32(packet[13]) << 24
            | UInt32(packet[14]) << 16
            | UInt32(packet[15]) << 8
            | UInt32(packet[16])
        let metadataJSON = packet.subdata(in: 17..<(17 + Int(metaLen)))
        let decoded = try JSONDecoder().decode(AudioPacketMetadata.self, from: metadataJSON)
        XCTAssertEqual(decoded.frameCount, 320)
        XCTAssertEqual(decoded.encoding, "pcm_s16le")
        XCTAssertEqual(packet.count, RelayProtocol.headerSize + Int(metaLen) + pcm.count)
    }
}

final class TelemetryJSONTests: XCTestCase {
    func testMotionJSONIncludesSessionAndSequence() throws {
        let message = MotionMessage(
            sessionId: "abc",
            sequence: 572,
            timestampMs: 1_789_840_000_123,
            source: "iphone",
            attitude: AttitudePayload(quaternion: Quaternion(x: 0.01, y: -0.11, z: 0.02, w: 0.99)),
            rotationRateRadPerSec: Vector3(x: 0.1, y: -0.2, z: 0.05),
            gravityG: Vector3(x: 0, y: -0.98, z: -0.18),
            userAccelerationG: Vector3(x: 0.03, y: 0.01, z: -0.08)
        )
        let data = try JSONEncoder().encode(message)
        let object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(object["type"] as? String, "motion")
        XCTAssertEqual(object["sessionId"] as? String, "abc")
        XCTAssertEqual(object["sequence"] as? Int, 572)
        XCTAssertEqual(object["source"] as? String, "iphone")
    }

    func testLocationJSONIncludesSession() throws {
        let message = LocationMessage(
            sessionId: "loc-1",
            sequence: 84,
            timestampMs: 100,
            source: "iphone",
            latitude: 37.0,
            longitude: -80.0,
            altitudeMeters: 620.2,
            horizontalAccuracyMeters: 5.1,
            verticalAccuracyMeters: 7.8,
            speedMetersPerSecond: 1.3,
            courseDegrees: 181.4
        )
        let data = try JSONEncoder().encode(message)
        let object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(object["type"] as? String, "location")
        XCTAssertEqual(object["sessionId"] as? String, "loc-1")
        XCTAssertEqual(object["latitude"] as? Double, 37.0)
    }

    func testHelloIncludesCapabilities() throws {
        let hello = HelloMessage(
            sessionId: "s1",
            timestampMs: Time.timestampMs(),
            app: AppIdentity(name: "SIGHTLINE Link", version: "1.0.0", build: "1"),
            platform: PlatformIdentity(os: "iOS", osVersion: "18.0"),
            capabilities: RelayCapabilities(
                raybanCamera: true,
                phoneCamera: true,
                audio: true,
                location: true,
                motion: true,
                heading: true
            ),
            activeSources: ActiveSources(
                video: "rayban",
                audio: "iphone",
                location: "iphone",
                motion: "iphone"
            )
        )
        let data = try JSONEncoder().encode(hello)
        let object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(object["type"] as? String, "hello")
        XCTAssertEqual(object["protocolVersion"] as? Int, 1)
        XCTAssertNotNil(object["capabilities"])
    }
}

final class RelayURLTests: XCTestCase {
    func testValidURL() {
        let result = RelayProtocol.validateBackend(host: "192.168.1.123", port: 8000)
        guard case .success(let url) = result else {
            return XCTFail("expected success")
        }
        XCTAssertEqual(url.absoluteString, "ws://192.168.1.123:8000/ws/relay")
    }

    func testInvalidBackendURL() {
        XCTAssertEqual(RelayProtocol.validateBackend(host: "", port: 8000), .failure(.invalid))
        XCTAssertEqual(RelayProtocol.validateBackend(host: "192.168.1.1", port: 0), .failure(.invalid))
        XCTAssertEqual(RelayProtocol.validateBackend(host: "192.168.1.1", port: 70000), .failure(.invalid))
        XCTAssertNil(RelayProtocol.makeRelayURL(host: "   ", port: 8000, secure: false))
    }
}
