"use client";

/* ============================================================
   .aqvenor — the per-project folder, à la .claude.
   Every project Aqvenor works in carries its own state on disk:
     .aqvenor/canvas.json — the spatial graph (nodes/edges/viewport)
     .aqvenor/mcp.json   — the MCP servers configured for the project
     .aqvenor/README.md  — one line saying what this folder is
   Writes are debounced and best-effort: the folder is a portable
   export, never a blocker for the app itself.
   ============================================================ */

import { workspace } from "./backend";
import { isServerMode } from "./sync";
import { useAqvenor } from "./store";
import { importMcpServers, serializeMcpServers } from "./mcp";
import type { CanvasEdge, CanvasNode } from "./types";

const AQ_DIR = ".aqvenor";
const CANVAS_FILE = `${AQ_DIR}/canvas.json`;
const MCP_FILE = `${AQ_DIR}/mcp.json`;
const README_FILE = `${AQ_DIR}/README.md`;

const README_CONTENT = `# .aqvenor

Aqvenor keeps its per-project state in this folder:

- \`canvas.json\` — the spatial canvas (nodes, edges, viewport)
- \`mcp.json\`    — MCP servers configured for this project

Both files are plain JSON; commit them to share the workspace setup.
`;

interface CanvasFile {
  version: number;
  savedAt: number;
  viewport: { zoom: number; panX: number; panY: number };
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

async function writeProjectFile(path: string, content: string): Promise<void> {
  if (!isServerMode()) return;
  if (!useAqvenor.getState().workspaceRoot) return;
  try {
    await workspace.write(path, content);
  } catch {
    /* best-effort: a read-only workspace must never break the app */
  }
}

/* ---------- canvas ---------- */

const CANVAS_WRITE_DELAY_MS = 1500;
let canvasTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCanvasWrite(): void {
  if (canvasTimer !== null) clearTimeout(canvasTimer);
  canvasTimer = setTimeout(() => {
    canvasTimer = null;
    const { canvas } = useAqvenor.getState();
    const file: CanvasFile = {
      version: 1,
      savedAt: Date.now(),
      viewport: { zoom: canvas.zoom, panX: canvas.panX, panY: canvas.panY },
      nodes: canvas.nodes.map(({ ...n }) => n),
      edges: canvas.edges.map(({ ...e }) => e),
    };
    void writeProjectFile(CANVAS_FILE, JSON.stringify(file, null, 2) + "\n");
  }, CANVAS_WRITE_DELAY_MS);
}

/* ---------- hydration ---------- */

/** Read .aqvenor from a freshly opened workspace: restore the canvas when the
 *  graph is still empty, and merge any MCP servers the project declares. */
export async function hydrateProjectFiles(): Promise<void> {
  if (!isServerMode()) return;
  if (!useAqvenor.getState().workspaceRoot) return;

  try {
    const res = await workspace.read(CANVAS_FILE, 1, 1_000_000);
    const parsed = JSON.parse(res.content) as Partial<CanvasFile>;
    if (Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
      const st = useAqvenor.getState();
      /* only seed from the file when there is nothing on screen yet — the
         server graph (and the person's current session) always win */
      if (st.canvas.nodes.length === 0) {
        st.setCanvas({
          nodes: parsed.nodes,
          edges: parsed.edges,
          selectedIds: [],
          primaryId: null,
          selectedEdgeId: null,
          selectedEdgeIds: [],
          ...(parsed.viewport
            ? { zoom: parsed.viewport.zoom, panX: parsed.viewport.panX, panY: parsed.viewport.panY }
            : {}),
        });
      }
    }
  } catch {
    /* no canvas.json — a fresh project */
  }

  try {
    const res = await workspace.read(MCP_FILE, 1, 100_000);
    importMcpServers(JSON.parse(res.content));
  } catch {
    /* no mcp.json */
  }
}

/* ---------- wiring ---------- */

/** Subscribe the folder's writers to the store. Call once from the app shell;
 *  returns an unsubscribe for tests. */
export function initProjectFileSync(): () => void {
  /* seed the folder's README once per workspace open */
  let knownRoot: string | null = null;

  const unsubCanvas = useAqvenor.subscribe((s, prev) => {
    if (s.canvas.nodes === prev.canvas.nodes && s.canvas.edges === prev.canvas.edges) return;
    scheduleCanvasWrite();
  });

  const unsubMcp = useAqvenor.subscribe((s, prev) => {
    if (s.mcpServers === prev.mcpServers) return;
    void writeProjectFile(MCP_FILE, serializeMcpServers(s.mcpServers));
  });

  const unsubRoot = useAqvenor.subscribe((s, prev) => {
    if (s.workspaceRoot === prev.workspaceRoot) return;
    if (s.workspaceRoot && s.workspaceRoot !== knownRoot) {
      knownRoot = s.workspaceRoot;
      void writeProjectFile(README_FILE, README_CONTENT);
      void hydrateProjectFiles();
    }
  });

  return () => {
    unsubCanvas();
    unsubMcp();
    unsubRoot();
  };
}
