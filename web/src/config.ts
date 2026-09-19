import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

export const config = {
  port: Number(process.env.PORT ?? 8000),
  host: process.env.HOST ?? "0.0.0.0",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY ?? "",
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM",
  ansTeamDomain: process.env.ANS_TEAM_DOMAIN ?? "sightline.local",
  visionEveryNFrames: Number(process.env.VISION_EVERY_N_FRAMES ?? 3),
  visionMinScore: Number(process.env.VISION_MIN_SCORE ?? 0.35),
  previewMaxFps: Number(process.env.PREVIEW_MAX_FPS ?? 5),
  geminiEveryNVisionPasses: Number(process.env.GEMINI_EVERY_N_VISION ?? 4),
  leaveBehindMeters: Number(process.env.LEAVE_BEHIND_METERS ?? 12),
  leaveBehindAbsentMs: Number(process.env.LEAVE_BEHIND_ABSENT_MS ?? 8000),
  dbPath: path.join(ROOT, "data", "sightline.sqlite"),
  publicDir: path.join(ROOT, "public"),
  dashboardDir: path.join(ROOT, "dashboard", "dist"),
};
