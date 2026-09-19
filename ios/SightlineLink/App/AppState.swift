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
        Task {
            await coordinator.meta.handleCallbackURL(url)
        }
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
        lines.append("streamState=\(c.meta.streamStateText)")
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
        lines.append("lastError=\(c.lastError ?? c.meta.lastError ?? "none")")
        lines.append("--- log ---")
        lines.append(AppLog.debugSnapshot())
        return lines.joined(separator: "\n")
    }
}
