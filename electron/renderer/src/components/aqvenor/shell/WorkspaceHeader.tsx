"use client";

import { ArrowLeft } from "lucide-react";
import { useAqvenor } from "@/lib/aqvenor/store";
import { useT } from "@/lib/aqvenor/useT";
import { AqToolButton } from "@/components/aqvenor/ui";
import { modeDefaultSurface } from "@/lib/aqvenor/modes";
import { ExportMenu } from "./ExportMenu";

/* Page header for the full-page surfaces (models / tasks / settings): back
   arrow, page title, export/import menu. Workspace surfaces render no bar —
   the dock shows them as tabs and each view owns its own chrome. */
export function WorkspaceHeader() {
  const t = useT();
  const surface = useAqvenor((s) => s.surface);
  const setSurface = useAqvenor((s) => s.setSurface);
  const workMode = useAqvenor((s) => s.ui.workMode);

  const isPage = surface === "models" || surface === "tasks" || surface === "settings";
  const pageTitles: Record<string, string> = {
    models: t("providers.title"),
    tasks: t("tasks.title"),
    settings: t("settings.title"),
  };

  if (!isPage) return null;

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line-faint bg-app px-3">
      <AqToolButton
        onClick={() => setSurface(modeDefaultSurface[workMode])}
        aria-label={t("common.back")}
        title={t("common.back")}
      >
        <ArrowLeft size={14} />
      </AqToolButton>
      <span className="text-[13px] font-semibold text-fg-1">{pageTitles[surface]}</span>

      <div className="ml-auto flex items-center gap-1">
        <ExportMenu />
      </div>
    </div>
  );
}
