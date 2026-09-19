import express from "express";
import cors from "cors";
import type { SightlineApp } from "../app.js";
import { objectWithThumb } from "../app.js";
import { config } from "../config.js";
import { buildLinkInfo } from "../link/linkInfo.js";

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
    const objectId = String(req.body?.objectId ?? "");
    const result = await app.selectRecall(objectId);
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

  router.post("/emergency/dismiss", (_req, res) => {
    app.dismissEmergency();
    res.json({ ok: true });
  });

  router.post("/demo/reset", (_req, res) => {
    app.resetDemo();
    res.json({ ok: true });
  });

  return router;
}
