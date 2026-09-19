import AVFoundation
import Foundation
import UIKit

@MainActor
final class PhoneCameraService: NSObject, ObservableObject {
    @Published private(set) var isRunning = false
    @Published private(set) var previewImage: UIImage?
    @Published private(set) var lastError: String?
    @Published private(set) var permissionGranted = false

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "com.sightline.link.phone-camera")
    private var videoOutput: AVCaptureVideoDataOutput?
    private var onFrame: ((UIImage, Int, Int) -> Void)?
    private var lastEmitDate: Date?
    private var minInterval: TimeInterval = 1.0 / 12.0
    private var isConfigured = false

    func setFrameHandler(_ handler: @escaping (UIImage, Int, Int) -> Void) {
        onFrame = handler
    }

    func setRelayFPS(_ fps: RelayFPS) {
        minInterval = 1.0 / Double(fps.rawValue)
    }

    func requestPermissionIfNeeded() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            permissionGranted = true
            return true
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            permissionGranted = granted
            return granted
        default:
            permissionGranted = false
            return false
        }
    }

    func start(relayFPS: RelayFPS) async {
        setRelayFPS(relayFPS)
        guard await requestPermissionIfNeeded() else {
            lastError = "Phone camera permission denied"
            return
        }

        if isRunning { return }

        do {
            try await configureSessionIfNeeded()
            sessionQueue.async { [weak self] in
                self?.session.startRunning()
                Task { @MainActor in
                    self?.isRunning = true
                    AppLog.info("Phone camera fallback started")
                }
            }
        } catch {
            lastError = error.localizedDescription
            AppLog.error("Phone camera start failed: \(error.localizedDescription)")
        }
    }

    func stop() {
        sessionQueue.async { [weak self] in
            self?.session.stopRunning()
            Task { @MainActor in
                self?.isRunning = false
                self?.previewImage = nil
            }
        }
    }

    private func configureSessionIfNeeded() async throws {
        if isConfigured { return }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            sessionQueue.async { [weak self] in
                guard let self else {
                    continuation.resume()
                    return
                }
                do {
                    self.session.beginConfiguration()
                    self.session.sessionPreset = .medium

                    guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
                        throw PhoneCameraError.noDevice
                    }
                    let input = try AVCaptureDeviceInput(device: device)
                    if self.session.canAddInput(input) {
                        self.session.addInput(input)
                    }

                    let output = AVCaptureVideoDataOutput()
                    output.alwaysDiscardsLateVideoFrames = true
                    output.videoSettings = [
                        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
                    ]
                    output.setSampleBufferDelegate(self, queue: self.sessionQueue)
                    if self.session.canAddOutput(output) {
                        self.session.addOutput(output)
                    }
                    self.videoOutput = output
                    self.session.commitConfiguration()
                    self.isConfigured = true
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }
}

extension PhoneCameraService: AVCaptureVideoDataOutputSampleBufferDelegate {
    nonisolated func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let ciImage = CIImage(cvPixelBuffer: imageBuffer)
        let context = CIContext()
        guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else { return }
        let image = UIImage(cgImage: cgImage, scale: 1.0, orientation: .right)
        let width = cgImage.width
        let height = cgImage.height

        Task { @MainActor in
            let now = Date()
            if let last = lastEmitDate, now.timeIntervalSince(last) < minInterval {
                return
            }
            lastEmitDate = now
            previewImage = image
            onFrame?(image, width, height)
        }
    }
}

enum PhoneCameraError: Error {
    case noDevice
}
