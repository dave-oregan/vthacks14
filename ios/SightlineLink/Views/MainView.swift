import SwiftUI

struct MainView: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var coordinator: TelemetryCoordinator

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    if coordinator.isRelaying {
                        liveBanner
                    }
                    BackendConfigurationView()
                    mediaModePicker
                    ConnectionStatusView()
                    privacyToggles
                    SensorStatusView()
                    relayButton
                    VideoPreviewView(
                        image: coordinator.previewImage
                            ?? coordinator.meta.previewImage
                            ?? coordinator.phoneCamera.previewImage
                    )
                    DebugLogView()
                }
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("SIGHTLINE Link")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("SIGHTLINE LINK")
                .font(.system(.largeTitle, design: .monospaced).weight(.bold))
            Text("iPhone Sensor Gateway")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(coordinator.statusMessage)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
        }
    }

    private var liveBanner: some View {
        HStack {
            Circle()
                .fill(Color.red)
                .frame(width: 10, height: 10)
            Text("RELAY LIVE")
                .font(.headline.monospaced())
            Spacer()
            Text(coordinator.activeVideoSource.rawValue.uppercased())
                .font(.caption.monospaced())
        }
        .padding(12)
        .background(Color.red.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var mediaModePicker: some View {
        GroupBox("Media Mode") {
            VStack(alignment: .leading, spacing: 10) {
                Text(coordinator.settings.isIPhoneMediaMode
                      ? "Running without Ray-Ban: iPhone camera + mic."
                      : "Prefer Ray-Ban when available; iPhone is the fallback.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                HStack(spacing: 8) {
                    Button {
                        coordinator.enableIPhoneCameraAndMicMode()
                        if coordinator.isRelaying {
                            Task {
                                await coordinator.switchToIPhoneMediaFallback(reason: "user_selected_iphone_mode")
                            }
                        }
                    } label: {
                        Text("iPhone Camera + Mic")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(coordinator.settings.isIPhoneMediaMode ? .accentColor : .secondary)

                    Button {
                        coordinator.enableAutoRayBanMode()
                    } label: {
                        Text("Auto / Ray-Ban")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }

                if coordinator.isRelaying, coordinator.activeVideoSource != .iphone {
                    Button("Switch to iPhone fallback now") {
                        Task {
                            await coordinator.switchToIPhoneMediaFallback(reason: "user_manual_fallback")
                        }
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
    }

    private var privacyToggles: some View {
        GroupBox("Streams") {
            Toggle("Video", isOn: $coordinator.settings.enableVideo)
            Toggle("Audio", isOn: $coordinator.settings.enableAudio)
            Toggle("Location", isOn: $coordinator.settings.enableLocation)
            Toggle("Motion", isOn: $coordinator.settings.enableMotion)

            Picker("Video Source", selection: $coordinator.settings.videoSourceMode) {
                ForEach(VideoSourceMode.allCases) { mode in
                    Text(mode.displayName).tag(mode)
                }
            }
            .onChange(of: coordinator.settings.videoSourceMode) { _, mode in
                if mode == .iphone {
                    coordinator.settings.audioInputMode = .iphone
                }
                coordinator.saveSettings()
            }

            Picker("Audio Input", selection: $coordinator.settings.audioInputMode) {
                ForEach(AudioInputMode.allCases) { mode in
                    Text(mode.displayName).tag(mode)
                }
            }
            .onChange(of: coordinator.settings.audioInputMode) { _, _ in
                coordinator.saveSettings()
            }

            Toggle("Allow iPhone fallback (Auto)", isOn: $coordinator.settings.phoneFallbackEnabled)
                .onChange(of: coordinator.settings.phoneFallbackEnabled) { _, _ in
                    coordinator.saveSettings()
                }

            Picker("Relay FPS", selection: $coordinator.settings.relayFPS) {
                ForEach(RelayFPS.allCases) { fps in
                    Text("\(fps.rawValue)").tag(fps)
                }
            }
            Picker("Motion Hz", selection: $coordinator.settings.motionTransmitHz) {
                ForEach(MotionTransmitHz.allCases) { hz in
                    Text("\(hz.rawValue)").tag(hz)
                }
            }
        }
    }

    private var relayButton: some View {
        Button {
            Task {
                if coordinator.isRelaying {
                    await coordinator.stopRelay()
                } else {
                    await coordinator.startRelay()
                }
            }
        } label: {
            Text(coordinator.isRelaying ? "STOP SIGHTLINE RELAY" : "START SIGHTLINE RELAY")
                .font(.headline.monospaced())
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
        }
        .buttonStyle(.borderedProminent)
        .tint(coordinator.isRelaying ? .red : .accentColor)
    }
}
