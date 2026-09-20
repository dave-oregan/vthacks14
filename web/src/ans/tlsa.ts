/**
 * TLSA (DANE) lookup — ANS-6 silver-tier evidence.
 *
 * At registration the ANS registry publishes a TLSA record binding the agent's
 * server certificate to its name:
 *
 *   _443._tcp.<host>  IN TLSA  3 0 1 <sha256-of-cert>
 *
 * Node's resolver has no TLSA support (dns.resolve handles A/AAAA/TXT/SRV/...
 * but not type 52), so we build the query by hand over UDP.
 */
import dgram from "node:dgram";
import fs from "node:fs";

export interface TlsaRecord {
  usage: number;          // 3 = domain-issued certificate
  selector: number;       // 0 = full certificate
  matchingType: number;   // 1 = SHA-256
  data: string;           // hex
}

const TYPE_TLSA = 52;
const TIMEOUT_MS = 3000;

function systemResolver(): string {
  try {
    const conf = fs.readFileSync("/etc/resolv.conf", "utf8");
    const m = conf.match(/^nameserver\s+(\S+)/m);
    if (m) return m[1];
  } catch {
    /* Windows, or no resolv.conf — fall through */
  }
  return "1.1.1.1";
}

function encodeQuery(name: string, type: number): Buffer {
  const labels = name.split(".").filter(Boolean);
  const question = Buffer.concat([
    ...labels.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, "ascii")])),
    Buffer.from([0]),
  ]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(Math.floor(Math.random() * 65535), 0);
  header.writeUInt16BE(0x0100, 2); // recursion desired
  header.writeUInt16BE(1, 4);      // one question
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2);        // class IN
  return Buffer.concat([header, question, tail]);
}

/** Advance past a (possibly compressed) domain name. */
function skipName(buf: Buffer, offset: number): number {
  for (;;) {
    const len = buf[offset];
    if (len === undefined) return offset;
    if (len === 0) return offset + 1;
    if ((len & 0xc0) === 0xc0) return offset + 2; // pointer, always terminal
    offset += len + 1;
  }
}

export function lookupTlsa(host: string, port = 443): Promise<TlsaRecord[]> {
  const name = `_${port}._tcp.${host}`;
  return new Promise((resolve) => {
    let settled = false;
    const socket = dgram.createSocket("udp4");
    const finish = (records: TlsaRecord[]) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* already closed */ }
      resolve(records);
    };
    const timer = setTimeout(() => finish([]), TIMEOUT_MS);

    socket.on("message", (msg) => {
      clearTimeout(timer);
      try {
        const answerCount = msg.readUInt16BE(6);
        let off = skipName(msg, 12) + 4; // past the question
        const out: TlsaRecord[] = [];
        for (let i = 0; i < answerCount; i++) {
          off = skipName(msg, off);
          const rtype = msg.readUInt16BE(off);
          off += 8;                       // type(2) class(2) ttl(4)
          const rdLength = msg.readUInt16BE(off);
          off += 2;
          const rdata = msg.subarray(off, off + rdLength);
          off += rdLength;
          if (rtype === TYPE_TLSA && rdata.length > 3) {
            out.push({
              usage: rdata[0],
              selector: rdata[1],
              matchingType: rdata[2],
              data: rdata.subarray(3).toString("hex"),
            });
          }
        }
        finish(out);
      } catch {
        finish([]);
      }
    });

    socket.on("error", () => { clearTimeout(timer); finish([]); });
    socket.send(encodeQuery(name, TYPE_TLSA), 53, systemResolver(), (err) => {
      if (err) { clearTimeout(timer); finish([]); }
    });
  });
}

/** Does a certificate's SHA-256 fingerprint match any published TLSA record? */
export function tlsaMatches(records: TlsaRecord[], sha256Hex: string): boolean {
  const want = sha256Hex.replace(/:/g, "").toLowerCase();
  return records.some((r) => r.matchingType === 1 && r.data.toLowerCase() === want);
}
