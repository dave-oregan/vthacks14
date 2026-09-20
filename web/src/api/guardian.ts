import { sendEmergencySms } from "./twilio.js";
import { verifyAnsIdentity } from "../ans/godaddy.js";
import { resolveAnsName } from "../ans/dns.js";
import { config } from "../config.js";


// Keep track of recent evaluations to prevent spamming
let lastAlertTimestamp = 0;
const ALERT_COOLDOWN_MS = 60 * 1000; // 1 minute cooldown

export interface MotionData {
  timestampMs: number;
  acceleration?: { x: number; y: number; z: number };
  impactScore?: number; // A normalized 0-100 score indicating severity of sudden motion
}

export interface VisionContext {
  sceneDescription: string;
  hasPeople: boolean;
}

/**
 * Discover the Memory agent's endpoint from its published ANS record.
 *
 * This is the "discover" verb: the URL is not hardcoded, it is read from the
 * _ans TXT record that Memory published in DNS at registration time. Falls
 * back to loopback so the demo still runs before the domain is registered —
 * and says which path it took, rather than pretending it resolved.
 */
async function discoverMemoryEndpoint(): Promise<{ url: string; viaAns: boolean }> {
  const loopback = `http://127.0.0.1:${config.port}`;
  try {
    const record = await resolveAnsName(`ans://memory.${config.ansTeamDomain}`);
    const endpoint = record.endpoints.find((e) => e.url);
    if (endpoint?.url) {
      console.log(`[GUARDIAN] Discovered Memory via _ans.${record.host} -> ${endpoint.url}`);
      return { url: endpoint.url, viaAns: true };
    }
    console.log(`[GUARDIAN] No _ans record for memory.${config.ansTeamDomain}; using loopback`);
  } catch (err) {
    console.log(`[GUARDIAN] ANS discovery failed (${err instanceof Error ? err.message : err}); using loopback`);
  }
  return { url: loopback, viaAns: false };
}

/**
 * Evaluates incoming motion and vision data to determine if an emergency
 * SMS should be triggered.
 */
export async function evaluateRisk(
  motion: MotionData,
  vision?: VisionContext,
  agentAnsName: string = `ans://v1.0.0.guardian.${config.ansTeamDomain}`
) {
  // Check cooldown
  if (Date.now() - lastAlertTimestamp < ALERT_COOLDOWN_MS) {
    return { triggered: false, reason: "cooldown" };
  }

  const isSevereImpact = motion.impactScore !== undefined && motion.impactScore > 80;
  
  if (!isSevereImpact) {
    return { triggered: false, reason: "normal" };
  }

  console.log(`[GUARDIAN] High impact detected (score: ${motion.impactScore}). Evaluating risk...`);

  // Guardian discovers Memory via DNS
  const discovery = await discoverMemoryEndpoint();
  const memoryEndpoint = discovery.url;

  // Guardian verifies its own ANS identity and scope BEFORE asking for data.
  const GUARDIAN_SCOPES = ["telemetry.fall", "memory.frame", "location.coarse"];
  const ansResult = await verifyAnsIdentity(agentAnsName, GUARDIAN_SCOPES);
  console.log(`[GUARDIAN] ANS ${agentAnsName} -> ${ansResult.status}`);
  for (const c of ansResult.checks) {
    console.log(`  ${c.passed ? "PASS" : "FAIL"}  ${c.name.padEnd(14)} ${c.detail ?? ""}`);
  }

  // Guardian calls Memory's endpoint over HTTP, presenting its own identity
  let isAnsVerified = ansResult.isFullyVerified;
  let memoryContext = null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);

  try {
    const contextRes = await fetch(`${memoryEndpoint}/api/memory/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentAnsName }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (contextRes.ok) {
      memoryContext = await contextRes.json();
      console.log(`[GUARDIAN] Memory verified identity and released context.`);
    } else {
      console.warn(`[GUARDIAN] Memory denied access or failed: ${contextRes.status}`);
    }
  } catch (err) {
    console.error("[GUARDIAN] Failed to reach Memory service", err);
  }

  // Construct message based on ANS status and vision context
  let message = "";
  if (isAnsVerified) {
    message = `[GUARDIAN ALERT] IDENTITY VERIFIED (${agentAnsName}). Severe impact detected at ${new Date(motion.timestampMs).toLocaleTimeString()}.`;
    if (vision || memoryContext?.sceneDescription) {
      message += ` Context: ${vision?.sceneDescription || memoryContext?.sceneDescription}.`;
    }
  } else {
    // Fallback: Low context, immediate minimal SMS
    message = `[EMERGENCY FALLBACK] Potential severe impact detected. ANS verification failed. Please check on the user immediately.`;
  }

  // Log the REAL message to the terminal for the judges
  console.log("\n==================================================");
  console.log("🚨 " + message);
  console.log("==================================================\n");

  // Send the alert we just built. Labelled SIMULATION: this is a hackathon
  // demo escalating to a teammate's phone, never an emergency service.
  const sent = await sendEmergencySms(`SIMULATION - ${message}`);
  
  if (sent) {
    lastAlertTimestamp = Date.now();
  }

  return { triggered: true, message, isAnsVerified };
}
