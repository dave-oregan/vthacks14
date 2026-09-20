import Foundation
import SwiftUI

@MainActor
final class AppState: ObservableObject {
    let coordinator: TelemetryCoordinator

    @Published var showDebug = false
    @Published var lastCopiedLog = false

    init() {
        self.coordinator = TelemetryCoordinator()
    }

    func bootstrap() {
        coordinator.bootstrap()
    }

    func handleOpenURL(_ url: URL) {
        // Pairing deep link from Mission Control QR:
        // sightlinelink://link?host=192.168.1.5&port=8000&autoStart=1
        if handlePairingURL(url) {
            return
        }
        Task {
            await coordinator.meta.handleCallbackURL(url)
        }
    }

    @discardableResult
    func handlePairingURL(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "sightlinelink" else { return false }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return false
        }

        // Accept sightlinelink://link?... or sightlinelink://...?host=...
        let hostComponent = (components.host ?? "").lowercased()
        let path = components.path.lowercased()
        let items = components.queryItems ?? []
        let hasHostParam = items.contains { $0.name == "host" && !($0.value ?? "").isEmpty }
        let looksLikePairing = hostComponent == "link" || path.contains("link") || hasHostParam
        guard looksLikePairing, hasHostParam else { return false }

        guard let host = items.first(where: { $0.name == "host" })?.value, !host.isEmpty else {
            return false
        }
        let port = Int(items.first(where: { $0.name == "port" })?.value ?? "8000") ?? 8000
        let autoStart = (items.first(where: { $0.name == "autoStart" })?.value ?? "1") != "0"
        coordinator.applyBackendLink(host: host, port: port, autoStart: autoStart)
        return true
    }

    var debugLogText: String {
        var lines: [String] = []
        let c = coordinator
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        lines.append("appVersion=\(version) (\(build))")
        lines.append("protocolVersion=\(RelayProtocol.version)")
        lines.append("sessionId=\(c.sessionId)")
        lines.append("backendURL=\(c.settings.webSocketURLString)")
        lines.append("socketState=\(c.backendState.rawValue)")
        lines.append("metaRegistration=\(c.meta.registrationState.rawValue)")
        lines.append("deviceSession=\(c.meta.sessionStateText)")
        lines.append("cameraState=\(c.meta.cameraStateText)")
        lines.append("streamState=\(c.meta.streamStateText)")
        lines.append("raybanFrames=\(c.meta.framesReceived)")
        lines.append("lastRayBanFrameAt=\(c.meta.lastFrameTimestamp.map { ISO8601DateFormatter().string(from: $0) } ?? "n/a")")
        lines.append("activeVideoSource=\(c.activeVideoSource.rawValue)")
        lines.append("framesReceived=\(c.videoStats.framesReceived)")
        lines.append("framesSent=\(c.videoStats.framesTransmitted)")
        lines.append("framesDropped=\(c.videoStats.framesDropped)")
        lines.append("outgoingVideoFPS=\(String(format: "%.1f", c.videoStats.outgoingFPS))")
        lines.append("audioRoute=\(c.audio.inputRouteDescription)")
        lines.append("audioSampleRate=\(c.audio.sampleRate)")
        lines.append("audioChunksSent=\(c.audio.chunksSent)")
        lines.append("locationAuth=\(String(describing: c.location.authorizationStatus.rawValue))")
        lines.append("gpsAccuracy=\(c.location.latestAccuracyMeters.map { String(format: "%.1f" , $0) } ?? "n/a")")
        lines.append("deviceMotionAvailable=\(c.motion.isAvailable)")
        lines.append("motionUpdateRate=\(String(format: "%.1f", c.motion.updateRateHz))")
        lines.append("networkPath=\(c.networkMonitor.interfaceType) connected=\(c.networkMonitor.isConnected)")
        lines.append("discovered=\(c.discovery.backends.map(\.id).joined(separator: ","))")
        lines.append("lastError=\(c.lastError ?? c.meta.lastError ?? "none")")
        lines.append("--- log ---")
        lines.append(AppLog.debugSnapshot())
        return lines.joined(separator: "\n")
    }
}
