import os from "node:os";

export function listLanIPv4(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      out.push(entry.address);
    }
  }
  return out;
}

export function preferredLanIP(): string | null {
  const ips = listLanIPv4();
  // Prefer common private ranges used on home/hackathon Wi-Fi.
  const ranked = [...ips].sort((a, b) => score(b) - score(a));
  return ranked[0] ?? null;
}

function score(ip: string): number {
  if (ip.startsWith("192.168.")) return 30;
  if (ip.startsWith("10.")) return 20;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 10;
  return 0;
}
