import Foundation

enum BinaryPacketEncoder {
    static func encode(
        packetType: UInt8,
        timestampMs: UInt64,
        sequence: UInt32,
        metadataJSON: Data,
        payload: Data
    ) -> Data {
        var packet = Data()
        packet.reserveCapacity(RelayProtocol.headerSize + metadataJSON.count + payload.count)
        packet.appendUInt8(packetType)
        packet.appendUInt64BE(timestampMs)
        packet.appendUInt32BE(sequence)
        packet.appendUInt32BE(UInt32(metadataJSON.count))
        packet.append(metadataJSON)
        packet.append(payload)
        return packet
    }

    static func encodeVideo(
        timestampMs: UInt64,
        sequence: UInt32,
        metadata: VideoPacketMetadata,
        jpeg: Data,
        encoder: JSONEncoder = JSONEncoder()
    ) throws -> Data {
        let metadataJSON = try encoder.encode(metadata)
        return encode(
            packetType: RelayProtocol.packetTypeJPEGVideo,
            timestampMs: timestampMs,
            sequence: sequence,
            metadataJSON: metadataJSON,
            payload: jpeg
        )
    }

    static func encodeAudio(
        timestampMs: UInt64,
        sequence: UInt32,
        metadata: AudioPacketMetadata,
        pcm: Data,
        encoder: JSONEncoder = JSONEncoder()
    ) throws -> Data {
        let metadataJSON = try encoder.encode(metadata)
        return encode(
            packetType: RelayProtocol.packetTypePCM16Audio,
            timestampMs: timestampMs,
            sequence: sequence,
            metadataJSON: metadataJSON,
            payload: pcm
        )
    }
}
