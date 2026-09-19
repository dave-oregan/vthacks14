import Foundation
import Network

struct DiscoveredBackend: Identifiable, Equatable, Hashable {
    var id: String { "\(host):\(port)" }
    var name: String
    var host: String
    var port: Int
}

@MainActor
final class BackendDiscoveryService: ObservableObject {
    @Published private(set) var backends: [DiscoveredBackend] = []
    @Published private(set) var isBrowsing = false
    @Published private(set) var lastError: String?

    private var browser: NWBrowser?
    private let queue = DispatchQueue(label: "com.sightline.link.bonjour")

    func start() {
        stop()
        isBrowsing = true
        lastError = nil
        backends = []

        let descriptor = NWBrowser.Descriptor.bonjour(type: "_sightline._tcp", domain: "local.")
        let browser = NWBrowser(for: descriptor, using: .tcp)
        self.browser = browser

        browser.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                if case .failed(let error) = state {
                    self?.lastError = error.localizedDescription
                    AppLog.warn("Bonjour browser: \(error.localizedDescription)")
                }
            }
        }

        browser.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in
                await self?.resolve(results: Array(results))
            }
        }

        browser.start(queue: queue)
        AppLog.info("Bonjour browse started for _sightline._tcp")
    }

    func stop() {
        browser?.cancel()
        browser = nil
        isBrowsing = false
    }

    private func resolve(results: [NWBrowser.Result]) async {
        var found: [DiscoveredBackend] = []
        for result in results {
            if let backend = await resolveOne(result) {
                found.append(backend)
            }
        }
        var unique: [String: DiscoveredBackend] = [:]
        for item in found {
            unique[item.id] = item
        }
        backends = unique.values.sorted { $0.host < $1.host }
        if !backends.isEmpty {
            AppLog.info("Discovered Mission Control: \(backends.map(\.id).joined(separator: ", "))")
        }
    }

    private func resolveOne(_ result: NWBrowser.Result) async -> DiscoveredBackend? {
        let serviceName: String
        if case .service(let name, _, _, _) = result.endpoint {
            serviceName = name.isEmpty ? "SIGHTLINE Mission Control" : name
        } else {
            serviceName = "SIGHTLINE Mission Control"
        }

        return await withCheckedContinuation { continuation in
            // Resolve via the browser result endpoint directly.
            let connection = NWConnection(to: result.endpoint, using: .tcp)
            let lock = NSLock()
            var resumed = false
            func finish(_ value: DiscoveredBackend?) {
                lock.lock()
                defer { lock.unlock() }
                guard !resumed else { return }
                resumed = true
                connection.cancel()
                continuation.resume(returning: value)
            }

            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if case .hostPort(let host, let port) = connection.currentPath?.remoteEndpoint {
                        finish(
                            DiscoveredBackend(
                                name: serviceName,
                                host: stringify(host),
                                port: Int(port.rawValue)
                            )
                        )
                    } else {
                        finish(nil)
                    }
                case .failed, .cancelled:
                    finish(nil)
                default:
                    break
                }
            }

            connection.start(queue: queue)
            queue.asyncAfter(deadline: .now() + 2.5) {
                finish(nil)
            }
        }
    }
}

private func stringify(_ host: NWEndpoint.Host) -> String {
    switch host {
    case .ipv4(let addr):
        return String(describing: addr).components(separatedBy: "%").first ?? String(describing: addr)
    case .ipv6(let addr):
        return String(describing: addr).components(separatedBy: "%").first ?? String(describing: addr)
    case .name(let name, _):
        return name
    @unknown default:
        return "\(host)"
    }
}
