import Foundation

enum Time {
    /// Unix epoch milliseconds used by every outbound SIGHTLINE packet.
    static func timestampMs(_ date: Date = Date()) -> UInt64 {
        UInt64(date.timeIntervalSince1970 * 1000.0)
    }
}
