import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { isRendererUrl, assertRendererSender } = require("../../../../../main/renderer-security.js");
const { readRpcResponse } = require("../../../../../main/mcp-response.js");

describe("privileged renderer boundary", () => {
  it("allows only the entry document and the main frame", () => {
    const entry = resolve("dist/renderer/index.html");
    expect(isRendererUrl("http://127.0.0.1:5173/", "http://127.0.0.1:5173", entry, true)).toBe(true);
    expect(isRendererUrl("http://127.0.0.1:5173/evil", "http://127.0.0.1:5173", entry, true)).toBe(false);
    expect(isRendererUrl("https://example.com/", "http://127.0.0.1:5173", entry, true)).toBe(false);
    expect(isRendererUrl("file:///C:/evil.html", "", entry, false)).toBe(false);
    const frame = { url: "http://127.0.0.1:5173/" };
    const wc = { mainFrame: frame };
    const win = { webContents: wc, isDestroyed: () => false };
    expect(() => assertRendererSender({ sender: wc, senderFrame: frame }, win, frame.url, entry, true)).not.toThrow();
    expect(() => assertRendererSender({ sender: wc, senderFrame: { ...frame } }, win, frame.url, entry, true)).toThrow();
    expect(() => assertRendererSender({ sender: {}, senderFrame: frame }, win, frame.url, entry, true)).toThrow();
  });
});

describe("MCP main-process permissions", () => {
  it("rejects unconfigured tools, denied actions and disabled servers before computer access", async () => {
    const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    const clipboard = { readText: vi.fn(() => "secret") };
    const fakeFs = { readFileSync: () => "[]", mkdirSync: vi.fn(), writeFileSync: vi.fn() };
    const mod = { exports: {} as { registerMcpIpc: (...args: unknown[]) => void } };
    runInNewContext(readFileSync(resolve("main/mcp.js"), "utf8"), {
      module: mod, require: (name: string) => name === "electron" ? { app: { getPath: () => "scratch" }, clipboard } : name === "fs" ? fakeFs : name === "path" ? require("node:path") : require(resolve("main", name)),
      AbortController, setTimeout, clearTimeout,
    });
    const confirm = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mod.exports.registerMcpIpc({ handle: (name: string, fn: typeof handlers[string]) => { handlers[name] = fn; } }, { confirm, isAllowedPath: () => true });
    await expect(handlers["aqvenor:mcp"]({}, { builtin: "computer" }, "tools/call", { name: "clipboard_get" })).rejects.toThrow("enable");
    await handlers["aqvenor:mcpConfigure"]({}, [{ id: "pc", name: "Computer", target: "computer", transport: "builtin", enabled: true }]);
    await expect(handlers["aqvenor:mcp"]({}, { id: "pc" }, "tools/call", { name: "clipboard_get" })).rejects.toThrow("denied");
    expect(clipboard.readText).not.toHaveBeenCalled();
    await handlers["aqvenor:mcpConfigure"]({}, []);
    await expect(handlers["aqvenor:mcp"]({}, { id: "pc" }, "probe", {})).rejects.toThrow("enable");
  });
});

describe("bounded MCP response streams", () => {
  it("returns the matching SSE response without waiting for EOF", async () => {
    let cancelled = false;
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"id":99,"result":{}}\n\ndata: {"id":1,\n')); c.enqueue(new TextEncoder().encode('data: "result":{"ok":true}}\n\n')); }, cancel() { cancelled = true; } });
    expect(await readRpcResponse(new Response(stream, { headers: { "content-type": "text/event-stream" } }), 1)).toEqual({ ok: true });
    expect(cancelled).toBe(true);
  });
  it("enforces response size and response identity", async () => {
    await expect(readRpcResponse(new Response("x".repeat(20)), 1, 10)).rejects.toThrow("size limit");
    await expect(readRpcResponse(new Response('{"id":2,"result":{}}'), 1)).rejects.toThrow("id");
  });
});
