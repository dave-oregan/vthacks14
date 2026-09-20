import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

export const config = {
  port: Number(process.env.PORT ?? 8000),
  host: process.env.HOST ?? "0.0.0.0",
  /** Force pairing QR / deep link to this host (e.g. hotspot IP). */
  linkHost: (process.env.LINK_HOST ?? "").trim(),
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY ?? "",
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM",
  elevenLabsModelId: process.env.ELEVENLABS_MODEL_ID ?? "eleven_turbo_v2_5",
  sttEnabled: (process.env.STT_ENABLED ?? "1") !== "0",
  sttModelId: process.env.ELEVENLABS_STT_MODEL ?? "scribe_v1",
  sttLanguageCode: process.env.STT_LANGUAGE_CODE ?? "",
  sttAutoRecall: (process.env.STT_AUTO_RECALL ?? "0") === "1",
  ansTeamDomain: process.env.ANS_TEAM_DOMAIN ?? "sightline.local",
  visionEveryNFrames: Number(process.env.VISION_EVERY_N_FRAMES ?? 8),
  visionMinScore: Number(process.env.VISION_MIN_SCORE ?? 0.35),
  previewMaxFps: Number(process.env.PREVIEW_MAX_FPS ?? 12),
  /**
   * browser = Mission Control WebGL COCO (default, smooth)
   * server  = Node COCO on laptop
   * both    = both paths
   */
  visionMode: (process.env.VISION_MODE ?? "browser") as "browser" | "server" | "both",
  /** How often Gemini enriches descriptors (separate from vision cadence). */
  geminiEveryNVisionPasses: Number(process.env.GEMINI_EVERY_N_VISION ?? 6),
  /** Optional NVIDIA LocateAnything worker base URL (POST /detect). */
  locateAnythingUrl: (process.env.LOCATE_ANYTHING_URL ?? "").replace(/\/$/, ""),
  locateAnythingTimeoutMs: Number(process.env.LOCATE_ANYTHING_TIMEOUT_MS ?? 8000),
  /** Min ms between LocateAnything calls (slow GPU path). */
  locateAnythingMinIntervalMs: Number(process.env.LOCATE_ANYTHING_MIN_INTERVAL_MS ?? 8000),
  /**
   * When LocateAnything returns 0 / fails, fall back to local COCO-SSD.
   * Default off — LA empty should not pay COCO load cost or muddy the demo.
   */
  cocoFallback: ["1", "true", "yes", "on"].includes(
    String(process.env.COCO_FALLBACK ?? "true").toLowerCase(),
  ),
  leaveBehindMeters: Number(process.env.LEAVE_BEHIND_METERS ?? 12),
  leaveBehindAbsentMs: Number(process.env.LEAVE_BEHIND_ABSENT_MS ?? 8000),
  dbPath: path.join(ROOT, "data", "sightline.sqlite"),
  publicDir: path.join(ROOT, "public"),
  dashboardDir: path.join(ROOT, "dashboard", "dist"),

  // GoDaddy ANS
  godaddyApiKey: process.env.GODADDY_API_KEY ?? "",
  godaddyApiSecret: process.env.GODADDY_API_SECRET ?? "",

  // Twilio
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID ?? "",
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? "",
  twilioFromNumber: process.env.TWILIO_FROM_NUMBER ?? "",
  // No default: a real number must never be hardcoded in a public repo.
  // Set TWILIO_TO_NUMBER in .env to a TEAMMATE's phone for the demo.
  twilioToNumber: process.env.TWILIO_TO_NUMBER ?? "",

  // Database (Stretch)
  mongoUri: process.env.MONGO_URI ?? "",
};
