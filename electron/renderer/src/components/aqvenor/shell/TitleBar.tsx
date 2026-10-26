"use client";

import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  Minus,
  PanelRightClose,
  PanelRightOpen,
  Search,
  Square,
  X,
} from "lucide-react";
import { useAqvenor } from "@/lib/aqvenor/store";
import { useT } from "@/lib/aqvenor/useT";
import { AqToolButton } from "@/components/aqvenor/ui";
import brandMark from "../../../assets/aqvenor-mark.png";

export function TitleBar() {
  const t = useT();
  const surface = useAqvenor((s) => s.surface);
  const runnerStatus = useAqvenor((s) => s.runner.status);
  const ui = useAqvenor((s) => s.ui);
  const toggleSidebar = useAqvenor((s) => s.toggleSidebar);
  const toggleContextPanel = useAqvenor((s) => s.toggleContextPanel);
  const togglePalette = useAqvenor((s) => s.togglePalette);
  const setSidebarOpenMobile = useAqvenor((s) => s.setSidebarOpenMobile);
  const goHistory = useAqvenor((s) => s.goHistory);
  const historyIndex = useAqvenor((s) => s.historyIndex);
  const historyLen = useAqvenor((s) => s.history.length);

  /* The brand mark in the corner is the sidebar's toggle: click to collapse /
     expand (desktop) or open the drawer (mobile). One control, no duplicate
     close button beside it. */
  const onBrandClick = () => {
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      setSidebarOpenMobile(true);
      return;
    }
    toggleSidebar();
  };

  return (
    <header className="aq-drag grid h-10 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-1.5 border-b border-line-faint bg-surface-1 px-2">
      {/* left cluster — the logo doubles as the sidebar toggle (collapse state
          shown by the open/closed eye around the mark), plus the run status. */}
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          onClick={onBrandClick}
          aria-label={t("shortcuts.sidebar")}
          title={t("shortcuts.sidebar")}
          className={`aq-focus-ring aq-no-drag group relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] transition-colors hover:bg-surface-hover ${
            ui.sidebarCollapsed ? "" : "bg-surface-hover/60"
          }`}
        >
          <span
            aria-hidden
            className="flex h-7 w-7 select-none items-center justify-center rounded-[7px] border border-white/15 bg-gradient-to-b from-surface-3 to-sunken p-[3px] shadow-[0_0_10px_var(--aq-accent-glow,rgba(255,255,255,0.08))] transition-transform duration-150 group-hover:scale-[1.06] group-active:scale-95"
          >
            <img
              src={brandMark}
              alt=""
              aria-hidden
              draggable={false}
              className="h-full w-full object-contain"
            />
          </span>
          {/* collapse state hint — a quiet rail that mirrors the sidebar's edge */}
          <span
            aria-hidden
            className={`absolute left-0 top-1/2 h-[16px] w-[2px] -translate-y-1/2 rounded-full bg-accent transition-opacity duration-150 ${
              ui.sidebarCollapsed ? "opacity-0" : "opacity-100"
            }`}
          />
        </button>
        <span className="ml-0.5 shrink-0 text-[13px] font-semibold tracking-[-0.01em] text-fg-1">
          {t("app.name")}
        </span>
        {runnerStatus === "running" && (
          <span className="ml-1 flex h-5 items-center gap-1.5 rounded-full border border-line-faint bg-surface-2 px-2 text-[10.5px] font-medium text-fg-2">
            <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-accent" aria-hidden />
            {t("main.ai.working")}
          </span>
        )}
      </div>

      {/* center — history arrows + the command-palette search, centered. */}
      <div className="flex items-center gap-1 justify-self-center">
        <AqToolButton
          size={24}
          onClick={() => goHistory(-1)}
          disabled={historyIndex <= 0}
          aria-label={t("shortcuts.back")}
          className="hidden sm:flex"
        >
          <ArrowLeft size={13} />
        </AqToolButton>
        <AqToolButton
          size={24}
          onClick={() => goHistory(1)}
          disabled={historyIndex >= historyLen - 1}
          aria-label={t("shortcuts.forward")}
          className="hidden sm:flex"
        >
          <ArrowRight size={13} />
        </AqToolButton>

        <button
          type="button"
          onClick={togglePalette}
          className="aq-focus-ring group hidden h-[26px] w-[200px] items-center gap-2 rounded-sm border border-line bg-sunken px-2.5 text-fg-3 transition-all duration-150 hover:border-line-strong hover:text-fg-2 active:scale-[0.995] sm:flex lg:w-[240px] xl:w-[280px]"
        >
          <Search size={12} className="shrink-0 transition-colors group-hover:text-fg-2" />
          <span className="ml-auto flex items-center gap-0.5 opacity-70 transition-opacity duration-150 group-hover:opacity-100">
            <span className="aq-keycap">Ctrl</span>
            <span className="aq-keycap">Shift</span>
            <span className="aq-keycap">P</span>
          </span>
        </button>
        <AqToolButton onClick={togglePalette} aria-label={t("shortcuts.commandPalette")} className="sm:hidden">
          <Search size={14} />
        </AqToolButton>
      </div>

      {/* right cluster — the model picker lives in the composer now, so the
          corner holds only the context panel toggle and the window controls. */}
      <div className="flex min-w-0 items-center gap-1 justify-self-end">
        <AqToolButton onClick={toggleContextPanel} active={ui.contextPanelOpen} aria-label={t("main.inspector")}>
          {surface === "canvas" || surface === "graph" ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
        </AqToolButton>
        <WindowControls />
      </div>
    </header>
  );
}

/* Custom window controls for the frameless Electron shell. Renders nothing in
   the plain browser build (where `window.aqvenor?.win` is undefined), so the
   OS-less chrome only appears inside the real desktop app. */
function WindowControls() {
  const t = useT();
  const win = typeof window !== "undefined" ? window.aqvenor?.win : undefined;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!win) return;
    let active = true;
    win.isMaximized().then((v) => active && setMaximized(v)).catch(() => {});
    const off = win.onMaximizedChanged((v) => active && setMaximized(v));
    return () => {
      active = false;
      off?.();
    };
  }, [win]);

  if (!win) return null;

  return (
    <div className="aq-no-drag ml-1 flex items-center">
      <button
        type="button"
        onClick={() => win.minimize()}
        aria-label={t("window.minimize")}
        className="aq-focus-ring flex h-7 w-11 items-center justify-center rounded-sm text-fg-3 transition-colors hover:bg-surface-hover hover:text-fg-1"
      >
        <Minus size={15} />
      </button>
      <button
        type="button"
        onClick={() => win.maximizeToggle()}
        aria-label={maximized ? t("window.restore") : t("window.maximize")}
        className="aq-focus-ring flex h-7 w-11 items-center justify-center rounded-sm text-fg-3 transition-colors hover:bg-surface-hover hover:text-fg-1"
      >
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button
        type="button"
        onClick={() => win.close()}
        aria-label={t("window.close")}
        className="aq-focus-ring flex h-7 w-11 items-center justify-center rounded-sm text-fg-3 transition-colors hover:bg-error hover:text-white"
      >
        <X size={16} />
      </button>
    </div>
  );
}
