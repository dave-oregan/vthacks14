import Foundation

enum RelayProtocol {
    static let version = 1
    static let path = "/ws/relay"

    static let packetTypeJPEGVideo: UInt8 = 0x01
    static let packetTypePCM16Audio: UInt8 = 0x02

    static let headerSize = 17 // 1 + 8 + 4 + 4

    static func makeRelayURL(host: String, port: Int, secure: Bool) -> URL? {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, port > 0, port <= 65535 else { return nil }

        var components = URLComponents()
        components.scheme = secure ? "wss" : "ws"
        components.host = trimmed
        components.port = port
        components.path = path
        return components.url
    }

    static func validateBackend(host: String, port: Int) -> Result<URL, RelayURLError> {
        guard let url = makeRelayURL(host: host, port: port, secure: false)
                ?? makeRelayURL(host: host, port: port, secure: true) else {
            return .failure(.invalid)
        }
        // Prefer explicit construction for the validated insecure/local default path.
        if let ws = makeRelayURL(host: host, port: port, secure: false) {
            return .success(ws)
        }
        return .success(url)
    }
}

enum RelayURLError: Error, Equatable {
    case invalid
}
