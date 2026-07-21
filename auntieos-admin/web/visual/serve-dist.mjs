// Minimal static server for the wasm dist, used by the visual harness against the
// local emulator. Sets the correct application/wasm MIME (so instantiateStreaming
// succeeds) and serves NO CSP header (so the Firebase SDK may reach the
// localhost:9099/8085 emulators). SPA fallback to index.html for hash routes.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../composeApp/build/dist/wasmJs/productionExecutable");
const PORT = Number(process.env.SERVE_PORT || 8088);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (urlPath === "/") urlPath = "/index.html";
    let filePath = normalize(join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    let s = await stat(filePath).catch(() => null);
    if (!s || s.isDirectory()) {
      // SPA fallback (hash routing lives client-side; unknown paths -> index.html)
      filePath = join(ROOT, "index.html");
    }
    const body = await readFile(filePath);
    const type = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(body);
  } catch (e) {
    res.writeHead(500).end(String(e?.message || e));
  }
});
server.listen(PORT, () => console.log(`serving ${ROOT}\n  http://localhost:${PORT}/`));
