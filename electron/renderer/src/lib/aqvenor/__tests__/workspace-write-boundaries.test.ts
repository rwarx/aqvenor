// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphResult, ServerGraphSnapshot } from "../backend";

vi.mock("../../../components/aqvenor/settings/McpSettings", () => ({ McpSettings: () => null }));
vi.mock("../../../components/aqvenor/settings/UpdatesSettings", () => ({ UpdatesSettings: () => null }));
vi.mock("../../../components/aqvenor/chat/ProviderStudio", () => ({ ProviderStudioLauncher: () => null }));

const firstRoot = "D:\\boundary-project-a";
const secondRoot = "D:\\boundary-project-b";
const path = "notes.txt";
const saved = { state: "saved" as const, privateSaved: true };
const initialViewport = { zoom: 1, panX: 0, panY: 0 };
const initialNode = { id: "note-a", kind: "Note", title: "A", x: 10, y: 20, width: 180, height: 72 };

function snapshot(root = firstRoot, patch: Partial<ServerGraphSnapshot> = {}): ServerGraphSnapshot {
  return { version: 1, workspaceRoot: root, nodes: [initialNode], edges: [], viewport: initialViewport,
    canUndo: false, canRedo: false, hasSavedGraph: true, persistence: saved, ...patch };
}
function result(patch: Partial<ServerGraphSnapshot> = {}): GraphResult {
  return { rejected: [], saved: true, snapshot: snapshot(firstRoot, patch), persistence: saved };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let mounted: Root | undefined;
let container: HTMLDivElement | undefined;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); localStorage.clear();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected boundary-test network request")));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  delete window.aqvenor;
});
afterEach(async () => {
  if (mounted) await act(async () => mounted!.unmount());
  mounted = undefined; container?.remove(); container = undefined;
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
  const graphSnapshot = vi.spyOn(backend.graph, "snapshot").mockImplementation(async (root) =>
    snapshot(root ?? currentRoot, root === secondRoot ? { nodes: [], edges: [] } : {}));
  const apply = vi.spyOn(backend.graph, "apply").mockResolvedValue(result());
  vi.spyOn(backend.graph, "save").mockResolvedValue({ saved: true, snapshot: snapshot(), persistence: saved });
  const viewport = vi.spyOn(backend.graph, "viewport").mockImplementation(async (_root, value) => ({ saved: true, persistence: saved, viewport: value }));
  const reindex = vi.spyOn(backend.graph, "reindex").mockResolvedValue(result());
  vi.spyOn(backend.workspace, "status").mockImplementation(async () => ({ isOpen: true, root: currentRoot }));
  const open = vi.spyOn(backend.workspace, "open").mockImplementation(async (root) => { currentRoot = root; return { root }; });
  vi.spyOn(backend.workspace, "list").mockResolvedValue({ path: ".", isTruncated: false, entries: [
    { path, name: path, isDirectory: false, size: 8, modifiedAt: "2026-11-08T00:00:00Z" },
  ] });
  const write = vi.spyOn(backend.workspace, "write").mockResolvedValue({ created: false, linesAfter: 1 });
  vi.spyOn(backend.workspace, "readDocument").mockResolvedValue({ path, content: "original", firstLine: 1, lineCount: 1, totalLines: 1, size: 8, isTruncated: false });
  useAqvenor.setState({ workspaceRoot: firstRoot });
  await sync.hydrateFromBackend();
  await vi.dynamicImportSettled();
  await sync.syncCanvas();
  useAqvenor.setState((state) => ({ files: state.files.map((file) => ({ ...file, content: "original", loadState: "loaded", workspaceRoot: firstRoot })) }));
  useAqvenor.getState().setUi({ locale: "en" });
  vi.clearAllMocks();
  return { backend, useAqvenor, sync, graphSnapshot, apply, viewport, reindex, open, write, setBackendRoot(root: string) { currentRoot = root; } };
}

describe("workspace persistence boundaries", () => {
  it("keeps the current project when Stop is unconfirmed and retries before the next transition", async () => {
    const f = await fixture();
    const agent = await import("../agent-live");
    const cancellation = deferred<boolean>();
    const retry = vi.spyOn(agent, "retryAgentCancellations").mockReturnValueOnce(cancellation.promise).mockResolvedValueOnce(true);
    const switching = f.sync.openWorkspaceByPath(secondRoot);
    const failedSwitch = expect(switching).rejects.toThrow("confirm");
    expect(f.useAqvenor.getState().workspaceSwitching).toBe(true);
    expect(f.open).not.toHaveBeenCalled();
    cancellation.resolve(false);
    await failedSwitch;
    expect(f.useAqvenor.getState().workspaceRoot).toBe(firstRoot);
    expect(f.useAqvenor.getState().workspaceSwitching).toBe(false);
    expect(f.useAqvenor.getState().graphSync.ready).toBe(true);
    await f.sync.openWorkspaceByPath(secondRoot);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(f.open).toHaveBeenCalledExactlyOnceWith(secondRoot);
  });

  it("rejects local graph and file edits while a checkpoint is restoring and shows the restored graph", async () => {
    const f = await fixture();
    const restore = deferred<{ restoredFiles: number; graphRestored: boolean }>();
    const checkpointRestore = vi.spyOn(f.backend.checkpoints, "restore").mockReturnValueOnce(restore.promise);
    const checkpointId = "78d1296f-2aae-4c59-bf10-326c0342f424";
    f.useAqvenor.getState().restoreCheckpoint(checkpointId);
    await vi.waitFor(() => expect(checkpointRestore).toHaveBeenCalledExactlyOnceWith(checkpointId));
    f.useAqvenor.getState().moveNodes([{ id: initialNode.id, x: 80, y: 90 }]);
    f.useAqvenor.getState().setFileContent(path, "typed during restore");
    const canvasDuringRestore = f.useAqvenor.getState().canvas;
    const fileDuringRestore = f.useAqvenor.getState().files.find((file) => file.path === path)?.content;
    f.graphSnapshot.mockResolvedValueOnce(snapshot(firstRoot, { nodes: [{ ...initialNode, title: "Restored checkpoint", x: 5, y: 6 }] }));
    restore.resolve({ restoredFiles: 1, graphRestored: true });
    await vi.waitFor(() => expect(f.useAqvenor.getState().canvas.nodes[0].title).toBe("Restored checkpoint"));
    expect(canvasDuringRestore.nodes[0]).toMatchObject({ x: 10, y: 20 });
    expect(fileDuringRestore).toBe("original");
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.useAqvenor.getState().canvas.nodes[0]).toMatchObject({ title: "Restored checkpoint", x: 5, y: 6 });
  });

  it("rejects graph, viewport and file edits after flushing while another project is opening", async () => {
    const f = await fixture();
    const opening = deferred<void>();
    f.open.mockImplementationOnce(async (root) => { await opening.promise; f.setBackendRoot(root); return { root }; });
    const switching = f.sync.openWorkspaceByPath(secondRoot);
    await vi.waitFor(() => expect(f.open).toHaveBeenCalledOnce());
    f.useAqvenor.getState().moveNodes([{ id: initialNode.id, x: 80, y: 90 }]);
    f.useAqvenor.getState().setViewport(0.5, 40, 50);
    f.useAqvenor.getState().setFileContent(path, "too late for the outgoing project");
    const canvasDuringSwitch = f.useAqvenor.getState().canvas;
    const fileDuringSwitch = f.useAqvenor.getState().files.find((file) => file.path === path)?.content;
    opening.resolve();
    await switching;
    expect(canvasDuringSwitch.nodes[0]).toMatchObject({ x: 10, y: 20 });
    expect(canvasDuringSwitch).toMatchObject(initialViewport);
    expect(fileDuringSwitch).toBe("original");
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.viewport).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });

  it("includes a file edit made while graph persistence is in flight in the same flush", async () => {
    const f = await fixture();
    const graphSave = deferred<GraphResult>();
    f.apply.mockReturnValueOnce(graphSave.promise);
    f.useAqvenor.getState().moveNode(initialNode.id, 30, 40);
    const flush = f.sync.flushPendingWrites();
    await vi.waitFor(() => expect(f.apply).toHaveBeenCalledOnce());
    f.useAqvenor.getState().setFileContent(path, "typed during graph save");
    graphSave.resolve(result({ nodes: [{ ...initialNode, x: 30, y: 40 }] }));
    await flush;
    expect(f.write).toHaveBeenCalledExactlyOnceWith(path, "typed during graph save", firstRoot, undefined);
    expect(f.sync.pendingWritePaths()).toEqual([]);
    expect(f.useAqvenor.getState().saveStatus[path]).toBe("saved");
  });

  it("waits for pending graph persistence when a folder is opened from Settings", async () => {
    const f = await fixture();
    const graphSave = deferred<GraphResult>();
    f.apply.mockReturnValueOnce(graphSave.promise);
    Object.defineProperty(window, "aqvenor", { configurable: true, value: { pickFolder: vi.fn().mockResolvedValue(secondRoot) } });
    vi.spyOn(f.backend.meta, "info").mockRejectedValue(new Error("No diagnostics in fixture"));
    vi.spyOn(f.backend.meta, "health").mockRejectedValue(new Error("No diagnostics in fixture"));
    vi.spyOn(f.backend.tools, "list").mockResolvedValue([]);
    const { default: SettingsView } = await import("../../../components/aqvenor/settings/SettingsView");
    container = document.createElement("div"); document.body.appendChild(container);
    mounted = createRoot(container);
    await act(async () => mounted!.render(createElement(SettingsView)));
    await act(async () => f.useAqvenor.getState().moveNode(initialNode.id, 30, 40));
    const openFolder = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Open folder"));
    expect(openFolder).toBeDefined();
    await act(async () => openFolder!.click());
    await vi.waitFor(() => expect(f.apply).toHaveBeenCalledOnce());
    const openedBeforeSave = f.open.mock.calls.length;
    await act(async () => graphSave.resolve(result({ nodes: [{ ...initialNode, x: 30, y: 40 }] })));
    await vi.waitFor(() => expect(f.open).toHaveBeenCalledExactlyOnceWith(secondRoot));
    expect(openedBeforeSave).toBe(0);
    expect(f.reindex).not.toHaveBeenCalled();
    expect(f.useAqvenor.getState().workspaceRoot).toBe(secondRoot);
  });
});
