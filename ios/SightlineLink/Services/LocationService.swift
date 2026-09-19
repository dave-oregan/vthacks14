import CoreLocation
import Foundation

@MainActor
final class LocationService: NSObject, ObservableObject {
    @Published private(set) var authorizationStatus: CLAuthorizationStatus = .notDetermined
    @Published private(set) var latestSample: LocationSample?
    @Published private(set) var latestAccuracyMeters: Double?
    @Published private(set) var isRunning = false
    @Published private(set) var lastError: String?

    private let manager = CLLocationManager()
    private var onSample: ((LocationSample) -> Void)?
    private var onDenied: (() -> Void)?
    private var latestHeading: CLHeading?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 1
        authorizationStatus = manager.authorizationStatus
    }

    func setHandlers(onSample: @escaping (LocationSample) -> Void, onDenied: @escaping () -> Void) {
        self.onSample = onSample
        self.onDenied = onDenied
    }

    func requestPermission() {
        manager.requestWhenInUseAuthorization()
    }

    func start() {
        authorizationStatus = manager.authorizationStatus
        switch authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            isRunning = true
            manager.startUpdatingLocation()
            if CLLocationManager.headingAvailable() {
                manager.startUpdatingHeading()
            }
        case .denied, .restricted:
            lastError = "Location permission denied"
            onDenied?()
        case .notDetermined:
            requestPermission()
        @unknown default:
            lastError = "Unknown location authorization"
        }
    }

    func stop() {
        isRunning = false
        manager.stopUpdatingLocation()
        manager.stopUpdatingHeading()
    }

    var isAuthorized: Bool {
        switch authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse: return true
        default: return false
        }
    }
}

extension LocationService: CLLocationManagerDelegate {
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            authorizationStatus = manager.authorizationStatus
            if authorizationStatus == .denied || authorizationStatus == .restricted {
                lastError = "Location permission denied"
                onDenied?()
            } else if isRunning == false,
                      authorizationStatus == .authorizedWhenInUse || authorizationStatus == .authorizedAlways {
                // Permission may arrive after Start Relay requested location.
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        Task { @MainActor in
            let sample = LocationSample(
                timestampMs: Time.timestampMs(location.timestamp),
                latitude: location.coordinate.latitude,
                longitude: location.coordinate.longitude,
                altitudeMeters: location.verticalAccuracy >= 0 ? location.altitude : nil,
                horizontalAccuracyMeters: location.horizontalAccuracy,
                verticalAccuracyMeters: location.verticalAccuracy >= 0 ? location.verticalAccuracy : nil,
                speedMetersPerSecond: location.speed >= 0 ? location.speed : nil,
                courseDegrees: location.course >= 0 ? location.course : nil,
                magneticHeadingDegrees: latestHeading?.magneticHeading,
                trueHeadingDegrees: latestHeading?.trueHeading,
                headingAccuracyDegrees: latestHeading.map { $0.headingAccuracy >= 0 ? $0.headingAccuracy : nil } ?? nil
            )
            latestSample = sample
            latestAccuracyMeters = location.horizontalAccuracy
            onSample?(sample)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        Task { @MainActor in
            latestHeading = newHeading
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            lastError = error.localizedDescription
            AppLog.warn("Location error: \(error.localizedDescription)")
        }
    }
}
