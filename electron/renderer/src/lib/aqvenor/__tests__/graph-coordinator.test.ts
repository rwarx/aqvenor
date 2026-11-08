import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphCoordinator, type CanvasDocument, type GraphSyncStatus } from "../graph-coordinator";
import type { GraphPersistenceState, GraphResult, ServerGraphSnapshot } from "../backend";

const saved: GraphPersistenceState = { state: "saved", privateSaved: true };
const viewport = { zoom: 1, panX: 0, panY: 0 };
const node = { id: "a", kind: "note" as const, title: "A", x: 0, y: 0, w: 180, h: 72 };
const snapshot = (nodes = [node], version = 10, persistence = saved): ServerGraphSnapshot => ({
  nodes: nodes.map(({ w, h, ...n }) => ({ ...n, width: w, height: h })), edges: [], version,
  workspaceRoot: "A", viewport, persistence, hasSavedGraph: true,
});
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function fixture(initial = snapshot()) {
  let shown: CanvasDocument = { nodes: [], edges: [], viewport };
  let status!: GraphSyncStatus;
  const rejected = vi.fn();
  const transport = {
    snapshot: vi.fn().mockResolvedValue(initial),
    apply: vi.fn<(...args: unknown[]) => Promise<GraphResult>>(),
    save: vi.fn().mockResolvedValue({ snapshot: initial, persistence: saved }),
    viewport: vi.fn().mockImplementation(async (_root, value) => ({ persistence: saved, viewport: value })),
  };
  const coordinator = new GraphCoordinator(transport, (doc) => { shown = doc; }, (s) => { status = s; }, rejected);
  coordinator.reset("A");
  return { coordinator, transport, rejected, edit(doc: CanvasDocument) { shown = doc; coordinator.edit(doc); }, get shown() { return shown; }, get status() { return status; } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("graph coordinator concurrency and durability", () => {
  it("coalesces drag frames and flushes the current viewport with the graph", async () => {
    const f = fixture(); await f.coordinator.refresh();
    f.transport.apply.mockResolvedValue({ snapshot: snapshot([{ ...node, x: 3 }]), rejected: [] });
    for (let x = 1; x <= 3; x++) f.edit({ ...f.shown, nodes: [{ ...node, x }], viewport: { zoom: 2, panX: 5, panY: 6 } });
    expect(f.transport.apply).not.toHaveBeenCalled();
    await f.coordinator.flush();
    expect(f.transport.apply).toHaveBeenCalledTimes(1);
    expect(f.transport.apply.mock.calls[0][1]).toEqual([{ kind: "move-node", nodeId: "a", x: 3, y: 0 }]);
    expect(f.transport.viewport).toHaveBeenCalledExactlyOnceWith("A", { zoom: 2, panX: 5, panY: 6 });
    expect(f.shown.viewport.zoom).toBe(2);
  });

  it("rebases newer movement over server normalization and agent-created nodes", async () => {
    const f = fixture(); await f.coordinator.refresh();
    const response = deferred<GraphResult>();
    f.transport.apply.mockReturnValueOnce(response.promise).mockResolvedValueOnce({ snapshot: snapshot([
      { ...node, title: "Canonical", x: 8 }, { ...node, id: "agent", title: "From agent" },
    ]), rejected: [] });
    f.edit({ ...f.shown, nodes: [{ ...node, title: "Requested", x: 1 }] });
    const flush = f.coordinator.flush(); await Promise.resolve(); await Promise.resolve();
    f.edit({ ...f.shown, nodes: [{ ...node, title: "Requested", x: 8 }] });
    response.resolve({ snapshot: snapshot([{ ...node, title: "Canonical", x: 1 }, { ...node, id: "agent", title: "From agent" }]), rejected: [] });
    await flush;
    expect(f.shown.nodes.map((n) => [n.id, n.title, n.x])).toEqual([["a", "Canonical", 8], ["agent", "From agent", 0]]);
    expect(f.transport.apply.mock.calls[1][1]).toEqual([{ kind: "move-node", nodeId: "a", x: 8, y: 0 }]);
  });

  it("retries the same mutation identity after a lost response", async () => {
    const f = fixture(); await f.coordinator.refresh();
    f.transport.apply.mockRejectedValueOnce(new Error("connection lost")).mockResolvedValueOnce({ snapshot: snapshot([{ ...node, x: 2 }]), rejected: [] });
    f.edit({ ...f.shown, nodes: [{ ...node, x: 2 }] });
    await expect(f.coordinator.flush()).rejects.toThrow("connection lost");
    expect(f.status.state).toBe("error"); expect(f.shown.nodes[0].x).toBe(2);
    await f.coordinator.flush();
    expect(f.transport.apply.mock.calls[0][4]).toBe(f.transport.apply.mock.calls[1][4]);
    expect(f.status.state).toBe("saved");
  });

  it("rolls back rejected changes to the canonical graph without resubmission", async () => {
    const f = fixture(); await f.coordinator.refresh();
    f.transport.apply.mockResolvedValue({ snapshot: snapshot(), rejected: ["Rejected change"] });
    f.edit({ ...f.shown, nodes: [{ ...node, title: "Invalid" }] });
    await f.coordinator.flush(); await f.coordinator.flush();
    expect(f.shown.nodes[0].title).toBe("A");
    expect(f.rejected).toHaveBeenCalledExactlyOnceWith(["Rejected change"]);
    expect(f.transport.apply).toHaveBeenCalledTimes(1);
  });

  it("retries persistence without applying an already accepted mutation twice", async () => {
    const error: GraphPersistenceState = { state: "error", privateSaved: false, error: "disk full" };
    const f = fixture(); await f.coordinator.refresh();
    const changed = snapshot([{ ...node, x: 2 }], 11, error);
    f.transport.apply.mockResolvedValue({ snapshot: changed, persistence: error, rejected: [], saved: false });
    f.transport.save.mockResolvedValueOnce({ snapshot: changed, persistence: error }).mockResolvedValueOnce({ snapshot: { ...changed, persistence: saved }, persistence: saved });
    f.edit({ ...f.shown, nodes: [{ ...node, x: 2 }] });
    await expect(f.coordinator.flush()).rejects.toThrow("disk full");
    await f.coordinator.flush();
    expect(f.transport.apply).toHaveBeenCalledTimes(1); expect(f.transport.save).toHaveBeenCalledTimes(2);
    expect(f.status.state).toBe("saved");
  });

  it("allows close after local durability while retaining a portable export error", async () => {
    const error: GraphPersistenceState = { state: "error", privateSaved: true, portableError: "file changed externally" };
    const f = fixture(snapshot([node], 10, error)); await f.coordinator.refresh();
    await expect(f.coordinator.flush()).resolves.toBeUndefined();
    expect(f.status.portableError).toBe("file changed externally"); expect(f.status.state).toBe("error");
  });

  it("ignores an old project's response after a workspace reset", async () => {
    const f = fixture(); await f.coordinator.refresh();
    const response = deferred<GraphResult>(); f.transport.apply.mockReturnValue(response.promise);
    f.edit({ ...f.shown, nodes: [{ ...node, x: 4 }] });
    const flush = f.coordinator.flush(); await Promise.resolve(); await Promise.resolve();
    f.coordinator.reset("B");
    f.transport.snapshot.mockResolvedValue({ ...snapshot([{ ...node, title: "B" }]), workspaceRoot: "B" });
    const refresh = f.coordinator.refresh();
    response.resolve({ snapshot: snapshot([{ ...node, x: 4 }]), rejected: [] });
    await flush; await refresh;
    expect(f.shown.nodes[0].title).toBe("B"); expect(f.shown.nodes[0].x).toBe(0);
  });

  it("accepts undo snapshots whose graph version goes backwards", async () => {
    const f = fixture(); await f.coordinator.refresh();
    await f.coordinator.refresh(async () => ({ snapshot: snapshot([{ ...node, title: "Before" }], 2), rejected: [] }));
    expect(f.shown.nodes[0].title).toBe("Before");
  });

  it("reports pending backend persistence and flushes it before closing", async () => {
    const pending: GraphPersistenceState = { state: "pending", privateSaved: false };
    const f = fixture(snapshot([node], 10, pending)); await f.coordinator.refresh();
    expect(f.status.state).toBe("pending");
    await f.coordinator.flush();
    expect(f.transport.save).toHaveBeenCalledOnce();
    expect(f.status.state).toBe("saved");
  });

  it("keeps edits made while fetching a snapshot", async () => {
    const f = fixture(); await f.coordinator.refresh();
    const response = deferred<ServerGraphSnapshot>(); const requested = deferred<void>();
    f.transport.snapshot.mockImplementationOnce(() => { requested.resolve(); return response.promise; });
    const refresh = f.coordinator.refresh(); await requested.promise;
    f.edit({ ...f.shown, nodes: [{ ...node, x: 9 }] });
    response.resolve(snapshot([{ ...node, title: "Agent title" }])); await refresh;
    expect(f.shown.nodes[0]).toMatchObject({ title: "Agent title", x: 9 }); expect(f.status.state).toBe("pending");
  });

  it("flushes graph edits that arrive during a viewport save before allowing close", async () => {
    const f = fixture(); await f.coordinator.refresh();
    const response = deferred<{ persistence: GraphPersistenceState; viewport: typeof viewport }>();
    const requested = deferred<void>();
    f.transport.viewport.mockImplementationOnce(() => { requested.resolve(); return response.promise; });
    f.transport.apply.mockResolvedValue({ snapshot: snapshot([{ ...node, x: 7 }]), rejected: [] });
    f.edit({ ...f.shown, viewport: { ...viewport, panX: 4 } });
    const flush = f.coordinator.flush(); await requested.promise;
    f.edit({ ...f.shown, nodes: [{ ...node, x: 7 }] });
    response.resolve({ persistence: saved, viewport: { ...viewport, panX: 4 } });
    await flush;
    expect(f.transport.apply).toHaveBeenCalledOnce();
    expect(f.shown.nodes[0].x).toBe(7);
  });
});
