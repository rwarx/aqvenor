"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Download,
  FileArchive,
  FileCode2,
  FileDown,
  MessageSquare,
  Package,
  Users,
} from "lucide-react";
import { useAqvenor } from "@/lib/aqvenor/store";
import { useT } from "@/lib/aqvenor/useT";
import { flushPendingWrites } from "@/lib/aqvenor/sync";
import {
  exportSessionBundle,
  exportSessionJson,
  exportSessionMarkdown,
  exportSessionText,
} from "@/lib/aqvenor/export";
import { openBundleImport } from "./BundleImport";
import { AqToolButton } from "@/components/aqvenor/ui";
import { modeDefaultSurface } from "@/lib/aqvenor/modes";

/* the unified work-mode switch (item 10): Chat & Cowork share the chat surface
   (they differ only by whether the agent runs tools), while Code opens the IDE
   surface. Lives in the header so it stays visible on every surface — including
   Code, where the composer (its old home) isn't rendered. */
type ModeSeg = "chat" | "cowork" | "code";
const MODE_SEGS: { id: ModeSeg; icon: React.ElementType; labelKey: string }[] = [
  { id: "chat", icon: MessageSquare, labelKey: "work.mode.chat" },
  { id: "cowork", icon: Users, labelKey: "work.mode.cowork" },
  { id: "code", icon: FileCode2, labelKey: "work.mode.code" },
];

export function WorkspaceHeader() {
  const t = useT();
  const surface = useAqvenor((s) => s.surface);
  const setSurface = useAqvenor((s) => s.setSurface);
  const workMode = useAqvenor((s) => s.ui.workMode);
  const setWorkMode = useAqvenor((s) => s.setWorkMode);
  const currentSession = useAqvenor((s) => s.sessions.find((x) => x.id === s.currentSessionId));
  const canvas = useAqvenor((s) => s.canvas);
  const files = useAqvenor((s) => s.files);
  const goals = useAqvenor((s) => s.goals);
  const pushToast = useAqvenor((s) => s.pushToast);
  const setProjectExportOpen = useAqvenor((s) => s.setProjectExportOpen);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setExportOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [exportOpen]);

  const isPage = surface === "models" || surface === "tasks" || surface === "settings";
  const pageTitles: Record<string, string> = {
    models: t("providers.title"),
    tasks: t("tasks.title"),
    settings: t("settings.title"),
  };

  const session = currentSession;

  /* the switch drives workMode; the store lands the right surface for the mode
     (chat/cowork → chat, code → code) and keeps an in-mode surface if you were
     already on one. workMode is the single source of truth for the active seg. */
  const activeSeg: ModeSeg = workMode;
  const selectMode = (seg: ModeSeg) => {
    setWorkMode(seg);
  };

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line-faint bg-app px-3">
      {isPage ? (
        <>
          <AqToolButton onClick={() => setSurface(modeDefaultSurface[workMode])} aria-label={t("common.back")} title={t("common.back")}>
            <ArrowLeft size={14} />
          </AqToolButton>
          <span className="text-[13px] font-semibold text-fg-1">{pageTitles[surface]}</span>
        </>
      ) : (
        <>
          {/* session title */}
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-fg-1">
              {session?.title ?? t("app.name")}
            </span>
            {session?.forkedFrom && (
              <span className="hidden rounded-xs border border-line bg-surface-2 px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wide text-fg-3 sm:inline">
                {t("session.fork.badge")}
              </span>
            )}
          </div>

          {/* project selector removed — the open workspace is now managed via the
             Code project folders in the sidebar (each Code project relates to a
             folder; "Open workspace" applies it). The command palette and
             Settings still expose "open folder" too. */}

          {/* unified work-mode switch — Chat/Cowork (chat surface, agent off/on)
             + Code (IDE surface). Item 10; visible on every non-page surface. */}
          <div
            className="ml-1 flex items-center gap-0.5 rounded-sm border border-line-faint bg-sunken p-0.5"
            role="tablist"
            aria-label={t("work.mode")}
          >
            {MODE_SEGS.map(({ id, icon: Icon, labelKey }) => {
              const active = activeSeg === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => selectMode(id)}
                  title={t(`${labelKey}.hint`)}
                  className={`aq-focus-ring flex h-6 items-center gap-1.5 rounded-xs px-2 text-[11.5px] font-medium transition-colors duration-100 ${
                    active ? "bg-surface-3 text-fg-1 shadow-sm" : "text-fg-3 hover:text-fg-2"
                  }`}
                >
                  <Icon size={12} className={active ? "text-accent" : ""} />
                  <span className="hidden md:inline">{t(labelKey)}</span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* right cluster — single export/import menu (new-chat "+" moved into the
         chat corner, see ChatView) */}
      <div className="ml-auto flex items-center gap-1">
        <div className="relative" ref={exportRef}>
          <AqToolButton
            onClick={() => setExportOpen((v) => !v)}
            active={exportOpen}
            aria-label={t("main.exportImport")}
            title={t("main.exportImport")}
          >
            <Download size={14} />
          </AqToolButton>
          {exportOpen && (
            <div className="absolute right-0 top-[calc(100%+6px)] z-40 w-60 animate-settle rounded-md border border-line bg-surface-3 p-1 shadow-overlay">
              {session && session.messages.length > 0 && (
                <>
                  <div className="px-2 pb-1 pt-1.5">
                    <span className="aq-overline">{t("export.session")}</span>
                  </div>
                  {[
                    { label: t("export.markdown"), action: () => exportSessionMarkdown(session) },
                    { label: t("export.json"), action: () => exportSessionJson(session) },
                    { label: t("export.text"), action: () => exportSessionText(session) },
                    {
                      label: t("export.bundle"),
                      // Flush before packaging. The bundle carries the renderer's in-memory file
                      // state, and editor writes are debounced, so without this a bundle can be
                      // written while the last edit is still sitting in the queue — and the export
                      // would faithfully contain the file as it was before those keystrokes.
                      action: () => {
                        void flushPendingWrites().then(() => {
                          exportSessionBundle({
                            session,
                            nodes: canvas.nodes,
                            edges: canvas.edges,
                            files: useAqvenor.getState().files,
                            goals,
                          });
                          pushToast(t("export.bundle"), t("export.bundle.toast"));
                        });
                      },
                      bundle: true,
                    },
                  ].map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      onClick={() => { setExportOpen(false); item.action(); }}
                      className={
                        "flex h-7 w-full items-center gap-2 rounded-xs px-2 text-[12px] transition-colors hover:bg-surface-hover " +
                        (item.bundle ? "text-accent hover:text-accent" : "text-fg-2 hover:text-fg-1")
                      }
                    >
                      {item.bundle ? <FileArchive size={11} className="text-accent" /> : <Download size={11} className="text-fg-3" />}
                      {item.label}
                    </button>
                  ))}
                  <div className="my-1 border-t border-line-faint" />
                </>
              )}
              <div className="px-2 pb-1 pt-1.5">
                <span className="aq-overline">{t("export.project")}</span>
              </div>
              <button
                type="button"
                onClick={() => { setExportOpen(false); setProjectExportOpen(true); }}
                className="flex h-7 w-full items-center gap-2 rounded-xs px-2 text-[12px] text-fg-2 transition-colors hover:bg-surface-hover hover:text-fg-1"
              >
                <Package size={11} className="text-fg-3" />
                {t("project.button")}
              </button>
              <button
                type="button"
                onClick={() => { setExportOpen(false); openBundleImport(); }}
                className="flex h-7 w-full items-center gap-2 rounded-xs px-2 text-[12px] text-fg-2 transition-colors hover:bg-surface-hover hover:text-fg-1"
              >
                <FileDown size={11} className="text-fg-3" />
                {t("import.bundle")}
              </button>
              <div className="mt-1 border-t border-line-faint px-2 pb-1 pt-1.5 text-[10px] leading-snug text-fg-3">
                {t("export.bundle.hint")}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
