import AVFoundation
import Foundation

@MainActor
final class AudioCaptureService: ObservableObject {
    @Published private(set) var isRunning = false
    @Published private(set) var source: MediaSource = .none
    @Published private(set) var inputRouteDescription = "none"
    @Published private(set) var sampleRate: Double = 16_000
    @Published private(set) var chunksSent: UInt64 = 0
    @Published private(set) var lastError: String?
    @Published private(set) var permissionGranted = false

    private var engine: AVAudioEngine?
    private var converter: AVAudioConverter?
    private var onChunk: ((Data, AudioPacketMetadata, UInt64) -> Void)?
    private var onRouteChanged: ((MediaSource, String) -> Void)?
    private var routeObserver: NSObjectProtocol?
    private let targetSampleRate: Double = 16_000
    private let targetChannels: AVAudioChannelCount = 1

    func setHandlers(
        onChunk: @escaping (Data, AudioPacketMetadata, UInt64) -> Void,
        onRouteChanged: @escaping (MediaSource, String) -> Void
    ) {
        self.onChunk = onChunk
        self.onRouteChanged = onRouteChanged
    }

    func requestPermissionIfNeeded() async -> Bool {
        let permission = AVAudioApplication.shared.recordPermission
        switch permission {
        case .granted:
            permissionGranted = true
            return true
        case .denied:
            permissionGranted = false
            return false
        case .undetermined:
            let granted = await AVAudioApplication.requestRecordPermission()
            permissionGranted = granted
            return granted
        @unknown default:
            return false
        }
    }

    /// - Parameter preferBuiltInMic: when true, force the iPhone mic and do not select Bluetooth HFP.
    func start(sessionId: String, preferBuiltInMic: Bool = false) async {
        guard await requestPermissionIfNeeded() else {
            lastError = "Microphone permission denied"
            source = .none
            return
        }

        stop()

        do {
            let session = AVAudioSession.sharedInstance()
            var options: AVAudioSession.CategoryOptions = [.defaultToSpeaker, .mixWithOthers]
            if !preferBuiltInMic {
                options.insert(.allowBluetooth)
            }
            try session.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: options
            )
            try session.setActive(true, options: [])
            if preferBuiltInMic {
                preferBuiltInMicrophone(session)
            } else {
                preferBluetoothHFP(session)
            }
            refreshRoute(emitEvent: false)

            let engine = AVAudioEngine()
            let input = engine.inputNode
            let inputFormat = input.outputFormat(forBus: 0)

            guard let targetFormat = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: targetSampleRate,
                channels: targetChannels,
                interleaved: true
            ) else {
                lastError = "Failed to create PCM16 format"
                return
            }

            converter = AVAudioConverter(from: inputFormat, to: targetFormat)
            sampleRate = targetSampleRate

            let bufferSize: AVAudioFrameCount = 1024
            input.installTap(onBus: 0, bufferSize: bufferSize, format: inputFormat) { [weak self] buffer, _ in
                self?.handleInputBuffer(buffer, sessionId: sessionId, targetFormat: targetFormat)
            }

            try engine.start()
            self.engine = engine
            isRunning = true
            AppLog.info("Audio capture started route=\(inputRouteDescription) source=\(source.rawValue)")
        } catch {
            lastError = error.localizedDescription
            AppLog.error("Audio start failed: \(error.localizedDescription)")
        }

        routeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.refreshRoute(emitEvent: true)
            }
        }
    }

    func stop() {
        if let observer = routeObserver {
            NotificationCenter.default.removeObserver(observer)
            routeObserver = nil
        }
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        converter = nil
        isRunning = false
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    private func preferBluetoothHFP(_ session: AVAudioSession) {
        if let bluetooth = session.availableInputs?.first(where: {
            $0.portType == .bluetoothHFP || $0.portType == .bluetoothLE
        }) {
            do {
                try session.setPreferredInput(bluetooth)
                AppLog.info("Preferred audio input: \(bluetooth.portName)")
            } catch {
                AppLog.warn("Could not set preferred Bluetooth input: \(error.localizedDescription)")
            }
        }
    }

    private func preferBuiltInMicrophone(_ session: AVAudioSession) {
        if let builtIn = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
            do {
                try session.setPreferredInput(builtIn)
                AppLog.info("Preferred audio input: iPhone built-in mic (\(builtIn.portName))")
            } catch {
                AppLog.warn("Could not set preferred built-in mic: \(error.localizedDescription)")
            }
        } else {
            AppLog.warn("Built-in mic not listed in availableInputs; using system default")
        }
    }

    private func refreshRoute(emitEvent: Bool) {
        let session = AVAudioSession.sharedInstance()
        let inputs = session.currentRoute.inputs
        let description = inputs.map { "\($0.portName) (\($0.portType.rawValue))" }.joined(separator: ", ")
        inputRouteDescription = description.isEmpty ? "none" : description

        let previous = source
        source = classifySource(inputs: inputs)
        if emitEvent, previous != source {
            onRouteChanged?(source, inputRouteDescription)
        }
    }

    private func classifySource(inputs: [AVAudioSessionPortDescription]) -> MediaSource {
        guard let input = inputs.first else { return .systemDefault }
        switch input.portType {
        case .bluetoothHFP, .bluetoothLE:
            // Only claim Ray-Ban when the route name suggests Meta/Ray-Ban glasses.
            let name = input.portName.lowercased()
            if name.contains("ray-ban") || name.contains("rayban") || name.contains("meta") {
                return .raybanBluetooth
            }
            return .raybanBluetooth // Bluetooth HFP headset path used by Ray-Ban Meta
        case .builtInMic:
            return .iphone
        default:
            return .systemDefault
        }
    }

    nonisolated private func handleInputBuffer(
        _ buffer: AVAudioPCMBuffer,
        sessionId: String,
        targetFormat: AVAudioFormat
    ) {
        Task { @MainActor in
            guard let converter = self.converter else { return }
            let ratio = targetFormat.sampleRate / buffer.format.sampleRate
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
            guard let outBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }

            var error: NSError?
            let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
                outStatus.pointee = .haveData
                return buffer
            }
            converter.convert(to: outBuffer, error: &error, withInputFrom: inputBlock)
            if let error {
                AppLog.warn("Audio convert error: \(error.localizedDescription)")
                return
            }
            guard let channel = outBuffer.int16ChannelData?[0] else { return }
            let frameCount = Int(outBuffer.frameLength)
            let byteCount = frameCount * MemoryLayout<Int16>.size
            let data = Data(bytes: channel, count: byteCount)

            let metadata = AudioPacketMetadata(
                sessionId: sessionId,
                source: self.source.rawValue,
                sampleRate: Int(self.targetSampleRate),
                channels: Int(self.targetChannels),
                frameCount: frameCount
            )
            self.chunksSent &+= 1
            self.onChunk?(data, metadata, Time.timestampMs())
        }
    }
}
