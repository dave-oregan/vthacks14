import SwiftUI

struct BackendConfigurationView: View {
    @EnvironmentObject private var coordinator: TelemetryCoordinator
    @State private var showManual = false

    var body: some View {
        GroupBox("Link Mission Control") {
            VStack(alignment: .leading, spacing: 12) {
                statusRow(
                    "Connection",
                    text: coordinator.backendState.rawValue.uppercased(),
                    tone: backendTone
                )
                HStack {
                    Text("Target")
                    Spacer()
                    Text(coordinator.settings.webSocketURLString.isEmpty
                         ? "—"
                         : coordinator.settings.webSocketURLString)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                }

                if coordinator.discovery.isBrowsing {
                    Text(coordinator.discovery.backends.isEmpty
                          ? "Searching for Mission Control on Wi‑Fi…"
                          : "Found \(coordinator.discovery.backends.count) computer(s)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                ForEach(coordinator.discovery.backends) { backend in
                    Button {
                        coordinator.linkToDiscovered(backend, autoStart: true)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(backend.name)
                                    .font(.subheadline.weight(.semibold))
                                Text("\(backend.host):\(backend.port)")
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(isCurrent(backend) ? "LINKED" : "LINK & START")
                                .font(.caption.monospaced())
                        }
                        .padding(.vertical, 4)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(isCurrent(backend) && coordinator.isRelaying ? .green : .accentColor)
                }

                HStack {
                    Button {
                        coordinator.discovery.start()
                    } label: {
                        Label(
                            coordinator.discovery.backends.isEmpty ? "Find Mission Control" : "Refresh",
                            systemImage: "wifi"
                        )
                    }
                    .buttonStyle(.bordered)

                    if coordinator.isRelaying {
                        Button("Stop Relay") {
                            Task { await coordinator.stopRelay() }
                        }
                        .buttonStyle(.bordered)
                    } else if !coordinator.settings.backendHost.isEmpty {
                        Button("Start Relay") {
                            Task { await coordinator.startRelay() }
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }

                DisclosureGroup("Manual IP (fallback)", isExpanded: $showManual) {
                    HStack {
                        Text("Host")
                        TextField("192.168.1.100", text: $coordinator.settings.backendHost)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.asciiCapable)
                            .multilineTextAlignment(.trailing)
                    }
                    HStack {
                        Text("Port")
                        TextField("8000", value: $coordinator.settings.backendPort, format: .number)
                            .keyboardType(.numberPad)
                            .multilineTextAlignment(.trailing)
                    }
                    Toggle("Secure (wss)", isOn: $coordinator.settings.useSecureWebSocket)

                    Button("Save & Start Relay") {
                        coordinator.saveSettings()
                        Task { await coordinator.startRelay() }
                    }
                    .buttonStyle(.borderedProminent)
                    .padding(.top, 4)
                }
                .font(.subheadline)

                Text("Tip: on the laptop, open Mission Control and scan the QR code.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .onAppear {
            if !coordinator.discovery.isBrowsing {
                coordinator.discovery.start()
            }
        }
        .onChange(of: coordinator.settings.backendHost) { _, _ in coordinator.saveSettings() }
        .onChange(of: coordinator.settings.backendPort) { _, _ in coordinator.saveSettings() }
        .onChange(of: coordinator.settings.useSecureWebSocket) { _, _ in coordinator.saveSettings() }
    }

    private func isCurrent(_ backend: DiscoveredBackend) -> Bool {
        coordinator.settings.backendHost == backend.host
            && coordinator.settings.backendPort == backend.port
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
