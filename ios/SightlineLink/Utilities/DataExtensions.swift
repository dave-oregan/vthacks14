import Foundation

extension Data {
    mutating func appendUInt8(_ value: UInt8) {
        append(value)
    }

    mutating func appendUInt32BE(_ value: UInt32) {
        var be = value.bigEndian
        append(Data(bytes: &be, count: MemoryLayout<UInt32>.size))
    }

    mutating func appendUInt64BE(_ value: UInt64) {
        var be = value.bigEndian
        append(Data(bytes: &be, count: MemoryLayout<UInt64>.size))
    }
}
