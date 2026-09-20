import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { SightlineApp } from "./app.js";
import { createApiRouter } from "./api/routes.js";
import { startBonjourAdvertisement } from "./link/bonjour.js";
import { listLanIPv4, preferredLanIP } from "./link/lanAddresses.js";
import { connectDatabases, closeDatabases, loadPersistedState } from "./memory/db.js";

const appCore = new SightlineApp();
const expressApp = express();

expressApp.use("/api", createApiRouter(appCore));

const dashboardDist = config.dashboardDir;
const publicDir = config.publicDir;
if (fs.existsSync(dashboardDist)) {
  expressApp.use(express.static(dashboardDist));
}
expressApp.use(express.static(publicDir));

expressApp.get(/^(?!\/api|\/ws).*/, (req, res, next) => {
  if (req.method !== "GET") return next();
  const indexDist = path.join(dashboardDist, "index.html");
  const indexPublic = path.join(publicDir, "index.html");
  if (fs.existsSync(indexDist)) return res.sendFile(indexDist);
  if (fs.existsSync(indexPublic)) return res.sendFile(indexPublic);
  res.status(404).send("Dashboard not built. Run npm run build:dashboard");
});

const server = http.createServer(expressApp);

const relayWss = new WebSocketServer({ noServer: true });
const dashWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const remote = req.socket.remoteAddress ?? "?";
  if (pathname === "/ws/relay") {
    relayWss.handleUpgrade(req, socket, head, (ws) => {
      console.log(`[ws] iOS relay connected from ${remote}`);
      appCore.relay.attach(ws);
    });
    return;
  }
  if (pathname === "/ws/dashboard") {
    dashWss.handleUpgrade(req, socket, head, (ws) => {
      console.log(`[ws] dashboard connected from ${remote}`);
      ws.send(JSON.stringify({ type: "state", payload: appCore.getDashboardState() }));
      const onDash = (state: unknown) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "state", payload: state }));
        }
      };
      const onFrame = (frame: unknown) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "frame", payload: frame }));
        }
      };
      const onVoice = (voice: unknown) => {
        if (ws.readyState !== ws.OPEN) return;
        // Strip giant base64 — dashboard loads /api/voice/latest.mp3 instead.
        const v = voice as { text?: string; ok?: boolean; audioUrl?: string; error?: string; audioBase64?: string };
        const audioUrl =
          v.audioUrl ||
          (v.audioBase64 ? `/api/voice/latest.mp3?t=${Date.now()}` : undefined);
        ws.send(
          JSON.stringify({
            type: "voice",
            payload: {
              ok: v.ok,
              text: v.text,
              audioUrl,
              error: v.error,
            },
          }),
        );
      };
      const onEmergency = (alert: unknown) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "emergency", payload: alert }));
        }
      };
      appCore.on("dashboard", onDash);
      appCore.on("frame", onFrame);
      appCore.on("voice", onVoice);
      appCore.on("emergency", onEmergency);
      ws.on("close", () => {
        appCore.off("dashboard", onDash);
        appCore.off("frame", onFrame);
        appCore.off("voice", onVoice);
        appCore.off("emergency", onEmergency);
      });
    });
    return;
  }
  socket.destroy();
});

// Non-blocking on purpose: Atlas connects in the background so flaky venue
// wifi can never delay the server coming up. Once connected, the previous
// session's object memory and timeline are restored into the live store.
void connectDatabases().then(async () => {
  const persisted = await loadPersistedState();
  if (persisted && (persisted.objects.length || persisted.events.length)) {
    appCore.store.hydrate(persisted.objects, persisted.events);
    console.log(
      `[db] restored ${persisted.objects.length} objects and ${persisted.events.length} events from Atlas`,
    );
  }
});

server.listen(config.port, config.host, () => {
  startBonjourAdvertisement();
  const preferred = preferredLanIP();
  const hosts = listLanIPv4();
  console.log(`SIGHTLINE web listening on http://${config.host}:${config.port}`);
  console.log(`  Mission Control: http://localhost:${config.port}`);
  if (preferred) {
    console.log(
      `  Pair iPhone via:  sightlinelink://link?host=${preferred}&port=${config.port}&autoStart=1`,
    );
    console.log(`  iOS relay:        ws://${preferred}:${config.port}/ws/relay`);
  }
  for (const h of hosts) {
    if (h !== preferred) console.log(`  also: ws://${h}:${config.port}/ws/relay`);
  }
  console.log(`  Bonjour:          _sightline._tcp (SIGHTLINE Mission Control)`);
  console.log(`  Link API:         http://localhost:${config.port}/api/link`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] ${signal} received, closing SIGHTLINE...`);
  await closeDatabases();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
