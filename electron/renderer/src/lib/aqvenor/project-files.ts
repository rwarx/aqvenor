"use client";

/* ============================================================
   .aqvenor — the per-project folder, à la .claude.
   Every project Aqvenor works in carries its own state on disk:
     .aqvenor/canvas.json — the spatial graph (nodes/edges/viewport)
     .aqvenor/mcp.json   — the MCP servers configured for the project
     .aqvenor/README.md  — one line saying what this folder is
   The backend owns canvas.json; the renderer writes MCP configuration.
   ============================================================ */

import { workspace } from "./backend";
import { isServerMode } from "./sync";
import { useAqvenor } from "./store";
import { translate } from "./i18n";
import { hasAgentWorkInFlight, retryAgentCancellations } from "./agent-live";
import { configureMcpBridge, importMcpServers, isImportingMcpConfig, serializeMcpServers } from "./mcp";

const AQ_DIR = ".aqvenor";
const MCP_FILE = `${AQ_DIR}/mcp.json`;
const README_FILE = `${AQ_DIR}/README.md`;

const README_CONTENT = `# .aqvenor

Aqvenor keeps its per-project state in this folder:

- \`canvas.json\` — the spatial canvas (nodes, edges, viewport)
- \`mcp.json\`    — MCP servers configured for this project

The backend saves canvas.json as a portable export of its canonical graph.
Both files are plain JSON; commit them to share the workspace setup.
`;

async function writeProjectFile(path: string, content: string, root = useAqvenor.getState().workspaceRoot): Promise<void> {
  if (!isServerMode()) return;
  if (!useAqvenor.getState().workspaceRoot) return;

  try {
    await workspace.write(path, content, root);
  } catch {
    /* best-effort: a read-only workspace must never break the app */
  }
}

/* ---------- hydration ---------- */

/** Merge MCP servers declared by the project. Graph import belongs to the backend. */
export async function hydrateProjectFiles(): Promise<void> {
  if (!isServerMode()) return;
  if (!useAqvenor.getState().workspaceRoot) return;
  const root = useAqvenor.getState().workspaceRoot!;

  try {
    const status = await workspace.status();
    if (!status.isOpen || status.root !== root || useAqvenor.getState().workspaceRoot !== root) return;
    // This file is optional. Check directory entries instead of issuing a
    // document request that reports a failed HTTP response on every fresh project.
    const directory = await workspace.list(".", false);
    if (useAqvenor.getState().workspaceRoot !== root
      || !directory.entries.some((entry) => entry.isDirectory && entry.path.replace(/\\/g, "/") === AQ_DIR)) return;
    const configDirectory = await workspace.list(AQ_DIR, false);
    if (useAqvenor.getState().workspaceRoot !== root
      || !configDirectory.entries.some((entry) => !entry.isDirectory && entry.path.replace(/\\/g, "/") === MCP_FILE)) return;
    const res = await workspace.readDocument(MCP_FILE, root);
    if (res.isTruncated || useAqvenor.getState().workspaceRoot !== root) return;
    importMcpServers(JSON.parse(res.content), root);
  } catch {
    /* no mcp.json */
  }
}

/* ---------- wiring ---------- */

/** Subscribe the folder's writers to the store. Call once from the app shell;
 *  returns an unsubscribe for tests. */
export function initProjectFileSync(): () => void {
  const unsubUpdates = window.aqvenor?.updates?.onChanged((state) => {
    if (state.status !== "installing" && useAqvenor.getState().updateClosing) {
      useAqvenor.setState({ updateClosing: false });
    }
  });
  const unsubClose = window.aqvenor?.onPrepareClose((request, forUpdate = false) => {
    if (forUpdate) useAqvenor.setState({ updateClosing: true });
    const refuseUnsafeUpdate = async () => {
      if (!forUpdate) return false;
      const state = useAqvenor.getState();
      const activeSession = Object.values(state.runningSessions).some((run) => run.status === "running" || run.status === "awaiting-approval");
      if (!state.workspaceSwitching && !hasAgentWorkInFlight() && !activeSession) return false;
      state.pushToast(translate(state.ui.locale, "update.activeRun.title"), translate(state.ui.locale, state.workspaceSwitching ? "update.workspaceBusy" : "update.activeRun.description"), "destructive");
      useAqvenor.setState({ updateClosing: false });
      await window.aqvenor?.finishClose(request, false);
      return true;
    };
    void (async () => {
      try {
        if (forUpdate && !await retryAgentCancellations()) throw new Error(translate(useAqvenor.getState().ui.locale, "update.cancellationFailed"));
        if (await refuseUnsafeUpdate()) return;
        await useAqvenor.getState().flushPendingWrites();
        if (await refuseUnsafeUpdate()) return;
        await window.aqvenor?.finishClose(request, true);
      } catch (error) {
        if (forUpdate) useAqvenor.setState({ updateClosing: false });
        const state = useAqvenor.getState();
        state.pushToast(translate(state.ui.locale, "update.closeFailed"), error instanceof Error ? error.message : String(error), "destructive");
        // A disconnected bridge can reject both acknowledgements. Keep the
        // failed save visible without leaking an unhandled promise rejection.
        try { await window.aqvenor?.finishClose(request, false); } catch { /* bridge is unavailable */ }
      }
    })();
  });
  /* seed the folder's README once per workspace open */
  let knownRoot: string | null = null;

  const unsubMcp = useAqvenor.subscribe((s, prev) => {
    if (s.mcpServers === prev.mcpServers) return;
    void configureMcpBridge().catch(() => {});
    if (!isImportingMcpConfig()) void writeProjectFile(MCP_FILE, serializeMcpServers(s.mcpServers.filter((m) => m.projectRoot === s.workspaceRoot)));
  });

  const unsubRoot = useAqvenor.subscribe((s, prev) => {
    if (s.workspaceRoot === prev.workspaceRoot) return;
    void configureMcpBridge().catch(() => {});
    if (s.workspaceRoot && s.workspaceRoot !== knownRoot) {
      knownRoot = s.workspaceRoot;
      void writeProjectFile(README_FILE, README_CONTENT);
      void hydrateProjectFiles();
    }
  });

  return () => {
    unsubClose?.();
    unsubUpdates?.();
    unsubMcp();
    unsubRoot();
  };
}
