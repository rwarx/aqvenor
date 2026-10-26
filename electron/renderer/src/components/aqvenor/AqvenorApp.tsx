"use client";

import { useEffect, useRef } from "react";
import { applyAppZoom, useAqvenor } from "@/lib/aqvenor/store";
import { useT } from "@/lib/aqvenor/useT";
import { useToast } from "@/hooks/use-toast";
import { TitleBar } from "./shell/TitleBar";
import { Sidebar } from "./shell/Sidebar";
import { StatusBar } from "./shell/StatusBar";
import { WorkspaceHeader } from "./shell/WorkspaceHeader";
import { Onboarding } from "./shell/Onboarding";
import { CommandPalette } from "./shell/CommandPalette";
import { CheckpointQuickJump } from "./shell/CheckpointQuickJump";
import { BundleImport } from "./shell/BundleImport";
import { ProjectExportDialog } from "./shell/ProjectExportDialog";
import { ProjectGate } from "./shell/ProjectGate";
import { ProviderStudio } from "./chat/ProviderStudio";
import { ShortcutCheatsheet } from "./shell/ShortcutCheatsheet";
import { triggerDictation } from "./chat/Composer";
import { stopGeneration } from "@/lib/aqvenor/scenario";
import { isServerMode } from "@/lib/aqvenor/sync";
import { initProjectFileSync } from "@/lib/aqvenor/project-files";
import { DockWorkspace } from "./shell/DockWorkspace";

function ToasterBridge() {
  const toasts = useAqvenor((s) => s.toasts);
  const dismissToast = useAqvenor((s) => s.dismissToast);
  const { toast } = useToast();
  const seen = useRef(new Set<number>());

  useEffect(() => {
    for (const t of toasts) {
      if (seen.current.has(t.id)) continue;
      seen.current.add(t.id);
      toast({
        title: t.title,
        description: t.description,
        variant: t.variant === "destructive" ? "destructive" : undefined,
      });
      setTimeout(() => dismissToast(t.id), 5000);
    }
  }, [toasts, toast, dismissToast]);

  return null;
}

export function AqvenorApp() {
  const theme = useAqvenor((s) => s.ui.theme);  const locale = useAqvenor((s) => s.ui.locale);
  const surface = useAqvenor((s) => s.surface);
  const workMode = useAqvenor((s) => s.ui.workMode);
  const workspaceRoot = useAqvenor((s) => s.workspaceRoot);
  const appZoom = useAqvenor((s) => s.ui.appZoom);
  const hydrated = useAqvenor((s) => s.hydrated);
  const checkpointJumpOpen = useAqvenor((s) => s.checkpointJumpOpen);
  const setCheckpointJumpOpen = useAqvenor((s) => s.setCheckpointJumpOpen);
  const cheatsheetOpen = useAqvenor((s) => s.cheatsheetOpen);
  const setCheatsheetOpen = useAqvenor((s) => s.setCheatsheetOpen);
  const projectExportOpen = useAqvenor((s) => s.projectExportOpen);
  const setProjectExportOpen = useAqvenor((s) => s.setProjectExportOpen);
  const providerStudioOpen = useAqvenor((s) => s.providerStudioOpen);
  const modeChosen = useAqvenor((s) => s.ui.modeChosen);
  const t = useT();
  useT(); // subscribe for re-render on locale change

  /* Dev-only handle on the store, next to DockWorkspace's `__aqDock`: lets a QA
     session (or the browser console) read runs/current session without a build. */
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __aqStore?: typeof useAqvenor }).__aqStore = useAqvenor;
  }, []);

  /* theme class on <html>: "system" follows the OS live via matchMedia */
  useEffect(() => {
    const root = document.documentElement;
    const apply = (resolved: "dark" | "light") => {
      root.classList.toggle("light", resolved === "light");
      root.style.colorScheme = resolved;
    };
    if (theme !== "system" || typeof window === "undefined" || !window.matchMedia) {
      apply(theme === "light" ? "light" : "dark");
      return;
    }
    const query = window.matchMedia("(prefers-color-scheme: light)");
    apply(query.matches ? "light" : "dark");
    const onChange = (e: MediaQueryListEvent) => apply(e.matches ? "light" : "dark");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [theme]);

  /* interface zoom (app scale) — native in the desktop shell, CSS fallback in
     the browser build. Re-applied on rehydrate since Chromium zoom resets on a
     cold start / reload. */
  useEffect(() => {
    applyAppZoom(appZoom ?? 1);
  }, [appZoom, hydrated]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  /* .aqvenor project folder: mirror the canvas + MCP set into the open
     workspace (and hydrate them back when a workspace opens) */
  useEffect(() => initProjectFileSync(), []);

  /* global keyboard layer */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useAqvenor.getState();
      const mod = e.ctrlKey || e.metaKey;

      if (e.key === "Escape") {
        if (s.paletteOpen) {
          s.setPaletteOpen(false);
          return;
        }
        if (s.checkpointJumpOpen) {
          s.setCheckpointJumpOpen(false);
          return;
        }
        if (s.cheatsheetOpen) {
          s.setCheatsheetOpen(false);
          return;
        }
        if (s.projectExportOpen) {
          s.setProjectExportOpen(false);
          return;
        }
        if (s.providerStudioOpen) {
          s.setProviderStudioOpen(false);
          return;
        }
        if (s.sidebarOpenMobile) {
          s.setSidebarOpenMobile(false);
          return;
        }
        /* the canvas owns Escape while a local overlay/gesture is open
         *  (kind picker, search, connect/reconnect drag) — its own chain
         *  closes it; that keypress must not stop a running generation */
        if (s.canvasOverlayActive) return;
        const generating = s.runner.status === "running" || s.runner.status === "awaiting-approval";
        if (generating) {
          e.preventDefault();
          stopGeneration();
        }
        return;
      }

      if (!mod) {
        if (e.altKey && e.key === "ArrowLeft") {
          e.preventDefault();
          s.goHistory(-1);
        } else if (e.altKey && e.key === "ArrowRight") {
          e.preventDefault();
          s.goHistory(1);
        } else if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
          /* ? opens the shortcut cheatsheet — unless typing in a field */
          const el = e.target as HTMLElement | null;
          const typing =
            !!el &&
            (el.tagName === "INPUT" ||
              el.tagName === "TEXTAREA" ||
              el.isContentEditable ||
              el.closest?.("[data-note-editor],[role=listbox],[cmdk-root]"));
          if (!typing) {
            e.preventDefault();
            s.setCheatsheetOpen(!s.cheatsheetOpen);
          }
        }
        return;
      }

      const key = e.key.toLowerCase();
      if (e.shiftKey && key === "p") {
        e.preventDefault();
        s.togglePalette();
      } else if (e.shiftKey && key === "k") {
        /* Ctrl+Shift+K — checkpoint quick jump */
        e.preventDefault();
        s.setCheckpointJumpOpen(!s.checkpointJumpOpen);
      } else if (e.shiftKey && key === "d") {
        /* Ctrl+Shift+D — download the whole project */
        e.preventDefault();
        s.setProjectExportOpen(true);
      } else if (key === "k") {
        e.preventDefault();
        s.setPaletteOpen(true);
      } else if (key === "n" && !e.shiftKey) {
        e.preventDefault();
        s.newSession();
      } else if (key === "b") {
        e.preventDefault();
        s.toggleSidebar();
      } else if (key === "g") {
        e.preventDefault();
        s.setSurface("canvas");
      } else if (key === "m") {
        e.preventDefault();
        triggerDictation();
      } else if (key === ",") {
        // Was `", "` with a trailing space, so this branch was unreachable: `e.key` is `","` on
        // its own. The Ctrl+, shortcut advertised in the cheatsheet and in the command palette did
        // nothing at all.
        e.preventDefault();
        s.setSurface("settings");
      } else if (e.altKey && key === "i") {
        e.preventDefault();
        s.toggleContextPanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* block browser zoom-reload gestures inside the app is not needed; nothing else */

  if (!hydrated) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-app">
        <span className="h-6 w-6 animate-spin-slow rounded-full border-2 border-line border-t-accent" />
      </div>
    );
  }

  /* Code mode is workspace-bound: require a project before any code-mode
     surface renders (Chat & Cowork stay project-free). Global config pages
     (settings/models) and the cross-mode Tasks surface stay reachable so
     providers can be set up and tasks viewed before a folder is open. */
  const needsProject =
    isServerMode() &&
    workMode === "code" &&
    !workspaceRoot &&
    surface !== "settings" &&
    surface !== "models" &&
    surface !== "tasks";

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-app text-fg-1" aria-label={t("app.name")}>
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <WorkspaceHeader />
          <div className="min-h-0 flex-1">
            {needsProject ? <ProjectGate /> : <DockWorkspace />}
          </div>
          {/* the Context panel is a dockable panel inside DockWorkspace now;
             Alt+I / its toggle open & close it there. */}
        </main>
      </div>
      <StatusBar />
      <CommandPalette />
      {checkpointJumpOpen && <CheckpointQuickJump onClose={() => setCheckpointJumpOpen(false)} />}
      {cheatsheetOpen && <ShortcutCheatsheet onClose={() => setCheatsheetOpen(false)} />}
      {projectExportOpen && (
        <ProjectExportDialog onClose={() => setProjectExportOpen(false)} />
      )}
      {providerStudioOpen && <ProviderStudio />}
      <BundleImport />
      <ToasterBridge />
      {!modeChosen && <Onboarding />}
    </div>
  );
}
