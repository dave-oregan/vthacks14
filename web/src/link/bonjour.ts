import Bonjour from "bonjour-service";
import { config } from "../config.js";

let bonjour: InstanceType<typeof Bonjour> | null = null;

/** Advertise Mission Control on the LAN so iOS can find it without typing an IP. */
export function startBonjourAdvertisement(): void {
  try {
    bonjour = new Bonjour();
    bonjour.publish({
      name: "SIGHTLINE Mission Control",
      type: "sightline",
      protocol: "tcp",
      port: config.port,
      txt: {
        path: "/ws/relay",
        proto: "ws",
        v: "1",
        ui: "/",
      },
    });
    console.log(`[link] Bonjour advertising _sightline._tcp port ${config.port}`);
  } catch (err) {
    console.warn("[link] Bonjour publish failed:", err instanceof Error ? err.message : err);
  }
}

export function stopBonjourAdvertisement(): void {
  try {
    bonjour?.unpublishAll(() => {
      bonjour?.destroy();
      bonjour = null;
    });
  } catch {
    /* ignore */
  }
}
