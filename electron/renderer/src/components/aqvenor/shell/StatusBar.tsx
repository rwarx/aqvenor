"use client";

import { FolderOpen, Keyboard, Link2, Redo2, Sparkles, Undo2 } from "lucide-react";
import { useAqvenor } from "@/lib/aqvenor/store";
import { useT } from "@/lib/aqvenor/useT";
import { useModel } from "@/lib/aqvenor/useModel";
import { AqToolButton } from "@/components/aqvenor/ui";

export function StatusBar() {
  const t = useT();
  const runnerStatus = useAqvenor((s) => s.runner.status);
  const runnerLabel = useAqvenor((s) => s.runner.label);
  const selectedModelId = useAqvenor((s) => s.ui.selectedModelId);
  /* Selected to primitives rather than to `s.canvas`. Subscribing to the whole canvas object meant a
   new identity on every pan and zoom step — and `panBy` writes the object on each pointermove — so
   the status bar re-rendered continuously while the user dragged the canvas. It reads four scalars,
   and a selector that returns exactly those does not re-render when any of the other fifty
   properties change. */
const nodeCount = useAqvenor((s) => s.canvas.nodes.length);
const edgeCount = useAqvenor((s) => s.canvas.edges.length);
const canvasZoom = useAqvenor((s) => s.canvas.zoom);
const selectedEdgeKind = useAqvenor((s) => {
  const edge = s.canvas.edges.find((e) => e.id === s.canvas.selectedEdgeId);
  return edge?.kind ?? null;
});
  const surface = useAqvenor((s) => s.surface);
  const setSurface = useAqvenor((s) => s.setSurface);
  const undoCanvas = useAqvenor((s) => s.undoCanvas);
  const redoCanvas = useAqvenor((s) => s.redoCanvas);
  const canUndo = useAqvenor((s) => s.canvasUndo.length > 0);
  const canRedo = useAqvenor((s) => s.canvasRedo.length > 0);
  const setCheatsheetOpen = useAqvenor((s) => s.setCheatsheetOpen);

  /* real open-workspace name from the shared store.workspaceRoot (item 5 single
     source of truth) — falls back to the app name in demo mode / when nothing is
     open (no hardcoded project label). */
  const root = useAqvenor((s) => s.workspaceRoot);
  const projectName = root ? (root.split(/[/\\]/).filter(Boolean).pop() ?? root) : t("app.name");

  const model = useModel(selectedModelId);
  const generating = runnerStatus === "running" || runnerStatus === "awaiting-approval";
  const spatial = surface === "canvas" || surface === "graph";


  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-line-faint bg-surface-1 px-3">
      {/* left: workspace */}
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-fg-2" title={root ?? undefined}>
        <FolderOpen size={11} className="shrink-0 text-fg-3" />
        <span className="truncate">{projectName}</span>
      </span>

      <span className="hidden items-center gap-1.5 text-[11px] text-fg-3 md:flex">
        <span className="h-2.5 w-px bg-line" />
        <Sparkles size={11} className={generating ? "animate-pulse-dot text-accent" : "text-fg-3"} />
        <span className={generating ? "text-fg-2" : ""}>
          {generating ? (runnerLabel || t("status.generating")) : t("main.ai.idle")}
        </span>
      </span>

      {/* right cluster */}
      <div className="ml-auto flex items-center gap-2.5">
        <span className="hidden max-w-[180px] truncate text-[11px] text-fg-2 md:block" title={model?.id}>
          {model?.name ?? t("status.noModel")}
        </span>

        <AqToolButton
          size={20}
          onClick={() => setCheatsheetOpen(true)}
          aria-label={t("cheatsheet.palette")}
          title={t("cheatsheet.palette") + "  ?"}
          className="hidden sm:flex"
        >
          <Keyboard size={11} />
        </AqToolButton>

        {spatial && (
          <>
            {selectedEdgeKind && (
              <button
                type="button"
                onClick={() => setSurface("canvas")}
                className="aq-focus-ring hidden items-center gap-1 rounded-[3px] border border-line-faint bg-sunken px-1.5 py-px font-mono text-[10px] uppercase tracking-wider text-fg-3 transition-colors duration-100 hover:border-accent-border/60 hover:text-accent sm:flex"
                title={t("status.edgeTitle")}
              >
                <Link2 size={10} aria-hidden />
                {t(`edgekind.${selectedEdgeKind}`)}
              </button>
            )}
            <button
              type="button"
              onClick={() => setSurface("graph")}
              className="aq-focus-ring hidden rounded-[3px] px-1 py-px font-mono text-[10.5px] text-fg-3 transition-colors duration-100 hover:bg-surface-hover hover:text-fg-2 sm:block"
              title={t("status.countsTitle")}
            >
              {t.p("status.nodes", nodeCount)} · {t.p("status.edges", edgeCount)}
            </button>
            <button
              type="button"
              onClick={() => setSurface("canvas")}
              className="aq-focus-ring rounded-[3px] px-1 py-px font-mono text-[10.5px] text-fg-3 transition-colors duration-100 hover:bg-surface-hover hover:text-fg-2"
              title={t("status.zoomTitle")}
            >
              {t("status.zoom", Math.round(canvasZoom * 100))}
            </button>
            <span className="flex items-center gap-0.5">
              <AqToolButton size={20} onClick={undoCanvas} disabled={!canUndo} aria-label={t("status.undo")} title={t("status.undo")}>
                <Undo2 size={11} />
              </AqToolButton>
              <AqToolButton size={20} onClick={redoCanvas} disabled={!canRedo} aria-label={t("status.redo")} title={t("status.redo")}>
                <Redo2 size={11} />
              </AqToolButton>
            </span>
          </>
        )}
      </div>
    </footer>
  );
}
