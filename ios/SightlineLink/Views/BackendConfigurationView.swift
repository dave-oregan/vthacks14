import SwiftUI

struct BackendConfigurationView: View {
    @EnvironmentObject private var coordinator: TelemetryCoordinator

    var body: some View {
        GroupBox("Backend") {
            HStack {
                Text("Host")
                TextField("192.168.1.100", text: $coordinator.settings.backendHost)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
            }
            HStack {
                Text("Port")
                TextField("8000", value: $coordinator.settings.backendPort, format: .number)
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.trailing)
            }
            Toggle("Secure (wss)", isOn: $coordinator.settings.useSecureWebSocket)
            statusRow(
                "Connection",
                text: coordinator.backendState.rawValue.uppercased(),
                tone: backendTone
            )
            HStack {
                Text("Latency")
                Spacer()
                Text(coordinator.latencyMs.map { "\($0) ms" } ?? "—")
                    .font(.caption.monospaced())
            }
            Text(coordinator.settings.webSocketURLString)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)

            HStack {
                Button("Connect") {
                    Task { await coordinator.connectBackendOnly() }
                }
                Button("Disconnect") {
                    Task { await coordinator.disconnectBackendOnly() }
                }
                Button("Reconnect") {
                    Task {
                        await coordinator.disconnectBackendOnly()
                        await coordinator.connectBackendOnly()
                    }
                }
            }
            .buttonStyle(.bordered)
        }
        .onChange(of: coordinator.settings.backendHost) { _, _ in coordinator.saveSettings() }
        .onChange(of: coordinator.settings.backendPort) { _, _ in coordinator.saveSettings() }
        .onChange(of: coordinator.settings.useSecureWebSocket) { _, _ in coordinator.saveSettings() }
    }

    private var backendTone: StatusTone {
        switch coordinator.backendState {
        case .connected: return .green
        case .connecting, .reconnecting, .degraded: return .yellow
        case .failed: return .red
        case .disconnected: return .gray
        }
    }
}
