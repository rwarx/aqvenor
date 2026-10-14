"use client";

import { lazy, Suspense, createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import "@/styles/dockview-aqvenor.css";
import { X } from "lucide-react";

import { useAqvenor } from "@/lib/aqvenor/store";
import { useT } from "@/lib/aqvenor/useT";
import { translate } from "@/lib/aqvenor/i18n";
import { modeDefaultSurface, surfaceAllowedInMode } from "@/lib/aqvenor/modes";
import type { Surface, WorkMode, Locale } from "@/lib/aqvenor/types";
import { ContextPanel } from "./ContextPanel";
import { getSessionDragId, hasSessionDrag } from "@/lib/aqvenor/dnd";

import { ChatView } from "../chat/ChatView";
const CanvasView = lazy(() => import("../canvas/CanvasView"));
const GraphOutlineView = lazy(() => import("../canvas/GraphOutlineView"));
const FilesView = lazy(() => import("../workspace/FilesView"));
const CodeView = lazy(() => import("../workspace/CodeView"));
const GitView = lazy(() => import("../workspace/GitView"));
const ModelsView = lazy(() => import("../settings/ModelsView"));
const TasksView = lazy(() => import("../workspace/TasksView"));
const WorkflowsView = lazy(() => import("../workspace/WorkflowsView"));
const TrajectoryView = lazy(() => import("../workspace/TrajectoryView"));
const SettingsView = lazy(() => import("../settings/SettingsView"));

function Fallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <span className="h-5 w-5 animate-spin-slow rounded-full border-2 border-line border-t-accent" />
    </div>
  );
}

/* surface id → the existing view, rendered to fill the dock panel body */
const VIEWS: Record<string, React.ReactNode> = {
  chat: <ChatView />,
  canvas: <CanvasView />,
  graph: <GraphOutlineView />,
  files: <FilesView />,
  code: <CodeView />,
  git: <GitView />,
  models: <ModelsView />,
  tasks: <TasksView />,
  workflows: <WorkflowsView />,
  trajectory: <TrajectoryView />,
  settings: <SettingsView />,
  context: <ContextPanel />,
};

/* surface id → i18n key for the tab title */
const TITLE_KEY: Record<string, string> = {
  chat: "nav.chat",
  canvas: "nav.canvas",
  graph: "nav.graph",
  files: "nav.files",
  code: "nav.code",
  git: "nav.git",
  trajectory: "nav.trajectory",
  tasks: "tasks.title",
  models: "providers.title",
  workflows: "nav.workflows",
  settings: "settings.title",
  context: "dock.context",
};

export function panelTitle(surface: string, locale: Locale): string {
  const pinned = pinnedSessionOf(surface);
  if (pinned) {
    // Pinned chat panels carry their session's title, like the sidebar row.
    const title = useAqvenor.getState().resolveSession(pinned)?.title;
    if (title) return title;
  }
  const key = TITLE_KEY[surface];
  return key ? translate(locale, key) : surface;
}

/* Drag payload the sidebar sets on a NavItem dragstart; DockWorkspace reads it
   on drop. Lowercase by convention — browsers lowercase dataTransfer types. */
export const DOCK_SURFACE_MIME = "application/x-aq-surface";

/* A second chat pinned beside the main one: panel id `chat:<sessionId>`
   with params { surface: "chat", sessionId }. The main "chat" panel keeps
   following the current session; pinned panels stay on theirs, so two
   chats read side by side. */
export const pinnedChatId = (sessionId: string): string => `chat:${sessionId}`;
const pinnedSessionOf = (panelId: string): string | null =>
  panelId.startsWith("chat:") ? panelId.slice("chat:".length) : null;

/* How many panels the dock currently holds. Feeds the per-panel close button:
   with a single panel there is nothing docked, so the × stays hidden. */
const DockCountContext = createContext(1);

/* One generic panel component for every surface — reads its surface id from the
   panel params and renders the matching view (lazy ones resolve in Suspense).
   The dock has no tab strip (see dockview-aqvenor.css), so each panel in a
   split carries its own hover-close — the only per-panel removal besides the
   palette's reset-layout. Closing the last panel rebuilds the mode default
   through onDidRemovePanel, so the dock can never be left empty. */
function SurfacePanel(props: IDockviewPanelProps<{ surface: string; sessionId?: string }>) {
  const t = useT();
  const panelCount = useContext(DockCountContext);
  const pinnedSession = props.params.surface === "chat" ? props.params.sessionId : undefined;
  const node =
    pinnedSession !== undefined ? (
      <ChatView key={pinnedSession} sessionId={pinnedSession} />
    ) : (
      (VIEWS[props.params.surface] ?? VIEWS.chat)
    );
  return (
    <div className="group/aq-panel relative h-full w-full min-h-0 overflow-hidden">
      <Suspense fallback={<Fallback />}>{node}</Suspense>
      {panelCount > 1 && (
        <button
          type="button"
          onClick={() => props.api.close()}
          aria-label={t("common.close")}
          title={t("common.close")}
          className="aq-focus-ring absolute right-1.5 top-14 z-20 flex h-6 w-6 items-center justify-center rounded-xs border border-line-faint bg-surface-2/90 text-fg-3 opacity-0 shadow-subtle backdrop-blur transition-opacity hover:bg-surface-hover hover:text-fg-1 focus-visible:opacity-100 group-hover/aq-panel:opacity-100"
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

const COMPONENTS = { surface: SurfacePanel };

/* A saved layout stripped of floating / popout / edge groups. Floating panels
   must NOT persist: a stray float restored on load sits on top of the dock and
   makes it look like surfaces "won't open" (they actually open behind it).
   Native drag-to-float still works within a session; it just never survives a
   reload. */
function stripFloats(json: Record<string, unknown>): Record<string, unknown> {
  return { grid: json.grid, panels: json.panels, activeGroup: json.activeGroup };
}

export function DockWorkspace() {
  const t = useT();
  const locale = t.locale;
  const surface = useAqvenor((s) => s.surface);
  const surfaceNonce = useAqvenor((s) => s.surfaceNonce);
  const workMode = useAqvenor((s) => s.ui.workMode);
  const contextOpen = useAqvenor((s) => s.ui.contextPanelOpen);
  const apiRef = useRef<DockviewApi | null>(null);
  const modeRef = useRef<WorkMode>(workMode);
  const restoringRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* Bumping this remounts DockviewReact. We rebuild the layout by remounting
     rather than calling api.clear() on the live dock, because clear()+re-add on
     a populated, mounted dock leaves the renderer blank (the panel portals are
     torn down and not re-established) — the "nothing opens in Code mode" bug.
     A fresh mount always renders cleanly. */
  const [dockEpoch, setDockEpoch] = useState(0);
  const remount = useCallback(() => setDockEpoch((e) => e + 1), []);
  /* sidebar drag-to-dock: which edge the dragged surface would split at, for
     the drop indicator. Null = no sidebar drag over the dock, or the centre
     ("open here", a plain focus like a sidebar click). */
  const [dropDir, setDropDir] = useState<"left" | "right" | "top" | "bottom" | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /* live panel count for the hover-close visibility (DockCountContext) */
  const [panelCount, setPanelCount] = useState(1);

  const addSurface = useCallback(
    (api: DockviewApi, id: string, splitRight = false) => {
      const existing = api.getPanel(id);
      if (existing) return existing;
      return api.addPanel({
        id,
        component: "surface",
        title: panelTitle(id, locale),
        params: { surface: id },
        ...(splitRight ? { position: { direction: "right" as const } } : {}),
      });
    },
    [locale],
  );

  /* Open a surface in a new group beside the reference panel (sidebar split:
     Alt+click, "open beside", sidebar drop). Existing panel → focus.
     Disallowed in this mode → ignore. Never `within`: with no tab strip a
     same-group stack would hide panels behind no affordance. */
  const placeSurface = useCallback(
    (surfaceId: string, dir: "left" | "right" | "above" | "below") => {
      const dock = apiRef.current;
      if (!dock) return;
      if (!surfaceAllowedInMode(surfaceId as Surface, modeRef.current)) return;
      const existing = dock.getPanel(surfaceId);
      if (existing) {
        existing.api.setActive();
        return;
      }
      const ref =
        dock.activePanel && dock.activePanel.id !== "context"
          ? dock.activePanel
          : dock.panels[0];
      const panel = dock.addPanel({
        id: surfaceId,
        component: "surface",
        title: panelTitle(surfaceId, useAqvenor.getState().ui.locale),
        params: { surface: surfaceId },
        ...(ref ? { position: { referencePanel: ref.id, direction: dir } } : {}),
      });
      panel.api.setActive();
    },
    [],
  );

  /* Pin a chat beside the reference panel (sidebar session drop, Alt+click,
     "open beside"). Existing pin → focus. The main "chat" panel is never
     reused: it keeps following the current session. */
  const placePinnedChat = useCallback(
    (sessionId: string, dir: "left" | "right" | "above" | "below") => {
      const dock = apiRef.current;
      if (!dock) return;
      if (!surfaceAllowedInMode("chat", modeRef.current)) return;
      const st = useAqvenor.getState();
      // Dedupe by RESOLVED session: after a placeholder→server upgrade the
      // same chat answers to two ids, and a second pin must focus, not fork.
      const resolved = st.resolveSession(sessionId)?.id ?? sessionId;
      const dup = dock.panels.find((p) => {
        const sid = pinnedSessionOf(p.id);
        if (!sid) return false;
        return (st.resolveSession(sid)?.id ?? sid) === resolved;
      });
      if (dup) {
        dup.api.setActive();
        return;
      }
      const id = pinnedChatId(sessionId);
      const existing = dock.getPanel(id);
      if (existing) {
        existing.api.setActive();
        return;
      }
      const ref =
        dock.activePanel && dock.activePanel.id !== "context"
          ? dock.activePanel
          : dock.panels[0];
      const panel = dock.addPanel({
        id,
        component: "surface",
        title: panelTitle(id, useAqvenor.getState().ui.locale),
        params: { surface: "chat", sessionId },
        ...(ref ? { position: { referencePanel: ref.id, direction: dir } } : {}),
      });
      panel.api.setActive();
    },
    [],
  );

  /* Build a mode's default layout: its home surface + the context panel on the
     right when the context toggle is on. */  const buildDefault = useCallback(
    (api: DockviewApi, mode: WorkMode) => {
      restoringRef.current = true;
      api.clear();
      const st = useAqvenor.getState();
      const home = surfaceAllowedInMode(st.surface, mode) ? st.surface : modeDefaultSurface[mode];
      const homePanel = addSurface(api, home);
      if (st.ui.contextPanelOpen) addSurface(api, "context", true);
      homePanel.api.setActive(); // keep the home surface focused, not the context panel
      restoringRef.current = false;
    },
    [addSurface],
  );

  /* Restore a mode's saved layout, falling back to its default on anything
     missing or corrupt. */
  const restoreOrDefault = useCallback(
    (api: DockviewApi, mode: WorkMode) => {
      const saved = useAqvenor.getState().dockLayout[mode];
      if (saved) {
        try {
          restoringRef.current = true;
          api.fromJSON(stripFloats(saved as Record<string, unknown>) as unknown as Parameters<DockviewApi["fromJSON"]>[0]);
          restoringRef.current = false;
          if (api.panels.length === 0) buildDefault(api, mode);
        } catch {
          restoringRef.current = false;
          buildDefault(api, mode);
        }
      } else {
        buildDefault(api, mode);
      }
      const activeRaw = api.activePanel?.id;
      const active = activeRaw && pinnedSessionOf(activeRaw) ? "chat" : activeRaw;
      if (active && active !== "context") {
        useAqvenor.getState().setSurface(active as Surface, { noHistory: true });
      }
    },
    [buildDefault],
  );

  const scheduleSave = useCallback(() => {
    if (restoringRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const api = apiRef.current;
      if (!api) return;
      try {
        // persist the docked layout only — floats never survive a reload
        useAqvenor.getState().setDockLayout(modeRef.current, stripFloats(api.toJSON() as unknown as Record<string, unknown>));
      } catch {
        /* ignore serialization hiccups */
      }
    }, 400);
  }, []);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      apiRef.current = api;
      // live api for the command-palette reset-layout action (and tests)
      (window as unknown as { __aqDock?: DockviewApi }).__aqDock = api;
      (window as unknown as { __aqDockReset?: () => void }).__aqDockReset = () => {
        useAqvenor.getState().resetDockLayout(modeRef.current);
        remount();
      };
      // live api for the sidebar's split action (Alt+click / "open beside" / drop)
      (window as unknown as { __aqDockSplit?: (surface: string) => void }).__aqDockSplit = (
        surfaceId: string,
      ) => {
        placeSurface(surfaceId, "right");
      };
      // live api for pinning a chat beside the active panel (Alt+click /
      // "open beside" / session-row drop on a sidebar chat row)
      (window as unknown as { __aqDockPinChat?: (sessionId: string) => void }).__aqDockPinChat = (
        sessionId: string,
      ) => {
        placePinnedChat(sessionId, "right");
      };
      modeRef.current = useAqvenor.getState().ui.workMode;
      restoreOrDefault(api, modeRef.current);
      // the restore above runs before the layout subscription below, so sync
      // the initial count explicitly — otherwise a restored split would hide
      // every close button until the next layout change
      setPanelCount(api.panels.length);

      // active panel → store.surface (sidebar highlight / header / shortcuts).
      // Pinned chat panels report as plain "chat": the store knows surfaces,
      // not sessions, and "chat:…" would corrupt the highlight.
      api.onDidActivePanelChange((e) => {
        const raw = e.panel?.id;
        const id = raw && pinnedSessionOf(raw) ? "chat" : raw;
        if (id && id !== "context" && id !== useAqvenor.getState().surface) {
          useAqvenor.getState().setSurface(id as Surface, { noHistory: true });
        }
      });
      api.onDidRemovePanel((panel) => {
        if (panel?.id === "context") useAqvenor.getState().setUi({ contextPanelOpen: false });
        if (api.panels.length === 0) buildDefault(api, modeRef.current);
        scheduleSave();
      });
      api.onDidLayoutChange(() => {
        scheduleSave();
        // panel count for the hover-close: a layout change is add/remove/move,
        // and same-value sets bail out, so this is cheap to run unconditionally
        setPanelCount(api.panels.length);
      });
    },
    [restoreOrDefault, buildDefault, scheduleSave, remount, placeSurface, placePinnedChat],
  );

  // Work-mode switch: persist the outgoing layout, then REMOUNT so the incoming
  // mode's layout is built on a fresh dock (never clear() a live one).
  useEffect(() => {
    if (modeRef.current === workMode) return;
    const api = apiRef.current;
    if (api) {
      try {
        useAqvenor.getState().setDockLayout(modeRef.current, stripFloats(api.toJSON() as unknown as Record<string, unknown>));
      } catch {
        /* ignore */
      }
    }
    modeRef.current = workMode;
    remount();
  }, [workMode, remount]);

  // Open/focus the active surface on a nav click (same mode only; a mode switch
  // is handled by the remount above, which opens the mode's active surface).
  useEffect(() => {
    const api = apiRef.current;
    if (!api || modeRef.current !== workMode) return;
    if ((surface as string) === "context" || !surfaceAllowedInMode(surface, workMode)) return;
    addSurface(api, surface).api.setActive();
  }, [surface, surfaceNonce, workMode, addSurface]);

  // context panel is a dock panel now; its toggle (Alt+I) opens / closes it.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const panel = api.getPanel("context");
    if (contextOpen && !panel) addSurface(api, "context", true);
    else if (!contextOpen && panel) panel.api.close();
  }, [contextOpen, addSurface]);

  return (
    <div
      ref={wrapRef}
      onDragOver={(e) => {
        const types = Array.from(e.dataTransfer.types ?? []);
        if (!types.includes(DOCK_SURFACE_MIME) && !hasSessionDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        const rect = wrapRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) {
          setDropDir(null);
          return;
        }
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        const EDGE = 0.22;
        setDropDir(
          x < EDGE ? "left" : x > 1 - EDGE ? "right" : y < EDGE ? "top" : y > 1 - EDGE ? "bottom" : null,
        );
      }}
      onDragLeave={(e) => {
        if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) setDropDir(null);
      }}
      onDrop={(e) => {
        const surfaceId = e.dataTransfer.getData(DOCK_SURFACE_MIME);
        const sessionId = getSessionDragId(e);
        const dir = dropDir;
        setDropDir(null);
        if (!surfaceId && !sessionId) return;
        e.preventDefault();
        if (sessionId) {
          // chat row drop — centre means "beside", like Alt+click
          placePinnedChat(sessionId, dir === "top" ? "above" : dir === "bottom" ? "below" : dir === "left" ? "left" : "right");
          return;
        }
        if (!dir) {
          // centre drop — plain open through the store, like a sidebar click
          if (surfaceAllowedInMode(surfaceId as Surface, modeRef.current)) {
            useAqvenor.getState().setSurface(surfaceId as Surface);
          }
          return;
        }
        placeSurface(surfaceId, dir === "top" ? "above" : dir === "bottom" ? "below" : dir);
      }}
      className="relative h-full w-full min-h-0"
    >
      <DockCountContext.Provider value={panelCount}>
        <DockviewReact
          key={dockEpoch}
          className="aq-dock dockview-theme-dark dockview-theme-aqvenor"
          components={COMPONENTS}
          onReady={onReady}
          disableFloatingGroups
        />
      </DockCountContext.Provider>
      {dropDir && (
        <div
          aria-hidden
          className={`pointer-events-none absolute z-30 border-accent bg-accent-soft/30 ${
            dropDir === "left"
              ? "inset-y-0 left-0 w-1/4 border-r-2"
              : dropDir === "right"
                ? "inset-y-0 right-0 w-1/4 border-l-2"
                : dropDir === "top"
                  ? "inset-x-0 top-0 h-1/4 border-b-2"
                  : "inset-x-0 bottom-0 h-1/4 border-t-2"
          }`}
        />
      )}
    </div>
  );
}
