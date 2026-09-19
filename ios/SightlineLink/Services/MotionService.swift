import CoreMotion
import Foundation

@MainActor
final class MotionService: ObservableObject {
    @Published private(set) var isAvailable = false
    @Published private(set) var isRunning = false
    @Published private(set) var updateRateHz: Double = 0
    @Published private(set) var lastError: String?

    private let manager = CMMotionManager()
    private let opQueue = OperationQueue()
    private var onSample: ((MotionSample) -> Void)?
    private var transmitInterval: TimeInterval = 1.0 / 20.0
    private var lastTransmitDate: Date?
    private var sampleWindow: [Date] = []
    private var uiPublishCounter = 0

    init() {
        opQueue.name = "com.sightline.link.motion"
        opQueue.maxConcurrentOperationCount = 1
        isAvailable = manager.isDeviceMotionAvailable || manager.isAccelerometerAvailable
    }

    func setHandler(_ handler: @escaping (MotionSample) -> Void) {
        onSample = handler
    }

    func start(transmitHz: MotionTransmitHz) {
        stop()
        transmitInterval = 1.0 / Double(transmitHz.rawValue)
        lastTransmitDate = nil

        if manager.isDeviceMotionAvailable {
            manager.deviceMotionUpdateInterval = 1.0 / 30.0
            manager.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: opQueue) { [weak self] motion, error in
                guard let self else { return }
                if let error {
                    Task { @MainActor in
                        self.lastError = error.localizedDescription
                    }
                    return
                }
                guard let motion else { return }
                self.handleDeviceMotion(motion)
            }
            isRunning = true
            AppLog.info("MotionService started (deviceMotion @ 30Hz, transmit \(transmitHz.rawValue)Hz)")
            return
        }

        // Graceful fallback: accelerometer + gyro separately when fused motion is unavailable.
        if manager.isAccelerometerAvailable {
            manager.accelerometerUpdateInterval = 1.0 / 30.0
            manager.startAccelerometerUpdates(to: opQueue) { [weak self] data, _ in
                guard let self, let data else { return }
                self.handleFallback(
                    userAcceleration: data.acceleration,
                    rotation: nil,
                    attitude: nil,
                    gravity: nil
                )
            }
            isRunning = true
        }
        if manager.isGyroAvailable {
            manager.gyroUpdateInterval = 1.0 / 30.0
            manager.startGyroUpdates(to: opQueue) { [weak self] data, _ in
                guard let self, let data else { return }
                self.handleFallback(
                    userAcceleration: nil,
                    rotation: data.rotationRate,
                    attitude: nil,
                    gravity: nil
                )
            }
            isRunning = true
        }

        if !isRunning {
            lastError = "Motion sensors unavailable"
            AppLog.warn(lastError ?? "motion unavailable")
        }
    }

    func stop() {
        manager.stopDeviceMotionUpdates()
        manager.stopAccelerometerUpdates()
        manager.stopGyroUpdates()
        isRunning = false
        sampleWindow.removeAll()
    }

    private func handleDeviceMotion(_ motion: CMDeviceMotion) {
        let now = Date()
        if let last = lastTransmitDate, now.timeIntervalSince(last) < transmitInterval {
            return
        }
        lastTransmitDate = now

        let attitude = motion.attitude.quaternion
        let field = motion.magneticField
        let magnetic = Vector3(x: field.field.x, y: field.field.y, z: field.field.z)
        let accuracy = Int(field.accuracy.rawValue)

        let sample = MotionSample(
            timestampMs: Time.timestampMs(now),
            attitude: AttitudePayload(
                quaternion: Quaternion(x: attitude.x, y: attitude.y, z: attitude.z, w: attitude.w)
            ),
            rotationRateRadPerSec: Vector3(
                x: motion.rotationRate.x,
                y: motion.rotationRate.y,
                z: motion.rotationRate.z
            ),
            gravityG: Vector3(x: motion.gravity.x, y: motion.gravity.y, z: motion.gravity.z),
            userAccelerationG: Vector3(
                x: motion.userAcceleration.x,
                y: motion.userAcceleration.y,
                z: motion.userAcceleration.z
            ),
            magneticField: magnetic,
            magneticAccuracy: accuracy
        )

        onSample?(sample)
        noteRate(now)
    }

    private var fallbackAccel: CMAcceleration?
    private var fallbackRotation: CMRotationRate?

    private func handleFallback(
        userAcceleration: CMAcceleration?,
        rotation: CMRotationRate?,
        attitude: CMAttitude?,
        gravity: CMAcceleration?
    ) {
        if let userAcceleration { fallbackAccel = userAcceleration }
        if let rotation { fallbackRotation = rotation }

        let now = Date()
        if let last = lastTransmitDate, now.timeIntervalSince(last) < transmitInterval {
            return
        }
        lastTransmitDate = now

        let accel = fallbackAccel ?? .init(x: 0, y: 0, z: 0)
        let rot = fallbackRotation ?? .init(x: 0, y: 0, z: 0)
        let sample = MotionSample(
            timestampMs: Time.timestampMs(now),
            attitude: AttitudePayload(quaternion: Quaternion(x: 0, y: 0, z: 0, w: 1)),
            rotationRateRadPerSec: Vector3(x: rot.x, y: rot.y, z: rot.z),
            gravityG: Vector3(x: 0, y: 0, z: 0),
            userAccelerationG: Vector3(x: accel.x, y: accel.y, z: accel.z),
            magneticField: nil,
            magneticAccuracy: nil
        )
        onSample?(sample)
        noteRate(now)
    }

    private func noteRate(_ now: Date) {
        sampleWindow.append(now)
        sampleWindow.removeAll { now.timeIntervalSince($0) > 1.0 }
        uiPublishCounter += 1
        // Throttle UI publishes (~2 Hz) so SwiftUI isn't hammered at 20–30 Hz.
        if uiPublishCounter % 10 == 0 {
            Task { @MainActor in
                self.updateRateHz = Double(self.sampleWindow.count)
            }
        }
    }
}
