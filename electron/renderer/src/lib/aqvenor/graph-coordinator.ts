import type { GraphChangeInput, GraphPersistenceState, GraphResult, GraphViewport, ServerGraphSnapshot } from "./backend";
import type { CanvasEdge, CanvasNode, CanvasNodeStatus, EdgeKind, NodeKind } from "./types";

export interface CanvasDocument { nodes: CanvasNode[]; edges: CanvasEdge[]; viewport: GraphViewport }
export interface GraphSyncStatus {
  state: "local" | "loading" | "saved" | "pending" | "error";
  ready: boolean;
  error?: string;
  portableError?: string;
  canUndo: boolean;
  canRedo: boolean;
  hasSavedGraph?: boolean;
}
export const localGraphStatus: GraphSyncStatus = { state: "local", ready: true, canUndo: false, canRedo: false };
const empty = (): CanvasDocument => ({ nodes: [], edges: [], viewport: { zoom: 1, panX: 0, panY: 0 } });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const nodeKinds = new Set(["file", "folder", "module", "service", "interface", "data", "view", "test", "plan", "task", "agent", "model", "external", "note"]);
const edgeKinds = new Set(["contains", "depends", "calls", "implements", "relates", "plans"]);
const statuses = new Set(["pending", "running", "done", "failed"]);

export function canvasFromSnapshot(s: ServerGraphSnapshot, fallback: GraphViewport): CanvasDocument {
  return {
    nodes: s.nodes.map((n) => ({ id: n.id, kind: (nodeKinds.has(n.kind.toLowerCase()) ? n.kind.toLowerCase() : "note") as NodeKind,
      title: n.title, meta: n.subtitle ?? undefined, note: n.detail ?? undefined, path: n.path ?? undefined,
      x: n.x, y: n.y, w: n.width, h: n.height,
      status: statuses.has(n.status?.toLowerCase() ?? "") ? n.status!.toLowerCase() as CanvasNodeStatus : undefined })),
    edges: s.edges.map((e) => ({ id: e.id, from: e.sourceId, to: e.targetId,
      kind: (edgeKinds.has(e.kind.toLowerCase()) ? e.kind.toLowerCase() : "relates") as EdgeKind, note: e.label ?? undefined })),
    viewport: s.viewport ?? fallback,
  };
}

/** A field-level rebase keeps only edits made while a request was in flight. */
function rebaseItems<T extends { id: string }>(before: T[], after: T[], canonical: T[]): T[] {
  const old = new Map(before.map((n) => [n.id, n]));
  const next = new Map(after.map((n) => [n.id, n]));
  const result = new Map(canonical.map((n) => [n.id, n]));
  for (const n of before) if (!next.has(n.id)) result.delete(n.id);
  for (const n of after) {
    const previous = old.get(n.id);
    if (!previous) { result.set(n.id, n); continue; }
    const base = result.get(n.id);
    if (!base) continue; // a server deletion wins over a stale edit
    const patch: Partial<T> = {};
    for (const key of new Set([...Object.keys(previous), ...Object.keys(n)]) as Set<keyof T>) {
      if (!same(previous[key], n[key])) patch[key] = n[key];
    }
    result.set(n.id, { ...base, ...patch });
  }
  return [...result.values()];
}
export function rebaseCanvas(before: CanvasDocument, after: CanvasDocument, canonical: CanvasDocument): CanvasDocument {
  const nodes = rebaseItems(before.nodes, after.nodes, canonical.nodes);
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, edges: rebaseItems(before.edges, after.edges, canonical.edges).filter((e) => ids.has(e.from) && ids.has(e.to)),
    viewport: same(before.viewport, after.viewport) ? canonical.viewport : after.viewport };
}

export function diffCanvas(before: CanvasDocument, after: CanvasDocument): GraphChangeInput[] {
  const changes: GraphChangeInput[] = [];
  const nodes = new Map(before.nodes.map((n) => [n.id, n]));
  const edges = new Map(before.edges.map((e) => [e.id, e]));
  const nextNodes = new Set(after.nodes.map((n) => n.id));
  const nextEdges = new Map(after.edges.map((e) => [e.id, e]));
  for (const e of before.edges) {
    const next = nextEdges.get(e.id);
    if (!next || next.from !== e.from || next.to !== e.to) changes.push({ kind: "remove-edge", edgeId: e.id });
  }
  for (const n of before.nodes) if (!nextNodes.has(n.id)) changes.push({ kind: "remove-node", nodeId: n.id });
  for (const n of after.nodes) {
    const old = nodes.get(n.id);
    if (!old) {
      changes.push({ kind: "add-node", node: { id: n.id, kind: n.kind, title: n.title, subtitle: n.meta, detail: n.note, path: n.path,
        x: n.x, y: n.y, width: n.w, height: n.h, status: n.status } });
      continue;
    }
    if (old.x !== n.x || old.y !== n.y) changes.push({ kind: "move-node", nodeId: n.id, x: n.x, y: n.y });
    const patch: GraphChangeInput = { kind: "update-node", nodeId: n.id };
    if (old.title !== n.title) patch.title = n.title;
    if (old.kind !== n.kind) patch.nodeKind = n.kind;
    if (old.meta !== n.meta) patch.subtitle = n.meta ?? "";
    if (old.note !== n.note) patch.detail = n.note ?? "";
    if (old.path !== n.path) patch.path = n.path ?? "";
    if (old.w !== n.w) patch.width = n.w ?? 180;
    if (old.h !== n.h) patch.height = n.h ?? 72;
    if (Object.keys(patch).length > 2) changes.push(patch);
  }
  for (const e of after.edges) {
    const old = edges.get(e.id);
    if (!old || old.from !== e.from || old.to !== e.to) {
      changes.push({ kind: "add-edge", edge: { id: e.id, sourceId: e.from, targetId: e.to, kind: e.kind, label: e.note } });
    } else if (old.kind !== e.kind || old.note !== e.note) {
      changes.push({ kind: "update-edge", edgeId: e.id, ...(old.kind !== e.kind ? { edgeKind: e.kind } : {}),
        ...(old.note !== e.note ? { label: e.note ?? "" } : {}) });
    }
  }
  return changes;
}

interface GraphTransport {
  snapshot(root: string | null): Promise<ServerGraphSnapshot>;
  apply(title: string, changes: GraphChangeInput[], root: string | null, description?: string, requestId?: string): Promise<GraphResult>;
  save(root: string | null): Promise<{ snapshot: ServerGraphSnapshot; persistence: GraphPersistenceState }>;
  viewport(root: string | null, viewport: GraphViewport): Promise<{ persistence: GraphPersistenceState; viewport: GraphViewport }>;
}

/** One queue owns mutations, refreshes and persistence. Graph version can go backwards on undo. */
export class GraphCoordinator {
  private root: string | null = null;
  private epoch = 0;
  private ready = false;
  private canonical = empty();
  private desired = empty();
  private persistence?: GraphPersistenceState;
  private canUndo = false;
  private canRedo = false;
  private hasSavedGraph = true;
  private tail: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: { target: CanvasDocument; changes: GraphChangeInput[]; id: string };
  constructor(private transport: GraphTransport, private show: (doc: CanvasDocument, reset: boolean) => void,
    private status: (status: GraphSyncStatus) => void, private rejected: (reasons: string[]) => void, private delay = 300) {}
  get isReady(): boolean { return this.ready; }

  reset(root: string | null): void {
    this.epoch++; this.root = root; this.ready = false; this.pending = undefined;
    this.canonical = empty(); this.desired = empty(); this.persistence = undefined; this.canUndo = false; this.canRedo = false; this.hasSavedGraph = true;
    clearTimeout(this.timer); this.timer = undefined;
    this.show(this.desired, true); this.report("loading");
  }
  edit(doc: CanvasDocument): void {
    if (!this.ready) { this.show(this.desired, false); return; }
    this.desired = doc;
    if (same(this.canonical, doc)) return;
    this.report("pending"); this.schedule();
  }
  private schedule(): void {
    clearTimeout(this.timer);
    const epoch = this.epoch;
    this.timer = setTimeout(() => { this.timer = undefined; if (epoch === this.epoch) void this.flush().catch(() => {}); }, this.delay);
  }
  private report(state?: GraphSyncStatus["state"], error?: string): void {
    this.status({ state: state ?? this.persistence?.state ?? "saved", ready: this.ready,
      error: error ?? this.persistence?.error ?? undefined, portableError: this.persistence?.portableError ?? undefined,
      canUndo: this.canUndo, canRedo: this.canRedo, hasSavedGraph: this.hasSavedGraph });
  }
  private serial<T>(operation: (epoch: number, root: string | null) => Promise<T>): Promise<T> {
    const epoch = this.epoch, root = this.root;
    const job = this.tail.catch(() => {}).then(async () => {
      if (epoch !== this.epoch) return undefined as T;
      try { return await operation(epoch, root); }
      catch (error) { if (epoch === this.epoch) this.report("error", error instanceof Error ? error.message : String(error)); throw error; }
    });
    this.tail = job;
    return job;
  }
  private accept(snap: ServerGraphSnapshot, before: CanvasDocument, preserveViewport = false): void {
    if (snap.workspaceRoot !== undefined && snap.workspaceRoot !== this.root) throw new Error("Graph belongs to a different project.");
    const canonical = canvasFromSnapshot(snap, this.canonical.viewport);
    const viewport = this.desired.viewport;
    this.desired = rebaseCanvas(before, this.desired, canonical);
    if (preserveViewport) this.desired = { ...this.desired, viewport };
    this.canonical = canonical; this.persistence = snap.persistence;
    this.canUndo = snap.canUndo ?? this.canUndo; this.canRedo = snap.canRedo ?? this.canRedo;
    this.hasSavedGraph = snap.hasSavedGraph ?? true;
    this.ready = true; this.show(this.desired, false); this.report(same(this.canonical, this.desired) ? undefined : "pending");
  }
  async refresh(operation?: (root: string | null) => Promise<GraphResult>): Promise<void> {
    return this.serial(async (epoch, root) => {
      if (this.ready) await this.drain(epoch, root);
      if (epoch !== this.epoch) return;
      const before = this.desired;
      const result = operation ? await operation(root) : undefined;
      const snap = result?.snapshot ?? await this.transport.snapshot(root);
      if (epoch !== this.epoch) return;
      this.accept(snap, before);
      if (result?.rejected.length) this.rejected(result.rejected);
      if (!same(this.canonical, this.desired) || this.persistence?.state === "pending") this.schedule();
    });
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    return this.serial(async (epoch, root) => {
      if (!this.ready) throw new Error("Wait for the project graph to load before saving.");
      do {
        await this.drain(epoch, root);
        if (epoch !== this.epoch) return;
        if (this.persistence?.privateSaved === false || this.persistence?.state === "pending") {
          const before = this.desired;
          const result = await this.transport.save(root);
          if (epoch !== this.epoch) return;
          this.accept({ ...result.snapshot, persistence: result.persistence }, before);
        }
        if (this.persistence?.privateSaved === false) throw new Error(this.persistence.error ?? "Graph could not be saved.");
      } while (diffCanvas(this.canonical, this.desired).length || !same(this.canonical.viewport, this.desired.viewport));
    });
  }
  async retry(): Promise<void> {
    if (!this.ready) return this.refresh();
    await this.flush();
    return this.serial(async (epoch, root) => {
      const before = this.desired;
      const result = await this.transport.save(root);
      if (epoch === this.epoch) this.accept({ ...result.snapshot, persistence: result.persistence }, before);
    });
  }
  private async drain(epoch: number, root: string | null): Promise<void> {
    while (epoch === this.epoch) {
      if (!this.pending) {
        const changes = diffCanvas(this.canonical, this.desired);
        if (changes.length) this.pending = { target: this.desired, changes, id: crypto.randomUUID() };
      }
      if (!this.pending) {
        if (same(this.canonical.viewport, this.desired.viewport)) break;
        const viewport = this.desired.viewport;
        const result = await this.transport.viewport(root, viewport);
        if (epoch !== this.epoch) return;
        this.canonical = { ...this.canonical, viewport: result.viewport };
        this.persistence = result.persistence;
        if (same(viewport, this.desired.viewport)) {
          this.desired = { ...this.desired, viewport: result.viewport };
          this.show(this.desired, false);
        }
        continue;
      }
      const pending = this.pending;
      const result = await this.transport.apply("Edit canvas", pending.changes, root, undefined, pending.id);
      if (epoch !== this.epoch) return;
      this.pending = undefined;
      this.accept({ ...result.snapshot, persistence: result.persistence ?? result.snapshot.persistence }, pending.target, true);
      if (result.rejected.length) this.rejected(result.rejected);
    }
    if (epoch !== this.epoch) return;
    this.report();
  }
}
