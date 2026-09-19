import Foundation
import os

enum AppLog {
    private static let logger = Logger(subsystem: "com.sightline.link", category: "gateway")
    private static let lock = NSLock()
    private static var entries: [String] = []
    private static let maxEntries = 500

    static func info(_ message: String) {
        logger.info("\(message, privacy: .public)")
        append("INFO  \(message)")
    }

    static func warn(_ message: String) {
        logger.warning("\(message, privacy: .public)")
        append("WARN  \(message)")
    }

    static func error(_ message: String) {
        logger.error("\(message, privacy: .public)")
        append("ERROR \(message)")
    }

    static func debugSnapshot() -> String {
        lock.lock()
        defer { lock.unlock() }
        return entries.joined(separator: "\n")
    }

    static func clear() {
        lock.lock()
        defer { lock.unlock() }
        entries.removeAll(keepingCapacity: true)
    }

    private static func append(_ line: String) {
        let stamped = "\(ISO8601DateFormatter().string(from: Date())) \(line)"
        lock.lock()
        entries.append(stamped)
        if entries.count > maxEntries {
            entries.removeFirst(entries.count - maxEntries)
        }
        lock.unlock()
    }
}
