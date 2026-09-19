#!/usr/bin/env python3
"""
Minimal HTTP wrapper around locate-anything-cli, shaped for SIGHTLINE's
web/src/vision/locateAnything.ts client.

  POST /detect  {image_base64, categories?, generation_mode?}
     -> {image_width, image_height, items:[{label, confidence, bbox:{x1,y1,x2,y2}}]}
  GET  /health  -> {"ok": true}

Stdlib only. Serialized on one lock because there is a single GPU.

NOTE: the CLI reloads ~5.2GB into VRAM on every invocation, so expect roughly
15s per request. This proves the wiring; it is not a real-time path.
"""
import base64, json, os, struct, subprocess, tempfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.expanduser("~")
CLI = os.environ.get("LA_CLI", f"{HOME}/locate-anything.cpp/build/examples/cli/locate-anything-cli")
MODEL = os.environ.get("LA_MODEL", f"{HOME}/models/locate-anything-q6_k.gguf")
PORT = int(os.environ.get("LA_PORT", "8199"))
DEFAULT_CATS = ["backpack", "laptop", "cell phone", "bottle", "person"]

_lock = threading.Lock()


def jpeg_size(data):
    """(width, height) from a baseline JPEG SOF marker."""
    i, n = 2, len(data)
    while i + 9 < n:
        if data[i] != 0xFF:
            i += 1
            continue
        m = data[i + 1]
        if m in (0xD8, 0xD9) or 0xD0 <= m <= 0xD7:
            i += 2
            continue
        seglen = struct.unpack(">H", data[i + 2:i + 4])[0]
        if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return w, h
        i += 2 + seglen
    return None, None


def run_cli(path, categories):
    prompt = ("Locate all the instances that matches the following description: "
              + "</c>".join(categories) + ".")
    proc = subprocess.run(
        [CLI, "detect", "--model", MODEL, "--input", path, "--prompt", prompt],
        capture_output=True, text=True, timeout=180)
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line.startswith('{"detections"'):
            return json.loads(line).get("detections", []), None
    return [], (proc.stderr or proc.stdout)[-400:]


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send(200, {"ok": True, "cli": CLI, "model": MODEL})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/detect"):
            return self._send(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:
            return self._send(400, {"error": f"bad json: {e}"})

        b64 = req.get("image_base64") or ""
        if not b64:
            return self._send(400, {"error": "image_base64 required"})
        raw = base64.b64decode(b64)
        cats = req.get("categories") or DEFAULT_CATS
        w, h = jpeg_size(raw)

        tmp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
        try:
            tmp.write(raw)
            tmp.close()
            with _lock:
                dets, err = run_cli(tmp.name, cats)
        except Exception as e:
            return self._send(500, {"error": str(e)})
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass

        items = []
        for d in dets:
            box = d.get("box") or []
            if len(box) != 4:
                continue
            try:
                x1, y1, x2, y2 = (float(v) for v in box)
            except (TypeError, ValueError):
                continue
            items.append({
                "label": d.get("label", "object"),
                "confidence": float(d.get("score", d.get("confidence", 0.85))),
                "bbox": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
            })

        out = {"image_width": w, "image_height": h, "items": items}
        if err and not items:
            out["warning"] = err
        print(f"[la-worker] {len(items)} items  {w}x{h}  cats={len(cats)}", flush=True)
        self._send(200, out)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    for p in (CLI, MODEL):
        if not os.path.exists(p):
            raise SystemExit(f"missing: {p}")
    print(f"[la-worker] listening on 0.0.0.0:{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
