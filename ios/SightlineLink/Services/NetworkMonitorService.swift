import Foundation
import Network

@MainActor
final class NetworkMonitorService: ObservableObject {
    @Published private(set) var isConnected = true
    @Published private(set) var interfaceType = "unknown"
    @Published private(set) var isExpensive = false
    @Published private(set) var isConstrained = false

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.sightline.link.network")

    func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in
                self?.apply(path)
            }
        }
        monitor.start(queue: queue)
    }

    func stop() {
        monitor.cancel()
    }

    private func apply(_ path: NWPath) {
        isConnected = path.status == .satisfied
        isExpensive = path.isExpensive
        isConstrained = path.isConstrained
        if path.usesInterfaceType(.wifi) {
            interfaceType = "wifi"
        } else if path.usesInterfaceType(.cellular) {
            interfaceType = "cellular"
        } else if path.usesInterfaceType(.wiredEthernet) {
            interfaceType = "ethernet"
        } else if path.status == .satisfied {
            interfaceType = "other"
        } else {
            interfaceType = "none"
        }
    }
}
