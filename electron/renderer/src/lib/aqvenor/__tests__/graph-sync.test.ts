// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphResult, GraphViewport, ServerGraphSnapshot } from "../backend";

const firstRoot = "D:\\project-a";
const secondRoot = "D:\\project-b";
const saved = { state: "saved" as const, privateSaved: true };
const initialNodes = [
  { id: "node-a", kind: "Note", title: "A", x: 10, y: 20, width: 180, height: 72 },
  { id: "node-b", kind: "Note", title: "B", x: 100, y: 120, width: 180, height: 72 },
];
const initialEdges = [{ id: "edge-a-b", sourceId: "node-a", targetId: "node-b", kind: "Relates" }];

function snapshot(root = firstRoot, patch: Partial<ServerGraphSnapshot> = {}): ServerGraphSnapshot {
  return { version: 1, workspaceRoot: root, nodes: initialNodes, edges: initialEdges,
    viewport: { zoom: 1, panX: 0, panY: 0 }, canUndo: false, canRedo: false,
    hasSavedGraph: true, persistence: saved, ...patch };
}
function result(patch: Partial<ServerGraphSnapshot> = {}): GraphResult {
  return { rejected: [], saved: true, snapshot: snapshot(firstRoot, patch), persistence: saved };
}

let cleanup: (() => void) | undefined;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected graph-test network request")));
  localStorage.clear();
  delete window.aqvenor;
});
afterEach(() => {
  cleanup?.(); cleanup = undefined;
  vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
  delete window.aqvenor;
});

async function fixture() {
  const backend = await import("../backend");
  const { useAqvenor } = await import("../store");
  const sync = await import("../sync");
  await Promise.resolve();
  vi.spyOn(backend, "checkBackend").mockResolvedValue(true);
  vi.spyOn(backend.providers, "list").mockResolvedValue([]);
  vi.spyOn(backend.providers, "allModels").mockResolvedValue([]);
  vi.spyOn(backend.settings, "get").mockResolvedValue({});
  vi.spyOn(backend.conversations, "list").mockResolvedValue([]);
  vi.spyOn(backend.checkpoints, "list").mockResolvedValue([]);
  vi.spyOn(backend.projects, "list").mockResolvedValue([]);
  let currentRoot = firstRoot;
  const snapshots = new Map([[firstRoot, snapshot()], [secondRoot, snapshot(secondRoot, { nodes: [], edges: [] })]]);
  const graphSnapshot = vi.spyOn(backend.graph, "snapshot").mockImplementation(async (root) => snapshots.get(root ?? currentRoot)!);
  const apply = vi.spyOn(backend.graph, "apply").mockResolvedValue(result());
  const save = vi.spyOn(backend.graph, "save").mockResolvedValue({ saved: true, snapshot: snapshot(), persistence: saved });
  const viewport = vi.spyOn(backend.graph, "viewport").mockImplementation(async (_root, viewport) => ({ saved: true, persistence: saved, viewport }));
  const reindex = vi.spyOn(backend.graph, "reindex").mockResolvedValue(result());
  vi.spyOn(backend.workspace, "status").mockImplementation(async () => ({ isOpen: true, root: currentRoot }));
  vi.spyOn(backend.workspace, "open").mockImplementation(async (root) => { currentRoot = root; return { root }; });
  vi.spyOn(backend.workspace, "list").mockResolvedValue({ path: ".", isTruncated: false, entries: [] });
  const write = vi.spyOn(backend.workspace, "write").mockResolvedValue({ created: false, linesAfter: 1 });
  vi.spyOn(backend.workspace, "readDocument").mockRejectedValue(new Error("No project MCP configuration"));
  useAqvenor.setState({ workspaceRoot: firstRoot });
  await sync.hydrateFromBackend();
  await vi.dynamicImportSettled();
  await sync.syncCanvas();
  expect(useAqvenor.getState().graphSync).toMatchObject({ state: "saved", ready: true });
  vi.clearAllMocks();
  return { backend, useAqvenor, sync, graphSnapshot, apply, save, viewport, reindex, write, snapshots };
}

describe("store actions through the shared graph coordinator", () => {
  it("batches a multi-node drag and persists only the final positions with the captured project", async () => {
    const { useAqvenor, sync, apply } = await fixture();
    useAqvenor.getState().moveNodes([{ id: "node-a", x: 40, y: 50 }, { id: "node-b", x: 140, y: 150 }]);
    useAqvenor.getState().moveNodes([{ id: "node-a", x: 60, y: 70 }, { id: "node-b", x: 160, y: 170 }], true);
    expect(apply).not.toHaveBeenCalled();
    expect(useAqvenor.getState().graphSync.state).toBe("pending");
    apply.mockResolvedValueOnce(result({ version: 2, nodes: initialNodes.map((node, index) => ({ ...node, x: index === 0 ? 60 : 160, y: index === 0 ? 70 : 170 })), canUndo: true }));
    await sync.flushPendingWrites();
    expect(apply).toHaveBeenCalledExactlyOnceWith("Edit canvas", [
      { kind: "move-node", nodeId: "node-a", x: 60, y: 70 },
      { kind: "move-node", nodeId: "node-b", x: 160, y: 170 },
    ], firstRoot, undefined, expect.any(String));
    expect(useAqvenor.getState().canvas.nodes.map(({ x, y }) => ({ x, y }))).toEqual([{ x: 60, y: 70 }, { x: 160, y: 170 }]);
    expect(useAqvenor.getState().graphSync).toMatchObject({ state: "saved", canUndo: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("captures generic setCanvas alignment and node removal with incident edges", async () => {
    const { useAqvenor, sync, apply } = await fixture();
    const aligned = initialNodes.map((node) => ({ ...node, x: 15 }));
    apply.mockResolvedValueOnce(result({ nodes: aligned, canUndo: true }));
    useAqvenor.getState().setCanvas({ nodes: useAqvenor.getState().canvas.nodes.map((node) => ({ ...node, x: 15 })) });
    await sync.flushPendingWrites();
    expect(apply.mock.calls[0][1]).toEqual([
      { kind: "move-node", nodeId: "node-a", x: 15, y: 20 },
      { kind: "move-node", nodeId: "node-b", x: 15, y: 120 },
    ]);
    useAqvenor.getState().setCanvas({ selectedIds: ["node-a"], primaryId: "node-a", selectedEdgeId: "edge-a-b" });
    useAqvenor.getState().setCanvas({ nodes: useAqvenor.getState().canvas.nodes.filter((node) => node.id !== "node-a"), edges: [] });
    apply.mockResolvedValueOnce(result({ nodes: [aligned[1]], edges: [] }));
    await sync.flushPendingWrites();
    expect(apply.mock.calls[1][1]).toEqual([{ kind: "remove-edge", edgeId: "edge-a-b" }, { kind: "remove-node", nodeId: "node-a" }]);
    expect(useAqvenor.getState().canvas).toMatchObject({ selectedIds: [], primaryId: null, selectedEdgeId: null, selectedEdgeIds: [] });
  });

  it("does not persist selections or undo snapshot bookkeeping and never mirrors canvas.json from the renderer", async () => {
    const { useAqvenor, sync, apply, viewport, write } = await fixture();
    const { initProjectFileSync } = await import("../project-files");
    cleanup = initProjectFileSync();
    useAqvenor.getState().selectNode("node-a");
    useAqvenor.getState().selectEdge("edge-a-b");
    useAqvenor.getState().setSelectedEdgeIds(["edge-a-b"]);
    useAqvenor.getState().clearSelection();
    useAqvenor.getState().pushUndoSnapshot();
    await vi.advanceTimersByTimeAsync(2000);
    await sync.flushPendingWrites();
    expect(apply).not.toHaveBeenCalled();
    expect(viewport).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(useAqvenor.getState().graphSync.state).toBe("saved");
  });

  it("flushes the latest viewport without manufacturing a graph mutation", async () => {
    const { useAqvenor, sync, apply, viewport } = await fixture();
    useAqvenor.getState().setViewport(0.75, 40, 50);
    useAqvenor.getState().panBy(5, 15);
    expect(viewport).not.toHaveBeenCalled();
    await sync.flushPendingWrites();
    expect(apply).not.toHaveBeenCalled();
    expect(viewport).toHaveBeenCalledExactlyOnceWith(firstRoot, { zoom: 0.75, panX: 45, panY: 65 });
    expect(useAqvenor.getState().graphSync.state).toBe("saved");
  });

  it("clears selection and local history on project switch and respects an intentionally saved empty graph", async () => {
    const { useAqvenor, sync, graphSnapshot, reindex, apply } = await fixture();
    useAqvenor.getState().selectNode("node-a");
    useAqvenor.getState().selectEdge("edge-a-b");
    useAqvenor.getState().pushUndoSnapshot();
    useAqvenor.setState({ canvasRedo: [...useAqvenor.getState().canvasUndo] });
    expect(await sync.openWorkspaceByPath(secondRoot)).toBe(secondRoot);
    expect(graphSnapshot).toHaveBeenCalledWith(secondRoot);
    expect(reindex).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(useAqvenor.getState()).toMatchObject({ workspaceRoot: secondRoot, canvasUndo: [], canvasRedo: [],
      canvas: { nodes: [], edges: [], selectedIds: [], primaryId: null, selectedEdgeId: null, selectedEdgeIds: [] },
      graphSync: { state: "saved", hasSavedGraph: true, canUndo: false, canRedo: false } });
  });

  it("acknowledges close only after graph and viewport persistence settle", async () => {
    const { useAqvenor, apply, viewport } = await fixture();
    let close!: (request: string) => void;
    const finishClose = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "aqvenor", { configurable: true, value: {
      onPrepareClose: (callback: typeof close) => { close = callback; return vi.fn(); }, finishClose,
    } });
    const { initProjectFileSync } = await import("../project-files");
    cleanup = initProjectFileSync();
    useAqvenor.getState().moveNodes([{ id: "node-a", x: 33, y: 44 }]);
    useAqvenor.getState().setViewport(0.5, 12, 34);
    let persist!: (response: GraphResult) => void;
    apply.mockReturnValueOnce(new Promise<GraphResult>((resolve) => { persist = resolve; }));
    let persistViewport!: (response: { saved: boolean; persistence: typeof saved; viewport: GraphViewport }) => void;
    viewport.mockReturnValueOnce(new Promise((resolve) => { persistViewport = resolve; }));
    close("update-request");
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(finishClose).not.toHaveBeenCalled();
    persist(result({ nodes: [{ ...initialNodes[0], x: 33, y: 44 }, initialNodes[1]] }));
    await vi.waitFor(() => expect(viewport).toHaveBeenCalledOnce());
    expect(finishClose).not.toHaveBeenCalled();
    persistViewport({ saved: true, persistence: saved, viewport: { zoom: 0.5, panX: 12, panY: 34 } });
    await vi.waitFor(() => expect(finishClose).toHaveBeenCalledExactlyOnceWith("update-request", true));
  });

  it("rejects the close acknowledgement when graph persistence fails and keeps the user's pending graph", async () => {
    const { useAqvenor, apply } = await fixture();
    let close!: (request: string) => void;
    const finishClose = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "aqvenor", { configurable: true, value: {
      onPrepareClose: (callback: typeof close) => { close = callback; return vi.fn(); }, finishClose,
    } });
    const { initProjectFileSync } = await import("../project-files");
    cleanup = initProjectFileSync();
    useAqvenor.getState().moveNode("node-a", 88, 99);
    apply.mockRejectedValueOnce(new Error("disk unavailable"));
    close("failed-update-request");
    await vi.waitFor(() => expect(finishClose).toHaveBeenCalledExactlyOnceWith("failed-update-request", false));
    expect(useAqvenor.getState().graphSync).toMatchObject({ state: "error", ready: true, error: "disk unavailable" });
    expect(useAqvenor.getState().canvas.nodes[0]).toMatchObject({ id: "node-a", x: 88, y: 99 });
  });

  it.each(["running", "awaiting-approval"] as const)("refuses an update restart before flushing a %s session", async (status) => {
    const { useAqvenor } = await fixture();
    const flush = vi.fn().mockResolvedValue(undefined);
    useAqvenor.setState({ runningSessions: { background: { status } }, flushPendingWrites: flush });
    useAqvenor.getState().setUi({ locale: "ru" });
    let close!: (request: string, forUpdate?: boolean) => void;
    const finishClose = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "aqvenor", { configurable: true, value: {
      onPrepareClose: (callback: typeof close) => { close = callback; return vi.fn(); }, finishClose,
    } });
    const { initProjectFileSync } = await import("../project-files");
    cleanup = initProjectFileSync();
    close("active-update", true);
    await vi.waitFor(() => expect(finishClose).toHaveBeenCalledExactlyOnceWith("active-update", false));
    expect(flush).not.toHaveBeenCalled();
    expect(useAqvenor.getState().updateClosing).toBe(false);
    expect(useAqvenor.getState().toasts.at(-1)).toMatchObject({ title: "Перезапуск отложен", description: expect.stringContaining("Завершите или остановите") });
  });

  it("rechecks active sessions after flushing and resets the update gate after installer failure", async () => {
    const { useAqvenor } = await fixture();
    let flushed!: () => void;
    const flush = vi.fn().mockReturnValue(new Promise<void>((resolve) => { flushed = resolve; }));
    useAqvenor.setState({ flushPendingWrites: flush });
    let close!: (request: string, forUpdate?: boolean) => void;
    let changed!: (state: { status: string }) => void;
    const finishClose = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "aqvenor", { configurable: true, value: {
      onPrepareClose: (callback: typeof close) => { close = callback; return vi.fn(); }, finishClose,
      updates: { onChanged: (callback: typeof changed) => { changed = callback; return vi.fn(); } },
    } });
    const { initProjectFileSync } = await import("../project-files");
    cleanup = initProjectFileSync();
    close("late-run-update", true);
    expect(useAqvenor.getState().updateClosing).toBe(true);
    expect(finishClose).not.toHaveBeenCalled();
    useAqvenor.setState({ runningSessions: { background: { status: "running" } } });
    flushed();
    await vi.waitFor(() => expect(finishClose).toHaveBeenCalledExactlyOnceWith("late-run-update", false));
    expect(useAqvenor.getState().updateClosing).toBe(false);
    useAqvenor.setState({ runningSessions: {} });
    close("safe-update", true);
    await vi.waitFor(() => expect(finishClose).toHaveBeenCalledWith("safe-update", true));
    expect(useAqvenor.getState().updateClosing).toBe(true);
    changed({ status: "downloaded" });
    expect(useAqvenor.getState().updateClosing).toBe(false);
  });

  it("keeps ordinary close behavior while a session is active", async () => {
    const { useAqvenor } = await fixture();
    const flush = vi.fn().mockResolvedValue(undefined);
    useAqvenor.setState({ runningSessions: { background: { status: "running" } }, flushPendingWrites: flush });
    let close!: (request: string, forUpdate?: boolean) => void;
    const finishClose = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "aqvenor", { configurable: true, value: {
      onPrepareClose: (callback: typeof close) => { close = callback; return vi.fn(); }, finishClose,
    } });
    const { initProjectFileSync } = await import("../project-files");
    cleanup = initProjectFileSync();
    close("ordinary-close");
    await vi.waitFor(() => expect(finishClose).toHaveBeenCalledExactlyOnceWith("ordinary-close", true));
    expect(flush).toHaveBeenCalledOnce();
    expect(useAqvenor.getState().updateClosing).toBe(false);
  });

  it("contains both close acknowledgement IPC failures and releases the update gate", async () => {
    const { useAqvenor } = await fixture();
    useAqvenor.setState({ flushPendingWrites: vi.fn().mockResolvedValue(undefined) });
    let close!: (request: string, forUpdate?: boolean) => void;
    const finishClose = vi.fn().mockRejectedValue(new Error("desktop bridge disconnected"));
    Object.defineProperty(window, "aqvenor", { configurable: true, value: {
      onPrepareClose: (callback: typeof close) => { close = callback; return vi.fn(); }, finishClose,
    } });
    const { initProjectFileSync } = await import("../project-files");
    cleanup = initProjectFileSync();
    close("lost-bridge-update", true);
    await vi.waitFor(() => expect(finishClose).toHaveBeenCalledTimes(2));
    expect(finishClose.mock.calls).toEqual([["lost-bridge-update", true], ["lost-bridge-update", false]]);
    expect(useAqvenor.getState().updateClosing).toBe(false);
    expect(useAqvenor.getState().toasts.at(-1)?.description).toContain("desktop bridge disconnected");
    await vi.advanceTimersByTimeAsync(0);
  });

  it.each(["before", "during"] as const)("refuses an update when a project switch starts %s its flush", async (phase) => {
    const { useAqvenor } = await fixture();
    let flushed!: () => void;
    const flush = vi.fn().mockImplementation(() => phase === "during" ? new Promise<void>((resolve) => { flushed = resolve; }) : Promise.resolve());
    useAqvenor.setState({ workspaceSwitching: phase === "before", flushPendingWrites: flush });
    useAqvenor.getState().setUi({ locale: "en" });
    let close!: (request: string, forUpdate?: boolean) => void;
    const finishClose = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "aqvenor", { configurable: true, value: {
      onPrepareClose: (callback: typeof close) => { close = callback; return vi.fn(); }, finishClose,
    } });
    const { initProjectFileSync } = await import("../project-files");
    cleanup = initProjectFileSync();
    close("project-switch-update", true);
    if (phase === "during") {
      await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
      useAqvenor.setState({ workspaceSwitching: true });
      flushed();
    }
    await vi.waitFor(() => expect(finishClose).toHaveBeenCalledExactlyOnceWith("project-switch-update", false));
    expect(flush).toHaveBeenCalledTimes(phase === "during" ? 1 : 0);
    expect(useAqvenor.getState().updateClosing).toBe(false);
    expect(useAqvenor.getState().toasts.at(-1)?.description).toContain("project finishes opening or restoring");
  });
});
