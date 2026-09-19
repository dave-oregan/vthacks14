import Foundation

actor WebSocketClient {
    enum Event: Sendable {
        case connected
        case disconnected(String?)
        case text(String)
        case failed(String)
    }

    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var receiveLoopTask: Task<Void, Never>?
    private var connectTask: Task<Void, Never>?
    private var eventContinuation: AsyncStream<Event>.Continuation?
    private var connectionGeneration = 0
    private(set) var isConnected = false
    private(set) var currentURL: URL?

    func events() -> AsyncStream<Event> {
        AsyncStream { continuation in
            self.eventContinuation = continuation
        }
    }

    func connect(url: URL) {
        connectionGeneration &+= 1
        let generation = connectionGeneration
        connectTask?.cancel()
        disconnect(reason: "reconnect", emitEvent: isConnected)

        currentURL = url
        isConnected = false
        AppLog.info("WebSocket connecting to \(url.absoluteString)")

        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 30
        let session = URLSession(configuration: config)
        self.session = session
        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        startReceiveLoop(task, generation: generation)

        // Confirm the socket is actually open before advertising connected.
        connectTask = Task {
            do {
                try await task.sendPing()
                guard !Task.isCancelled, generation == self.connectionGeneration else { return }
                self.isConnected = true
                self.eventContinuation?.yield(.connected)
                AppLog.info("WebSocket connected to \(url.absoluteString)")
            } catch {
                guard !Task.isCancelled, generation == self.connectionGeneration else { return }
                self.isConnected = false
                let message = error.localizedDescription
                AppLog.error("WebSocket connect failed: \(message)")
                self.eventContinuation?.yield(.failed(message))
                self.eventContinuation?.yield(.disconnected(message))
            }
        }
    }

    func disconnect(reason: String? = nil) {
        disconnect(reason: reason, emitEvent: true)
    }

    private func disconnect(reason: String?, emitEvent: Bool) {
        connectTask?.cancel()
        connectTask = nil
        receiveLoopTask?.cancel()
        receiveLoopTask = nil
        let wasConnected = isConnected
        task?.cancel(with: .goingAway, reason: reason?.data(using: .utf8))
        task = nil
        session?.invalidateAndCancel()
        session = nil
        isConnected = false
        currentURL = nil
        if emitEvent, wasConnected {
            eventContinuation?.yield(.disconnected(reason))
        }
    }

    func sendText(_ text: String) async throws {
        guard let task, isConnected else { throw WebSocketError.notConnected }
        try await task.send(.string(text))
    }

    func sendBinary(_ data: Data) async throws {
        guard let task, isConnected else { throw WebSocketError.notConnected }
        try await task.send(.data(data))
    }

    func sendCodable<T: Encodable>(_ value: T, encoder: JSONEncoder = JSONEncoder()) async throws {
        let data = try encoder.encode(value)
        guard let text = String(data: data, encoding: .utf8) else {
            throw WebSocketError.encodingFailed
        }
        try await sendText(text)
    }

    private func startReceiveLoop(_ task: URLSessionWebSocketTask, generation: Int) {
        receiveLoopTask = Task {
            while !Task.isCancelled {
                do {
                    let message = try await task.receive()
                    guard generation == self.connectionGeneration else { break }
                    switch message {
                    case .string(let text):
                        eventContinuation?.yield(.text(text))
                    case .data:
                        break
                    @unknown default:
                        break
                    }
                } catch {
                    guard !Task.isCancelled, generation == self.connectionGeneration else { break }
                    isConnected = false
                    eventContinuation?.yield(.failed(error.localizedDescription))
                    eventContinuation?.yield(.disconnected(error.localizedDescription))
                    break
                }
            }
        }
    }
}

enum WebSocketError: Error {
    case notConnected
    case encodingFailed
}

private extension URLSessionWebSocketTask {
    func sendPing() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            self.sendPing { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }
}
