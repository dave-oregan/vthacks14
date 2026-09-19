import SwiftUI

@main
@MainActor
struct SightlineLinkApp: App {
    @StateObject private var appState = AppState()

    init() {
        // Meta SDK configuration happens in AppState.bootstrap / MetaWearablesService
        // so configure failures update visible app state instead of crashing launch.
    }

    var body: some Scene {
        WindowGroup {
            MainView()
                .environmentObject(appState)
                .environmentObject(appState.coordinator)
                .onAppear {
                    appState.bootstrap()
                }
                .onOpenURL { url in
                    appState.handleOpenURL(url)
                }
        }
    }
}
