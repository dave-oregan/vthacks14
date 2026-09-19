import SwiftUI

struct ConnectionStatusView: View {
    @EnvironmentObject private var coordinator: TelemetryCoordinator

    var body: some View {
        GroupBox("Meta Wearables") {
            statusRow("Registration", text: coordinator.meta.registrationState.rawValue.uppercased(), tone: registrationTone)
            statusRow("Glasses", text: coordinator.meta.hasActiveDevice ? "CONNECTED" : "WAITING", tone: coordinator.meta.hasActiveDevice ? .green : .yellow)
            statusRow("Camera Permission", text: coordinator.meta.cameraPermissionGranted ? "GRANTED" : "NEEDED", tone: coordinator.meta.cameraPermissionGranted ? .green : .yellow)
            statusRow("Video", text: coordinator.meta.isStreaming ? "STREAMING" : coordinator.meta.streamStateText.uppercased(), tone: coordinator.meta.isStreaming ? .green : .gray)
            statusRow("Source", text: videoSourceLabel, tone: .gray)

            if coordinator.settings.isIPhoneMediaMode {
                Text("iPhone camera + mic mode — Meta registration not required.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if coordinator.meta.registrationState != .registered {
                Text("Meta registration required for Ray-Ban video. Or use iPhone Camera + Mic.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("REGISTER WITH META AI") {
                    Task { await coordinator.meta.startRegistration() }
                }
                .buttonStyle(.borderedProminent)
            } else {
                Label("Registered", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.subheadline)
            }

            if !coordinator.settings.isIPhoneMediaMode,
               coordinator.meta.registrationState == .registered,
               !coordinator.meta.cameraPermissionGranted {
                Button("REQUEST CAMERA ACCESS") {
                    Task { _ = await coordinator.meta.requestCameraPermission() }
                }
                .buttonStyle(.bordered)
            }

            if !coordinator.settings.isIPhoneMediaMode,
               coordinator.meta.registrationState == .registered,
               !coordinator.meta.hasActiveDevice {
                Text("Waiting for Ray-Ban Meta… (Auto will fall back to iPhone if enabled)")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
    }

    private var videoSourceLabel: String {
        switch coordinator.activeVideoSource {
        case .rayban: return "RAY-BAN"
        case .iphone: return "IPHONE"
        default: return "NONE"
        }
    }

    private var registrationTone: StatusTone {
        switch coordinator.meta.registrationState {
        case .registered: return .green
        case .registering, .available: return .yellow
        case .error: return .red
        case .unavailable: return .gray
        }
    }
}

enum StatusTone {
    case green, yellow, red, gray

    var color: Color {
        switch self {
        case .green: return .green
        case .yellow: return .yellow
        case .red: return .red
        case .gray: return .gray
        }
    }
}

func statusRow(_ title: String, text: String, tone: StatusTone) -> some View {
    HStack {
        Text(title)
        Spacer()
        Circle().fill(tone.color).frame(width: 8, height: 8)
        Text(text)
            .font(.caption.monospaced())
    }
}
