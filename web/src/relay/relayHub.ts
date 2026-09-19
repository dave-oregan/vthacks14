import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import {
  PACKET_JPEG,
  PACKET_PCM16,
  encodePong,
  nowMs,
  parseBinaryPacket,
} from "./binaryPacket.js";
import type { GeoPoint, SessionSnapshot } from "../shared/types.js";

export interface RelayVideoFrame {
  sessionId: string;
  timestampMs: number;
  sequence: number;
  source: string;
  width: number;
  height: number;
  quality: number;
  jpeg: Buffer;
}

export interface RelayAudioChunk {
  sessionId: string;
  timestampMs: number;
  sequence: number;
  source: string;
  sampleRate: number;
  channels: number;
  frameCount: number;
  pcm: Buffer;
}

export interface RelayMotionSample {
  sessionId: string;
  timestampMs: number;
  userAccelerationG: { x: number; y: number; z: number };
  gravityG: { x: number; y: number; z: number } | null;
  rotationRateRadPerSec: { x: number; y: number; z: number } | null;
}

export interface RelayHubEvents {
  hello: [SessionSnapshot];
  location: [GeoPoint & { sessionId: string }];
  motion: [RelayMotionSample];
  video: [RelayVideoFrame];
  audio: [RelayAudioChunk];
  stream_event: [{ sessionId: string; event: string; payload: Record<string, unknown> }];
  disconnected: [string | null];
  status: [SessionSnapshot | null];
}

export class RelayHub extends EventEmitter {
  private session: SessionSnapshot | null = null;
  private socket: WebSocket | null = null;

  getSession(): SessionSnapshot | null {
    return this.session;
  }

  attach(socket: WebSocket): void {
    if (this.socket && this.socket !== socket) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
    }
    this.socket = socket;
    socket.on("message", (data, isBinary) => {
      void this.handleMessage(data, isBinary);
    });
    socket.on("close", () => {
      if (this.session) {
        this.session.connected = false;
        this.session.updatedAtMs = nowMs();
      }
      this.emit("disconnected", this.session?.sessionId ?? null);
      this.emit("status", this.session);
      if (this.socket === socket) this.socket = null;
    });
  }

  private async handleMessage(data: WebSocket.RawData, isBinary: boolean): Promise<void> {
    try {
      if (isBinary) {
        const buf = Buffer.isBuffer(data)
          ? data
          : Buffer.isBuffer((data as Buffer[])[0])
            ? Buffer.concat(data as Buffer[])
            : Buffer.from(data as ArrayBuffer);
        await this.handleBinary(buf);
        return;
      }
      const text =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Buffer.from(data as ArrayBuffer).toString("utf8");
      await this.handleText(text);
    } catch (err) {
      console.warn("[relay] message error:", err instanceof Error ? err.message : err);
    }
  }

  private async handleText(text: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(msg.type ?? "");

    if (type === "ping") {
      this.socket?.send(
        encodePong(nowMs(), Number(msg.timestampMs ?? nowMs())),
      );
      return;
    }

    if (type === "hello") {
      const sessionId = String(msg.sessionId ?? "unknown");
      this.session = {
        sessionId,
        connected: true,
        protocolVersion: Number(msg.protocolVersion ?? 1),
        app: msg.app as SessionSnapshot["app"],
        platform: msg.platform as SessionSnapshot["platform"],
        capabilities: msg.capabilities as Record<string, boolean>,
        activeSources: msg.activeSources as Record<string, string>,
        videoStats: this.session?.videoStats ?? {
          framesReceived: 0,
          framesVisioned: 0,
        },
        audioChunks: this.session?.audioChunks ?? 0,
        updatedAtMs: nowMs(),
        lastLocation: this.session?.lastLocation,
      };
      console.log(`[relay] hello session=${sessionId}`);
      this.emit("hello", this.session);
      this.emit("status", this.session);
      return;
    }

    if (!this.session) {
      // Allow telemetry before hello by synthesizing a session.
      this.session = {
        sessionId: String(msg.sessionId ?? "anonymous"),
        connected: true,
        protocolVersion: 1,
        videoStats: { framesReceived: 0, framesVisioned: 0 },
        audioChunks: 0,
        updatedAtMs: nowMs(),
      };
    }

    const sessionId = String(msg.sessionId ?? this.session.sessionId);

    if (type === "location") {
      const geo: GeoPoint & { sessionId: string } = {
        sessionId,
        latitude: Number(msg.latitude),
        longitude: Number(msg.longitude),
        altitudeMeters: msg.altitudeMeters == null ? null : Number(msg.altitudeMeters),
        horizontalAccuracyMeters:
          msg.horizontalAccuracyMeters == null
            ? null
            : Number(msg.horizontalAccuracyMeters),
        timestampMs: Number(msg.timestampMs ?? nowMs()),
      };
      this.session.lastLocation = geo;
      this.session.updatedAtMs = nowMs();
      this.emit("location", geo);
      this.emit("status", this.session);
      return;
    }

    if (type === "motion") {
      this.session.lastMotionAtMs = Number(msg.timestampMs ?? nowMs());
      this.session.updatedAtMs = nowMs();
      const ua = (msg.userAccelerationG ?? {}) as Record<string, unknown>;
      const gr = (msg.gravityG ?? null) as Record<string, unknown> | null;
      const rr = (msg.rotationRateRadPerSec ?? null) as Record<string, unknown> | null;
      this.emit("motion", {
        sessionId,
        timestampMs: this.session.lastMotionAtMs,
        userAccelerationG: {
          x: Number(ua.x ?? 0),
          y: Number(ua.y ?? 0),
          z: Number(ua.z ?? 0),
        },
        gravityG: gr
          ? { x: Number(gr.x ?? 0), y: Number(gr.y ?? 0), z: Number(gr.z ?? 0) }
          : null,
        rotationRateRadPerSec: rr
          ? { x: Number(rr.x ?? 0), y: Number(rr.y ?? 0), z: Number(rr.z ?? 0) }
          : null,
      });
      return;
    }

    if (type === "stream_event" || type === "health") {
      this.session.updatedAtMs = nowMs();
      if (type === "stream_event" && msg.activeSources) {
        this.session.activeSources = msg.activeSources as Record<string, string>;
      }
      this.emit("stream_event", {
        sessionId,
        event: String(msg.event ?? type),
        payload: msg,
      });
      this.emit("status", this.session);
      return;
    }
  }

  private async handleBinary(buf: Buffer): Promise<void> {
    const packet = parseBinaryPacket(buf);
    const sessionId = String(packet.metadata.sessionId ?? this.session?.sessionId ?? "anonymous");
    if (!this.session) {
      this.session = {
        sessionId,
        connected: true,
        protocolVersion: 1,
        videoStats: { framesReceived: 0, framesVisioned: 0 },
        audioChunks: 0,
        updatedAtMs: nowMs(),
      };
    }

    const timestampMs = Number(packet.timestampMs);

    if (packet.packetType === PACKET_JPEG) {
      this.session.videoStats.framesReceived += 1;
      this.session.videoStats.lastVideoSource = String(packet.metadata.source ?? "unknown");
      this.session.updatedAtMs = nowMs();
      const frame: RelayVideoFrame = {
        sessionId,
        timestampMs,
        sequence: packet.sequence,
        source: String(packet.metadata.source ?? "unknown"),
        width: Number(packet.metadata.width ?? 0),
        height: Number(packet.metadata.height ?? 0),
        quality: Number(packet.metadata.quality ?? 0.65),
        jpeg: packet.payload,
      };
      this.emit("video", frame);
      // Do not emit status on every video frame — that floods the dashboard.
      return;
    }

    if (packet.packetType === PACKET_PCM16) {
      this.session.audioChunks += 1;
      this.session.updatedAtMs = nowMs();
      const chunk: RelayAudioChunk = {
        sessionId,
        timestampMs,
        sequence: packet.sequence,
        source: String(packet.metadata.source ?? "unknown"),
        sampleRate: Number(packet.metadata.sampleRate ?? 16000),
        channels: Number(packet.metadata.channels ?? 1),
        frameCount: Number(packet.metadata.frameCount ?? 0),
        pcm: packet.payload,
      };
      this.emit("audio", chunk);
    }
  }

  markVisioned(): void {
    if (this.session) this.session.videoStats.framesVisioned += 1;
  }
}
