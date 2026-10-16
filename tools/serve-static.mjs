// Tiny static server for the UI reference (docs/ui-reference). Serves the repo root on
// 127.0.0.1 so the page can load the real brand mark from electron/renderer/src/assets.
// "/" goes straight to the reference page. Loopback only, read only, no directory listing.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.argv[2] ?? 4791);
const types = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
  ".css": "text/css", ".js": "text/javascript", ".jpg": "image/jpeg" };

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/") path = "/docs/ui-reference/index.html";
  const file = normalize(join(root, path));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`ui-reference on http://127.0.0.1:${port}`));
