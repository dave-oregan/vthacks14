import QRCode from "qrcode";
import { config } from "../config.js";
import { isCgnatAddress, listLanIPv4, preferredLanIP } from "./lanAddresses.js";

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
  cgnatWarning: boolean;
  linkHostOverride: string | null;
}

export async function buildLinkInfo(): Promise<LinkInfo> {
  const hosts = listLanIPv4();
  const preferredHost = preferredLanIP();
  const port = config.port;
  const relayPath = "/ws/relay";
  const cgnatWarning = isCgnatAddress(preferredHost);

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

  const instructions = [
    "On iPhone: open SIGHTLINE Link → scan this QR (or Find Mission Control).",
    "Phone and Mac must be on the same network.",
    "Then START SIGHTLINE RELAY (QR with autoStart does this).",
  ];
  if (cgnatWarning) {
    instructions.unshift(
      "This Mac’s Wi‑Fi IP is 100.64.x (CGNAT). Many venue networks isolate phones from laptops — Bonjour/QR will fail.",
      "Fix: turn on Personal Hotspot on the iPhone, join it from the Mac, restart npm run dev, then scan the new QR.",
    );
  }
  if (config.linkHost) {
    instructions.unshift(`Using LINK_HOST override: ${config.linkHost}`);
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
    instructions,
    cgnatWarning,
    linkHostOverride: config.linkHost || null,
  };
}
