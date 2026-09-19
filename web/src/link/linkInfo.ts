import QRCode from "qrcode";
import { config } from "../config.js";
import { listLanIPv4, preferredLanIP } from "./lanAddresses.js";

export interface LinkInfo {
  service: string;
  port: number;
  relayPath: string;
  preferredHost: string | null;
  hosts: string[];
  relayUrls: string[];
  deepLinks: string[];
  preferredRelayUrl: string | null;
  preferredDeepLink: string | null;
  qrDataUrl: string | null;
  instructions: string[];
}

export async function buildLinkInfo(): Promise<LinkInfo> {
  const hosts = listLanIPv4();
  const preferredHost = preferredLanIP();
  const port = config.port;
  const relayPath = "/ws/relay";

  const relayUrls = hosts.map((h) => `ws://${h}:${port}${relayPath}`);
  const deepLinks = hosts.map(
    (h) => `sightlinelink://link?host=${encodeURIComponent(h)}&port=${port}&autoStart=1`,
  );

  const preferredRelayUrl = preferredHost
    ? `ws://${preferredHost}:${port}${relayPath}`
    : relayUrls[0] ?? null;
  const preferredDeepLink = preferredHost
    ? `sightlinelink://link?host=${encodeURIComponent(preferredHost)}&port=${port}&autoStart=1`
    : deepLinks[0] ?? null;

  let qrDataUrl: string | null = null;
  if (preferredDeepLink) {
    qrDataUrl = await QRCode.toDataURL(preferredDeepLink, {
      margin: 1,
      width: 280,
      color: { dark: "#0b0f0e", light: "#ffffff" },
    });
  }

  return {
    service: "_sightline._tcp",
    port,
    relayPath,
    preferredHost,
    hosts,
    relayUrls,
    deepLinks,
    preferredRelayUrl,
    preferredDeepLink,
    qrDataUrl,
    instructions: [
      "On iPhone: open SIGHTLINE Link → tap Find Mission Control (or scan this QR).",
      "Same Wi‑Fi as this Mac is required.",
      "Then tap START SIGHTLINE RELAY (QR with autoStart does this for you).",
    ],
  };
}
