import SwiftUI

struct SensorStatusView: View {
    @EnvironmentObject private var coordinator: TelemetryCoordinator

    var body: some View {
        GroupBox("Sensor Relay") {
            statusRow(
                "Video",
                text: videoLine,
                tone: coordinator.activeVideoSource == .none ? .gray : .green
            )
            statusRow(
                "Audio",
                text: audioLine,
                tone: coordinator.audio.isRunning ? .green : .gray
            )
            statusRow(
                "GPS",
                text: gpsLine,
                tone: coordinator.location.isRunning ? .green : .gray
            )
            statusRow(
                "Motion",
                text: motionLine,
                tone: coordinator.motion.isRunning ? .green : .gray
            )

            Divider()
            labeled("VIDEO source", videoProvenance)
            labeled("AUDIO source", audioProvenance)
            labeled("LOCATION source", "iPhone")
            labeled("MOTION source", "iPhone")
        }
    }

    private var videoLine: String {
        let fps = String(format: "%.0f", coordinator.videoStats.outgoingFPS)
        return "\(fps) FPS · \(coordinator.activeVideoSource.rawValue)"
    }

    private var audioLine: String {
        switch coordinator.audio.source {
        case .raybanBluetooth: return "Ray-Ban Mic"
        case .iphone: return "iPhone Microphone"
        case .systemDefault: return "System Default"
        case .none: return "OFF"
        default: return coordinator.audio.source.rawValue
        }
    }

    private var gpsLine: String {
        if let accuracy = coordinator.location.latestAccuracyMeters {
            return String(format: "±%.0f m", accuracy)
        }
        return coordinator.location.isAuthorized ? "waiting" : "denied/unavailable"
    }

    private var motionLine: String {
        String(format: "%.0f Hz", coordinator.motion.updateRateHz)
    }

    private var videoProvenance: String {
        switch coordinator.activeVideoSource {
        case .rayban: return "Ray-Ban Meta"
        case .iphone: return "iPhone Camera Fallback"
        default: return "none"
        }
    }

    private var audioProvenance: String {
        switch coordinator.audio.source {
        case .raybanBluetooth: return "Ray-Ban Meta Bluetooth Mic"
        case .iphone: return "iPhone Microphone"
        case .systemDefault: return "System Default"
        default: return "none"
        }
    }

    private func labeled(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.caption2.monospaced())
        }
    }
}
