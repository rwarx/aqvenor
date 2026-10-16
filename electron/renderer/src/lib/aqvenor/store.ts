"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  AgentMode,
  Approval,
  ApprovalDecision,
  CanvasEdge,
  CanvasNode,
  CanvasState,
  Checkpoint,
  ContextFile,
  DemoFile,
  DraftAttachment,
  EdgeKind,
  Goal,
  Locale,
  Message,
  MessageBlock,
  Project,
  Provider,
  RunnerState,
  Session,
  Surface,
  ThemeMode,
  ToolCall,
  ToolRisk,
  TrajectoryEvent,
  WorkMethod,
  WorkMode,
} from "./types";
import {
  DEFAULT_MODEL_ID,
  DEMO_FILES,
  INITIAL_EDGES,
  INITIAL_NODES,
  PROVIDERS,
  SEED_SESSIONS,
  SKILLS,
} from "./data";
import { modeDefaultSurface, surfaceAllowedInMode } from "./modes";
import { tp, translate } from "./i18n";
import { fmtInt } from "./format";

/* approval waiters (module-scoped, outside the store) */
type ApprovalResolution = { decision: ApprovalDecision; reason?: string };
type ApprovalWaiter = {
  resolve: (r: ApprovalResolution) => void;
  reject: (reason: Error) => void;
  sessionId?: string;
};
const approvalWaiters = new Map<string, ApprovalWaiter>();

/* One chat's unsent input. Keyed by session id so three chats side by side
   keep three independent text boxes, trays and send targets. Runtime-only,
   never persisted (like the old global draft). */
export interface SessionDraft {
  text: string;
  attachments: DraftAttachment[];
}

const emptyDraft = (): SessionDraft => ({ text: "", attachments: [] });

/**
 * Waits for the person to answer one approval question.
 *
 * Rejects rather than hanging forever if the same question is registered twice, and is rejected
 * outright once the run has finished. The previous version resolved through a single
 * `store.approval` slot: two approvals arriving close together overwrote each other, the first
 * waiter's resolve was never called, and since the promise could not reject either, `await` on it
 * blocked the frame handler, which blocked the run. A run that hangs with a spinner and no error is
 * the worst of the available failure modes, so every path out of here terminates.
 */
export function waitForApproval(id: string, sessionId?: string): Promise<ApprovalResolution> {
  return new Promise<ApprovalResolution>((resolve, reject) => {
    const existing = approvalWaiters.get(id);

    if (existing) {
      existing.reject(new Error(`Approval ${id} was registered twice.`));
      approvalWaiters.delete(id);
    }

    approvalWaiters.set(id, { resolve, reject, sessionId });
  });
}

/**
 * Fails every question still open, and why.
 *
 * Called when the run ends. Anything left waiting would otherwise wait for an answer that can no
 * longer arrive, because the store's single approval slot has been cleared.
 */
/* Cleanup hooks for session deletion (stopping a live run lives in
   agent-live, which already imports the store — a direct import back would
   be a module cycle, so deletion notifies instead of calling). */
type SessionDeleteHook = (id: string) => void;
const sessionDeleteHooks = new Set<SessionDeleteHook>();

/** Run `hook` when any chat is deleted; returns an unsubscribe function. */
export function onSessionDeleted(hook: SessionDeleteHook): () => void {
  sessionDeleteHooks.add(hook);
  return () => {
    sessionDeleteHooks.delete(hook);
  };
}

/* Chats currently rendered by a ChatView panel (main or pinned). A run that
   finishes in a non-rendered chat toasts + bumps unread; a visible one needs
   neither, the transcript is already on screen. Refcounts survive StrictMode
   double-mount (mount, unmount, mount ends at exactly one). */
const visibleChats = new Map<string, number>();

export function markChatVisible(id: string): void {
  visibleChats.set(id, (visibleChats.get(id) ?? 0) + 1);
}

export function unmarkChatVisible(id: string): void {
  const n = (visibleChats.get(id) ?? 1) - 1;
  if (n <= 0) visibleChats.delete(id);
  else visibleChats.set(id, n);
}

export function isChatVisible(id: string): boolean {
  return visibleChats.has(id);
}

export function failPendingApprovals(reason: string, sessionId?: string): void {
  if (approvalWaiters.size === 0) return;

  const entries = [...approvalWaiters.entries()];
  for (const [id, waiter] of entries) {
    // A run ending must not kill another chat's open question.
    if (sessionId !== undefined && waiter.sessionId !== undefined && waiter.sessionId !== sessionId) {
      continue;
    }
    approvalWaiters.delete(id);
    waiter.reject(new Error(reason));
  }
}

export interface ToastPayload {
  id: number;
  title: string;
  description?: string;
  variant?: "default" | "destructive";
}

/**
 * Where one file's editor state stands relative to the backend.
 *
 * `unsaved` exists because writes are debounced: without a state between the
 * keystroke and the request there is a window in which the file has been edited
 * and nothing says so.
 */
export type SaveStatus = "unsaved" | "saving" | "saved" | "error";

/**
 * Persisted-shape version. Bump when `partialize` changes shape, so an older cache is rebuilt from
 * defaults instead of being read as if it were current.
 */
const PERSIST_VERSION = 4;

/**
 * Ceilings that keep a long session from growing the cache or memory without limit.
 *
 * Not correctness limits — the backend holds the full history, and the UI paginates by scrolling —
 * so the numbers are about when a person would notice. 2000 messages is roughly a hundred long
 * exchanges; 500 events is well past a screen of scrollback.
 */
const MAX_PERSISTED_MESSAGES = 2000;
const MAX_EVENTS = 500;
const MAX_MESSAGES_PER_SESSION = 2000;

interface UiPrefs {
  theme: ThemeMode;
  locale: Locale;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  /** interface zoom (app scale). 1 = 100%. Applied natively via the Electron
   *  `view.setZoom` bridge, with a CSS `zoom` fallback in the browser build. */
  appZoom: number;
  contextPanelOpen: boolean;
  /** top-level Chat / Cowork / Code switch */
  workMode: WorkMode;
  /** false until the user picks a mode in the first-run onboarding screen */
  modeChosen: boolean;
  /** autonomy while coworking: plan / ask / auto / full */
  workMethod: WorkMethod;
  /** engine mode consumed by the run pipeline — kept in sync with
   *  workMode + workMethod so scenario.ts / agent-live.ts stay unchanged */
  agentMode: AgentMode;
  /** last-open chat per work mode, so switching Chat/Cowork/Code returns you to
   *  the conversation you were in for that mode rather than a shared one. Keyed
   *  by WorkMode; entries are pruned on delete and re-pointed on create/select. */
  activeSessionByMode: Partial<Record<WorkMode, string>>;
  selectedModelId: string;
  showGrid: boolean;
  enterSend: boolean;
  renderMarkdown: boolean;
  autoscroll: boolean;
  /** ask before deleting a chat or message (mirrors General.ConfirmBeforeDelete) */
  confirmDelete: boolean;
  /** derive a chat title from the first user message (mirrors General.AutoGenerateTitles) */
  autoTitles: boolean;
  maxSteps: number;
  /** LLM ghost-text inline completion in the code editor (Tier 1 #7).
   *  Off by default — opt-in per session to avoid surprise token cost. */
  ghostText: boolean;
  /** which auto-selectable skills are active (id → on). Seeded from SKILLS
   *  defaults; the agent only draws on enabled skills when picking per-run. */
  skillsEnabled: Record<string, boolean>;
}

/* Collapse per-chat run states into the single global indicator:
   anything streaming wins, then anything waiting on the person.
   Exported for unit tests — the global bars depend on this ordering. */
export function summarizeRuns(running: Record<string, RunnerState>): RunnerState {
  let awaiting: RunnerState | null = null;
  for (const id of Object.keys(running)) {
    const r = running[id];
    if (r.status === "running") return r;
    if (r.status === "awaiting-approval") awaiting = r;
  }
  return awaiting ?? { status: "idle" };
}

/* Derive the engine AgentMode from the user-facing controls.
   Chat = plain conversation (no tools); Cowork/Code = agentic. */
export function engineModeFor(workMode: WorkMode, workMethod: WorkMethod): AgentMode {
  if (workMode === "chat") return "off";
  return workMethod === "plan" ? "plan" : "build";
}

/* Client-side auto-approval policy for the autonomy selector.
   Returns the decision to apply automatically, or null to prompt the user.
   NB: "full" auto-approves execute here, but the backend still enforces its
   own Execute gate (AgentSettings.AllowCommands, default OFF). */
export function autoApprovalDecision(
  workMethod: WorkMethod,
  risk: ToolRisk,
): ApprovalDecision | null {
  if (workMethod === "auto") return risk === "execute" ? null : "allowed";
  if (workMethod === "full") return "allowed";
  return null;
}

/* ---------- app scale (interface zoom) ----------
   The desktop shell scales crisply via Chromium's own zoom
   (webContents.setZoomFactor, reached through the preload `view` bridge). The
   plain browser build has no bridge, so it falls back to CSS `zoom` on <html>
   — same visual result, so the control is never a dead button. Bounded to a
   readable range. */
export const APP_ZOOM_MIN = 0.6;
export const APP_ZOOM_MAX = 2;
export const APP_ZOOM_PRESETS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;

export function clampAppZoom(factor: number): number {
  const n = Number(factor);
  if (!Number.isFinite(n)) return 1;
  return Math.min(APP_ZOOM_MAX, Math.max(APP_ZOOM_MIN, n));
}

export function applyAppZoom(factor: number): void {
  const f = clampAppZoom(factor);
  if (typeof window === "undefined") return;
  const view = window.aqvenor?.view;
  if (view?.setZoom) {
    void view.setZoom(f);
    /* drop any CSS fallback a prior browser session may have left on <html> */
    if (typeof document !== "undefined") document.documentElement.style.zoom = "";
  } else if (typeof document !== "undefined") {
    document.documentElement.style.zoom = f === 1 ? "" : String(f);
  }
}

interface AqvenorState {
  hydrated: boolean;

  /* ui */
  surface: Surface;
  /** bumped on every setSurface call (even same value) so the dockable
   *  workspace can re-open/focus a surface's panel on a repeat nav click. */
  surfaceNonce: number;
  history: Surface[];
  historyIndex: number;
  paletteOpen: boolean;
  checkpointJumpOpen: boolean;
  cheatsheetOpen: boolean;
  projectExportOpen: boolean;
  /** provider/model management modal (opencode-style) */
  providerStudioOpen: boolean;
  providerStudioTab: "manage" | "connect";
  /** transient: the canvas has a local overlay/gesture that owns Escape
   *  (kind picker, search, connect/reconnect drag) — the global chain
   *  must not treat that Escape as "stop generation" */
  canvasOverlayActive: boolean;
  /** unsent input per chat session (text + staged file tray) */
  drafts: Record<string, SessionDraft>;
  /** sidecar reachability: null = not probed yet, false = runs can't start.
   *  Mirrored from backend.checkBackend so the UI can say so honestly. */
  backendReachable: boolean | null;
  setBackendReachable: (ok: boolean) => void;
  /** chat panel under keyboard focus (main or pinned) — prompt actions
   *  (canvas Ask AI, context panel) address this chat, not always current.
   *  Null until anything is focused; falls back to the current session. */
  focusedChatSessionId: string | null;
  setFocusedChat: (id: string | null) => void;
  recording: boolean;
  sidebarOpenMobile: boolean;
  ui: UiPrefs;
  toasts: ToastPayload[];

  /* data */
  sessions: Session[];
  currentSessionId: string;
  /** project folders for the Cowork / Code sidebars (empty in Chat mode).
   *  Server-backed in server mode; local-only in demo/offline mode. */
  projects: Project[];
  /** serialized dockview layouts, one per work mode (opaque dockview JSON);
   *  persisted so the dockable workspace survives a reload. */
  dockLayout: Record<string, unknown>;
  /** pending approval question per chat session — concurrent runs in
   *  different chats must never overwrite each other's gate. */
  approvals: Record<string, Approval>;
  /** "allowed for this run" tools per chat session (was global: a standing
   *  yes in one chat leaked into every other). */
  allowForRunTools: Record<string, string[]>;
  isAllowedForRun: (tool: string, sessionId?: string) => boolean;
  /** live run state per chat session; the global `runner` mirrors the most
   *  active one so title/status bars keep working unchanged. */
  runningSessions: Record<string, RunnerState>;
  /** finished-while-away counters per chat (sidebar badge); cleared on view */
  unread: Record<string, number>;
  bumpUnread: (sessionId: string) => void;
  markSessionRead: (sessionId: string) => void;
  /** placeholder id → upgraded server id (ensureServerSession swaps the
   *  session object; pinned panels bound to the old id follow the alias). */
  sessionAliases: Record<string, string>;
  goals: Goal[];
  checkpoints: Checkpoint[];
  contextFiles: ContextFile[];
  files: DemoFile[];
  canvas: CanvasState;
  canvasUndo: { nodes: CanvasNode[]; edges: CanvasEdge[] }[];
  canvasRedo: { nodes: CanvasNode[]; edges: CanvasEdge[] }[];
  codeTabs: string[];
  activeCodeTab: string | null;
  /** transient per-file save state for the Code editor (server-mode write-through) */
  saveStatus: Record<string, SaveStatus>;
  /** checkpoint id whose diff review is active in the Code surface (transient) */
  codeReviewCheckpointId: string | null;
  providers: Provider[];
  runner: RunnerState;
  indexing: boolean;
  /** absolute path of the open sidecar workspace (null in demo / none open).
   *  transient (not persisted) — kept in sync by syncWorkspaceFiles and the
   *  shared openWorkspaceDialog() so every surface reads one source of truth. */
  workspaceRoot: string | null;

  /* ui actions */
  setSurface: (s: Surface, opts?: { noHistory?: boolean }) => void;
  goHistory: (delta: number) => void;
  setPaletteOpen: (open: boolean) => void;
  setCheckpointJumpOpen: (open: boolean) => void;
  setCheatsheetOpen: (open: boolean) => void;
  setProjectExportOpen: (open: boolean) => void;
  setProviderStudioOpen: (open: boolean, tab?: "manage" | "connect") => void;
  setCanvasOverlayActive: (active: boolean) => void;
  setCodeReviewCheckpoint: (id: string | null) => void;
  togglePalette: () => void;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  setSidebarOpenMobile: (open: boolean) => void;
  toggleContextPanel: () => void;
  setUi: (patch: Partial<UiPrefs>) => void;
  /** set the Chat/Cowork/Code switch, keeping agentMode in sync */
  setWorkMode: (mode: WorkMode) => void;
  /** set the autonomy selector, keeping agentMode in sync.
   *  With a session id it pins the choice to that chat (panels diverge);
   *  the global stays the default for chats created from here on. */
  setWorkMethod: (method: WorkMethod, sessionId?: string) => void;
  /** unsent text of one chat (defaults to the current session) */
  draftOf: (sessionId?: string) => SessionDraft;
  /** chat under keyboard focus, else the current chat (alias-resolved) */
  focusedChat: () => string;
  setDraft: (draft: string, sessionId?: string) => void;
  addDraftAttachment: (attachment: DraftAttachment, sessionId?: string) => void;
  removeDraftAttachment: (id: string, sessionId?: string) => void;
  clearDraftAttachments: (sessionId?: string) => void;
  setRecording: (recording: boolean) => void;
  setRunner: (patch: Partial<RunnerState>) => void;
  setIndexing: (indexing: boolean) => void;
  setWorkspaceRoot: (root: string | null) => void;
  pushToast: (title: string, description?: string, variant?: "default" | "destructive") => void;
  dismissToast: (id: number) => void;

  /* session actions */
  newSession: () => string;
  /** restore a session + goals from an imported bundle (ids remapped on collision) */
  importSession: (session: Session, goals: Goal[]) => string;
  selectSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  /** apply a title derived automatically (provisional guess or the server's
   *  echo) — local-only, never PATCHes the server, and leaves a hand-renamed
   *  chat (titleUserDefined) untouched. */
  applyAutoTitle: (id: string, title: string) => void;
  deleteSession: (id: string) => void;
  setSessionPinned: (id: string, pinned: boolean) => void;
  /** pin a provider/model to one chat (different chats, different agents) */
  setSessionModel: (sessionId: string, modelId: string) => void;
  forkSession: (id: string) => string;
  currentSession: () => Session | undefined;
  /** follow upgrade aliases (placeholder id → server id) */
  resolveSession: (id: string) => Session | undefined;
  addMessage: (msg: Message, sessionId?: string) => void;
  deleteMessage: (id: string, sessionId?: string) => void;
  updateMessage: (id: string, patch: Partial<Message>, sessionId?: string) => void;
  appendToMessage: (id: string, text: string, sessionId?: string) => void;
  /** Buffered sibling of appendToMessage: coalesces live-stream deltas into
   *  one store write per animation frame. Flush with flushMessageBuffer. */
  appendToMessageBuffered: (id: string, text: string, sessionId?: string) => void;
  /** Apply any buffered stream deltas synchronously (call before reading the
   *  message, finalizing a stream, or handling a structural frame). */
  flushMessageBuffer: (sessionId?: string) => void;
  addToolCall: (msgId: string, call: ToolCall, sessionId?: string) => void;
  updateToolCall: (msgId: string, callId: string, patch: Partial<ToolCall>, sessionId?: string) => void;
  addBlock: (msgId: string, block: MessageBlock, sessionId?: string) => void;
  updateBlock: (msgId: string, index: number, patch: Record<string, unknown>, sessionId?: string) => void;
  addEvent: (ev: TrajectoryEvent, sessionId?: string) => void;
  setContextTokens: (tokens: number) => void;
  compactSession: (sessionId?: string) => void;

  /* goals */
  addGoal: (goal: Goal) => void;
  updateGoal: (id: string, patch: Partial<Goal>) => void;
  updateGoalCriteria: (goalId: string, itemId: string, done: boolean) => void;

  /* projects (Cowork / Code) */
  /** replace the whole project set (server hydration) */
  loadProjects: (projects: Project[]) => void;
  /** create a project in the current work mode; folders are view-grouped */
  createProject: (name: string, opts?: { workspacePath?: string; description?: string; accent?: string }) => void;
  /** delete a project; its chats are unfiled (projectId → null), never deleted */
  deleteProject: (id: string) => void;
  /** file a chat under a project, or unfile it when projectId is null */
  assignSessionToProject: (sessionId: string, projectId: string | null) => void;
  /** toggle a folder open/closed (local view state only) */
  toggleProjectExpanded: (id: string) => void;
  /** start a fresh chat already filed under a project, and open it */
  newSessionInProject: (projectId: string) => string;

  /* dockable workspace */
  /** store the serialized dockview layout for a work mode */
  setDockLayout: (mode: WorkMode, layout: unknown) => void;
  /** drop a mode's saved layout so it rebuilds from the default */
  resetDockLayout: (mode: WorkMode) => void;

  /* approvals */
  approvalOf: (sessionId?: string) => Approval | null;
  setApproval: (approval: Approval | null, sessionId?: string) => void;
  resolveApproval: (decision: ApprovalDecision, reason?: string, sessionId?: string) => void;
  /** live run state of one chat (defaults to the current session) */
  sessionRunnerOf: (sessionId?: string) => RunnerState;
  setSessionRunner: (sessionId: string, patch: Partial<RunnerState>) => void;
  clearSessionRunner: (sessionId: string) => void;

  /* canvas */
  setCanvas: (patch: Partial<CanvasState>) => void;
  setViewport: (zoom: number, panX: number, panY: number) => void;
  zoomAt: (factor: number, screenX: number, screenY: number, viewW: number, viewH: number) => void;
  panBy: (dx: number, dy: number) => void;
  selectNode: (id: string, additive?: boolean) => void;
  clearSelection: () => void;
  selectEdge: (id: string | null) => void;
  /** bulk edge selection — sets the whole set (outline marquee / shift-click);
   *  the first member becomes the single primary `selectedEdgeId` */
  setSelectedEdgeIds: (ids: string[]) => void;
  moveNode: (id: string, x: number, y: number, commit?: boolean) => void;
  setNodeNote: (id: string, note: string | undefined) => void;
  /** set / remove a connection label (undoable, mirrors setNodeNote) */
  setEdgeNote: (id: string, note: string | undefined) => void;
  addNodes: (nodes: CanvasNode[]) => void;
  addEdges: (edges: CanvasEdge[]) => void;
  /** change an edge's kind; undoable when edited deliberately (inspector),
   *  silent for the post-create kind popover (creation itself is undoable) */
  updateEdgeKind: (id: string, kind: EdgeKind, opts?: { undoable?: boolean }) => void;
  /** re-point an edge's from/to endpoint (reconnect drag) — snapshot for
   *  undo is pushed by the caller (gesture commits once) */
  updateEdgeEndpoints: (id: string, from: string, to: string) => void;
  pushUndoSnapshot: () => void;
  undoCanvas: () => void;
  redoCanvas: () => void;

  /* files & code */
  setFileContent: (path: string, content: string) => void;
  setFileModified: (path: string, modified: boolean) => void;
  openCodeTab: (path: string) => void;
  closeCodeTab: (path: string) => void;
  setActiveCodeTab: (path: string) => void;
  markSave: (path: string, status: SaveStatus) => void;
  /**
   * Writes every file with a queued edit, and resolves when they have all landed.
   *
   * Installed by `sync.ts`; a no-op in demo mode, where nothing is written anywhere. The editor's
   * writes are debounced, so this is what stands between a keystroke and a lost edit whenever the
   * renderer is about to stop being able to send it.
   */
  flushPendingWrites: () => Promise<void>;

  /* context */
  setContextFiles: (files: ContextFile[]) => void;
  addContextFile: (file: ContextFile) => void;
  removeContextFile: (path: string) => void;
  pinContextFile: (path: string) => void;

  /* checkpoints */
  addCheckpoint: (cp: Checkpoint) => void;
  restoreCheckpoint: (id: string) => void;

  /* providers */
  setProviderState: (id: string, patch: Partial<Provider>) => void;
}

const uid = (() => {
  let counter = 0;
  return (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
})();

export const newId = uid;

const initialCanvas: CanvasState = {
  nodes: INITIAL_NODES,
  edges: INITIAL_EDGES,
  selectedIds: [],
  primaryId: null,
  selectedEdgeId: null,
  selectedEdgeIds: [],
  zoom: 0.85,
  panX: 0,
  panY: 0,
  showGrid: true,
  tool: "select",
  hiddenEdgeKinds: [],
};

const defaultUi: UiPrefs = {
  theme: "dark",
  locale: "ru",
  sidebarCollapsed: false,
  sidebarWidth: 248,
  appZoom: 1,
  contextPanelOpen: true,
  workMode: "chat",
  modeChosen: false,
  workMethod: "ask",
  agentMode: "off",
  activeSessionByMode: {},
  selectedModelId: DEFAULT_MODEL_ID,
  showGrid: true,
  enterSend: true,
  renderMarkdown: true,
  autoscroll: true,
  confirmDelete: true,
  autoTitles: true,
  maxSteps: 40,
  ghostText: false,
  skillsEnabled: Object.fromEntries(SKILLS.map((s) => [s.id, s.enabled])),
};

function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    return b.updatedAt - a.updatedAt;
  });
}

/* Chats are partitioned by work mode. A session with no explicit mode is a
   legacy/pre-feature conversation and reads as "chat" so nothing is orphaned. */
export function sessionModeOf(s: { mode?: WorkMode }): WorkMode {
  return s.mode ?? "chat";
}

/* ---------- auto-title (ChatGPT-style) ----------
   Derive a short chat title from the first user message: strip a leading
   imperative ("напиши …", "write …"), keep the first clause, cap on a word
   boundary, capitalise. Instant and local — the server may later emit a nicer
   title over the wire, which refines this via applyAutoTitle. Bilingual-ish
   (ru / en / de) because the UI ships all three. */
const TITLE_LEAD_WORDS = [
  // politeness / fillers first so "напиши пожалуйста …" strips both passes
  "пожалуйста", "please", "bitte", "me", "mir", "mich",
  // ru imperatives
  "напиши", "напишите", "создай", "создайте", "сделай", "сделайте",
  "сгенерируй", "сгенерируйте", "подготовь", "подготовьте", "построй",
  "постройте", "реализуй", "реализуйте", "добавь", "добавьте", "помоги",
  "помогите", "объясни", "объясните", "расскажи", "расскажите", "покажи",
  "покажите", "давай", "мне нужно", "мне нужен", "мне надо", "хочу", "нужно",
  // en imperatives
  "write", "create", "make", "build", "generate", "implement", "add", "help",
  "explain", "show", "give me", "give", "could you", "can you", "i want",
  "i need", "let's", "lets",
  // de imperatives
  "schreibe", "schreib", "erstelle", "erstell", "mache", "mach", "baue",
  "generiere", "implementiere", "hilf", "erkläre", "zeige", "zeig",
].sort((a, b) => b.length - a.length);

export function deriveTitle(raw: string): string {
  let text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "New chat";
  /* first clause — cut at the first sentence break if it isn't right at the start */
  const brk = text.search(/[.!?\n]/);
  if (brk >= 12) text = text.slice(0, brk).trim();
  /* strip up to two leading lead-words (one imperative + one filler) */
  for (let pass = 0; pass < 2; pass++) {
    const lower = text.toLowerCase();
    const hit = TITLE_LEAD_WORDS.find((w) => lower.startsWith(`${w} `));
    if (!hit) break;
    text = text.slice(hit.length).trimStart();
  }
  /* cap on a word boundary */
  const CAP = 48;
  if (text.length > CAP) {
    const cut = text.slice(0, CAP);
    const sp = cut.lastIndexOf(" ");
    text = (sp > 20 ? cut.slice(0, sp) : cut).trim();
  }
  /* drop trailing dashes / separators / list colons */
  text = text.replace(/[\s—–-]+$/, "").replace(/[,:;]+$/, "").trim();
  if (!text) return "New chat";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/* The chat to open for a mode: the remembered one if it still exists and still
   belongs to the mode, else the most-recent chat in that mode, else undefined
   (caller mints a fresh placeholder). */
function pickSessionForMode(
  sessions: Session[],
  mode: WorkMode,
  remembered?: string,
): string | undefined {
  if (remembered) {
    const r = sessions.find((s) => s.id === remembered);
    if (r && sessionModeOf(r) === mode) return remembered;
  }
  const inMode = sessions.filter((s) => sessionModeOf(s) === mode);
  return inMode.length ? sortSessions(inMode)[0].id : undefined;
}

/* A fresh, empty local chat stamped with its mode. Stays local (offline id)
   until the first message upgrades it to a server conversation. */
function makePlaceholder(mode: WorkMode, modelId: string): Session {
  return {
    id: uid("s"),
    title: "New chat",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    preview: "",
    messages: [],
    events: [],
    goalIds: [],
    modelId,
    mode,
  };
}

/* ------------------------------------------------------------------ *
 * Streaming coalescer
 *
 * Live NDJSON deltas can arrive faster than the browser paints. The read
 * loop (`backend.streamNdjson`) resolves each `reader.read()` on a microtask
 * and calls `onFrame` synchronously, so appending to the store on every delta
 * never yields a frame to the compositor — text accumulates in state but the
 * screen only repaints in one burst (e.g. when a keypress like Space forces a
 * paint). We coalesce appends into a single store write per animation frame:
 * smooth streaming, far fewer renders, far less persist churn. No tokens are
 * dropped — every stream-terminal path flushes synchronously first.
 * ------------------------------------------------------------------ */
/* Buffered stream deltas tagged with their chat session, so two runs in
   two chats never pour text into each other's transcript. */
const pendingAppends = new Map<string, { text: string; sessionId: string }>();
let flushHandle: number | null = null;

function applyPendingAppends(onlySessionId?: string): void {
  if (pendingAppends.size === 0) return;
  // Swap the buffer out before applying, so a re-entrant append queued by a
  // store subscriber re-buffers for the next frame instead of being dropped.
  const batch = new Map(pendingAppends);
  pendingAppends.clear();
  useAqvenor.setState((state) => {
    const { sessions } = state;
    // Entries for other sessions go back for their own frame.
    const rest = new Map<string, { text: string; sessionId: string }>();
    const mine = new Map<string, string>();
    for (const [id, entry] of batch) {
      if (onlySessionId !== undefined && entry.sessionId !== onlySessionId) {
        rest.set(id, entry);
      } else {
        mine.set(id, (mine.get(id) ?? "") + entry.text);
      }
    }
    if (rest.size > 0) {
      for (const [id, entry] of rest) pendingAppends.set(id, entry);
    }
    if (mine.size === 0) return {};
    return {
      sessions: sessions.map((s) => {
        const hasMine = s.messages.some((m) => mine.has(m.id));
        if (!hasMine) return s;
        return {
          ...s,
          messages: s.messages.map((m) =>
            mine.has(m.id) ? { ...m, content: m.content + mine.get(m.id)! } : m,
          ),
        };
      }),
    } as Partial<AqvenorState>;
  });
}

function scheduleAppendFlush(): void {
  if (flushHandle !== null) return;
  if (typeof requestAnimationFrame === "undefined") {
    // Headless / SSR / tests: no compositor to wait for — apply immediately.
    applyPendingAppends();
    return;
  }
  flushHandle = requestAnimationFrame(() => {
    flushHandle = null;
    applyPendingAppends();
  });
}

export const useAqvenor = create<AqvenorState>()(
  persist(
    (set, get) => ({
      hydrated: false,

      surface: "chat",
      surfaceNonce: 0,
      history: ["chat"],
      historyIndex: 0,
      paletteOpen: false,
      checkpointJumpOpen: false,
      cheatsheetOpen: false,
      projectExportOpen: false,
      providerStudioOpen: false,
      providerStudioTab: "manage",
      canvasOverlayActive: false,
      drafts: {},
      focusedChatSessionId: null,
      backendReachable: null,
      recording: false,
      sidebarOpenMobile: false,
      ui: defaultUi,
      toasts: [],

      sessions: [
        ...SEED_SESSIONS,
        {
          id: "current",
          title: "New chat",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          preview: "",
          messages: [],
          events: [],
          goalIds: [],
          modelId: DEFAULT_MODEL_ID,
          mode: "chat",
        },
      ],
      currentSessionId: "current",
      projects: [],
      dockLayout: {},
      approvals: {},
      runningSessions: {},
      sessionAliases: {},
      unread: {},
      allowForRunTools: {},
      goals: [],
      checkpoints: [],
      contextFiles: [],
      files: DEMO_FILES.map((f) => ({ ...f })),
      canvas: initialCanvas,
      canvasUndo: [],
      canvasRedo: [],
      codeTabs: [],
      activeCodeTab: null,
      saveStatus: {},
      codeReviewCheckpointId: null,
      providers: PROVIDERS.map((p) => ({ ...p, models: p.models.map((mm) => ({ ...mm })) })),
      runner: { status: "idle" },
      indexing: false,
      workspaceRoot: null,

      /* ---------- ui ---------- */
      setSurface: (s, opts) => {
        const { history, historyIndex, surfaceNonce } = get();
        if (opts?.noHistory || history[historyIndex] === s) {
          set({ surface: s, surfaceNonce: surfaceNonce + 1 });
          return;
        }
        const trimmed = history.slice(0, historyIndex + 1);
        trimmed.push(s);
        set({ surface: s, surfaceNonce: surfaceNonce + 1, history: trimmed.slice(-32), historyIndex: Math.min(trimmed.length - 1, 31) });
      },
      goHistory: (delta) => {
        const { history, historyIndex } = get();
        const next = historyIndex + delta;
        if (next < 0 || next >= history.length) return;
        set({ historyIndex: next, surface: history[next] });
      },
      setPaletteOpen: (open) => set({ paletteOpen: open }),
      togglePalette: () => set({ paletteOpen: !get().paletteOpen }),
      setCheckpointJumpOpen: (open) => set({ checkpointJumpOpen: open }),
      setCheatsheetOpen: (open) => set({ cheatsheetOpen: open }),
      setProjectExportOpen: (open) => set({ projectExportOpen: open }),
      setProviderStudioOpen: (open, tab) =>
        set((s) => ({
          providerStudioOpen: open,
          providerStudioTab: tab ?? s.providerStudioTab,
        })),
      setCanvasOverlayActive: (active) => set({ canvasOverlayActive: active }),
      setCodeReviewCheckpoint: (id) => set({ codeReviewCheckpointId: id }),
      toggleSidebar: () => set({ ui: { ...get().ui, sidebarCollapsed: !get().ui.sidebarCollapsed } }),
      setSidebarWidth: (w) =>
        set({ ui: { ...get().ui, sidebarWidth: Math.max(200, Math.min(420, w)) } }),
      setSidebarOpenMobile: (open) => set({ sidebarOpenMobile: open }),
      toggleContextPanel: () =>
        set({ ui: { ...get().ui, contextPanelOpen: !get().ui.contextPanelOpen } }),
      setUi: (patch) => set({ ui: { ...get().ui, ...patch } }),
      setWorkMode: (mode) => {
        const { ui, surface, sessions, currentSessionId } = get();
        if (mode === ui.workMode) return;
        /* keep the current surface if it still belongs to the new mode,
           otherwise land on the mode's home surface (chat / chat / code). */
        const nextSurface = surfaceAllowedInMode(surface, mode)
          ? surface
          : modeDefaultSurface[mode];
        /* remember the chat we're leaving under its own mode, so coming back to
           that mode returns here rather than to a shared conversation. */
        const remembered: Partial<Record<WorkMode, string>> = { ...ui.activeSessionByMode };
        const leaving = sessions.find((s) => s.id === currentSessionId);
        if (leaving) remembered[sessionModeOf(leaving)] = leaving.id;
        /* the chat to open for the new mode: the remembered one, else the most
           recent in that mode, else a fresh placeholder minted just for it. */
        let nextSessions = sessions;
        let targetId = pickSessionForMode(sessions, mode, remembered[mode]);
        if (!targetId) {
          const placeholder = makePlaceholder(mode, ui.selectedModelId);
          nextSessions = sortSessions([placeholder, ...sessions]);
          targetId = placeholder.id;
        }
        remembered[mode] = targetId;
        set({
          sessions: nextSessions,
          currentSessionId: targetId,
          ui: {
            ...ui,
            workMode: mode,
            agentMode: engineModeFor(mode, ui.workMethod),
            activeSessionByMode: remembered,
          },
          surface: nextSurface,
        });
      },
      setWorkMethod: (method, sessionId) => {
        const st = get();
        const ui = st.ui;
        const patch: Partial<AqvenorState> = {
          ui: { ...ui, workMethod: method, agentMode: engineModeFor(ui.workMode, method) },
        };
        const sid = sessionId ?? st.currentSessionId;
        (patch as { sessions?: Session[] }).sessions = st.sessions.map((s) =>
          s.id === sid ? { ...s, method } : s,
        );
        set(patch);
      },
      isAllowedForRun: (tool, sessionId) => {
        const st = get();
        const sid = sessionId ?? st.currentSessionId;
        return (st.allowForRunTools[sid] ?? []).includes(tool);
      },
      draftOf: (sessionId) => {
        const id = sessionId ?? get().currentSessionId;
        return get().drafts[id] ?? emptyDraft();
      },
      setBackendReachable: (ok) => {
        if (get().backendReachable === ok) return;
        set({ backendReachable: ok });
      },
      /* Which chat a prompt action should address: the focused panel when it
         still exists, else the current chat. Resolves upgrade aliases. */
      focusedChat: () => {
        const st = get();
        const focused = st.focusedChatSessionId;
        if (focused) {
          const resolved = st.resolveSession(focused)?.id;
          if (resolved) return resolved;
        }
        return st.currentSessionId;
      },
      setFocusedChat: (id) => {
        if (get().focusedChatSessionId === id) return;
        set({ focusedChatSessionId: id });
      },
      setDraft: (draft, sessionId) => {
        const id = sessionId ?? get().currentSessionId;
        set((s) => ({ drafts: { ...s.drafts, [id]: { ...(s.drafts[id] ?? emptyDraft()), text: draft } } }));
      },
      addDraftAttachment: (attachment, sessionId) => {
        const id = sessionId ?? get().currentSessionId;
        set((s) => {
          const cur = s.drafts[id] ?? emptyDraft();
          if (cur.attachments.some((a) => a.id === attachment.id)) return {};
          return { drafts: { ...s.drafts, [id]: { ...cur, attachments: [...cur.attachments, attachment] } } };
        });
      },
      removeDraftAttachment: (id, sessionId) => {
        const sid = sessionId ?? get().currentSessionId;
        set((s) => {
          const cur = s.drafts[sid];
          if (!cur) return {};
          return {
            drafts: { ...s.drafts, [sid]: { ...cur, attachments: cur.attachments.filter((a) => a.id !== id) } },
          };
        });
      },
      clearDraftAttachments: (sessionId) => {
        const sid = sessionId ?? get().currentSessionId;
        set((s) => {
          const cur = s.drafts[sid];
          if (!cur || cur.attachments.length === 0) return {};
          return { drafts: { ...s.drafts, [sid]: { ...cur, attachments: [] } } };
        });
      },
      setRecording: (recording) => set({ recording }),
      /* Legacy global writer (demo theater, global guards): mirrors the patch
         into the current chat's slot; the global stays the OR-view of all
         chats so session-scoped readers and global indicators agree. */
      setRunner: (patch) =>
        set((s) => {
          const sid = s.currentSessionId;
          const runningSessions = {
            ...s.runningSessions,
            [sid]: { ...(s.runningSessions[sid] ?? { status: "idle" as const }), ...patch },
          };
          return { runningSessions, runner: summarizeRuns(runningSessions) };
        }),
      sessionRunnerOf: (sessionId) => {
        const id = sessionId ?? get().currentSessionId;
        return get().runningSessions[id] ?? { status: "idle" };
      },
      /* One chat's run state. The global `runner` mirrors the most active
         session so every global indicator (title/status bars, Esc handling,
         import guards) keeps working without knowing about sessions. */
      setSessionRunner: (sessionId, patch) => {
        set((s) => {
          const runningSessions = {
            ...s.runningSessions,
            [sessionId]: { ...(s.runningSessions[sessionId] ?? { status: "idle" as const }), ...patch },
          };
          return { runningSessions, runner: summarizeRuns(runningSessions) };
        });
      },
      clearSessionRunner: (sessionId) => {
        set((s) => {
          if (!(sessionId in s.runningSessions)) return {};
          const runningSessions = { ...s.runningSessions };
          delete runningSessions[sessionId];
          return { runningSessions, runner: summarizeRuns(runningSessions) };
        });
      },
      bumpUnread: (sessionId) => {
        set((s) => ({ unread: { ...s.unread, [sessionId]: (s.unread[sessionId] ?? 0) + 1 } }));
      },
      markSessionRead: (sessionId) => {
        set((s) => {
          if (!(sessionId in s.unread)) return {};
          const unread = { ...s.unread };
          delete unread[sessionId];
          return { unread };
        });
      },
      setIndexing: (indexing) => set({ indexing }),
      setWorkspaceRoot: (root) => set({ workspaceRoot: root }),
      pushToast: (title, description, variant) =>
        set({ toasts: [...get().toasts, { id: Date.now() + Math.random(), title, description, variant }] }),
      dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

      /* ---------- sessions ---------- */
      newSession: () => {
        const id = uid("s");
        const { ui } = get();
        const mode = ui.workMode;
        const session: Session = {
          id,
          title: "New chat",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          preview: "",
          messages: [],
          events: [],
          goalIds: [],
          modelId: ui.selectedModelId,
          mode,
        };
        set({
          sessions: sortSessions([session, ...get().sessions]),
          currentSessionId: id,
          surface: "chat",
          ui: { ...ui, activeSessionByMode: { ...ui.activeSessionByMode, [mode]: id } },
        });
        return id;
      },
      importSession: (session, goals) => {
        const { sessions, goals: existingGoals, ui } = get();
        let id = session.id;
        if (sessions.some((s) => s.id === id)) id = uid("s");
        const remapped = goals.map((g) => {
          let gid = g.id;
          if (existingGoals.some((x) => x.id === gid)) gid = uid("g");
          return { ...g, id: gid, sessionId: id };
        });
        /* an imported chat keeps its own tagged mode; an untagged one joins the
           mode we're in now. Selecting it aligns workMode so the invariant holds. */
        const mode = session.mode ?? ui.workMode;
        const imported: Session = {
          ...session,
          id,
          pinned: false,
          goalIds: remapped.map((g) => g.id),
          mode,
        };
        set({
          sessions: sortSessions([imported, ...sessions]),
          goals: [...existingGoals, ...remapped],
          currentSessionId: id,
          surface: "chat",
          ui: {
            ...ui,
            workMode: mode,
            agentMode: engineModeFor(mode, ui.workMethod),
            activeSessionByMode: { ...ui.activeSessionByMode, [mode]: id },
          },
        });
        return id;
      },
      selectSession: (id) => {
        const { sessions, ui } = get();
        const target = sessions.find((s) => s.id === id);
        get().markSessionRead(id);
        if (!target) {
          set({ currentSessionId: id, surface: "chat" });
          return;
        }
        /* selecting a chat aligns the work mode to it (so the mode-filtered list
           and the open conversation never disagree) and remembers it for that mode. */
        const mode = sessionModeOf(target);
        const activeSessionByMode = { ...ui.activeSessionByMode, [mode]: id };
        set({
          currentSessionId: id,
          surface: "chat",
          ui:
            mode === ui.workMode
              ? { ...ui, activeSessionByMode }
              : { ...ui, workMode: mode, agentMode: engineModeFor(mode, ui.workMethod), activeSessionByMode },
        });
      },
      renameSession: (id, title) => {
        set({ sessions: get().sessions.map((s) => (s.id === id ? { ...s, title, titleUserDefined: true } : s)) });
      },
      applyAutoTitle: (id, title) => {
        const clean = title.trim();
        if (!clean) return;
        set({
          sessions: get().sessions.map((s) =>
            s.id === id && !s.titleUserDefined ? { ...s, title: clean } : s,
          ),
        });
      },
      deleteSession: (id) => {
        const { sessions: all, currentSessionId, ui } = get();
        const removed = all.find((s) => s.id === id);
        const sessions = all.filter((s) => s.id !== id);
        const removedMode = removed ? sessionModeOf(removed) : ui.workMode;
        /* drop the deleted id out of every mode's memory */
        const remembered: Partial<Record<WorkMode, string>> = { ...ui.activeSessionByMode };
        for (const k of Object.keys(remembered) as WorkMode[]) {
          if (remembered[k] === id) delete remembered[k];
        }
        /* stop its live run first (the gate still exists, so the denial
           routes cleanly), then release stragglers and drop the slots */
        for (const hook of [...sessionDeleteHooks]) {
          try {
            hook(id);
          } catch {
            /* a failing hook must not block the deletion itself */
          }
        }
        /* release that chat's open approval question, if any — its gate is
           gone with the row, and the waiter must not hang another chat */
        failPendingApprovals("The chat was deleted.", id);
        let nextSessions = sessions;
        let nextCurrent = currentSessionId;
        if (currentSessionId === id) {
          /* stay inside the mode of the chat we just closed */
          let targetId = pickSessionForMode(sessions, removedMode, remembered[removedMode]);
          if (!targetId) {
            const placeholder = makePlaceholder(removedMode, ui.selectedModelId);
            nextSessions = sortSessions([placeholder, ...sessions]);
            targetId = placeholder.id;
          }
          nextCurrent = targetId;
          remembered[removedMode] = targetId;
        }
        /* drop the deleted chat's transient slots (draft, gate, run flag,
           aliases pointing at it) so nothing dangles after the row is gone */
        const st = get();
        const drafts = { ...st.drafts };
        delete drafts[id];
        const unread = { ...st.unread };
        delete unread[id];
        const approvals = { ...st.approvals };
        delete approvals[id];
        const runningSessions = { ...st.runningSessions };
        delete runningSessions[id];
        const sessionAliases: Record<string, string> = {};
        for (const [from, to] of Object.entries(st.sessionAliases)) {
          if (from !== id && to !== id) sessionAliases[from] = to;
        }
        set({
          sessions: nextSessions,
          currentSessionId: nextCurrent,
          ui: { ...ui, activeSessionByMode: remembered },
          drafts,
          approvals,
          runningSessions,
          runner: summarizeRuns(runningSessions),
          sessionAliases,
          unread,
        });
      },
      setSessionPinned: (id, pinned) => {
        set({ sessions: sortSessions(get().sessions.map((s) => (s.id === id ? { ...s, pinned } : s))) });
      },
      setSessionModel: (sessionId, modelId) => {
        const st = get();
        set({
          sessions: st.sessions.map((s) => (s.id === sessionId ? { ...s, modelId } : s)),
          // The global stays the default for chats created from here on.
          ui: { ...st.ui, selectedModelId: modelId },
        });
      },
      forkSession: (id) => {
        const source = get().sessions.find((s) => s.id === id);
        if (!source) return "";
        const locale = get().ui.locale;
        const newSessionId = uid("s");
        const fork: Session = {
          ...source,
          id: newSessionId,
          title: `${source.title} · ${translate(locale, "session.fork.badge")}`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          pinned: false,
          forkedFrom: source.id,
          preview: source.preview,
          messages: source.messages.map((m) => ({ ...m, id: uid("m"), toolCalls: m.toolCalls.map((t) => ({ ...t })) })),
          events: source.events.map((e) => ({ ...e, id: uid("ev") })),
        };
        /* a fork inherits its source's mode (copied via the spread) and becomes
           the remembered chat for that mode. */
        const forkMode = sessionModeOf(fork);
        const ui = get().ui;
        set({
          sessions: sortSessions([fork, ...get().sessions]),
          currentSessionId: newSessionId,
          ui: { ...ui, activeSessionByMode: { ...ui.activeSessionByMode, [forkMode]: newSessionId } },
        });
        get().addEvent({ id: uid("ev"), ts: Date.now(), kind: "fork", title: translate(locale, "sidebar.forked", source.title) });
        get().pushToast(translate(locale, "session.fork.title"), translate(locale, "session.fork.desc"));
        return newSessionId;
      },
      currentSession: () => get().sessions.find((s) => s.id === get().currentSessionId),

      resolveSession: (id) => {
        const st = get();
        const direct = st.sessions.find((s) => s.id === id);
        if (direct) return direct;
        const alias = st.sessionAliases[id];
        return alias ? st.sessions.find((s) => s.id === alias) : undefined;
      },

      addMessage: (msg, sessionId) => {
        const { sessions, ui } = get();
        const target = sessionId ?? get().currentSessionId;
        set({
          sessions: sessions.map((s) =>
            s.id === target
              ? {
                  ...s,
                  messages: [...s.messages, msg].slice(-MAX_MESSAGES_PER_SESSION),
                  updatedAt: Date.now(),
                  preview: msg.content.slice(0, 90),
                  /* ChatGPT-style provisional title from the first user turn:
                     only when auto-titling is on, the chat is still an untitled
                     placeholder and the person hasn't renamed it by hand.
                     Refined later by the server's own title echo via
                     applyAutoTitle (which the server gates itself). */
                  title:
                    ui.autoTitles &&
                    msg.role === "user" &&
                    !s.titleUserDefined &&
                    (s.title === "New chat" || s.title === "")
                      ? deriveTitle(msg.content)
                      : s.title,
                }
              : s,
          ),
        });
      },
      deleteMessage: (id, sessionId) => {
        const { sessions } = get();
        const target = sessionId ?? get().currentSessionId;
        set({
          sessions: sessions.map((s) =>
            s.id === target
              ? { ...s, messages: s.messages.filter((m) => m.id !== id) }
              : s,
          ),
        });
      },
      updateMessage: (id, patch, sessionId) => {
        const { sessions } = get();
        const target = sessionId ?? get().currentSessionId;
        set({
          sessions: sessions.map((s) =>
            s.id === target
              ? { ...s, messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) }
              : s,
          ),
        });
      },
      appendToMessage: (id, text, sessionId) => {
        const { sessions } = get();
        const target = sessionId ?? get().currentSessionId;
        set({
          sessions: sessions.map((s) =>
            s.id === target
              ? {
                  ...s,
                  messages: s.messages.map((m) =>
                    m.id === id ? { ...m, content: m.content + text } : m,
                  ),
                }
              : s,
          ),
        });
      },
      appendToMessageBuffered: (id, text, sessionId) => {
        if (!text) return;
        const sid = sessionId ?? get().currentSessionId;
        const prev = pendingAppends.get(id);
        pendingAppends.set(id, { text: (prev?.text ?? "") + text, sessionId: sid });
        scheduleAppendFlush();
      },
      flushMessageBuffer: (sessionId) => {
        if (flushHandle !== null) {
          if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(flushHandle);
          flushHandle = null;
        }
        applyPendingAppends(sessionId);
      },
      addToolCall: (msgId, call, sessionId) => {
        const { sessions } = get();
        const target = sessionId ?? get().currentSessionId;
        set({
          sessions: sessions.map((s) =>
            s.id === target
              ? {
                  ...s,
                  messages: s.messages.map((m) =>
                    m.id === msgId ? { ...m, toolCalls: [...m.toolCalls, call] } : m,
                  ),
                }
              : s,
          ),
        });
      },
      updateToolCall: (msgId, callId, patch, sessionId) => {
        const { sessions } = get();
        const target = sessionId ?? get().currentSessionId;
        set({
          sessions: sessions.map((s) =>
            s.id === target
              ? {
                  ...s,
                  messages: s.messages.map((m) =>
                    m.id === msgId
                      ? {
                          ...m,
                          toolCalls: m.toolCalls.map((t) => (t.id === callId ? { ...t, ...patch } : t)),
                        }
                      : m,
                  ),
                }
              : s,
          ),
        });
      },
      addBlock: (msgId, block, sessionId) => {
        const { sessions } = get();
        const target = sessionId ?? get().currentSessionId;
        set({
          sessions: sessions.map((s) =>
            s.id === target
              ? {
                  ...s,
                  messages: s.messages.map((m) =>
                    m.id === msgId ? { ...m, blocks: [...(m.blocks ?? []), block] } : m,
                  ),
                }
              : s,
          ),
        });
      },
      updateBlock: (msgId, index, patch, sessionId) => {
        const { sessions } = get();
        const target = sessionId ?? get().currentSessionId;
        set({
          sessions: sessions.map((s) =>
            s.id === target
              ? {
                  ...s,
                  messages: s.messages.map((m) => {
                    if (m.id !== msgId || !m.blocks) return m;
                    const blocks = [...m.blocks];
                    blocks[index] = { ...blocks[index], ...patch } as MessageBlock;
                    return { ...m, blocks };
                  }),
                }
              : s,
          ),
        });
      },
      addEvent: (ev, sessionId) => {
        const { sessions } = get();
        const target = sessionId ?? get().currentSessionId;
        set({
          sessions: sessions.map((s) =>
            s.id === target
              ? {
                  ...s,
                  // Rolling window. Every tool call, approval and streamed delta lands here, and
                  // nothing ever removed any of it.
                  events: [...s.events, ev].slice(-MAX_EVENTS),
                }
              : s,
          ),
        });
      },
      setContextTokens: (tokens) => {
        const { sessions, currentSessionId } = get();
        set({
          sessions: sessions.map((s) => (s.id === currentSessionId ? { ...s, contextTokens: tokens } : s)),
        });
      },
      compactSession: (sessionId) => {
        const sid = sessionId ?? get().currentSessionId;
        const session = get().sessions.find((s) => s.id === sid);
        if (!session) return;
        const locale = get().ui.locale;
        const foldable = session.messages.filter((m) => !m.folded && m.role === "user").length;
        if (foldable === 0) {
          get().pushToast(translate(locale, "context.compact.none"), translate(locale, "context.compact.noneDesc"));
          return;
        }
        const cutoff = session.messages.length - 6;
        const freed = session.contextTokens
          ? Math.round(session.contextTokens * 0.55)
          : 38000;
        const { sessions } = get();
        set({
          sessions: sessions.map((s) =>
            s.id === sid
              ? {
                  ...s,
                  foldedCount: (s.foldedCount ?? 0) + Math.max(0, cutoff),
                  contextTokens: Math.max(4000, (s.contextTokens ?? 94000) - freed),
                  messages:
                    cutoff > 0
                      ? s.messages.map((m, i) => (i < cutoff ? { ...m, folded: true } : m))
                      : s.messages,
                }
              : s,
          ),
        });
        get().addEvent({
          id: uid("ev"),
          ts: Date.now(),
          kind: "compact",
          title: tp(locale, "context.compacted", Math.max(0, cutoff)).replace("{1}", fmtInt(freed, locale)),
          status: "done",
        }, sid);
        get().pushToast(translate(locale, "context.compact"), tp(locale, "context.compacted", Math.max(0, cutoff)).replace("{1}", fmtInt(freed, locale)));
      },

      /* ---------- goals ---------- */
      addGoal: (goal) => {
        const { sessions, currentSessionId, goals } = get();
        set({
          goals: [...goals, goal],
          sessions: sessions.map((s) =>
            s.id === currentSessionId ? { ...s, goalIds: [...s.goalIds, goal.id] } : s,
          ),
        });
      },
      updateGoal: (id, patch) => set({ goals: get().goals.map((g) => (g.id === id ? { ...g, ...patch } : g)) }),
      updateGoalCriteria: (goalId, itemId, done) =>
        set({
          goals: get().goals.map((g) =>
            g.id === goalId
              ? { ...g, criteria: g.criteria.map((c) => (c.id === itemId ? { ...c, done } : c)) }
              : g,
          ),
        }),

      /* ---------- projects (Cowork / Code) ---------- */
      loadProjects: (projects) => set({ projects }),
      createProject: (name, opts) => {
        const { projects, ui } = get();
        const mode: WorkMode = ui.workMode === "chat" ? "cowork" : ui.workMode;
        const now = Date.now();
        const project: Project = {
          id: uid("p"),
          name: name.trim() || "Project",
          description: opts?.description,
          workspacePath: opts?.workspacePath,
          accent: opts?.accent,
          expanded: true,
          sortOrder: projects.length,
          conversationCount: 0,
          lastActivityAt: now,
          createdAt: now,
          updatedAt: now,
          mode,
        };
        set({ projects: [...projects, project] });
      },
      deleteProject: (id) => {
        set({
          projects: get().projects.filter((p) => p.id !== id),
          /* unfile — never delete — the chats that lived here */
          sessions: get().sessions.map((s) => (s.projectId === id ? { ...s, projectId: null } : s)),
        });
      },
      assignSessionToProject: (sessionId, projectId) => {
        set({
          sessions: get().sessions.map((s) => (s.id === sessionId ? { ...s, projectId } : s)),
          projects: projectId
            ? get().projects.map((p) =>
                p.id === projectId ? { ...p, expanded: true, lastActivityAt: Date.now() } : p,
              )
            : get().projects,
        });
      },
      toggleProjectExpanded: (id) =>
        set({ projects: get().projects.map((p) => (p.id === id ? { ...p, expanded: !p.expanded } : p)) }),
      newSessionInProject: (projectId) => {
        const id = uid("s");
        const { ui, projects } = get();
        const project = projects.find((p) => p.id === projectId);
        const mode: WorkMode = project?.mode ?? (ui.workMode === "chat" ? "cowork" : ui.workMode);
        const session: Session = { ...makePlaceholder(mode, ui.selectedModelId), id, projectId };
        set({
          sessions: sortSessions([session, ...get().sessions]),
          currentSessionId: id,
          surface: "chat",
          ui: {
            ...ui,
            workMode: mode,
            agentMode: engineModeFor(mode, ui.workMethod),
            activeSessionByMode: { ...ui.activeSessionByMode, [mode]: id },
          },
          projects: projects.map((p) =>
            p.id === projectId ? { ...p, expanded: true, lastActivityAt: Date.now() } : p,
          ),
        });
        return id;
      },

      /* ---------- dockable workspace ---------- */
      setDockLayout: (mode, layout) =>
        set({ dockLayout: { ...get().dockLayout, [mode]: layout } }),
      resetDockLayout: (mode) => {
        const next = { ...get().dockLayout };
        delete next[mode];
        set({ dockLayout: next });
      },

      /* ---------- approvals (one open question per chat) ---------- */
      approvalOf: (sessionId) => {
        const id = sessionId ?? get().currentSessionId;
        return get().approvals[id] ?? null;
      },
      setApproval: (approval, sessionId) => {
        const sid = sessionId ?? get().currentSessionId;
        set((s) => {
          const next = { ...s.approvals };
          if (approval) next[sid] = approval;
          else delete next[sid];
          return { approvals: next };
        });
        /* autonomy selector: auto-resolve gates the current work-method allows.
           Deferred a tick so the caller's waitForApproval() is registered first;
           for the live backend this still routes through resolveApproval →
           runs.answerApproval, so the server sees a real decision. */
        if (approval) {
          const st = get();
          const method = st.sessions.find((s) => s.id === sid)?.method ?? st.ui.workMethod;
          const decision = autoApprovalDecision(method, approval.risk);
          if (decision) {
            setTimeout(() => {
              if (get().approvals[sid]?.id === approval.id) get().resolveApproval(decision, undefined, sid);
            }, 0);
          }
        }
      },
      resolveApproval: (decision, reason, sessionId) => {
        const sid = sessionId ?? get().currentSessionId;
        const approval = get().approvals[sid];
        if (!approval) return;

        // Keyed off the approval's own id rather than off "whatever is in the slot". The two are
        // the same when only one question is ever open, and different the moment two are: the second
        // setApproval overwrote the first, so answering the second left the first waiter's promise
        // unresolved forever. Taking the id from the object that is actually on screen closes that.
        const waiter = approvalWaiters.get(approval.id);
        approvalWaiters.delete(approval.id);
        waiter?.resolve({ decision, reason });

        set((s) => {
          const next = { ...s.approvals };
          delete next[sid];
          if (decision === "allowed-for-run") {
            const scoped = [...(s.allowForRunTools[sid] ?? []), approval.tool];
            return {
              allowForRunTools: { ...s.allowForRunTools, [sid]: scoped },
              approvals: next,
            };
          }
          return { approvals: next };
        });
      },

      /* ---------- canvas ---------- */
      setCanvas: (patch) => {
        /* keep the bulk edge selection coherent with single-selection patches:
         *  selecting nodes or a single edge implicitly collapses the bulk set */
        const derived: Partial<CanvasState> = { ...patch };
        if (patch.selectedEdgeIds !== undefined) {
          /* explicit bulk set — keep it verbatim */
        } else if (patch.selectedEdgeId !== undefined) {
          derived.selectedEdgeIds = patch.selectedEdgeId ? [patch.selectedEdgeId] : [];
        } else if (patch.selectedIds !== undefined || patch.primaryId !== undefined) {
          derived.selectedEdgeIds = [];
        }
        set({ canvas: { ...get().canvas, ...derived } });
      },
      setViewport: (zoom, panX, panY) => set({ canvas: { ...get().canvas, zoom, panX, panY } }),
      zoomAt: (factor, screenX, screenY, viewW, viewH) => {
        const { zoom, panX, panY } = get().canvas;
        const next = Math.max(0.06, Math.min(3.5, zoom * factor));
        const wx = (screenX - viewW / 2 + panX) / zoom;
        const wy = (screenY - viewH / 2 + panY) / zoom;
        set({
          canvas: {
            ...get().canvas,
            zoom: next,
            panX: viewW / 2 - wx * next,
            panY: viewH / 2 - wy * next,
          },
        });
      },
      panBy: (dx, dy) => {
        const { panX, panY } = get().canvas;
        set({ canvas: { ...get().canvas, panX: panX + dx, panY: panY + dy } });
      },
      selectNode: (id, additive) => {
        const { selectedIds, primaryId } = get().canvas;
        if (additive) {
          const has = selectedIds.includes(id);
          set({
            canvas: {
              ...get().canvas,
              selectedIds: has ? selectedIds.filter((x) => x !== id) : [...selectedIds, id],
              primaryId: has ? (primaryId === id ? (selectedIds[0] ?? null) : primaryId) : id,
              selectedEdgeId: null,
              selectedEdgeIds: [],
            },
          });
        } else {
          set({
            canvas: {
              ...get().canvas,
              selectedIds: [id],
              primaryId: id,
              selectedEdgeId: null,
              selectedEdgeIds: [],
            },
          });
        }
      },
      clearSelection: () =>
        set({
          canvas: {
            ...get().canvas,
            selectedIds: [],
            primaryId: null,
            selectedEdgeId: null,
            selectedEdgeIds: [],
          },
        }),
      selectEdge: (id) =>
        set({
          canvas: {
            ...get().canvas,
            selectedEdgeId: id,
            selectedEdgeIds: id ? [id] : [],
          },
        }),
      setSelectedEdgeIds: (ids) =>
        set({
          canvas: {
            ...get().canvas,
            selectedIds: [],
            primaryId: null,
            selectedEdgeId: ids.length > 0 ? ids[0] : null,
            selectedEdgeIds: ids,
          },
        }),
      moveNode: (id, x, y, commit) => {
        set({
          canvas: {
            ...get().canvas,
            nodes: get().canvas.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)),
          },
        });
        if (commit) get().pushUndoSnapshot();
      },
      addNodes: (nodes) => set({ canvas: { ...get().canvas, nodes: [...get().canvas.nodes, ...nodes] } }),
      setNodeNote: (id, note) => {
        const current = get().canvas.nodes.find((n) => n.id === id);
        if (!current) return;
        const next = note === undefined || note.trim() === "" ? undefined : note.trim();
        if ((current.note ?? undefined) === next) return;
        get().pushUndoSnapshot();
        set({
          canvas: {
            ...get().canvas,
            nodes: get().canvas.nodes.map((n) =>
              n.id === id ? { ...n, note: next } : n,
            ),
          },
        });
      },
      addEdges: (edges) => set({ canvas: { ...get().canvas, edges: [...get().canvas.edges, ...edges] } }),
      setEdgeNote: (id, note) => {
        const current = get().canvas.edges.find((e) => e.id === id);
        if (!current) return;
        const next = note === undefined || note.trim() === "" ? undefined : note.trim();
        if ((current.note ?? undefined) === next) return;
        get().pushUndoSnapshot();
        set({
          canvas: {
            ...get().canvas,
            edges: get().canvas.edges.map((e) =>
              e.id === id ? { ...e, note: next } : e,
            ),
          },
        });
      },
      updateEdgeKind: (id, kind, opts) => {
        if (opts?.undoable) get().pushUndoSnapshot();
        set({
          canvas: {
            ...get().canvas,
            edges: get().canvas.edges.map((e) => (e.id === id ? { ...e, kind } : e)),
          },
        });
      },
      updateEdgeEndpoints: (id, from, to) =>
        set({
          canvas: {
            ...get().canvas,
            edges: get().canvas.edges.map((e) => (e.id === id ? { ...e, from, to } : e)),
          },
        }),
      pushUndoSnapshot: () => {
        const snapshot = {
          nodes: get().canvas.nodes.map((n) => ({ ...n })),
          edges: get().canvas.edges.map((e) => ({ ...e })),
        };
        set({ canvasUndo: [...get().canvasUndo.slice(-24), snapshot], canvasRedo: [] });
      },
      undoCanvas: () => {
        const { canvasUndo, canvasRedo, canvas } = get();
        const snapshot = canvasUndo[canvasUndo.length - 1];
        if (!snapshot) return;
        set({
          canvasUndo: canvasUndo.slice(0, -1),
          canvasRedo: [
            ...canvasRedo,
            { nodes: canvas.nodes.map((n) => ({ ...n })), edges: canvas.edges.map((e) => ({ ...e })) },
          ],
          canvas: { ...canvas, nodes: snapshot.nodes, edges: snapshot.edges },
        });
      },
      redoCanvas: () => {
        const { canvasUndo, canvasRedo, canvas } = get();
        const snapshot = canvasRedo[canvasRedo.length - 1];
        if (!snapshot) return;
        set({
          canvasRedo: canvasRedo.slice(0, -1),
          canvasUndo: [
            ...canvasUndo,
            { nodes: canvas.nodes.map((n) => ({ ...n })), edges: canvas.edges.map((e) => ({ ...e })) },
          ],
          canvas: { ...canvas, nodes: snapshot.nodes, edges: snapshot.edges },
        });
      },

      /* ---------- files & code ---------- */
      setFileContent: (path, content) =>
        set({ files: get().files.map((f) => (f.path === path ? { ...f, content } : f)) }),
      setFileModified: (path, modified) =>
        set({ files: get().files.map((f) => (f.path === path ? { ...f, modified } : f)) }),
      openCodeTab: (path) => {
        const { codeTabs, activeCodeTab } = get();
        if (codeTabs.includes(path)) {
          set({ activeCodeTab: path });
          return;
        }
        set({ codeTabs: [...codeTabs, path], activeCodeTab: path });
      },
      closeCodeTab: (path) => {
        const { codeTabs, activeCodeTab } = get();
        const next = codeTabs.filter((p) => p !== path);
        set({
          codeTabs: next,
          activeCodeTab: activeCodeTab === path ? (next[next.length - 1] ?? null) : activeCodeTab,
        });
      },
      setActiveCodeTab: (path) => set({ activeCodeTab: path }),
      markSave: (path, status) => set({ saveStatus: { ...get().saveStatus, [path]: status } }),

      // Replaced in server mode by sync.ts, which owns the debounced write queue. Demo mode has
      // nowhere to write to, so this is the honest no-op rather than a promise that never settles.
      flushPendingWrites: async () => {},

      /* ---------- context ---------- */
      setContextFiles: (files) => set({ contextFiles: files }),
      addContextFile: (file) =>
        set({ contextFiles: [...get().contextFiles.filter((c) => c.path !== file.path), file] }),
      removeContextFile: (path) => set({ contextFiles: get().contextFiles.filter((c) => c.path !== path) }),
      pinContextFile: (path) =>
        set({
          contextFiles: get().contextFiles.map((c) =>
            c.path === path ? { ...c, reason: c.reason === "pinned" ? "relevant" : "pinned" } : c,
          ),
        }),

      /* ---------- checkpoints ---------- */
      addCheckpoint: (cp) => set({ checkpoints: [...get().checkpoints, cp] }),
      restoreCheckpoint: (id) => {
        const cp = get().checkpoints.find((c) => c.id === id);
        if (!cp) return;
        const locale = get().ui.locale;
        cp.filesSnapshot.forEach((snap) => {
          get().setFileContent(snap.path, snap.content);
          get().setFileModified(snap.path, false);
        });
        /* restore the canvas graph captured with the checkpoint (keep viewport) */
        if (cp.canvasSnapshot) {
          const { nodes, edges } = cp.canvasSnapshot;
          set((state) => ({
            canvas: {
              ...state.canvas,
              nodes: [...nodes],
              edges: [...edges],
              selectedIds: [],
              primaryId: null,
              selectedEdgeId: null,
            },
          }));
        }
        get().addEvent({
          id: uid("ev"),
          ts: Date.now(),
          kind: "checkpoint",
          title: translate(locale, "checkpoint.restored.title"),
          detail:
            tp(locale, "checkpoint.restored.count", cp.filesSnapshot.length) +
            (cp.canvasSnapshot
              ? ` · ${translate(locale, "trajectory.checkpointGraph", cp.canvasSnapshot.nodes.length)}`
              : ""),
          status: "done",
        });
        get().pushToast(
          translate(locale, "checkpoint.restored.title"),
          tp(locale, "checkpoint.restored.files", cp.filesSnapshot.length).replace("{1}", cp.label),
        );
      },

      /* ---------- providers ---------- */
      setProviderState: (id, patch) =>
        set({ providers: get().providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) }),
    }),
    {
      name: "aqvenor-proto",
      storage: createJSONStorage(() => localStorage),
      /**
       * What goes to localStorage, and — more importantly — what does not.
       *
       * The backend is the source of truth for conversations, files and the graph; `sync.ts` hydrates
       * them on boot. This cache exists so a reload is not a blank screen for a moment, not so it can
       * hold a second copy of every file body.
       *
       * It used to persist `files` whole, plus each checkpoint's `filesSnapshot` — which is every
       * file's text again — plus every message of every session. On a real project that is
       * megabytes, and localStorage caps out around 5–10 MB. The failure is the bad part: the quota
       * exception is thrown inside the persist middleware's own subscriber, so it is swallowed, and
       * from that point on *nothing* is written again. No error, no warning, and a reload loses the
       * session. So bodies stay out and paths come in.
       */
      partialize: (state) => ({
        sessions: state.sessions.map((session) => ({
          ...session,
          // Bounded so a long-lived install cannot grow without limit; the backend holds the rest.
          messages: session.messages.slice(-MAX_PERSISTED_MESSAGES),
        })),
        currentSessionId: state.currentSessionId,
        ui: state.ui,
        goals: state.goals,
        // Folders only — chats carry their own projectId. Cached so a reload is
        // not a blank sidebar before the backend rehydrates the real set.
        projects: state.projects,
        // per-mode dockview layouts, so the workspace docking survives a reload.
        dockLayout: state.dockLayout,
        // Metadata only. `filesSnapshot` is every file's text, once per checkpoint.
        checkpoints: state.checkpoints.map(({ filesSnapshot: _bodies, ...rest }) => rest),
        canvas: state.canvas,
        // Paths and sizes, not contents.
        files: state.files.map(({ content: _content, ...rest }) => rest),
        codeTabs: state.codeTabs,
        activeCodeTab: state.activeCodeTab,
        contextFiles: state.contextFiles,
      }),
      /**
       * Bumped when the persisted shape changes. An install carrying an older shape is not migrated
       * field by field — the backend rehydrates it on boot, so starting from defaults is both correct
       * and far cheaper than guessing at a shape that no longer exists.
       */
      version: PERSIST_VERSION,
      migrate: (persisted: unknown) => {
        const shape = persisted as { state?: { version?: number } } | undefined;
        const version = shape?.state?.version;

        if (version === undefined || version < PERSIST_VERSION) {
          console.info(
            `[aqvenor] local cache written by an older build (v${version ?? "none"}); rebuilding from defaults. The backend has the real state.`,
          );
          return undefined;
        }

        return persisted;
      },
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        /* NB: runs synchronously during store creation for sync storage —
           defer setState until the module-level const exists. */
        queueMicrotask(() => {
          /* migrate persisted prefs that predate the Chat/Cowork/Code +
             work-method controls: derive them from the stored agentMode. */
          const s0 = useAqvenor.getState();
          const ui = s0.ui;
          /* older persisted prefs predate these axes — treat them as maybe-absent */
          const persisted = ui as { workMode?: WorkMode; workMethod?: WorkMethod; modeChosen?: boolean };
          const migratedUi =
            persisted.workMode === undefined || persisted.workMethod === undefined
              ? {
                  ...ui,
                  workMode: (ui.agentMode === "off" ? "chat" : "cowork") as WorkMode,
                  workMethod: (ui.agentMode === "plan" || ui.agentMode === "plancanvas"
                    ? "plan"
                    : "ask") as WorkMethod,
                }
              : ui;
          /* per-mode chats: ensure the memory map exists, then reconcile the
             restored mode with the chat that is actually open so the mode-filtered
             list and the open conversation never disagree. The open chat wins —
             legacy chats are all untagged ("chat"), so an upgrading user keeps
             their last conversation visible and selected rather than being
             stranded on an empty mode. */
          const activeSessionByMode: Partial<Record<WorkMode, string>> = {
            ...(migratedUi.activeSessionByMode ?? {}),
          };
          let sessions = s0.sessions;
          let currentSessionId = s0.currentSessionId;
          const cur = sessions.find((x) => x.id === currentSessionId);
          let workMode = migratedUi.workMode;
          if (cur) {
            workMode = sessionModeOf(cur);
            activeSessionByMode[workMode] = cur.id;
          } else {
            let targetId = pickSessionForMode(sessions, workMode, activeSessionByMode[workMode]);
            if (!targetId) {
              const placeholder = makePlaceholder(workMode, migratedUi.selectedModelId);
              sessions = sortSessions([placeholder, ...sessions]);
              targetId = placeholder.id;
            }
            currentSessionId = targetId;
            activeSessionByMode[workMode] = targetId;
          }
          /* first-run onboarding: show the mode picker until a mode is chosen.
             absent flag (fresh or pre-onboarding installs) => show it once. */
          const startSurface = s0.surface;
          useAqvenor.setState({
            hydrated: true,
            sessions,
            currentSessionId,
            ui: {
              ...migratedUi,
              appZoom: migratedUi.appZoom ?? 1,
              workMode,
              modeChosen: persisted.modeChosen ?? false,
              agentMode: engineModeFor(workMode, migratedUi.workMethod),
              activeSessionByMode,
            },
            /* clamp a persisted surface that doesn't belong to the restored mode */
            surface: surfaceAllowedInMode(startSurface, workMode) ? startSurface : modeDefaultSurface[workMode],
            runner: { status: "idle" },
            approvals: {},
            runningSessions: {},
            unread: {},
            toasts: [],
            recording: false,
            paletteOpen: false,
            checkpointJumpOpen: false,
            cheatsheetOpen: false,
            projectExportOpen: false,
            providerStudioOpen: false,
            canvasOverlayActive: false,
          });
        });
      },
    },
  ),
);

/**
 * Watches the size of what persistence would write, and says so before the browser refuses.
 *
 * The quota error this guards against is thrown by `setItem` inside the persist middleware's own
 * subscriber, where nothing catches it: the write silently stops happening and the only symptom is
 * that a reload loses the session. Warning at a threshold well under the real cap turns a mystery
 * into a line in the console, and the throttle keeps a streaming run from logging it per frame.
 */
const PERSIST_WARN_BYTES = 2 * 1024 * 1024;
let persistWarned = false;
let lastPersistCheck = 0;

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    /* Best effort only: beforeunload cannot await, so this marks the state and relies on the
       document being kept alive long enough for the request to leave. Debouncing means there is
       normally nothing to flush. */
    void useAqvenor.getState().flushPendingWrites?.();
  });

  window.setInterval(() => {
    const now = Date.now();
    if (persistWarned || now - lastPersistCheck < 5_000) return;
    lastPersistCheck = now;

    try {
      const serialised = JSON.stringify(
        (useAqvenor.getState() as unknown as Record<string, unknown>),
      ).length;

      if (serialised > PERSIST_WARN_BYTES) {
        persistWarned = true;
        console.warn(
          `[aqvenor] local state is ${Math.round(serialised / 1024 / 1024)} MB. Browsers cap this near 5-10 MB, and exceeding the cap stops persistence silently. The backend still holds the real conversations; this cache is a fast first paint, not a backup.`,
        );
      }
    } catch {
      /* A value that will not serialise is its own problem, and logging it every five seconds
         would be noise. */
    }
  }, 5_000);
}
