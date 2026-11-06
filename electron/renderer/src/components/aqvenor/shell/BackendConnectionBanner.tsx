"use client";

import { useEffect, useState } from "react";
import { useAqvenor } from "@/lib/aqvenor/store";
import { useT } from "@/lib/aqvenor/useT";
import { checkBackend, markBackendUnavailable } from "@/lib/aqvenor/backend";
import { hydrateFromBackend, isServerMode } from "@/lib/aqvenor/sync";

export function BackendConnectionBanner() {
  const reachable = useAqvenor((s) => s.backendReachable);
  const [checking, setChecking] = useState(false);
  const t = useT();

  useEffect(() => {
    const unsubscribe = window.aqvenor?.onSidecarGone?.(() => markBackendUnavailable());
    // Includes externally hosted development backends, whose process Electron does not own.
    // Poll only while using a real backend; the standalone preview stays network-free here.
    const timer = window.aqvenor || isServerMode()
      ? setInterval(() => {
          void checkBackend()
            .then((ok) => { if (ok && !isServerMode()) return hydrateFromBackend(); })
            .catch(() => markBackendUnavailable());
        }, 15_000)
      : undefined;
    return () => {
      if (timer !== undefined) clearInterval(timer);
      unsubscribe?.();
    };
  }, []);

  const retry = async () => {
    if (checking) return;
    setChecking(true);
    try {
      if (await checkBackend()) await hydrateFromBackend();
    } catch {
      markBackendUnavailable();
    } finally {
      setChecking(false);
    }
  };

  if (reachable !== false && !checking) return null;
  if (!window.aqvenor && !isServerMode()) return null;

  return (
    <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/40 bg-warning-soft/40 px-3.5 py-2">
      <p className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-fg-2">
        <span className="font-medium text-warning">{t(checking ? "connection.checking" : "connection.unavailable")}</span>
        <span className="text-fg-3"> · {t("connection.description")}</span>
      </p>
      <button
        type="button"
        onClick={() => { void retry(); }}
        disabled={checking}
        className="aq-focus-ring shrink-0 rounded-xs border border-line-faint px-2 py-0.5 text-[11px] font-medium text-fg-2 transition-colors hover:border-line-strong hover:text-fg-1 disabled:opacity-60"
      >
        {t(checking ? "connection.checking" : "connection.retry")}
      </button>
    </div>
  );
}
