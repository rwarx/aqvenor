// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "../types";
import type { GraphSyncStatus } from "../graph-coordinator";

vi.mock("../sync", () => ({
  isServerMode: vi.fn(() => true),
  openWorkspaceByPath: vi.fn(),
  CANVAS_FIT_EVENT: "aqvenor:canvas-fit",
}));
vi.mock("../../../components/aqvenor/canvas/CanvasNodeCard", () => ({ default: () => null }));
vi.mock("../../../components/aqvenor/canvas/MiniMap", () => ({ MiniMap: () => null }));

const firstRoot = "D:\\viewport-project-a";
const secondRoot = "D:\\viewport-project-b";
const savedViewport = { zoom: 0.8, panX: 100, panY: 80 };
const otherViewport = { zoom: 1.15, panX: -35, panY: 77 };
const nodes: CanvasNode[] = [{ id: "saved-node", kind: "note", title: "Saved", x: 1200, y: 900, w: 180, h: 72 }];
const saved: GraphSyncStatus = { state: "saved", ready: true, hasSavedGraph: true, canUndo: false, canRedo: false };
const loading: GraphSyncStatus = { ...saved, state: "loading", ready: false };

let mounted: Root | undefined;
let container: HTMLDivElement | undefined;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 800, height: 600, top: 0, left: 0, bottom: 600, right: 800, x: 0, y: 0, toJSON: () => ({}),
  });
});
afterEach(async () => {
  if (mounted) await act(async () => mounted!.unmount());
  mounted = undefined; container?.remove(); container = undefined;
  vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

async function fixture(status = saved, graphNodes = nodes, viewport = savedViewport, server = true) {
  const sync = await import("../sync");
  vi.mocked(sync.isServerMode).mockReturnValue(server);
  const { useAqvenor } = await import("../store");
  useAqvenor.setState((state) => ({ workspaceRoot: firstRoot, graphSync: status,
    canvas: { ...state.canvas, nodes: graphNodes, edges: [], ...viewport, selectedIds: [], primaryId: null, selectedEdgeId: null, selectedEdgeIds: [] },
  }));
  useAqvenor.getState().setUi({ locale: "en" });
  const setViewport = useAqvenor.getState().setViewport;
  const writes = vi.fn(setViewport);
  useAqvenor.setState({ setViewport: writes });
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  const { default: CanvasView } = await import("../../../components/aqvenor/canvas/CanvasView");
  const utils = await import("../../../components/aqvenor/canvas/canvas-utils");
  container = document.createElement("div"); document.body.appendChild(container);
  mounted = createRoot(container);
  await act(async () => mounted!.render(createElement(CanvasView)));
  return { useAqvenor, writes, focus, sync, utils };
}

describe("canvas viewport hydration", () => {
  it("retains a saved server viewport when the measured canvas first mounts", async () => {
    const f = await fixture();
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.useAqvenor.getState().canvas).toMatchObject(savedViewport);
  });

  it("waits for hydration before focusing and retains the loaded server viewport", async () => {
    const f = await fixture(loading, [], { zoom: 1, panX: 0, panY: 0 });
    const prematureWrites = f.writes.mock.calls.length;
    const prematureFocus = f.focus.mock.calls.length;
    f.writes.mockClear();
    await act(async () => f.useAqvenor.setState((state) => ({ graphSync: saved,
      canvas: { ...state.canvas, nodes, ...savedViewport },
    })));
    expect(prematureWrites).toBe(0);
    expect(prematureFocus).toBe(0);
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.useAqvenor.getState().canvas).toMatchObject(savedViewport);
  });

  it("retains another saved project's viewport across empty-to-populated loading", async () => {
    const f = await fixture();
    f.writes.mockClear();
    await act(async () => f.useAqvenor.setState((state) => ({ workspaceRoot: secondRoot, graphSync: loading,
      canvas: { ...state.canvas, nodes: [], zoom: 1, panX: 0, panY: 0 },
    })));
    await act(async () => f.useAqvenor.setState((state) => ({ graphSync: saved,
      canvas: { ...state.canvas, nodes: [{ ...nodes[0], id: "other-node" }], ...otherViewport },
    })));
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.useAqvenor.getState().canvas).toMatchObject(otherViewport);
  });

  it("defers an explicit fit for a newly indexed graph until the workspace is ready", async () => {
    const initial = { zoom: 1, panX: 0, panY: 0 };
    const f = await fixture(loading, [], initial);
    f.writes.mockClear();
    await act(async () => {
      f.useAqvenor.setState((state) => ({ canvas: { ...state.canvas, nodes } }));
      window.dispatchEvent(new Event(f.sync.CANVAS_FIT_EVENT));
    });
    const prematureWrites = f.writes.mock.calls.length;
    f.writes.mockClear();
    await act(async () => f.useAqvenor.setState({ graphSync: saved }));
    const fitted = f.utils.computeFit(nodes, 800, 600);
    expect(prematureWrites).toBe(0);
    expect(f.writes).toHaveBeenCalledExactlyOnceWith(fitted.zoom, fitted.panX, fitted.panY);
    expect(f.useAqvenor.getState().canvas).toMatchObject(fitted);
  });

  it("ignores node focus requests while the server graph is unavailable", async () => {
    const f = await fixture(loading);
    f.writes.mockClear(); f.focus.mockClear();
    await act(async () => window.dispatchEvent(new CustomEvent(f.utils.FOCUS_NODE_EVENT, { detail: { id: nodes[0].id } })));
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.focus).not.toHaveBeenCalled();
  });

  it("discards an earlier project's deferred fit when a saved project opens", async () => {
    const f = await fixture(loading);
    await act(async () => window.dispatchEvent(new Event(f.sync.CANVAS_FIT_EVENT)));
    await act(async () => f.useAqvenor.setState((state) => ({ workspaceRoot: secondRoot,
      canvas: { ...state.canvas, nodes: [], ...otherViewport },
    })));
    await act(async () => f.useAqvenor.setState((state) => ({ graphSync: saved,
      canvas: { ...state.canvas, nodes: [{ ...nodes[0], id: "other-node" }], ...otherViewport },
    })));
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.useAqvenor.getState().canvas).toMatchObject(otherViewport);
  });

  it("fits a ready server graph when the user explicitly requests it", async () => {
    const f = await fixture();
    await act(async () => window.dispatchEvent(new Event(f.sync.CANVAS_FIT_EVENT)));
    const fitted = f.utils.computeFit(nodes, 800, 600);
    expect(f.writes).toHaveBeenCalledExactlyOnceWith(fitted.zoom, fitted.panX, fitted.panY);
  });

  it("continues to fit an untouched local graph on its initial mount", async () => {
    const f = await fixture({ ...saved, state: "local" }, nodes, savedViewport, false);
    const fitted = f.utils.computeFit(nodes, 800, 600);
    expect(f.writes).toHaveBeenCalledExactlyOnceWith(fitted.zoom, fitted.panX, fitted.panY);
    expect(f.useAqvenor.getState().canvas).toMatchObject(fitted);
  });
});
