"use client";

import { useEffect, useRef, useState } from "react";
import { Download, FileArchive, FileDown, Package } from "lucide-react";
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

/* Single export/import menu, shared by the page header and the sidebar footer.
   `up` anchors the dropdown above the button (sidebar footer), `down` below
   (page header). */
export function ExportMenu({ up = false }: { up?: boolean }) {
  const t = useT();
  const currentSession = useAqvenor((s) => s.sessions.find((x) => x.id === s.currentSessionId));
  const canvas = useAqvenor((s) => s.canvas);
  const pushToast = useAqvenor((s) => s.pushToast);
  const setProjectExportOpen = useAqvenor((s) => s.setProjectExportOpen);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const session = currentSession;

  return (
    <div className="relative" ref={ref}>
      <AqToolButton
        onClick={() => setOpen((v) => !v)}
        active={open}
        aria-label={t("main.exportImport")}
        title={t("main.exportImport")}
      >
        <Download size={14} />
      </AqToolButton>
      {open && (
        <div
          className={`absolute right-0 z-40 w-60 animate-settle rounded-md border border-line bg-surface-3 p-1 shadow-overlay ${
            up ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]"
          }`}
        >
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
                        goals: useAqvenor.getState().goals,
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
                  onClick={() => { setOpen(false); item.action(); }}
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
            onClick={() => { setOpen(false); setProjectExportOpen(true); }}
            className="flex h-7 w-full items-center gap-2 rounded-xs px-2 text-[12px] text-fg-2 transition-colors hover:bg-surface-hover hover:text-fg-1"
          >
            <Package size={11} className="text-fg-3" />
            {t("project.button")}
          </button>
          <button
            type="button"
            onClick={() => { setOpen(false); openBundleImport(); }}
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
  );
}
