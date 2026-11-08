"use client";

import { useAppUpdates } from "@/lib/aqvenor/updates";
import { useT } from "@/lib/aqvenor/useT";

export function UpdateBanner() {
  const { state, busy, install } = useAppUpdates();
  const t = useT();
  if (!state || (state.status !== "downloaded" && state.status !== "installing")) return null;
  const installing = state.status === "installing";
  return (
    <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-accent-soft/40 px-3.5 py-2">
      <p className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-fg-2">
        <span className="font-medium">{t(installing ? "update.status.installing" : "update.status.downloaded", state.version ?? "")}</span>
        <span className={state.error ? "text-warning" : "text-fg-3"}> · {t(state.error ? `update.error.${state.error}` : "update.saveBeforeRestart")}</span>
      </p>
      <button
        type="button"
        disabled={busy || installing}
        onClick={() => { void install(); }}
        className="aq-focus-ring shrink-0 rounded-xs border border-line-faint px-2 py-0.5 text-[11px] font-medium text-fg-2 transition-colors hover:border-line-strong hover:text-fg-1 disabled:opacity-60"
      >
        {t(installing ? "update.status.installing" : "update.restart")}
      </button>
    </div>
  );
}
