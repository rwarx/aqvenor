"use client";

/* ============================================================
   MCP client (renderer side).
   Configuration lives in the store (persisted + mirrored to the
   workspace's .aqvenor/mcp.json); requests ride the preload
   bridge into the main process, which serves the built-in
   servers (memory / thinking / computer) and proxies remote
   Streamable-HTTP endpoints.
   ============================================================ */

import { useAqvenor } from "./store";
import type { McpServerConfig } from "./types";

/** Built-in servers shipped with the app — installable with one click
 *  from Settings → Tools & Skills → MCP. */
export const MCP_BUILTINS: {
  key: string;
  nameKey: string;
  descKey: string;
}[] = [
  { key: "memory", nameKey: "mcp.builtin.memory.name", descKey: "mcp.builtin.memory.desc" },
  { key: "thinking", nameKey: "mcp.builtin.thinking.name", descKey: "mcp.builtin.thinking.desc" },
  { key: "computer", nameKey: "mcp.builtin.computer.name", descKey: "mcp.builtin.computer.desc" },
];

function bridge() {
  return typeof window !== "undefined" ? window.aqvenor?.mcp : undefined;
}

async function mcpRequest(
  cfg: { transport: "builtin" | "http"; target: string },
  method: "probe" | "tools/list" | "tools/call",
  params?: Record<string, unknown>,
): Promise<{ tools?: { name: string; description: string }[] } & Record<string, unknown>> {
  const b = bridge();
  if (!b) throw new Error("MCP servers are available in the desktop app.");
  const target = cfg.transport === "builtin" ? { builtin: cfg.target } : { url: cfg.target };
  return b(target, method, params);
}

/** (Re)probe one configured server: initialize + tools/list, cache the result
 *  in the store so the settings page can show the connected set. */
export async function probeMcpServer(cfg: McpServerConfig): Promise<void> {
  const { setMcpStatus } = useAqvenor.getState();
  setMcpStatus(cfg.id, { state: "connecting", tools: [], checkedAt: Date.now() });
  try {
    const result = await mcpRequest(cfg, "probe");
    setMcpStatus(cfg.id, {
      state: "connected",
      tools: result.tools ?? [],
      checkedAt: Date.now(),
    });
  } catch (err) {
    setMcpStatus(cfg.id, {
      state: "error",
      tools: [],
      error: err instanceof Error ? err.message : "probe failed",
      checkedAt: Date.now(),
    });
  }
}

/** Probe every enabled server (boot + after any change). Failures land in the
 *  per-server status; they never throw. */
export async function probeMcpServers(): Promise<void> {
  const { mcpServers } = useAqvenor.getState();
  await Promise.all(mcpServers.filter((s) => s.enabled).map((s) => probeMcpServer(s)));
}

export async function callMcpTool(
  cfg: McpServerConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await mcpRequest(cfg, "tools/call", { name, arguments: args });
  /* Built-ins return `raw`; remote servers return MCP content blocks. */
  if (result && typeof result === "object" && "raw" in result) {
    return result.raw as Record<string, unknown>;
  }
  return result;
}

function findBuiltin(key: string): McpServerConfig | undefined {
  return useAqvenor.getState().mcpServers.find((s) => s.transport === "builtin" && s.target === key && s.enabled);
}

/* ---------- memory-between-chats integration ---------- */

interface MemoryEntry {
  id: string;
  text: string;
  tags?: string[];
  at: number;
}

/** Retrieve memories relevant to `text` formatted as a turn attachment, or
 *  null when the memory server is off / empty / unreachable. The attachment
 *  rides the run like any staged file, so the agent sees prior context from
 *  OTHER chats without the request shape changing. */
export async function memoryContextFor(text: string): Promise<{
  fileName: string;
  mimeType: string;
  textContent: string;
} | null> {
  const cfg = findBuiltin("memory");
  if (!cfg) return null;
  try {
    const res = (await callMcpTool(cfg, "memory_search", { query: text.slice(0, 200), limit: 5 })) as {
      memories?: MemoryEntry[];
    };
    const memories = res.memories ?? [];
    if (memories.length === 0) return null;
    const body = memories
      .map((m) => `- ${m.text}`)
      .join("\n");
    return {
      fileName: "memory-context.md",
      mimeType: "text/markdown",
      textContent:
        `# Memory (from earlier chats, via the memory MCP server)\n\n` +
        `Facts the assistant previously learned about this user and their projects:\n\n${body}\n`,
    };
  } catch {
    return null; /* memory is an enhancement, never a blocker */
  }
}

/** Persist a short cross-chat memory after a completed run. Best effort. */
export async function rememberRun(sessionTitle: string, userText: string, answerText: string): Promise<void> {
  const cfg = findBuiltin("memory");
  if (!cfg) return;
  const summary = answerText.replace(/\s+/g, " ").trim().slice(0, 180);
  const fact = `${sessionTitle}: asked "${userText.replace(/\s+/g, " ").slice(0, 120)}" → ${summary}`;
  try {
    await callMcpTool(cfg, "memory_save", { text: fact, tags: ["chat", sessionTitle] });
  } catch {
    /* never surface — a background capture failure must not annoy anyone */
  }
}

/* ---------- .aqvenor/mcp.json (project-portable config) ---------- */

export interface McpProjectFile {
  version: number;
  servers: {
    name: string;
    transport: "builtin" | "http";
    target: string;
    enabled: boolean;
  }[];
}

export function serializeMcpServers(servers: McpServerConfig[]): string {
  const file: McpProjectFile = {
    version: 1,
    servers: servers.map((s) => ({
      name: s.name,
      transport: s.transport,
      target: s.target,
      enabled: s.enabled,
    })),
  };
  return JSON.stringify(file, null, 2) + "\n";
}

/** Merge servers parsed from a project's .aqvenor/mcp.json into the local
 *  set (by target) without duplicating what's already configured. */
export function importMcpServers(parsed: unknown): number {
  const file = parsed as Partial<McpProjectFile>;
  if (!file || !Array.isArray(file.servers)) return 0;
  const st = useAqvenor.getState();
  let added = 0;
  for (const s of file.servers) {
    if (!s || typeof s.target !== "string") continue;
    const exists = st.mcpServers.some((x) => x.transport === s.transport && x.target === s.target);
    if (exists) continue;
    st.addMcpServer({
      name: typeof s.name === "string" && s.name ? s.name : s.target,
      transport: s.transport === "builtin" ? "builtin" : "http",
      target: s.target,
      enabled: s.enabled !== false,
    });
    added += 1;
  }
  if (added > 0) void probeMcpServers();
  return added;
}
