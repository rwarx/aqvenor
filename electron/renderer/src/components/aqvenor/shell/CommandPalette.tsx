"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Bookmark,
  Frame,
  Command,
  Download,
  FileCode2,
  FileDown,
  Files,
  FoldVertical,
  FolderOpen,
  GitFork,
  Keyboard,
  Languages,
  LayoutGrid,
  MessageSquare,
  Moon,
  Package,
  PanelLeft,
  PanelRight,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  Settings,
  Sun,
  Undo2,
  Waypoints,
  Workflow,
} from "lucide-react";
import { useAqvenor } from "@/lib/aqvenor/store";
import { useT } from "@/lib/aqvenor/useT";
import { graph, workspace } from "@/lib/aqvenor/backend";
import { exportCurrentSession, isServerMode, reindexCanvas, syncCanvas, syncWorkspaceFiles } from "@/lib/aqvenor/sync";
import {
  exportSessionJson,
  exportSessionMarkdown,
  exportSessionText,
} from "@/lib/aqvenor/export";
import type { Surface } from "@/lib/aqvenor/types";
import { openBundleImport } from "./BundleImport";

interface PaletteCommand {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keywords?: string;
  icon: React.ElementType;
  shortcut?: string[];
  run: () => void;
}

function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t.includes(q)) return 100 - t.indexOf(q);
  let qi = 0;
  let score = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      score += 1;
      qi++;
    }
  }
  return qi === q.length ? score : 0;
}

export function CommandPalette() {
  const t = useT();
  const paletteOpen = useAqvenor((s) => s.paletteOpen);
  const setPaletteOpen = useAqvenor((s) => s.setPaletteOpen);
  const setCheckpointJumpOpen = useAqvenor((s) => s.setCheckpointJumpOpen);
  const checkpointCount = useAqvenor((s) => s.checkpoints.length);
  const showCheckpointJump = checkpointCount > 0;
  const setSurface = useAqvenor((s) => s.setSurface);
  const newSession = useAqvenor((s) => s.newSession);
  const toggleSidebar = useAqvenor((s) => s.toggleSidebar);
  const toggleContextPanel = useAqvenor((s) => s.toggleContextPanel);
  const forkSession = useAqvenor((s) => s.forkSession);
  const compactSession = useAqvenor((s) => s.compactSession);
  const pushToast = useAqvenor((s) => s.pushToast);
  const setUi = useAqvenor((s) => s.setUi);
  const ui = useAqvenor((s) => s.ui);
  const currentSessionId = useAqvenor((s) => s.currentSessionId);
  const runnerStatus = useAqvenor((s) => s.runner.status);
  const setRunner = useAqvenor((s) => s.setRunner);
  const sendMessageRef = useRef<((text: string) => void) | null>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (paletteOpen) {
      setQuery("");
      setIndex(0);
      void import("@/lib/aqvenor/scenario").then((m) => {
        sendMessageRef.current = m.sendMessage;
      });
    }
  }, [paletteOpen]);

  const commands: PaletteCommand[] = useMemo(() => {
    const go = (s: Surface) => () => setSurface(s);
    const canRunDemo = runnerStatus === "idle" || runnerStatus === "done" || runnerStatus === "stopped";
    const cmds: PaletteCommand[] = [
      { id: "new-chat", group: t("sidebar.section.sessions"), label: t("sidebar.newChat"), icon: Plus, shortcut: ["Ctrl", "N"], run: () => newSession() },
      { id: "demo", group: t("sidebar.section.sessions"), label: t("demo.run"), icon: Play, keywords: t("palette.k.demo"), run: () => {
        setRunner({ status: "idle", label: undefined });
        setSurface("chat");
        sendMessageRef.current?.("Users get logged out after about an hour — fix the refresh token renewal");
      } },
      { id: "fork", group: t("sidebar.section.sessions"), label: t("sidebar.fork"), icon: GitFork, keywords: t("palette.k.fork"), run: () => forkSession(currentSessionId) },
      { id: "import-bundle", group: t("sidebar.section.sessions"), label: t("import.palette"), icon: FileDown, keywords: t("palette.k.importBundle"), run: () => openBundleImport() },
      { id: "compact", group: t("sidebar.section.sessions"), label: t("context.compact"), icon: FoldVertical, keywords: t("palette.k.compact"), run: () => compactSession() },
      { id: "export-md", group: t("export.group"), label: t("export.markdown"), icon: Download, run: () => { const s = useAqvenor.getState().sessions.find((x) => x.id === currentSessionId); if (s) exportSessionMarkdown(s); } },
      { id: "export-json", group: t("export.group"), label: t("export.json"), icon: Download, run: () => { const s = useAqvenor.getState().sessions.find((x) => x.id === currentSessionId); if (s) exportSessionJson(s); } },
      { id: "export-txt", group: t("export.group"), label: t("export.text"), icon: Download, run: () => { const s = useAqvenor.getState().sessions.find((x) => x.id === currentSessionId); if (s) exportSessionText(s); } },
      ...(isServerMode()
        ? [
            {
              id: "open-workspace",
              group: t("sidebar.section.tools"),
              label: t("palette.openWorkspace"),
              icon: FolderOpen,
              keywords: t("palette.k.openWorkspace"),
              run: () => {
                void (async () => {
                  if (!window.aqvenor) return;
                  const dir = await window.aqvenor.pickFolder();
                  if (!dir) return;
                  try {
                    await workspace.open(dir);
                    await syncWorkspaceFiles().catch(() => undefined);
                    // Walk the new folder so the canvas fills in (empty graph otherwise).
                    await reindexCanvas().catch(() => undefined);
                    pushToast(t("palette.openWorkspace"), dir);
                  } catch (err) {
                    pushToast(t("palette.openWorkspace"), err instanceof Error ? err.message : undefined, "destructive");
                  }
                })();
              },
            },
            {
              id: "reindex",
              group: t("sidebar.section.tools"),
              label: t("palette.reindex"),
              icon: RefreshCw,
              keywords: t("palette.k.reindex"),
              run: () => {
                void (async () => {
                  try {
                    const res = await graph.reindex();
                    await syncCanvas().catch(() => undefined);
                    pushToast(t("palette.reindex"), res.rejected.length > 0 ? t("palette.reindex.rejected", res.rejected.length) : undefined);
                  } catch (err) {
                    pushToast(t("palette.reindex"), err instanceof Error ? err.message : undefined, "destructive");
                  }
                })();
              },
            },
            {
              id: "undo-graph",
              group: t("sidebar.section.tools"),
              label: t("palette.undoGraph"),
              icon: Undo2,
              keywords: t("palette.k.undoGraph"),
              run: () => {
                void graph
                  .undo()
                  .then(() => syncCanvas().catch(() => undefined))
                  .catch((err: unknown) =>
                    pushToast(t("palette.undoGraph"), err instanceof Error ? err.message : undefined, "destructive"),
                  );
              },
            },
            {
              id: "redo-graph",
              group: t("sidebar.section.tools"),
              label: t("palette.redoGraph"),
              icon: Redo2,
              keywords: t("palette.k.redoGraph"),
              run: () => {
                void graph
                  .redo()
                  .then(() => syncCanvas().catch(() => undefined))
                  .catch((err: unknown) =>
                    pushToast(t("palette.redoGraph"), err instanceof Error ? err.message : undefined, "destructive"),
                  );
              },
            },
            {
              id: "export-server",
              group: t("export.group"),
              label: t("palette.exportServer"),
              icon: Download,
              keywords: t("palette.k.exportServer"),
              run: () => {
                void (async () => {
                  const text = await exportCurrentSession("markdown");
                  if (text == null) {
                    pushToast(t("palette.exportServer"), undefined, "destructive");
                    return;
                  }
                  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "transcript.md";
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 5000);
                })();
              },
            },
          ]
        : []),
      { id: "go-chat", group: t("sidebar.navigate"), label: t("nav.chat"), icon: MessageSquare, run: go("chat") },
      { id: "go-canvas", group: t("sidebar.navigate"), label: t("nav.canvas"), icon: Frame, shortcut: ["Ctrl", "G"], run: go("canvas") },
      { id: "go-graph", group: t("sidebar.navigate"), label: t("nav.graph"), icon: Waypoints, run: go("graph") },
      { id: "go-files", group: t("sidebar.navigate"), label: t("nav.files"), icon: Files, run: go("files") },
      { id: "go-code", group: t("sidebar.navigate"), label: t("nav.code"), icon: FileCode2, run: go("code") },
      { id: "go-trajectory", group: t("sidebar.navigate"), label: t("nav.trajectory"), icon: Bot, run: go("trajectory") },
      { id: "go-providers", group: t("sidebar.navigate"), label: t("nav.models"), icon: Package, run: go("models") },
      { id: "go-tasks", group: t("sidebar.navigate"), label: t("nav.tasks"), icon: Bot, run: go("tasks") },
      ...(showCheckpointJump
        ? [        { id: "checkpoint-jump", group: t("sidebar.navigate"), label: t("shortcuts.checkpointJump"), icon: Bookmark, shortcut: ["Ctrl", "Shift", "K"], keywords: t("palette.k.checkpointJump"), run: () => setCheckpointJumpOpen(true) }]
        : []),
      { id: "go-workflows", group: t("sidebar.navigate"), label: t("nav.workflows"), icon: Workflow, keywords: t("palette.k.workflows"), run: go("workflows") },
      { id: "settings", group: t("sidebar.section.tools"), label: t("settings.title"), icon: Settings, shortcut: ["Ctrl", ","], run: go("settings") },
      { id: "cheatsheet", group: t("sidebar.section.tools"), label: t("cheatsheet.palette"), icon: Keyboard, shortcut: ["?"], keywords: t("palette.k.cheatsheet"), run: () => useAqvenor.getState().setCheatsheetOpen(true) },
      { id: "project-export", group: t("sidebar.section.tools"), label: t("project.palette"), icon: Package, shortcut: ["Ctrl", "Shift", "D"], keywords: t("palette.k.projectExport"), run: () => useAqvenor.getState().setProjectExportOpen(true) },
      { id: "toggle-sidebar", group: t("sidebar.section.tools"), label: t("shortcuts.sidebar"), icon: PanelLeft, shortcut: ["Ctrl", "B"], keywords: t("palette.k.toggleSidebar"), run: () => toggleSidebar() },
      { id: "toggle-inspector", group: t("sidebar.section.tools"), label: t("shortcuts.contextPanel"), icon: PanelRight, shortcut: ["Ctrl", "Alt", "I"], keywords: t("palette.k.toggleInspector"), run: () => toggleContextPanel() },
      { id: "reset-layout", group: t("sidebar.section.tools"), label: t("dock.reset"), icon: LayoutGrid, keywords: t("palette.k.resetLayout"), run: () => (window as unknown as { __aqDockReset?: () => void }).__aqDockReset?.() },
      {
        id: "toggle-theme",
        group: t("sidebar.section.tools"),
        label: ui.theme === "dark" ? t("theme.light") : t("theme.dark"),
        icon: ui.theme === "dark" ? Sun : Moon,
        keywords: t("palette.k.toggleTheme"),
        run: () => setUi({ theme: ui.theme === "dark" ? "light" : "dark" }),
      },
      { id: "toggle-locale", group: t("sidebar.section.tools"), label: `${t("language")} · ${ui.locale.toUpperCase()} → ${ui.locale === "en" ? "RU" : ui.locale === "ru" ? "DE" : "EN"}`, icon: Languages, keywords: t("palette.k.toggleLocale"), run: () => {
        const next = ui.locale === "en" ? "ru" : ui.locale === "ru" ? "de" : "en";
        setUi({ locale: next });
        pushToast(t("language"), next.toUpperCase());
      } },
    ];
    return cmds.filter((c) => c.label);
  }, [t, ui.theme, ui.locale, setSurface, newSession, toggleSidebar, toggleContextPanel, forkSession, compactSession, setUi, pushToast, currentSessionId, runnerStatus, setRunner, showCheckpointJump, setCheckpointJumpOpen]);

  const filtered = useMemo(() => {
    if (!query.trim()) return commands;
    return commands
      .map((c) => ({
        c,
        score: Math.max(
          fuzzyScore(query, c.label),
          fuzzyScore(query, `${c.group} ${c.keywords ?? ""}`) * 0.7,
          fuzzyScore(query, c.id) * 0.85,
        ),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c);
  }, [commands, query]);

  const groups = useMemo(() => {
    const map = new Map<string, PaletteCommand[]>();
    filtered.forEach((c) => {
      const arr = map.get(c.group) ?? [];
      arr.push(c);
      map.set(c.group, arr);
    });
    return [...map.entries()];
  }, [filtered]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!paletteOpen) return null;

  const flat = filtered;

  const runIndex = (i: number) => {
    const cmd = flat[i];
    if (!cmd) return;
    setPaletteOpen(false);
    cmd.run();
  };

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={t("sidebar.commandPalette")}>
      <div className="absolute inset-0 bg-scrim" onClick={() => setPaletteOpen(false)} aria-hidden />
      <div className="absolute left-1/2 top-[10vh] w-[620px] max-w-[calc(100vw-32px)] -translate-x-1/2 animate-settle overflow-hidden rounded-lg border border-line-strong bg-surface-3 shadow-overlay">
        <div className="flex items-center gap-2.5 border-b border-line-faint px-4 py-3">
          <Command size={14} className="shrink-0 text-fg-3" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, flat.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                runIndex(index);
              } else if (e.key === "Escape") {
                setPaletteOpen(false);
              }
            }}
            placeholder={t("palette.placeholder")}
            className="w-full bg-transparent text-[14px] text-fg-1 outline-none placeholder:text-fg-3"
            aria-label={t("palette.placeholder")}
          />
          <span className="aq-keycap">Esc</span>
        </div>
        <div ref={listRef} className="max-h-[380px] overflow-y-auto p-2">
          {flat.length === 0 && (
            <p className="px-3 py-6 text-center text-[12.5px] text-fg-3">{t("palette.noMatches")}</p>
          )}
          {groups.map(([group, items]) => (
            <div key={group} className="mb-1">
              <p className="aq-overline px-2 py-1.5">{group}</p>
              {items.map((c) => {
                const i = flat.indexOf(c);
                const Icon = c.icon;
                return (
                  <button
                    key={c.id}
                    type="button"
                    data-index={i}
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => runIndex(i)}
                    className={`flex w-full items-center gap-2.5 rounded-sm px-2.5 py-[7px] text-left transition-colors ${
                      i === index ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-surface-hover"
                    }`}
                  >
                    <Icon size={13} className={i === index ? "text-accent" : "text-fg-3"} />
                    <span className={`text-[12.5px] ${i === index ? "font-medium text-accent" : "text-fg-1"}`}>
                      {c.label}
                    </span>
                    {c.shortcut && (
                      <span className="ml-auto flex items-center gap-0.5">
                        {c.shortcut.map((k) => (
                          <span key={k} className="aq-keycap">{k}</span>
                        ))}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="border-t border-line-faint px-4 py-2">
          <p className="text-[10.5px] text-fg-3">{t("palette.hints")}</p>
        </div>
      </div>
    </div>
  );
}
