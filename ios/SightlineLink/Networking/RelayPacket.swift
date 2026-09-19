import Foundation

/// Envelope describing a binary media WebSocket message.
struct RelayPacket {
    var packetType: UInt8
    var timestampMs: UInt64
    var sequence: UInt32
    var metadataJSON: Data
    var payload: Data

    var encoded: Data {
        BinaryPacketEncoder.encode(
            packetType: packetType,
            timestampMs: timestampMs,
            sequence: sequence,
            metadataJSON: metadataJSON,
            payload: payload
        )
    }
}
