import os from "node:os";
import { config } from "../config.js";

export function listLanIPv4(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const [name, entries] of Object.entries(ifaces)) {
    if (!entries) continue;
    // Skip Tailscale / VPN tunnel interfaces when ranking later — still list them.
    for (const entry of entries) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      out.push(entry.address);
    }
    void name;
  }
  // Deduplicate while preserving order
  return [...new Set(out)];
}

export function preferredLanIP(): string | null {
  const override = (config.linkHost || "").trim();
  if (override) return override;

  const ips = listLanIPv4();
  const ranked = [...ips].sort((a, b) => score(b) - score(a));
  return ranked[0] ?? null;
}

/** True when the only/preferred address looks like CGNAT (venue Wi‑Fi / Tailscale). */
export function isCgnatAddress(ip: string | null | undefined): boolean {
  return Boolean(ip && ip.startsWith("100.64."));
}

function score(ip: string): number {
  // Explicit private LAN — best for phone ↔ Mac pairing
  if (ip.startsWith("192.168.")) return 40;
  // iPhone hotspot / Internet Sharing often 172.20.x
  if (ip.startsWith("172.20.") || ip.startsWith("172.16.")) return 35;
  if (ip.startsWith("10.")) return 30;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 25;
  // Venue CGNAT Wi‑Fi (hackathons sometimes use 100.64) — usable if clients aren't isolated
  if (ip.startsWith("100.64.")) return 12;
  return 0;
}
