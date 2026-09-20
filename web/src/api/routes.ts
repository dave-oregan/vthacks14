import express from "express";
import cors from "cors";
import type { SightlineApp } from "../app.js";
import { objectWithThumb } from "../app.js";
import { config } from "../config.js";
import { buildLinkInfo } from "../link/linkInfo.js";
import {
  mongoStatus,
  recentPersistedEvents,
  recentTranscripts,
  type TranscriptDirection,
} from "../memory/db.js";
import { speak } from "../voice/elevenlabs.js";
import { getLatestVoiceClip } from "../voice/voiceCache.js";

export function createApiRouter(app: SightlineApp) {
  const router = express.Router();
  router.use(cors());
  router.use(express.json({ limit: "2mb" }));

  router.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "sightline-web",
      relayPath: "/ws/relay",
      dashboardWs: "/ws/dashboard",
      gemini: Boolean(config.geminiApiKey),
      locateAnything: Boolean(config.locateAnythingUrl),
      visionMode: config.visionMode,
      elevenlabs: Boolean(config.elevenLabsApiKey),
      mongo: mongoStatus(),
      stt: app.transcriber.status(),
    });
  });

  // Reads the timeline back out of MongoDB Atlas (not the in-memory store),
  // which is what proves the persistence layer round-trips.
  router.get("/mongo/events", async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 25, 200);
    res.json({ status: mongoStatus(), events: await recentPersistedEvents(limit) });
  });

  // Speak an arbitrary line through ElevenLabs and push it to the dashboard.
  // Lets us verify the whole voice path without faking a fall.
  router.post("/voice/test", async (req, res) => {
    const text =
      typeof req.body?.text === "string" && req.body.text.trim()
        ? String(req.body.text).slice(0, 400)
        : "SIGHTLINE voice check. If you can hear this, the audio path is working.";
    const voice = await speak(text);
    app.emit("voice", voice);
    const clip = getLatestVoiceClip();
    res.json({
      ok: voice.ok,
      text: voice.text,
      error: voice.error,
      audioUrl: voice.audioUrl,
      audioBytes: clip?.buf.length ?? 0,
    });
  });

  router.get("/voice/latest.mp3", (_req, res) => {
    const clip = getLatestVoiceClip();
    if (!clip) {
      res.status(404).type("text/plain").send("no voice clip yet");
      return;
    }
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(clip.buf);
  });

  // Feed a WAV/MP3 straight to Scribe to prove the STT path without needing
  // a wearable in the room: curl -F file=@clip.wav /api/stt/test
  router.post("/stt/test", express.raw({ type: "*/*", limit: "25mb" }), async (req, res) => {
    const body = req.body as Buffer | undefined;
    if (!body || body.length < 100) {
      res.status(400).json({ ok: false, error: "POST raw audio bytes as the body" });
      return;
    }
    const result = await app.transcribeBuffer(body);
    res.json(result);
  });

  // Full transcript log out of Atlas, newest first.
  router.get("/mongo/transcripts", async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const dir = String(req.query.direction ?? "");
    const direction: TranscriptDirection | undefined =
      dir === "spoken" || dir === "asked" || dir === "heard"
        ? (dir as TranscriptDirection)
        : undefined;
    res.json({
      status: mongoStatus(),
      direction: direction ?? "all",
      transcripts: await recentTranscripts(limit, direction),
    });
  });

  router.get("/link", async (_req, res) => {
    res.json(await buildLinkInfo());
  });

  router.get("/state", (_req, res) => {
    const state = app.getDashboardState();
    res.json({
      ...state,
      objects: app.store.listObjects().map(objectWithThumb),
    });
  });

  router.get("/objects", (_req, res) => {
    res.json({ objects: app.store.listObjects().map(objectWithThumb) });
  });

  router.get("/objects/search", (req, res) => {
    const q = String(req.query.q ?? "");
    res.json({ objects: app.store.searchObjects(q).map(objectWithThumb) });
  });

  router.get("/events", (_req, res) => {
    res.json({ events: app.store.listEvents(100) });
  });

  router.post("/missions/track", (req, res) => {
    const target = String(req.body?.target ?? "phone");
    const mission = app.startTrackMission(target);
    res.json({ mission });
  });

  router.post("/recall", async (req, res) => {
    const query = String(req.body?.query ?? "");
    const result = await app.recall(query);
    res.json(result);
  });

  router.post("/recall/select", async (req, res) => {
    const objectId = String(req.body?.objectId ?? req.body?.id ?? "");
    const kind = req.body?.kind === "transcript" ? "transcript" : "object";
    const transcriptText =
      typeof req.body?.transcriptText === "string" ? req.body.transcriptText : undefined;
    const query = typeof req.body?.query === "string" ? req.body.query : undefined;
    const result = await app.selectRecall(objectId, kind, transcriptText, query);
    res.json(result);
  });

  router.post("/ans/verify", async (req, res) => {
    const agentAnsName = String(req.body?.agentAnsName ?? "");
    const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes.map(String) : ["memory.read"];
    const result = await app.requestAgentAccess(agentAnsName, scopes);
    res.json({ request: result });
  });

  router.post("/ans/simulate-unknown", async (_req, res) => {
    res.json({ request: await app.simulateUnknownAgent() });
  });

  router.post("/vision/report", async (req, res) => {
    const detections = Array.isArray(req.body?.detections) ? req.body.detections : [];
    const timestampMs = Number(req.body?.timestampMs ?? Date.now());
    const result = await app.ingestClientDetections(detections, timestampMs);
    res.json({ ok: true, ...result });
  });

  router.post("/demo/fall", (_req, res) => {
    res.json({ alert: app.simulateFall() });
  });

  router.post("/demo/crash", (_req, res) => {
    res.json({ alert: app.simulateCrash() });
  });

  router.post("/emergency/dismiss", (_req, res) => {
    app.dismissEmergency();
    res.json({ ok: true });
  });

  router.post("/mode/guardian", (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    res.json(app.setGuardianMode(enabled));
  });

  /** @deprecated Prefer /mode/guardian */
  router.post("/mode/police", (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    res.json(app.setGuardianMode(enabled));
  });

  router.post("/mode/coco-fallback", (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    res.json(app.setCocoFallback(enabled));
  });

  router.post("/guardian/events/dismiss", (req, res) => {
    const id = String(req.body?.id ?? "");
    if (id) app.dismissGuardianEvent(id);
    res.json({ ok: true });
  });

  router.post("/guardian/events/confirm", (req, res) => {
    const id = String(req.body?.id ?? "");
    if (id) app.confirmGuardianEvent(id);
    res.json({ ok: true });
  });

  router.post("/guardian/query", (req, res) => {
    const query = String(req.body?.query ?? "");
    res.json(app.queryGuardianMemory(query));
  });

  router.post("/guardian/demo/:scenario", (req, res) => {
    try {
      if (!app.getDashboardState().guardianMode) {
        app.setGuardianMode(true);
      }
      const event = app.injectGuardianDemo(String(req.params.scenario));
      res.json({ ok: true, event, guardianEvents: app.getDashboardState().guardianEvents });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** @deprecated Prefer /guardian/events/dismiss */
  router.post("/alerts/dismiss", (req, res) => {
    const id = String(req.body?.id ?? "");
    if (id) app.dismissGuardianEvent(id);
    res.json({ ok: true });
  });

  router.post("/demo/reset", (_req, res) => {
    app.resetDemo();
    res.json({ ok: true });
  });

  router.post("/memory/context", async (req, res) => {
    const agentAnsName = String(req.body?.agentAnsName ?? "");
    const result = await app.requestAgentAccess(agentAnsName, ["location", "memory.read", "camera.read"]);
    
    if (result.decision === "allow") {
       const state = app.getDashboardState();
       const detectedLabels = state.latestDetections.map(d => d.displayName);
       const uniqueLabels = Array.from(new Set(detectedLabels));
       const sceneDescription = uniqueLabels.length > 0 
          ? `Detected objects: ${uniqueLabels.join(", ")}.`
          : "No objects recently detected.";

       res.json({
         location: state.session?.lastLocation ?? null,
         hasFrame: !!state.latestFrameJpegBase64,
         sceneDescription
       });
    } else {
       res.status(403).json({ error: "Access Denied by ANS", reason: result.verificationStatus });
    }
  });

  return router;
}
