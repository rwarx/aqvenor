"use strict";

/* ============================================================
   Aqvenor — MCP host bridge.
   Built-in MCP servers (memory / thinking / computer) served
   natively over the preload bridge, plus a fetch proxy so the
   renderer can talk to remote Streamable-HTTP MCP servers
   without the page's CSP ever having to allow arbitrary origins.
   ============================================================ */

const { app, clipboard, desktopCapturer, Notification, shell } = require("electron");
const fs = require("fs");
const path = require("path");

/* ---------- memory (between chats) ---------- */

const MEMORY_FILE = () => path.join(app.getPath("userData"), "mcp-memory.json");
const MEMORY_LIMIT = 500;

function loadMemories() {
  try {
    const raw = fs.readFileSync(MEMORY_FILE(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveMemories(list) {
  fs.mkdirSync(path.dirname(MEMORY_FILE()), { recursive: true });
  fs.writeFileSync(MEMORY_FILE(), JSON.stringify(list.slice(-MEMORY_LIMIT), null, 2), "utf8");
}

function memorySearch(list, query, limit) {
  const q = String(query ?? "").toLowerCase().trim();
  if (!q) return list.slice(-limit);
  const terms = q.split(/\s+/);
  const scored = list
    .map((m) => {
      const hay = `${m.text} ${(m.tags ?? []).join(" ")}`.toLowerCase();
      return { m, score: terms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.m.at - a.m.at);
  return scored.slice(0, limit).map((x) => x.m);
}

/* ---------- sequential thinking ---------- */

/* Thought chains keyed by a client-chosen session key; one chain per
   reasoning thread. Kept in memory only — a thought process is ephemeral. */
const thinkChains = new Map();

/* ---------- built-in server registry ---------- */

const BUILTIN_SERVERS = {
  memory: {
    tools: [
      {
        name: "memory_save",
        description: "Save a durable memory (fact, preference, decision) that persists across chats.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "The memory to keep, one concise sentence." },
            tags: { type: "array", items: { type: "string" }, description: "Optional search tags." },
          },
          required: ["text"],
        },
      },
      {
        name: "memory_search",
        description: "Search saved memories by keyword; returns the most relevant recent matches.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number", default: 5 },
          },
          required: ["query"],
        },
      },
      { name: "memory_list", description: "List every saved memory.", inputSchema: { type: "object", properties: {} } },
      {
        name: "memory_delete",
        description: "Delete a memory by id.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    ],
    call(tool, args) {
      const list = loadMemories();
      if (tool === "memory_save") {
        const text = String(args?.text ?? "").trim();
        if (!text) throw new Error("text is required");
        const entry = { id: `mem-${Date.now().toString(36)}`, text, tags: args?.tags ?? [], at: Date.now() };
        list.push(entry);
        saveMemories(list);
        return { saved: true, id: entry.id, total: Math.min(list.length, MEMORY_LIMIT) };
      }
      if (tool === "memory_search") {
        const hits = memorySearch(list, args?.query, Math.min(20, Math.max(1, args?.limit ?? 5)));
        return { memories: hits };
      }
      if (tool === "memory_list") return { memories: list.slice(-100) };
      if (tool === "memory_delete") {
        const next = list.filter((m) => m.id !== args?.id);
        saveMemories(next);
        return { deleted: next.length !== list.length };
      }
      throw new Error(`Unknown tool: ${tool}`);
    },
  },

  thinking: {
    tools: [
      {
        name: "sequentialthinking",
        description:
          "A structured scratchpad for step-by-step reasoning: log a numbered thought, revise earlier ones, and branch when an approach fails.",
        inputSchema: {
          type: "object",
          properties: {
            thought: { type: "string", description: "The current reasoning step." },
            nextThoughtRequired: { type: "boolean", description: "Whether another thought is needed." },
            thoughtNumber: { type: "number" },
            totalThoughts: { type: "number" },
            session: { type: "string", description: "Chain key; one chain per problem." },
            isRevision: { type: "boolean" },
            revisesThought: { type: "number" },
            branchFromThought: { type: "number" },
            branchId: { type: "string" },
          },
          required: ["thought", "nextThoughtRequired", "thoughtNumber", "totalThoughts"],
        },
      },
    ],
    call(tool, args) {
      if (tool !== "sequentialthinking") throw new Error(`Unknown tool: ${tool}`);
      const key = String(args?.session ?? "default");
      const chain = thinkChains.get(key) ?? [];
      const entry = {
        thought: String(args?.thought ?? ""),
        number: args?.thoughtNumber ?? chain.length + 1,
        isRevision: args?.isRevision === true,
        branch: args?.branchId ?? null,
        at: Date.now(),
      };
      chain.push(entry);
      if (chain.length > 100) thinkChains.set(key, chain.slice(-100));
      else thinkChains.set(key, chain);
      return {
        thoughtNumber: entry.number,
        totalThoughts: args?.totalThoughts ?? null,
        nextThoughtRequired: args?.nextThoughtRequired === true,
        branches: [...new Set(chain.map((t) => t.branch).filter(Boolean))],
        chainLength: chain.length,
      };
    },
  },

  computer: {
    tools: [
      {
        name: "screenshot",
        description: "Capture the screen and return a PNG data URL (what the user sees right now).",
        inputSchema: {
          type: "object",
          properties: { displayIndex: { type: "number", default: 0 } },
        },
      },
      {
        name: "open_path",
        description: "Open a file or folder on this computer with the OS default app.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      {
        name: "notify",
        description: "Show a desktop notification.",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" }, body: { type: "string" } },
          required: ["title"],
        },
      },
      {
        name: "clipboard_set",
        description: "Write text to the clipboard.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
      {
        name: "clipboard_get",
        description: "Read the clipboard text.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    async call(tool, args) {
      if (tool === "screenshot") {
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 1440, height: 900 },
        });
        const pick = sources[Math.max(0, args?.displayIndex ?? 0)] ?? sources[0];
        if (!pick) throw new Error("No display available to capture.");
        return { image: pick.thumbnail.toDataURL(), display: pick.display_id || pick.name };
      }
      if (tool === "open_path") {
        const errorMessage = await shell.openPath(String(args?.path ?? ""));
        if (errorMessage) throw new Error(errorMessage);
        return { opened: true };
      }
      if (tool === "notify") {
        if (!Notification.isSupported()) throw new Error("Notifications are not supported here.");
        new Notification({ title: String(args?.title ?? ""), body: String(args?.body ?? "") }).show();
        return { shown: true };
      }
      if (tool === "clipboard_set") {
        clipboard.writeText(String(args?.text ?? ""));
        return { ok: true };
      }
      if (tool === "clipboard_get") return { text: clipboard.readText() };
      throw new Error(`Unknown tool: ${tool}`);
    },
  },
};

/* ---------- remote Streamable-HTTP MCP servers ----------
   One initialize per URL (session id cached); every renderer call then POSTs
   a single JSON-RPC message. Responses may come back as JSON or as SSE —
   both shapes are parsed for the frame that answers our id. */

const remoteSessions = new Map(); // url -> session id | null

let rpcId = 0;

async function remoteCall(url, method, params, notify = false) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const sid = remoteSessions.get(url);
  if (sid) headers["Mcp-Session-Id"] = sid;

  const body = notify
    ? { jsonrpc: "2.0", method }
    : { jsonrpc: "2.0", id: ++rpcId, method, params: params ?? {} };

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`MCP server answered HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const newSid = res.headers.get("Mcp-Session-Id");
  if (newSid) remoteSessions.set(url, newSid);

  const contentType = res.headers.get("Content-Type") ?? "";
  const text = await res.text();
  if (contentType.includes("text/event-stream")) {
    // take the last data frame that parses and answers our id
    let found = null;
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const frame = JSON.parse(line.slice(5).trim());
        if (!notify && frame.id === body.id) found = frame;
      } catch {
        /* keepalive / partial frame */
      }
    }
    if (found?.error) throw new Error(found.error.message ?? "MCP call failed");
    return found?.result;
  }
  if (!text.trim()) return undefined;
  const frame = JSON.parse(text);
  if (frame.error) throw new Error(frame.error.message ?? "MCP call failed");
  return frame.result;
}

async function ensureRemoteSession(url) {
  if (remoteSessions.has(url)) return;
  const result = await remoteCall(url, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "aqvenor", version: "0.2.0" },
  }).catch((err) => {
    remoteSessions.delete(url);
    throw err;
  });
  if (!result) throw new Error("The MCP server did not complete initialization.");
  await remoteCall(url, "notifications/initialized", undefined, true).catch(() => undefined);
}

/** Drop a remote server's cached session (after a 404 on a stale id). */
function forgetRemote(url) {
  remoteSessions.delete(url);
}

/* ---------- the renderer-facing entry point ---------- */

/** Handle one MCP request from the renderer.
 *  @param {{builtin?: string, url?: string}} target
 *  @param {string} method  MCP method: "probe" | "tools/list" | "tools/call"
 *  @param {Record<string, unknown>} params  tool name/arguments for tools/call */
async function handleMcpRequest(target, method, params) {
  if (target?.builtin) {
    const server = BUILTIN_SERVERS[target.builtin];
    if (!server) throw new Error(`Unknown built-in MCP server '${target.builtin}'.`);
    if (method === "probe") {
      return { serverInfo: { name: target.builtin, version: "builtin" }, tools: server.tools.map(({ name, description }) => ({ name, description })) };
    }
    if (method === "tools/list") return { tools: server.tools };
    if (method === "tools/call") {
      const tool = String(params?.name ?? "");
      const args = params?.arguments ?? {};
      const result = await server.call(tool, args);
      return { content: [{ type: "text", text: JSON.stringify(result) }], raw: result };
    }
    throw new Error(`Built-in servers do not support '${method}'.`);
  }

  if (target?.url) {
    const url = String(target.url);
    if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) MCP endpoints are supported.");
    if (method === "probe" || method === "tools/list") {
      try {
        await ensureRemoteSession(url);
        const listed = await remoteCall(url, "tools/list", {});
        const tools = (listed?.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? "" }));
        return { tools };
      } catch (err) {
        // a stale session id is the one recoverable failure — retry once clean
        if (remoteSessions.has(url)) {
          forgetRemote(url);
          await ensureRemoteSession(url);
          const listed = await remoteCall(url, "tools/list", {});
          return { tools: (listed?.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? "" })) };
        }
        throw err;
      }
    }
    if (method === "tools/call") {
      await ensureRemoteSession(url);
      try {
        return await remoteCall(url, "tools/call", params ?? {});
      } catch (err) {
        forgetRemote(url);
        throw err;
      }
    }
    throw new Error(`Unsupported MCP method '${method}'.`);
  }

  throw new Error("An MCP request needs either a built-in server key or a server URL.");
}

function registerMcpIpc(ipcMain) {
  ipcMain.handle("aqvenor:mcp", (_event, target, method, params) =>
    handleMcpRequest(target, method, params).catch((err) => {
      throw new Error(err instanceof Error ? err.message : "The MCP request failed.");
    }),
  );
}

module.exports = { registerMcpIpc, handleMcpRequest, BUILTIN_SERVERS };
