import SwiftUI
import UIKit

struct DebugLogView: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var coordinator: TelemetryCoordinator
    @State private var expanded = false

    var body: some View {
        GroupBox {
            DisclosureGroup("Debug / Diagnostics", isExpanded: $expanded) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(appState.debugLogText)
                        .font(.system(.caption2, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    Button("COPY DEBUG LOG") {
                        UIPasteboard.general.string = appState.debugLogText
                        appState.lastCopiedLog = true
                    }
                    .buttonStyle(.bordered)

                    #if DEBUG
                    Button("Enable MockDeviceKit") {
                        coordinator.meta.startMockDeviceKit()
                    }
                    .buttonStyle(.bordered)
                    #endif
                }
            }
        }
    }
}
