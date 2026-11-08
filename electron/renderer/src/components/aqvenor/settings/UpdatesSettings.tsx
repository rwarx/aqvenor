"use client";

import { Download, RefreshCw, RotateCcw } from "lucide-react";
import { AqCard, AqGhostButton, Divider } from "../ui";
import { useT } from "@/lib/aqvenor/useT";
import { useAppUpdates } from "@/lib/aqvenor/updates";

export function UpdatesSettings() {
  const t = useT();
  const { state, busy, hasBridge, check, install } = useAppUpdates();
  const status = state?.status;
  const checking = busy || status === "checking" || status === "available" || status === "downloading" || status === "installing";
  return (
    <AqCard className="px-4 py-3">
      {state?.currentVersion && (
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-3">
          <span>{t("update.installedVersion", state.currentVersion)}</span>
          <span>{t("update.releaseChannel", ["alpha", "beta", "stable"].includes(state.channel) ? t(`update.channel.${state.channel}`) : state.channel)}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 py-2">
        <div className="min-w-0" role="status" aria-live="polite">
          <div className="text-[13px] font-medium text-fg-1">
            {t(!hasBridge ? "update.browser" : !state ? "update.loading" : `update.status.${status}`, state?.version ?? "")}
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-fg-3">
            {t(state?.channel === "stable" ? "update.automatic.stable" : "update.automatic.alpha")}
          </p>
        </div>
        {status === "downloaded" ? (
          <AqGhostButton disabled={busy} onClick={() => { void install(); }}>
            <RotateCcw size={13} aria-hidden />{t("update.restart")}
          </AqGhostButton>
        ) : (
          <AqGhostButton disabled={!hasBridge || !state || status === "disabled" || checking} onClick={() => { void check(); }}>
            <RefreshCw size={13} aria-hidden />{t(status === "error" ? "update.retry" : "update.check")}
          </AqGhostButton>
        )}
      </div>
      {status === "downloading" && state?.percent !== null && (
        <div className="my-2 flex items-center gap-2 text-fg-3">
          <Download size={12} aria-hidden />
          <progress className="h-1.5 flex-1 accent-accent" max={100} value={state?.percent ?? 0} aria-label={t("update.status.downloading", state?.version ?? "")} />
          <span className="font-mono text-[11px]">{Math.round(state?.percent ?? 0)}%</span>
        </div>
      )}
      {state?.error && <p role="alert" className="mt-1 text-[12px] leading-relaxed text-warning">{t(`update.error.${state.error}`)}</p>}
      {(status === "downloaded" || status === "installing") && <p className="mt-1 text-[11.5px] leading-relaxed text-fg-3">{t("update.saveBeforeRestart")}</p>}
      {state?.checkedAt && (
        <>
          <Divider className="my-3" />
          <p className="text-[11px] text-fg-3">{t("update.checkedAt", new Date(state.checkedAt).toLocaleString(t.locale))}</p>
        </>
      )}
    </AqCard>
  );
}
