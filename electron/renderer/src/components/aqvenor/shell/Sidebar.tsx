"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Eye,
  EyeOff,
  Frame,
  ListTodo,
  FileCode2,
  Files,
  Folder,
  FolderOpen,
  FolderPlus,
  ChevronRight,
  Check,
  Columns2,
  CornerDownRight,
  GitBranch,
  GitFork,
  MessageSquare,
  Moon,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Store,
  Sun,
  Trash2,
  Users,
  Waypoints,
  Workflow,
  X,
} from "lucide-react";
import { sessionModeOf, useAqvenor } from "@/lib/aqvenor/store";
import { openWorkspaceByPath, pickFolderPath } from "@/lib/aqvenor/sync";
import { useT } from "@/lib/aqvenor/useT";
import type { Project, Session, Surface } from "@/lib/aqvenor/types";
import { MODE_SURFACES } from "@/lib/aqvenor/modes";
import { AqGhostButton, AqToolButton, Overline } from "@/components/aqvenor/ui";
import { DOCK_SURFACE_MIME } from "./DockWorkspace";
import { ExportMenu } from "./ExportMenu";
import { getNodeDragIds, hasNodeDrag, setSessionDrag } from "@/lib/aqvenor/dnd";
import { attachCanvasNodeToDraft } from "@/lib/aqvenor/attachNode";

/* Pin a chat beside the active panel (the dock owns the split, like
   NavItem's __aqDockSplit): focus when already pinned, else a new group
   right of the active panel. Falls back to a plain open with no dock. */
export function openChatBeside(sessionId: string): void {
  const pin = (window as unknown as { __aqDockPinChat?: (id: string) => void }).__aqDockPinChat;
  if (pin) {
    pin(sessionId);
    return;
  }
  useAqvenor.getState().selectSession(sessionId);
}

function relativeTime(ts: number, t: (k: string, ...a: (string | number)[]) => string) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("time.justNow");
  if (mins < 60) return t("time.minutesAgo", mins);
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("time.hoursAgo", hours);
  return t("time.yesterday");
}

const NAV: { id: Surface; icon: React.ElementType; key: string }[] = [
  { id: "chat", icon: MessageSquare, key: "nav.chat" },
  { id: "canvas", icon: Frame, key: "nav.canvas" },
  { id: "graph", icon: Waypoints, key: "nav.graph" },
  { id: "files", icon: Files, key: "nav.files" },
  { id: "code", icon: FileCode2, key: "nav.code" },
  { id: "git", icon: GitBranch, key: "nav.git" },
  { id: "trajectory", icon: Activity, key: "nav.trajectory" },
  { id: "tasks", icon: ListTodo, key: "nav.tasks" },
];

function NavItem({
  surface,
  icon: Icon,
  label,
  collapsed,
  badge,
  onClick,
  editing,
  visible = true,
  onToggleVisible,
}: {
  surface: Surface;
  icon: React.ElementType;
  label: string;
  collapsed: boolean;
  badge?: number;
  onClick: () => void;
  /** sidebar edit mode: the row becomes a visibility toggle, not a link */
  editing?: boolean;
  visible?: boolean;
  onToggleVisible?: () => void;
}) {
  const t = useT();
  const active = useAqvenor((s) => s.surface) === surface;
  /* "open beside" menu (right-click alternative to Alt+click) */
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  /* the dock owns splitting (DockWorkspace.__aqDockSplit): focus when open,
     else a new group right of the active panel. */
  const split = () =>
    (window as unknown as { __aqDockSplit?: (s: string) => void }).__aqDockSplit?.(surface);

  return (
    <div ref={ref} className="group/nav relative">
      <button
        type="button"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DOCK_SURFACE_MIME, surface);
          e.dataTransfer.effectAllowed = "copy";
        }}
        onClick={(e) => {
          if (editing) {
            onToggleVisible?.();
            return;
          }
          if (e.altKey) split();
          else onClick();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!editing) setMenuOpen(true);
        }}
        title={collapsed ? label : undefined}
        aria-current={active ? "page" : undefined}
        className={`aq-focus-ring group relative flex h-[30px] w-full items-center gap-2.5 rounded-sm px-2 text-left transition-colors duration-100 ${
          active ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-surface-hover hover:text-fg-1"
        } ${collapsed ? "justify-center px-0" : ""} ${editing && !visible ? "opacity-45" : ""}`}
      >
        <span
          className={`absolute left-0 top-1/2 h-[14px] w-[2px] -translate-y-1/2 rounded-full bg-accent transition-all duration-150 ${
            active ? "scale-y-100 opacity-100" : "scale-y-0 opacity-0"
          }`}
          aria-hidden
        />
        <Icon size={14} className={active ? "text-accent" : "text-fg-3 group-hover:text-fg-2"} />
        {!collapsed && <span className="truncate text-[12.5px] font-medium">{label}</span>}
        {!collapsed && editing && (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-fg-3">
            {visible ? <Eye size={12} /> : <EyeOff size={12} />}
          </span>
        )}
        {!collapsed && !editing && badge !== undefined && badge > 0 && (
          <span className="ml-auto rounded-full bg-accent-soft px-1.5 py-px font-mono text-[10px] text-accent">
            {badge}
          </span>
        )}
      </button>

      {/* explicit docking: the row itself opens the surface on top of the current
          panel; this puts it in a column of its own (same as Alt+click and the
          row menu). A sibling of the row, because a button cannot nest in a
          button. With no tab strip this is the visible way to dock. */}
      {!collapsed && !editing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            split();
          }}
          aria-label={t("dock.openBeside")}
          title={t("dock.openBeside")}
          className="aq-focus-ring absolute right-1 top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-xs text-fg-3 opacity-0 transition-opacity duration-100 hover:bg-surface-3 hover:text-fg-1 focus-visible:opacity-100 group-hover/nav:opacity-100"
        >
          <PanelRight size={11} aria-hidden />
        </button>
      )}

      {menuOpen && (
        <div className="absolute left-0 top-8 z-30 w-52 animate-settle rounded-md border border-line bg-surface-3 p-1 shadow-overlay">
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              onClick();
            }}
            className="flex h-7 w-full items-center gap-2 rounded-xs px-2 text-[12px] text-fg-2 transition-colors hover:bg-surface-hover hover:text-fg-1"
          >
            <Icon size={12} />
            <span className="truncate">{label}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              split();
            }}
            className="flex h-7 w-full items-center gap-2 rounded-xs px-2 text-[12px] text-fg-2 transition-colors hover:bg-surface-hover hover:text-fg-1"
          >
            <PanelRight size={12} />
            <span className="truncate">{t("dock.openBeside")}</span>
          </button>
          <div className="px-2 py-1 text-[11px] text-fg-3">{t("dock.openBesideHint")}</div>
        </div>
      )}
    </div>
  );
}

function SessionRow({
  session,
  active,
  onOpen,
  assignTargets,
  onAssign,
}: {
  session: Session;
  active: boolean;
  onOpen: () => void;
  /** when provided (Cowork / Code), the row's menu gains a "move to project"
   *  section listing these folders; chat mode leaves it undefined. */
  assignTargets?: Project[];
  onAssign?: (projectId: string | null) => void;
}) {
  const t = useT();
  const renameSession = useAqvenor((s) => s.renameSession);
  const setSessionPinned = useAqvenor((s) => s.setSessionPinned);
  const deleteSession = useAqvenor((s) => s.deleteSession);
  const forkSession = useAqvenor((s) => s.forkSession);
  const confirmDelete = useAqvenor((s) => s.ui.confirmDelete);
  const unread = useAqvenor((s) => s.unread[session.id] ?? 0);
  const [menuOpen, setMenuOpen] = useState(false);
  /* two-step delete: with confirmDelete on, the first click arms the row */
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) {
      setConfirmingDelete(false);
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  if (editing) {
    return (
      <div className="px-1 py-0.5">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              renameSession(session.id, draft.trim() || session.title);
              setEditing(false);
            }
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={() => {
            renameSession(session.id, draft.trim() || session.title);
            setEditing(false);
          }}
          className="w-full rounded-xs border border-accent-border bg-sunken px-2 py-1 text-[12px] text-fg-1 outline-none"
          aria-label={t("sidebar.rename")}
          maxLength={80}
        />
      </div>
    );
  }

  /* drag the row onto the dock (or Alt+click) to pin this chat beside
     the active panel — two chats side by side. */
  const openBeside = () => openChatBeside(session.id);

  /* drop a canvas node onto the row: open this chat and pin the file(s)
     to its next turn — the reverse of dragging the row to the dock. */
  const [nodeOver, setNodeOver] = useState(false);
  const onNodeDrop = (e: React.DragEvent) => {
    if (!hasNodeDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setNodeOver(false);
    const ids = getNodeDragIds(e);
    if (ids.length === 0) return;
    const st = useAqvenor.getState();
    if (st.currentSessionId !== session.id) st.selectSession(session.id);
    st.setSurface("chat");
    void (async () => {
      for (const id of ids) await attachCanvasNodeToDraft(id, session.id);
    })();
  };

  return (
    <div
      ref={rowRef}
      className={`group relative rounded-sm transition-colors ${nodeOver ? "bg-accent-soft" : ""}`}
      draggable
      onDragStart={(e) => setSessionDrag(e, session.id)}
      onDragOver={(e) => {
        if (!hasNodeDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setNodeOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setNodeOver(false);
      }}
      onDrop={onNodeDrop}
    >
      {/* active indicator — same visual language as the NavItem bar */}
      <span
        className={`absolute left-0 top-1/2 h-[16px] w-[2px] -translate-y-1/2 rounded-full bg-accent transition-all duration-150 ${
          active ? "scale-y-100 opacity-100" : "scale-y-0 opacity-0"
        }`}
        aria-hidden
      />
      <button
        type="button"
        onClick={(e) => {
          if (e.altKey) openBeside();
          else onOpen();
        }}
        className={`aq-focus-ring flex h-8 w-full items-center gap-1.5 rounded-sm px-2 text-left transition-colors duration-100 ${
          active ? "bg-accent-soft" : "hover:bg-surface-hover"
        }`}
      >
        {session.pinned && <Pin size={10} className="shrink-0 text-warning" />}
        <span
          title={session.preview ? `${session.title} · ${session.preview}` : session.title}
          className={`min-w-0 flex-1 truncate text-[12px] font-medium ${active ? "text-accent" : "text-fg-1"}`}
        >
          {session.title}
        </span>
        {unread > 0 && (
          <span
            className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-accent px-1 font-mono text-[9px] font-semibold text-on-accent"
            title={`${unread}`}
            aria-label={`${unread}`}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
        <span className="shrink-0 whitespace-nowrap text-[10px] tabular-nums text-fg-3 transition-opacity duration-100 group-hover:opacity-0">
          {relativeTime(session.updatedAt, t)}
        </span>
        <span
          role="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className={`absolute right-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-fg-3 transition-opacity ${
            menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          } hover:bg-surface-3 hover:text-fg-1`}
          aria-label={t("session.actions")}
        >
          <MoreHorizontal size={12} />
        </span>
      </button>

      {menuOpen && (
        <div className="absolute right-0 top-0 z-30 w-44 animate-settle rounded-md border border-line bg-surface-3 p-1 shadow-overlay">
          {[
            {
              icon: Pencil,
              label: t("sidebar.rename"),
              action: () => {
                setDraft(session.title);
                setEditing(true);
              },
            },
            {
              icon: session.pinned ? PinOff : Pin,
              label: session.pinned ? t("sidebar.unpin") : t("sidebar.pin"),
              action: () => setSessionPinned(session.id, !session.pinned),
            },
            {
              icon: GitFork,
              label: t("sidebar.fork"),
              action: () => forkSession(session.id),
            },
            {
              icon: Columns2,
              label: t("sidebar.openBeside"),
              action: openBeside,
            },
          ].map(({ icon: Icon, label, action }) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                setMenuOpen(false);
                action();
              }}
              className="flex h-7 w-full items-center gap-2 rounded-xs px-2 text-[12px] text-fg-2 transition-colors hover:bg-surface-hover hover:text-fg-1"
            >
              <Icon size={12} />
              {label}
            </button>
          ))}
          {/* two-step delete: with confirmDelete on, the first click arms */}
          <button
            type="button"
            onClick={() => {
              if (confirmDelete && !confirmingDelete) {
                setConfirmingDelete(true);
                return;
              }
              setMenuOpen(false);
              setConfirmingDelete(false);
              deleteSession(session.id);
            }}
            className={`flex h-7 w-full items-center gap-2 rounded-xs px-2 text-[12px] transition-colors hover:bg-surface-hover ${
              confirmingDelete ? "bg-error-soft font-medium text-error" : "text-error"
            }`}
          >
            <Trash2 size={12} />
            {confirmingDelete ? t("sidebar.confirmDelete") : t("common.delete")}
          </button>

          {assignTargets && onAssign && (
            <>
              <div className="my-1 h-px bg-line-faint" />
              <div className="px-2 pb-0.5 pt-1">
                <Overline>{t("sidebar.project.moveTo")}</Overline>
              </div>
              {session.projectId && (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onAssign(null);
                  }}
                  className="flex h-7 w-full items-center gap-2 rounded-xs px-2 text-[12px] text-fg-2 transition-colors hover:bg-surface-hover hover:text-fg-1"
                >
                  <X size={12} />
                  {t("sidebar.project.removeFrom")}
                </button>
              )}
              {assignTargets.length === 0 ? (
                <div className="px-2 py-1 text-[11px] text-fg-3">{t("sidebar.project.none")}</div>
              ) : (
                assignTargets.map((p) => {
                  const here = p.id === session.projectId;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      disabled={here}
                      onClick={() => {
                        setMenuOpen(false);
                        if (!here) onAssign(p.id);
                      }}
                      className={`flex h-7 w-full items-center gap-2 rounded-xs px-2 text-[12px] transition-colors ${
                        here ? "text-accent" : "text-fg-2 hover:bg-surface-hover hover:text-fg-1"
                      }`}
                    >
                      {here ? <Check size={12} /> : <CornerDownRight size={12} className="text-fg-3" />}
                      <span className="truncate">{p.name}</span>
                    </button>
                  );
                })
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** chats filed under one project, newest first (pinned float up) */
function byProjectFilter(sessions: Session[], projectId: string): Session[] {
  return sessions
    .filter((s) => s.projectId === projectId)
    .sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return b.updatedAt - a.updatedAt;
    });
}

/** Inline composer for a new (folder-less) project — name only; a Code project
 *  with a workspace folder is created straight from the OS picker instead. */
function NewProjectRow({
  onCreate,
  onCancel,
}: {
  onCreate: (name: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const submit = () => {
    const n = name.trim();
    if (n) onCreate(n);
    else onCancel();
  };
  return (
    <div className="px-1 py-0.5">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
        onBlur={submit}
        placeholder={t("sidebar.project.namePlaceholder")}
        className="w-full rounded-xs border border-accent-border bg-sunken px-2 py-1 text-[12px] text-fg-1 outline-none"
        aria-label={t("sidebar.project.new")}
        maxLength={60}
      />
    </div>
  );
}

/** One collapsible project folder plus its nested chats (Cowork / Code). */
function ProjectFolder({
  project,
  sessions,
  currentSessionId,
  allProjects,
  isCode,
}: {
  project: Project;
  sessions: Session[];
  currentSessionId: string;
  allProjects: Project[];
  isCode: boolean;
}) {
  const t = useT();
  const toggleProjectExpanded = useAqvenor((s) => s.toggleProjectExpanded);
  const deleteProject = useAqvenor((s) => s.deleteProject);
  const newSessionInProject = useAqvenor((s) => s.newSessionInProject);
  const assignSessionToProject = useAqvenor((s) => s.assignSessionToProject);
  const selectSession = useAqvenor((s) => s.selectSession);
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  return (
    <div ref={ref} className="group/folder relative">
      <div
        className={`flex h-8 items-center gap-1 rounded-sm pl-1 pr-1.5 transition-colors ${
          project.expanded ? "bg-surface-hover/40" : "hover:bg-surface-hover"
        }`}
      >
        <button
          type="button"
          onClick={() => toggleProjectExpanded(project.id)}
          className="aq-focus-ring flex min-w-0 flex-1 items-center gap-1.5 rounded-xs py-1 text-left"
          aria-expanded={project.expanded}
        >
          <ChevronRight
            size={12}
            className={`shrink-0 text-fg-3 transition-transform duration-150 ${project.expanded ? "rotate-90" : ""}`}
          />
          {project.expanded ? (
            <FolderOpen size={13} className="shrink-0 text-accent" />
          ) : (
            <Folder size={13} className="shrink-0 text-fg-3" />
          )}
          <span
            className="truncate text-[12px] font-semibold text-fg-1"
            title={project.workspacePath ?? project.name}
          >
            {project.name}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-fg-3">{sessions.length}</span>
        </button>
        <button
          type="button"
          onClick={() => newSessionInProject(project.id)}
          title={t("sidebar.project.newChat")}
          aria-label={t("sidebar.project.newChat")}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-fg-3 opacity-0 transition-opacity hover:bg-surface-3 hover:text-fg-1 group-hover/folder:opacity-100"
        >
          <Plus size={12} />
        </button>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={t("sidebar.project.actions")}
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-fg-3 transition-opacity hover:bg-surface-3 hover:text-fg-1 ${
            menuOpen ? "opacity-100" : "opacity-0 group-hover/folder:opacity-100"
          }`}
        >
          <MoreHorizontal size={12} />
        </button>
      </div>

      {menuOpen && (
        <div className="absolute right-0 top-7 z-30 w-44 animate-settle rounded-md border border-line bg-surface-3 p-1 shadow-overlay">
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              newSessionInProject(project.id);
            }}
            className="flex h-7 w-full items-center gap-2 rounded-xs px-2 text-[12px] text-fg-2 transition-colors hover:bg-surface-hover hover:text-fg-1"
          >
            <Plus size={12} />
            {t("sidebar.project.newChat")}
          </button>
          {isCode && project.workspacePath && (
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                void openWorkspaceByPath(project.workspacePath as string).catch(() => undefined);
              }}
              className="flex h-7 w-full items-center gap-2 rounded-xs px-2 text-[12px] text-fg-2 transition-colors hover:bg-surface-hover hover:text-fg-1"
            >
              <FolderOpen size={12} />
              {t("sidebar.project.openWorkspace")}
            </button>
          )}
          <div className="my-1 h-px bg-line-faint" />
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              deleteProject(project.id);
            }}
            className="flex h-7 w-full items-center gap-2 rounded-xs px-2 text-[12px] text-error transition-colors hover:bg-surface-hover"
          >
            <Trash2 size={12} />
            {t("sidebar.project.delete")}
          </button>
        </div>
      )}

      {project.expanded && (
        <div className="ml-[13px] flex flex-col gap-0.5 border-l border-line-faint pb-0.5 pl-1.5 pt-0.5">
          {sessions.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-fg-3">{t("sidebar.project.empty")}</p>
          ) : (
            sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === currentSessionId}
                onOpen={() => selectSession(s.id)}
                assignTargets={allProjects}
                onAssign={(pid) => assignSessionToProject(s.id, pid)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const t = useT();
  const ui = useAqvenor((s) => s.ui);
  const setSurface = useAqvenor((s) => s.setSurface);
  const allSessions = useAqvenor((s) => s.sessions);
  /* Chats are partitioned by work mode: the list shows only the chats that belong
     to the mode you're in, and switching Chat/Cowork/Code swaps the whole list. */
  const sessions = useMemo(
    () => allSessions.filter((s) => sessionModeOf(s) === ui.workMode),
    [allSessions, ui.workMode],
  );
  const currentSessionId = useAqvenor((s) => s.currentSessionId);
  const currentSession = useAqvenor((s) => s.sessions.find((x) => x.id === s.currentSessionId));
  const selectSession = useAqvenor((s) => s.selectSession);
  const setUi = useAqvenor((s) => s.setUi);
  const sidebarOpenMobile = useAqvenor((s) => s.sidebarOpenMobile);
  const setSidebarOpenMobile = useAqvenor((s) => s.setSidebarOpenMobile);
  const eventsCount = currentSession?.events.length ?? 0;

  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grouped" | "recent">("grouped");
  const [resizing, setResizing] = useState(false);
  const resizeRef = useRef<HTMLDivElement>(null);

  /* ---- projects (Cowork / Code only; Chat stays a flat list) ---- */
  const isProjectMode = ui.workMode !== "chat";
  const isCode = ui.workMode === "code";
  const allProjects = useAqvenor((s) => s.projects);
  const createProject = useAqvenor((s) => s.createProject);
  const assignSessionToProject = useAqvenor((s) => s.assignSessionToProject);
  const [creatingProject, setCreatingProject] = useState(false);
  const modeProjects = useMemo(
    () =>
      allProjects
        .filter((p) => p.mode === ui.workMode)
        .sort((a, b) => a.sortOrder - b.sortOrder || b.lastActivityAt - a.lastActivityAt),
    [allProjects, ui.workMode],
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return sessions;
    const q = query.toLowerCase();
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.messages.some((m) => m.content.toLowerCase().includes(q)),
    );
  }, [sessions, query]);

  /* date-bucketed grouping: pinned → today → yesterday → previous 7 days → earlier */
  const grouped = useMemo(() => {
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startYesterday = startToday - 86_400_000;
    const startWeek = startToday - 6 * 86_400_000;
    const label = (key: string) =>
      key === "pinned"
        ? t("sidebar.group.pinned")
        : key === "today"
          ? t("sidebar.group.today")
          : key === "yesterday"
            ? t("sidebar.group.yesterday")
            : key === "week"
              ? t("sidebar.group.week")
              : t("sidebar.group.earlier");
    /* aggregate into fixed buckets so a pinned older session can't split a
       date group in two (which produced duplicate React keys). */
    const order = ["pinned", "today", "yesterday", "week", "earlier"] as const;
    const buckets: Record<string, typeof filtered> = {};
    for (const s of filtered) {
      const key = s.pinned
        ? "pinned"
        : s.updatedAt >= startToday
          ? "today"
          : s.updatedAt >= startYesterday
            ? "yesterday"
            : s.updatedAt >= startWeek
              ? "week"
              : "earlier";
      (buckets[key] ??= []).push(s);
    }
    return order
      .filter((key) => buckets[key]?.length)
      .map((key) => ({ key, label: label(key), items: buckets[key] }));
  }, [filtered, t]);

  /* chats with no project folder (or whose folder isn't in this mode) — shown
     under "Recent" in Cowork / Code so a chat is never hidden by a stale id */
  const ungrouped = useMemo(() => {
    const ids = new Set(modeProjects.map((p) => p.id));
    return filtered.filter((s) => !s.projectId || !ids.has(s.projectId));
  }, [filtered, modeProjects]);

  const basename = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
  /* Code projects relate to a workspace folder, so "+" offers the OS picker
     first; a cancelled pick (or Cowork) falls back to an inline name input. */
  const startCreateProject = async () => {
    if (isCode) {
      const dir = await pickFolderPath();
      if (dir) {
        createProject(basename(dir), { workspacePath: dir });
        return;
      }
    }
    setCreatingProject(true);
  };

  /* drag resize */
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      useAqvenor.getState().setSidebarWidth(e.clientX);
    };
    const onUp = () => setResizing(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizing]);

  const collapsed = ui.sidebarCollapsed;
  /* sidebar edit mode: nav rows become show/hide toggles (persisted in
     ui.hiddenNavItems — the person decides which elements the sidebar shows) */
  const [navEdit, setNavEdit] = useState(false);
  const hiddenNav = ui.hiddenNavItems ?? [];
  const toggleNavVisible = (id: Surface) => {
    const next = hiddenNav.includes(id) ? hiddenNav.filter((x) => x !== id) : [...hiddenNav, id];
    setUi({ hiddenNavItems: next });
  };

  const body = (
    <div className="flex h-full flex-col bg-surface-1">
      {/* work-mode switch (Chat / Cowork / Code) — the header no longer carries
          it, so the sidebar is its always-visible home. In the collapsed rail the
          three become fixed square buttons in a column: `flex-1` there has no
          free space to grow into (the container is auto-height), so it collapsed
          them from 26px to the 12px of the icon and they piled up on each other. */}
      <div
        className={`flex ${collapsed ? "flex-col items-center gap-1 px-1.5" : "gap-0.5 px-2"} pb-1.5 pt-2`}
      >
        {([
          { id: "chat", icon: MessageSquare, key: "work.mode.chat" },
          { id: "cowork", icon: Users, key: "work.mode.cowork" },
          { id: "code", icon: FileCode2, key: "work.mode.code" },
        ] as const).map(({ id, icon: Icon, key }) => {
          const active = ui.workMode === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => useAqvenor.getState().setWorkMode(id)}
              title={t(`${key}.hint`)}
              aria-pressed={active}
              aria-label={collapsed ? t(key) : undefined}
              className={`aq-focus-ring flex ${collapsed ? "h-7 w-7 shrink-0" : "h-[26px] flex-1"} items-center justify-center gap-1.5 rounded-sm text-[11.5px] font-medium transition-colors duration-100 ${
                active
                  ? "bg-surface-3 text-fg-1 shadow-sm"
                  : "text-fg-3 hover:bg-surface-hover hover:text-fg-2"
              }`}
            >
              <Icon size={collapsed ? 13 : 12} className={active ? "text-accent" : ""} />
              {!collapsed && <span className="truncate">{t(key)}</span>}
            </button>
          );
        })}
      </div>

      {/* rail — workflows / models (palette lives on its shortcuts) */}
      <nav className={`flex flex-col gap-px ${collapsed ? "px-1.5" : "px-2"} pb-1.5`}>
        <NavItem surface="workflows" icon={Workflow} label={t("sidebar.rail.workflows")} collapsed={collapsed} onClick={() => setSurface("workflows")} />
        <NavItem surface="models" icon={Store} label={t("sidebar.rail.models")} collapsed={collapsed} onClick={() => setSurface("models")} />
      </nav>

      <div className={`mx-3 h-px bg-line-faint ${collapsed ? "mx-2" : ""}`} />

      {/* navigation — scoped to the active work mode (chat / cowork / code);
          edit mode (pencil) turns rows into show/hide toggles so the person
          chooses which elements live in the sidebar */}
      <nav className={`flex flex-col gap-px ${collapsed ? "px-1.5" : "px-2"} pb-2 pt-1.5`} aria-label={t("sidebar.section.workspace")}>
        {!collapsed && (
          <div className="flex items-center justify-between px-2 pb-1 pt-1">
            <Overline>{t("sidebar.section.workspace")}</Overline>
            <button
              type="button"
              onClick={() => setNavEdit((v) => !v)}
              aria-pressed={navEdit}
              title={navEdit ? t("sidebar.edit.done") : t("sidebar.edit.start")}
              aria-label={navEdit ? t("sidebar.edit.done") : t("sidebar.edit.start")}
              className={`aq-focus-ring flex h-5 w-5 items-center justify-center rounded-xs transition-colors ${
                navEdit ? "bg-accent-soft text-accent" : "text-fg-3 hover:bg-surface-hover hover:text-fg-1"
              }`}
            >
              <Pencil size={11} />
            </button>
          </div>
        )}
        {navEdit && !collapsed && (
          <p className="px-2 pb-1 text-[10.5px] leading-snug text-fg-3">{t("sidebar.edit.hint")}</p>
        )}
        {NAV.filter((item) => MODE_SURFACES[ui.workMode].includes(item.id))
          .filter((item) => navEdit || !hiddenNav.includes(item.id))
          .map((item) => (
            <NavItem
              key={item.id}
              surface={item.id}
              icon={item.icon}
              label={t(item.key)}
              collapsed={collapsed}
              badge={item.id === "trajectory" ? eventsCount : undefined}
              onClick={() => setSurface(item.id)}
              editing={navEdit && !collapsed}
              visible={!hiddenNav.includes(item.id)}
              onToggleVisible={() => toggleNavVisible(item.id)}
            />
          ))}
      </nav>

      <div className={`mx-3 h-px bg-line-faint ${collapsed ? "mx-2" : ""}`} />

      {/* sessions */}
      {!collapsed && (
        <>
          <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-2.5">
            <div className="flex items-center gap-1.5">
              <Overline>{isProjectMode ? t("sidebar.section.projects") : t("sidebar.section.sessions")}</Overline>
              <span className="font-mono text-[10px] text-fg-3">
                {isProjectMode ? modeProjects.length : sessions.length}
              </span>
            </div>
            {isProjectMode ? (
              <button
                type="button"
                onClick={() => void startCreateProject()}
                title={t("sidebar.project.new")}
                aria-label={t("sidebar.project.new")}
                className="aq-focus-ring flex h-5 items-center gap-1 rounded-xs px-1.5 text-[10px] font-medium text-fg-3 transition-colors hover:bg-surface-hover hover:text-fg-1"
              >
                <FolderPlus size={12} />
                {t("sidebar.project.new")}
              </button>
            ) : (
              <div className="flex items-center gap-0.5 rounded-sm border border-line-faint bg-sunken p-0.5">
                {(["grouped", "recent"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setViewMode(mode)}
                    aria-pressed={viewMode === mode}
                    className={`rounded-xs px-1.5 py-px text-[10px] font-medium transition-colors ${
                      viewMode === mode ? "bg-surface-3 text-fg-1" : "text-fg-3 hover:text-fg-2"
                    }`}
                  >
                    {t(`sidebar.view.${mode}`)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="px-2 pb-1">
            <div className="flex h-7 items-center gap-1.5 rounded-sm border border-line bg-sunken px-2 focus-within:border-line-strong">
              <Search size={11} className="shrink-0 text-fg-3" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("sidebar.searchPlaceholder")}
                className="w-full bg-transparent text-[12px] text-fg-1 outline-none placeholder:text-fg-3"
                aria-label={t("sidebar.searchPlaceholder")}
              />
              {query && (
                <button type="button" onClick={() => setQuery("")} aria-label={t("common.clear")} className="text-fg-3 hover:text-fg-1">
                  <X size={11} />
                </button>
              )}
            </div>
          </div>
        </>
      )}
      <div className={`min-h-0 flex-1 overflow-y-auto ${collapsed ? "px-1.5" : "px-2 pb-2"} pt-1`}>
        {collapsed ? (
          <div className="flex flex-col items-center gap-1">
            {sessions.slice(0, 5).map((s) => (
              <button
                key={s.id}
                type="button"
                title={s.title}
                onClick={() => selectSession(s.id)}
                className={`flex h-7 w-7 items-center justify-center rounded-sm text-[11px] font-medium transition-colors ${
                  s.id === currentSessionId ? "bg-accent-soft text-accent" : "text-fg-3 hover:bg-surface-hover hover:text-fg-1"
                }`}
              >
                {s.title.slice(0, 1).toUpperCase()}
              </button>
            ))}
          </div>
        ) : isProjectMode ? (
          <div className="flex flex-col gap-0.5">
            {creatingProject && (
              <NewProjectRow
                onCreate={(name) => {
                  createProject(name);
                  setCreatingProject(false);
                }}
                onCancel={() => setCreatingProject(false)}
              />
            )}
            {modeProjects.map((p) => (
              <ProjectFolder
                key={p.id}
                project={p}
                sessions={byProjectFilter(filtered, p.id)}
                currentSessionId={currentSessionId}
                allProjects={modeProjects}
                isCode={isCode}
              />
            ))}
            {/* ungrouped chats */}
            {(ungrouped.length > 0 || modeProjects.length === 0) && (
              <div className="flex flex-col gap-0.5">
                <Overline className="px-2 pb-1 pt-2.5">{t("sidebar.group.recent")}</Overline>
                {ungrouped.length === 0 ? (
                  <p className="px-2 py-2 text-[11.5px] text-fg-3">
                    {query ? t("sidebar.noMatches", query) : t("sidebar.project.noneYet")}
                  </p>
                ) : (
                  ungrouped.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      active={s.id === currentSessionId}
                      onOpen={() => selectSession(s.id)}
                      assignTargets={modeProjects}
                      onAssign={(pid) => assignSessionToProject(s.id, pid)}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        ) : filtered.length === 0 ? (
          <p className="px-2 py-3 text-[11.5px] text-fg-3">
            {query ? t("sidebar.noMatches", query) : t("sidebar.noChats")}
          </p>
        ) : viewMode === "recent" ? (
          <div className="flex flex-col gap-0.5">
            {filtered.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === currentSessionId}
                onOpen={() => selectSession(s.id)}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {grouped.map((g) => (
              <div key={g.key} className="flex flex-col gap-0.5">
                <Overline className="px-2 pb-1 pt-2.5 first:pt-1.5">{g.label}</Overline>
                {g.items.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    active={s.id === currentSessionId}
                    onOpen={() => selectSession(s.id)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* footer */}
      <div className={`flex items-center gap-1 border-t border-line-faint p-2 ${collapsed ? "flex-col" : ""}`}>
        <AqToolButton onClick={() => setSurface("settings")} active={useAqvenor.getState().surface === "settings"} aria-label={t("sidebar.settings")}>
          <Settings size={14} />
        </AqToolButton>
        <ExportMenu up />
        <AqToolButton
          onClick={() => setUi({ theme: ui.theme === "dark" ? "light" : "dark" })}
          aria-label={t(`theme.${ui.theme === "dark" ? "light" : "dark"}`)}
          title={t(`theme.${ui.theme === "dark" ? "light" : "dark"}`)}
        >
          {ui.theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
        </AqToolButton>
        {!collapsed && (
          <span className="ml-auto pr-1 font-mono text-[10px] text-fg-3/70">v0.9</span>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* desktop sidebar */}
      <aside
        className="relative hidden shrink-0 border-r border-line-faint lg:block"
        style={{ width: collapsed ? 48 : ui.sidebarWidth }}
        aria-label={t("sidebar.label")}
      >
        {body}
        {/* resize handle */}
        {!collapsed && (
          <div
            ref={resizeRef}
            role="separator"
            aria-orientation="vertical"
            onMouseDown={(e) => {
              e.preventDefault();
              setResizing(true);
            }}
            className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-accent/40"
          />
        )}
      </aside>

      {/* mobile drawer */}
      {sidebarOpenMobile && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-scrim"
            onClick={() => setSidebarOpenMobile(false)}
            aria-hidden
          />
          <div className="absolute inset-y-0 left-0 w-[260px] animate-rise border-r border-line-faint shadow-overlay">
            {body}
          </div>
        </div>
      )}
    </>
  );
}
