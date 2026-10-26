"use client";

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import "@/styles/dockview-aqvenor.css";

import { useAqvenor } from "@/lib/aqvenor/store";
import { useT } from "@/lib/aqvenor/useT";
import { translate } from "@/lib/aqvenor/i18n";
import { X } from "lucide-react";
import { modeDefaultSurface, surfaceAllowedInMode } from "@/lib/aqvenor/modes";
import type { Surface, WorkMode, Locale } from "@/lib/aqvenor/types";
import { ContextPanel } from "./ContextPanel";
import { getSessionDragId, hasSessionDrag } from "@/lib/aqvenor/dnd";
import {
  CONTEXT_MIN_WIDTH,
  DOCK_LAYOUT_VERSION,
  PANEL_MIN_HEIGHT,
  PANEL_MIN_WIDTH,
  readSavedLayout,
  splitFits,
  stripFloats,
} from "@/lib/aqvenor/dock-layout";

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

/* One generic panel component for every surface — reads its surface id from the
   panel params and renders the matching view (lazy ones resolve in Suspense).
   There is no tab strip (see dockview-aqvenor.css), so each panel carries its
   own hover-close; the sidebar is the switcher. Closing the last panel rebuilds
   the mode default through onDidRemovePanel, so the dock is never left empty. */
function SurfacePanel(props: IDockviewPanelProps<{ surface: string; sessionId?: string }>) {
  const t = useT();
  const pinnedSession = props.params.surface === "chat" ? props.params.sessionId : undefined;
  const node =
    pinnedSession !== undefined ? (
      <ChatView key={pinnedSession} sessionId={pinnedSession} />
    ) : (
      (VIEWS[props.params.surface] ?? VIEWS.chat)
    );
  const closable = props.params.surface !== "context";
  return (
    <div className="group/aq-panel relative h-full w-full min-h-0 overflow-hidden">
      <Suspense fallback={<Fallback />}>{node}</Suspense>
      {closable && (
        <button
          type="button"
          onClick={() => props.api.close()}
          aria-label={t("common.close")}
          title={t("common.close")}
          className="aq-focus-ring absolute right-1.5 top-14 z-20 flex h-6 w-6 items-center justify-center rounded-xs border border-line-faint bg-surface-2/90 text-fg-3 opacity-0 shadow-subtle backdrop-blur transition-opacity hover:bg-surface-hover hover:text-fg-1 focus-visible:opacity-100 group-hover/aq-panel:opacity-100"
        >
          <X size={13} aria-hidden />
        </button>
      )}
    </div>
  );
}

const COMPONENTS = { surface: SurfacePanel };

export function DockWorkspace() {
  const t = useT();
  const locale = t.locale;
  const surface = useAqvenor((s) => s.surface);
  const surfaceNonce = useAqvenor((s) => s.surfaceNonce);
  const workMode = useAqvenor((s) => s.ui.workMode);
  const contextOpen = useAqvenor((s) => s.ui.contextPanelOpen);
  const apiRef = useRef<DockviewApi | null>(null);
  /* Set when a pinned chat panel becomes active: its surface is plain "chat",
     but the main chat panel must not grab focus — see the nav-click effect. */
  const skipSurfaceOpenRef = useRef(false);
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
     ("open here", a plain tab like a sidebar click). */
  const [dropDir, setDropDir] = useState<"left" | "right" | "top" | "bottom" | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const toast = useCallback((titleKey: string, descKey: string) => {
    const state = useAqvenor.getState();
    state.pushToast(translate(state.ui.locale, titleKey), translate(state.ui.locale, descKey));
  }, []);
  /* Plain open (sidebar click, palette, shortcut): the surface becomes a TAB in
     the group the person is looking at — it opens ON TOP of the previous panel.
     Splitting is now strictly an explicit action (Alt+click, "open beside", or
     dragging a tab / a sidebar row to an edge), because a click that silently
     divided the workspace was the single most annoying thing about the old
     dock: eight surfaces meant eight unreadable columns. An empty dock (fresh
     buildDefault) still fills whole. */
  const addSurface = useCallback(
    (
      api: DockviewApi,
      id: string,
      opts?: {
        params?: { surface: string; sessionId?: string };
        /** explicit docking edge; omitted = a tab next to the active panel */
        direction?: "left" | "right" | "above" | "below";
      },
    ) => {
      const existing = api.getPanel(id);
      if (existing) return existing;
      const ref =
        api.activePanel && api.activePanel.id !== "context" ? api.activePanel : api.panels[0];
      const isContext = id === "context";
      /* No edge given = a tab in the reference group ("within"). With no panel
         to reference, an explicit edge means an absolute split. */
      const position:
        | { referencePanel: string; direction: "left" | "right" | "above" | "below" | "within" }
        | { direction: "left" | "right" | "above" | "below" }
        | undefined = ref
        ? { referencePanel: ref.id, direction: opts?.direction ?? "within" }
        : opts?.direction
          ? { direction: opts.direction }
          : undefined;
      return api.addPanel({
        id,
        component: "surface",
        title: panelTitle(id, locale),
        params: opts?.params ?? { surface: id },
        minimumWidth: isContext ? CONTEXT_MIN_WIDTH : PANEL_MIN_WIDTH,
        minimumHeight: PANEL_MIN_HEIGHT,
        ...(position ? { position } : {}),
      });
    },
    [locale],
  );

  /* Open a surface in a NEW group beside the active panel (Alt+click, "open
     beside", sidebar drop on an edge, tab drag). Existing panel → focus. A
     split that would leave less than a readable panel falls back to a tab, so
     the workspace can never be diced into slivers. */
  const placeSurface = useCallback(
    (surfaceId: string, dir: "left" | "right" | "above" | "below") => {
      const dock = apiRef.current;
      if (!dock) return;
      if (!surfaceAllowedInMode(surfaceId as Surface, modeRef.current)) return;
      const existing = dock.getPanel(surfaceId);
      if (existing) {
        /* Already open. "Open beside" from the sidebar (or a drop on an edge)
           still means what it says: pull the panel out of its stack into its own
           column. Only when it already stands alone is there nothing to do. */
        if (existing.group.panels.length > 1 && splitFits(dock, dir)) {
          const group = dock.addGroup({ referencePanel: existing.id, direction: dir });
          existing.api.moveTo({ group });
        }
        existing.api.setActive();
        return;
      }
      if (!splitFits(dock, dir)) {
        addSurface(dock, surfaceId).api.setActive();
        toast("dock.noRoom.title", "dock.noRoom.desc");
        return;
      }
      addSurface(dock, surfaceId, { direction: dir }).api.setActive();
    },
    [addSurface, toast],
  );

  /* Pin a chat beside the reference panel (sidebar session drop, Alt+click,
     "open beside"). Existing pin → focus. The main "chat" panel is never
     reused: it keeps following the current session. A pin is an explicit
     "side by side" gesture, so it splits when there is room and becomes a tab
     when there is not. */
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
      const fits = splitFits(dock, dir);
      if (!fits) {
        /* No room for another column, and a pinned chat has no other way back
           (there is no tab strip, and it is not a sidebar item) — show it in the
           main chat panel instead of hiding it behind one. */
        st.selectSession(sessionId);
        st.setSurface("chat");
        toast("dock.noRoom.title", "dock.noRoom.chatDesc");
        return;
      }
      addSurface(dock, id, { params: { surface: "chat", sessionId }, direction: dir }).api.setActive();
    },
    [addSurface, toast],
  );

  const scheduleSave = useCallback(() => {
    if (restoringRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const api = apiRef.current;
      if (!api) return;
      try {
        // persist the docked layout only — floats never survive a reload
        useAqvenor.getState().setDockLayout(modeRef.current, {
          v: DOCK_LAYOUT_VERSION,
          layout: stripFloats(api.toJSON() as unknown as Record<string, unknown>),
        });
      } catch {
        /* ignore serialization hiccups */
      }
    }, 400);
  }, []);

  /* Build a mode's default layout: its home surface + the context panel on the
     right when the context toggle is on. The context panel is the one panel
     that is docked (not tabbed) by design — it is a side rail the person keeps
     in view while working, and Alt+I toggles it there. */
  const buildDefault = useCallback(
    (api: DockviewApi, mode: WorkMode) => {
      restoringRef.current = true;
      api.clear();
      const st = useAqvenor.getState();
      const home = surfaceAllowedInMode(st.surface, mode) ? st.surface : modeDefaultSurface[mode];
      const homePanel = addSurface(api, home);
      if (st.ui.contextPanelOpen) addSurface(api, "context", { direction: "right" });
      homePanel.api.setActive(); // keep the home surface focused, not the context panel
      restoringRef.current = false;
      // write the rebuilt layout back, so a dropped (legacy) layout is replaced
      // by this clean one instead of being rebuilt again on every start
      scheduleSave();
    },
    [addSurface, scheduleSave],
  );

  /* Restore a mode's saved layout, falling back to its default on anything
     missing, corrupt, or saved by the tiling dock. */
  const restoreOrDefault = useCallback(
    (api: DockviewApi, mode: WorkMode) => {
      const layout = readSavedLayout(useAqvenor.getState().dockLayout[mode]);
      if (layout) {
        try {
          restoringRef.current = true;
          api.fromJSON(
            stripFloats(layout) as unknown as Parameters<DockviewApi["fromJSON"]>[0],
          );
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

      // active panel → store.surface (sidebar highlight / header / shortcuts).
      // Pinned chat panels report as plain "chat": the store knows surfaces,
      // not sessions, and "chat:…" would corrupt the highlight.
      api.onDidActivePanelChange((e) => {
        const raw = e.panel?.id;
        const pinned = raw ? pinnedSessionOf(raw) : null;
        const id = pinned ? "chat" : raw;
        if (id && id !== "context" && id !== useAqvenor.getState().surface) {
          if (pinned) skipSurfaceOpenRef.current = true;
          useAqvenor.getState().setSurface(id as Surface, { noHistory: true });
        }
      });
      api.onDidRemovePanel((panel) => {
        if (panel?.id === "context") useAqvenor.getState().setUi({ contextPanelOpen: false });
        if (api.panels.length === 0) buildDefault(api, modeRef.current);
        scheduleSave();
      });
      api.onDidLayoutChange(() => scheduleSave());
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
        useAqvenor.getState().setDockLayout(modeRef.current, {
          v: DOCK_LAYOUT_VERSION,
          layout: stripFloats(api.toJSON() as unknown as Record<string, unknown>),
        });
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
    /* A pinned chat reports the surface "chat"; focusing the main chat panel here
       would yank the person away from the pane they just clicked. */
    if (skipSurfaceOpenRef.current) {
      skipSurfaceOpenRef.current = false;
      return;
    }
    addSurface(api, surface).api.setActive();
  }, [surface, surfaceNonce, workMode, addSurface]);

  // context panel is a dock panel now; its toggle (Alt+I) opens / closes it.
  // It docks to the right of the working group rather than tabbing over it.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const panel = api.getPanel("context");
    if (contextOpen && !panel) addSurface(api, "context", { direction: "right" });
    else if (!contextOpen && panel) panel.api.close();
  }, [contextOpen, addSurface]);

  // Tab titles follow the interface language, and a pinned chat's tab follows
  // its session title when the chat is renamed in the sidebar.
  useEffect(() => {
    const sync = () => {
      const api = apiRef.current;
      if (!api) return;
      const l = useAqvenor.getState().ui.locale;
      for (const panel of api.panels) {
        try {
          panel.api.setTitle(panelTitle(panel.id, l));
        } catch {
          /* a panel torn down mid-iteration (close during layout change) */
        }
      }
    };
    sync();
    let last = "";
    return useAqvenor.subscribe((s) => {
      const next = `${s.ui.locale}|${s.sessions.map((x) => `${x.id}:${x.title}`).join("|")}`;
      if (next === last) return;
      last = next;
      sync();
    });
  }, [locale, dockEpoch]);

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
      <DockviewReact
        key={dockEpoch}
        className="aq-dock dockview-theme-dark dockview-theme-aqvenor"
        components={COMPONENTS}
        onReady={onReady}
        disableFloatingGroups
      />
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
