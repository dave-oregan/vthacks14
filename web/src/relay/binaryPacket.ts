export const PACKET_JPEG = 0x01;
export const PACKET_PCM16 = 0x02;
export const HEADER_SIZE = 17;

export interface ParsedBinaryPacket {
  packetType: number;
  timestampMs: bigint;
  sequence: number;
  metadata: Record<string, unknown>;
  payload: Buffer;
}

export function parseBinaryPacket(buf: Buffer): ParsedBinaryPacket {
  if (buf.length < HEADER_SIZE) {
    throw new Error(`Binary packet too short: ${buf.length}`);
  }
  const packetType = buf.readUInt8(0);
  const timestampMs = buf.readBigUInt64BE(1);
  const sequence = buf.readUInt32BE(9);
  const metaLen = buf.readUInt32BE(13);
  const metaStart = HEADER_SIZE;
  const metaEnd = metaStart + metaLen;
  if (buf.length < metaEnd) {
    throw new Error(`Metadata length exceeds packet (${metaLen})`);
  }
  const metadataJSON = buf.subarray(metaStart, metaEnd).toString("utf8");
  const metadata = JSON.parse(metadataJSON) as Record<string, unknown>;
  const payload = buf.subarray(metaEnd);
  return { packetType, timestampMs, sequence, metadata, payload };
}

export function encodePong(timestampMs: number, receivedTimestampMs: number): string {
  return JSON.stringify({
    type: "pong",
    timestampMs,
    receivedTimestampMs,
  });
}

export function nowMs(): number {
  return Date.now();
}
