"use client";

/* ============================================================
   Backend sync — makes the zustand store server-backed.
   - boot hydration: providers/models, settings, sessions,
     checkpoints, workspace files, canvas graph
   - server-backed session actions (id is a Guid) + transcript
     reload after runs (canonical ids, usage, titles)
   Local demo/seed sessions (non-Guid ids) keep working offline.
   ============================================================ */

import {
  api,
  checkBackend,
  checkpoints,
  conversations,
  exportApi,
  getBackendUrl,
  graph,
  projects,
  providers,
  runs,
  settings,
  workspace,
  type GraphChangeInput,
  type ServerConversationDetail,
  type ServerConversationSummary,
  type ServerGraphSnapshot,
  type ServerMessage,
  type ServerModel,
  type ServerProject,
} from "./backend";
import { isPlaceholderTitle, newId, sessionModeOf, useAqvenor } from "./store";
import { serverCreateTitle } from "./session-titles";
import { looksLikeImageGenModel } from "./data";
import { tp, translate } from "./i18n";
import type {
  CanvasEdge,
  CanvasNode,
  CanvasNodeStatus,
  Checkpoint,
  DemoFile,
  EdgeKind,
  Message,
  ModelInfo,
  NodeKind,
  Project,
  Provider,
  ProviderState,
  Session,
  ToolCall,
  TrajectoryEvent,
  WorkMode,
} from "./types";

const S = () => useAqvenor.getState();

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isServerId = (id: string) => GUID_RE.test(id);

/* The conversation PATCH route reads projectId as Guid?: a real guid files the
   chat, the empty guid unfiles it, and JSON null is ignored (no change). So
   unfiling must send the empty guid, not null. */
const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";

let serverMode = false;
export const isServerMode = () => serverMode;

/** Fired after a workspace is opened/reindexed so the canvas can fit the fresh
 *  graph into view. CanvasView listens for this; other surfaces ignore it. */
export const CANVAS_FIT_EVENT = "aqvenor:canvas-fit";
function requestCanvasFit(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CANVAS_FIT_EVENT));
}

let booted = false;

/* ---------------- mapping ---------------- */

const toMs = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Date.now() : t;
};

function splitModelId(composite: string): { providerId: string; modelId: string } {
  const i = composite.indexOf("/");
  if (i < 0) return { providerId: "openrouter", modelId: composite };
  return { providerId: composite.slice(0, i), modelId: composite.slice(i + 1) };
}

export function toCompositeModel(providerId: string, modelId: string) {
  return `${providerId}/${modelId}`;
}

export function splitCompositeModel(composite: string): { providerId: string; modelId: string } {
  const i = composite.indexOf("/");
  if (i < 0) return { providerId: "openrouter", modelId: composite };
  return { providerId: composite.slice(0, i), modelId: composite.slice(i + 1) };
}

interface StoredToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

function parseStoredCalls(json: string | null | undefined): StoredToolCall[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as StoredToolCall[];
    if (!Array.isArray(arr)) return [];
    return arr.filter((c) => c && typeof c.id === "string" && typeof c.name === "string");
  } catch {
    return [];
  }
}

function toolStateFrom(outcome: boolean | null | undefined, hasMessage: boolean): ToolCall["state"] {
  if (!hasMessage) return "proposed";
  if (outcome === true) return "succeeded";
  if (outcome === false) return "failed";
  return "running";
}

function riskFrom(tool: string): ToolCall["risk"] {
  const t = tool.toLowerCase();
  if (t.includes("run_command") || t.includes("command")) return "execute";
  if (
    t.includes("write") || t.includes("edit") || t.includes("delete") || t.includes("move") ||
    t.includes("commit") || t.includes("checkout") || t.includes("revert") || t.includes("mkdir") ||
    t.includes("create_directory")
  ) {
    return "write";
  }
  return "read";
}

/** Fold tool rows under their assistant step; synthesize trajectory events. */
export function mapDetail(detail: ServerConversationDetail): { messages: Message[]; events: TrajectoryEvent[] } {
  const messages: Message[] = [];
  const events: TrajectoryEvent[] = [];
  const toolByCallId = new Map<string, ServerMessage>();
  for (const m of detail.messages) {
    if (m.role === "Tool" && m.toolCallId) toolByCallId.set(m.toolCallId, m);
  }

  let assistantById = new Map<string, Message>();
  let firstUser: ServerMessage | null = null;

  for (const m of detail.messages) {
    const role = m.role;
    if (role === "Tool") continue;
    if (role === "User" && !firstUser) {
      firstUser = m;
      events.push({
        id: newId("ev"),
        ts: toMs(m.createdAt),
        kind: "request",
        title: m.content.slice(0, 80),
        status: "done",
      });
    }
    const msg: Message = {
      id: m.id,
      role: role === "User" ? "user" : "assistant",
      content: m.content,
      reasoning: undefined,
      createdAt: toMs(m.createdAt),
      modelId: m.modelId ? toCompositeModel(m.providerId ?? "openrouter", m.modelId) : undefined,
      providerId: m.providerId ?? undefined,
      streaming: m.status === "Streaming",
      toolCalls: [],
      live: true,
      usage:
        m.inputTokens || m.outputTokens
          ? {
              inputTokens: m.inputTokens ?? 0,
              outputTokens: m.outputTokens ?? 0,
              ms: m.generationTimeMs ?? 0,
            }
          : undefined,
      folded: m.isCompacted || undefined,
    };
    if (msg.role === "assistant") {
      const stored = parseStoredCalls(m.toolCallsJson);
      for (const call of stored) {
        const row = toolByCallId.get(call.id);
        msg.toolCalls.push({
          id: call.id,
          tool: call.name,
          risk: riskFrom(call.name),
          state: toolStateFrom(row?.toolSucceeded, !!row),
          headline: row?.content?.split("\n")[0]?.slice(0, 120) || call.name,
          body: row?.content,
        });
        if (row) {
          events.push({
            id: newId("ev"),
            ts: toMs(row.createdAt),
            kind: "tool",
            title: `${call.name} · ${(row.content?.split("\n")[0] ?? "").slice(0, 80)}`,
            status: row.toolSucceeded === false ? "failed" : "done",
          });
        }
      }
      // tool rows without a stored call entry (interrupted runs): attach by proximity
      for (const [callId, row] of toolByCallId) {
        if (msg.toolCalls.some((t) => t.id === callId)) continue;
        if (toMs(row.createdAt) < toMs(m.createdAt)) continue;
        msg.toolCalls.push({
          id: callId,
          tool: row.toolName ?? translate(S().ui.locale, "tool.unnamed"),
          risk: riskFrom(row.toolName ?? ""),
          state: toolStateFrom(row.toolSucceeded, true),
          headline: row.content?.split("\n")[0]?.slice(0, 120) || (row.toolName ?? translate(S().ui.locale, "tool.unnamed")),
          body: row.content,
        });
      }
      assistantById.set(m.id, msg);
      if (m.status === "Failed") {
        // Surface the failure on the message itself so the bubble can show it
        // inline (see MessageItem) — not only as a trajectory event the user
        // never looks at. Empty content + no error read as a broken reply.
        msg.error = m.errorMessage || translate(S().ui.locale, "error.requestFailed");
        if (m.errorKind) msg.errorKind = m.errorKind;
        events.push({
          id: newId("ev"),
          ts: toMs(m.createdAt),
          kind: "error",
          title: m.errorMessage || translate(S().ui.locale, "error.requestFailed"),
          status: "failed",
        });
      }
    }
    messages.push(msg);
  }
  void assistantById;
  return { messages, events };
}

/* Server summaries carry no work mode (chats aren't partitioned server-side),
   so the caller supplies the mode it remembers for this conversation id; an
   unknown one stays undefined and reads as "chat" via sessionModeOf. */
function mapSummary(s: ServerConversationSummary, mode?: WorkMode): Session {
  return {
    id: s.id,
    title: s.title,
    createdAt: toMs(s.createdAt),
    updatedAt: toMs(s.updatedAt),
    pinned: s.isPinned ?? s.pinned ?? false,
    preview: s.preview ?? "",
    messages: [],
    events: [],
    goalIds: [],
    modelId:
      s.providerId && s.modelId ? toCompositeModel(s.providerId, s.modelId) : S().ui.selectedModelId,
    contextTokens: undefined,
    mode,
    projectId: s.projectId ?? null,
    /* carry the server's hand-rename flag so the client-side auto-title gates
       (addMessage / applyAutoTitle / reloadSession) survive a restart */
    titleUserDefined: s.isTitleUserDefined || undefined,
  };
}

/* Server projects carry no work mode (projects aren't partitioned server-side),
   so infer it: a remembered mode wins, else a filed chat's mode, else "code"
   when the project relates to a workspace folder, else "cowork". */
function mapProject(p: ServerProject): Project {
  const prior = S().projects.find((x) => x.id === p.id);
  const memberMode = S().sessions.find((s) => s.projectId === p.id && s.mode)?.mode;
  const inferred: WorkMode = prior?.mode ?? memberMode ?? (p.workspacePath ? "code" : "cowork");
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? undefined,
    workspacePath: p.workspacePath ?? undefined,
    accent: p.accent ?? undefined,
    /* keep the local open/closed choice across hydration — there is no server
       PATCH route to persist a toggle, so the client owns this view state. */
    expanded: prior ? prior.expanded : p.isExpanded,
    sortOrder: p.sortOrder,
    conversationCount: p.conversationCount,
    lastActivityAt: toMs(p.lastActivityAt),
    createdAt: toMs(p.createdAt),
    updatedAt: toMs(p.updatedAt),
    mode: inferred === "chat" ? "cowork" : inferred,
  };
}

/** (Re)load the project folders from the server into the store. */
export async function loadProjects(): Promise<void> {
  if (!serverMode) return;
  const list = await projects.list().catch(() => [] as ServerProject[]);
  useAqvenor.setState({ projects: list.map(mapProject) });
}

function mapProviders(list: Awaited<ReturnType<typeof providers.list>>): Provider[] {
  return list.map((p) => {
    /* Trust the backend's probed ConnectionState (serialized as its enum name)
       rather than inferring "connected" from mere key presence — a stored-but-
       untested or failed key must never read as live. Falls back to "unknown"
       when a key exists but no state was reported. */
    const raw = (p.connectionState ?? "").toLowerCase();
    const state: ProviderState =
      raw === "connected" ? "connected"
      : raw === "testing" ? "testing"
      : raw === "failed" ? "failed"
      : raw === "notconfigured" ? "missing-key"
      : raw === "unknown" ? "unknown"
      : p.hasApiKey ? "unknown" : "missing-key";
    return {
      id: p.id,
      name: p.name,
      endpoint: p.apiKeyUrl ?? "",
      state,
      statusMessage: p.statusMessage ?? undefined,
      models: [],
      builtin: !p.isCustom,
      enabled: p.isEnabled,
      apiKeyUrl: p.apiKeyUrl ?? undefined,
    };
  });
}

/* ---------------- boot hydration ---------------- */

export interface HydrateResult {
  ok: boolean;
  sessions: number;
  providers: number;
}

export async function hydrateFromBackend(): Promise<HydrateResult> {
  if (booted) return { ok: serverMode, sessions: 0, providers: 0 };
  booted = true;
  /* The sidecar boots in parallel with this page, and on a cold start the
     first probe can lose the race — a Kestrel that has not bound yet reads
     as "backend down", and without the retries below that one loss stuck for
     the whole session (the app opened offline until a manual Retry). Probe a
     few times with a short backoff before falling to the honest offline
     state; the Boot screen's own timeout keeps the UI responsive while this
     runs in the background. */
  let ok = false;
  for (let attempt = 0; attempt < 5 && !ok; attempt++) {
    ok = await checkBackend();
    if (!ok) await new Promise((r) => setTimeout(r, 1200 + attempt * 800));
  }
  if (!ok) return { ok: false, sessions: 0, providers: 0 };
  serverMode = true;

  await refreshProviders();

  // settings → ui prefs (theme/locale are renderer-owned; map the rest)
  let uiPatch: Record<string, unknown> = {};
  try {
    const s = await settings.get();
    const general = (s["general"] ?? {}) as Record<string, unknown>;
    const chat = (s["chat"] ?? {}) as Record<string, unknown>;
    const agent = (s["agent"] ?? {}) as Record<string, unknown>;
    const appearance = (s["appearance"] ?? {}) as Record<string, unknown>;
    const lang = general["language"];
    const locale = lang === 1 || lang === "Russian" ? "ru" : lang === 2 || lang === "German" ? "de" : "en";
    const themeRaw = appearance["theme"];
    const theme =
      themeRaw === 1 || themeRaw === "Light"
        ? "light"
        : themeRaw === 2 || themeRaw === "Dark"
          ? "dark"
          : "system";
    uiPatch = {
      locale,
      theme,
      enterSend: chat["sendWithEnter"] ?? true,
      renderMarkdown: chat["renderMarkdown"] ?? true,
      autoscroll: chat["autoScroll"] ?? true,
      maxSteps: (agent["maxSteps"] as number) ?? 40,
      autoTitles: (general["autoGenerateTitles"] as boolean) ?? true,
    };
    const dp = (chat["defaultProviderId"] as string) || "";
    const dm = (chat["defaultModelId"] as string) || "";
    if (dp && dm) {
      // The server's chat default only *seeds* the picker; it must not clobber
      // the model the user last chose (persisted in ui.selectedModelId) on every
      // boot/re-hydrate — that was the "selected model isn't retained" bug.
      // Keep a still-valid persisted pick; fall back to the server default only
      // when the catalogue actually loaded and the pick isn't in it (fresh
      // install, or a model that no longer exists). Never clobber just because
      // the model list failed to load this boot.
      const current = S().ui.selectedModelId;
      const catalogueLoaded = S().providers.some((p) => p.models.length > 0);
      const resolvable = !!current && S().providers.some((p) => p.models.some((m) => m.id === current));
      if (catalogueLoaded && !resolvable) uiPatch["selectedModelId"] = toCompositeModel(dp, dm);
    }
  } catch {
    /* keep renderer defaults */
  }

  // sessions (summaries only; details load on select). Server summaries have no
  // work mode, so re-stamp each from the mode we persisted for that id last time
  // (server ids are stable) — otherwise per-mode chat partitioning would reset to
  // "chat" for every server conversation on every boot.
  const priorModes = new Map(S().sessions.map((s) => [s.id, s.mode] as const));
  const summaries = await conversations.list(100).catch(() => [] as ServerConversationSummary[]);
  const sessions = summaries.map((s) => mapSummary(s, priorModes.get(s.id)));

  // checkpoints
  const cps = await checkpoints.list().catch(() => []);
  const mappedCps: Checkpoint[] = [];
  for (const c of cps) {
    try {
      const full = await checkpoints.get(c.id);
      mappedCps.push({
        id: full.id,
        label: full.label,
        createdAt: toMs(full.createdAt),
        filesSnapshot: Object.entries(full.files).map(([path, content]) => ({ path, content })),
        sessionId: full.conversationId,
        message: full.messageId ?? "",
      });
    } catch {
      /* skip unreadable checkpoint */
    }
  }

  const prev = S();
  const keepLocal = prev.sessions.filter((s) => !isServerId(s.id));
  useAqvenor.setState({
    providers: S().providers,
    ui: { ...prev.ui, ...uiPatch },
    sessions: [...sessions, ...keepLocal].sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return b.updatedAt - a.updatedAt;
    }),
    checkpoints: mappedCps,
  });
  installServerActions();
  installCanvasOverrides(prev);
  void loadProjects().catch(() => undefined);
  void syncWorkspaceFiles().catch(() => undefined);
  void syncCanvas().catch(() => undefined);
  return { ok: true, sessions: sessions.length, providers: S().providers.length };
}

/* ---------------- providers ---------------- */

const modelToUi = (m: ServerModel): ModelInfo => ({
  id: toCompositeModel(m.providerId, m.modelId),
  name: m.name,
  providerId: m.providerId,
  contextK: m.contextWindow ? Math.max(1, Math.round(m.contextWindow / 1024)) : 32,
  vision: m.supportsImages,
  tools: m.supportsTools,
  pricePrompt: m.promptPricePerMillion ?? undefined,
  /* the wire shape has no image-generation flag yet — infer it from the id
     ("…-image", "dall-e", "imagen", "banana", "flux", …) so the capability
     bar and /image model picker still know */
  imageGen: looksLikeImageGenModel(m.modelId) || undefined,
});

/** (Re)load providers + catalogue from the server into the store. */
export async function refreshProviders(): Promise<void> {
  if (!serverMode && !(await checkBackend())) return;
  serverMode = true;
  const [infos, allModels] = await Promise.all([providers.list(), providers.allModels().catch(() => [])]);
  const mapped = mapProviders(infos);
  const byId = new Map(mapped.map((p) => [p.id, p]));
  for (const m of allModels) {
    const p = byId.get(m.providerId);
    if (p && !p.models.some((x) => x.id === toCompositeModel(m.providerId, m.modelId))) {
      p.models.push(modelToUi(m));
    }
  }
  for (const p of mapped.slice(0, 12)) {
    if (p.models.length === 0) {
      try {
        const ms = await providers.models(p.id);
        for (const m of ms) {
          if (!p.models.some((x) => x.id === toCompositeModel(m.providerId, m.modelId))) {
            p.models.push(modelToUi(m));
          }
        }
      } catch {
        /* offline catalogue for this provider — keep the row */
      }
    }
  }
  useAqvenor.setState({ providers: mapped });
}

/* ---------------- server settings ---------------- */

export interface ServerSettingsSections {
  general: Record<string, unknown>;
  chat: Record<string, unknown>;
  agent: Record<string, unknown>;
  appearance: Record<string, unknown>;
  storage: Record<string, unknown>;
  canvas: Record<string, unknown>;
}

export async function loadServerSettings(): Promise<ServerSettingsSections | null> {
  try {
    const s = await settings.get();
    return {
      general: (s["general"] ?? {}) as Record<string, unknown>,
      chat: (s["chat"] ?? {}) as Record<string, unknown>,
      agent: (s["agent"] ?? {}) as Record<string, unknown>,
      appearance: (s["appearance"] ?? {}) as Record<string, unknown>,
      storage: (s["storage"] ?? {}) as Record<string, unknown>,
      canvas: (s["canvas"] ?? {}) as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

export async function saveServerSettings(
  section: string,
  body: unknown,
): Promise<{ ok: boolean; refused: string[] }> {
  try {
    const res = await settings.put(section, body);
    return { ok: true, refused: Array.isArray(res?.refused) ? res.refused.map(String) : [] };
  } catch {
    return { ok: false, refused: [] };
  }
}

/* Property names the sidecar refuses over HTTP (mirrors ServerOwnedSettings).
   The renderer never sends these: their switches are displayed locked with the
   live values instead. Filtering here too, so a stale caller cannot even try. */
export const SERVER_LOCKED_SETTINGS = new Set([
  "allowCommands",
  "allowedCommands",
  "allowNetwork",
  "allowExternalFiles",
  "workspaceRoot",
]);

/* ---------------- local sessions (demo/offline) ---------------- */

/** Create a local-only session (demo theater, offline fallback). Never touches the server. */
export function newLocalSession(title = "New chat"): string {
  const id = newId("s");
  useAqvenor.setState((st) => {
    const mode = st.ui.workMode;
    return {
      sessions: [
        {
          id,
          title,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          preview: "",
          messages: [],
          events: [],
          goalIds: [],
          modelId: st.ui.selectedModelId,
          mode,
        },
        ...st.sessions,
      ],
      currentSessionId: id,
      surface: "chat",
      ui: { ...st.ui, activeSessionByMode: { ...st.ui.activeSessionByMode, [mode]: id } },
    };
  });
  return id;
}

/* ---------------- server-backed actions ---------------- */

/** Pull the canonical transcript for a server conversation into its session row.
 *  Used lazily on select and on mode-switch — the summary lists carry no messages. */
async function loadServerTranscript(id: string): Promise<void> {
  try {
    const detail = await conversations.get(id);
    const { messages, events } = mapDetail(detail);
    useAqvenor.setState((st) => ({
      sessions: st.sessions.map((s) =>
        s.id === id
          ? {
              ...s,
              /* A hand-renamed chat keeps its local title: the wire title equals it
                 after a successful PATCH, but if that PATCH failed (backend briefly
                 down) the server still holds the auto-title, and blindly applying
                 it here would silently revert the rename on the very next click. */
              title: s.titleUserDefined || detail.isTitleUserDefined ? s.title : detail.title,
              titleUserDefined:
                s.titleUserDefined || detail.isTitleUserDefined ? true : undefined,
              messages,
              events,
              modelId:
                detail.providerId && detail.modelId
                  ? toCompositeModel(detail.providerId, detail.modelId)
                  : s.modelId,
            }
          : s,
      ),
    }));
  } catch {
    const locale = S().ui.locale;
    S().pushToast(translate(locale, "conv.openFailed.title"), translate(locale, "conv.openFailed.desc"));
  }
}

function installServerActions() {
  const prev = S();
  useAqvenor.setState({
    /* Debounced writes are flushed before anything that makes losing them costly or
       impossible: switching sessions, exporting a bundle, or saving a file through
       the OS dialog. Without this the last few characters typed before one of those
       actions are simply gone. */
    flushPendingWrites: () => flushPendingWrites(),
    selectSession: (id: string) => {
      // Base action aligns work mode to the chat, sets the chat surface and
      // remembers it for its mode (other chats' approval gates are untouched);
      // we only add the server transcript pull.
      prev.selectSession(id);
      if (isServerId(id)) void loadServerTranscript(id);
    },
    setWorkMode: (mode: WorkMode) => {
      // Base action repoints currentSessionId to this mode's remembered/most-recent
      // chat (or a fresh placeholder). If that chat is a server one we haven't opened
      // yet, pull its transcript so switching modes shows the conversation, not a blank.
      prev.setWorkMode(mode);
      const t = S().sessions.find((x) => x.id === S().currentSessionId);
      if (t && isServerId(t.id) && t.messages.length === 0) void loadServerTranscript(t.id);
    },
    newSession: () => {
      const local = newId("s");
      // Stamp the chat with the mode it's born into so the mode-filtered sidebar
      // shows it, and remember it as that mode's active chat. Captured now, since
      // the user may switch modes before the server round-trip resolves.
      const mode = S().ui.workMode;
      void (async () => {
        try {
          const { providerId, modelId } = splitModelId(S().ui.selectedModelId);
          /* No title on create: a chat is born untitled and the server then owns
             its auto-title. Sending the placeholder "New chat" marked the chat as
             hand-named (IsTitleUserDefined) and froze it on that name forever
             (AQV-003). */
          const created = await conversations.create(undefined, providerId, modelId);
          const session: Session = { ...mapSummary(created, mode), mode };
          useAqvenor.setState((st) => ({
            sessions: [session, ...st.sessions.filter((s) => s.id !== session.id)],
            currentSessionId: session.id,
            surface: "chat",
            ui: { ...st.ui, activeSessionByMode: { ...st.ui.activeSessionByMode, [mode]: session.id } },
          }));
        } catch {
          // offline fallback: local session
          useAqvenor.setState((st) => ({
            sessions: [
              {
                id: local,
                title: "New chat",
                createdAt: Date.now(),
                updatedAt: Date.now(),
                preview: "",
                messages: [],
                events: [],
                goalIds: [],
                modelId: st.ui.selectedModelId,
                mode,
              },
              ...st.sessions,
            ],
            currentSessionId: local,
            surface: "chat",
            ui: { ...st.ui, activeSessionByMode: { ...st.ui.activeSessionByMode, [mode]: local } },
          }));
        }
      })();
      return local;
    },
    deleteSession: (id: string) => {
      if (isServerId(id)) {
        void conversations.remove(id).catch(() => undefined);
      }
      prev.deleteSession(id);
    },
    renameSession: (id: string, title: string) => {
      if (isServerId(id)) {
        void conversations.patch(id, { title }).catch(() => undefined);
      }
      useAqvenor.setState((st) => ({
        sessions: st.sessions.map((s) => (s.id === id ? { ...s, title, titleUserDefined: true } : s)),
      }));
    },
    setSessionPinned: (id: string, pinned: boolean) => {
      if (isServerId(id)) {
        void conversations.patch(id, { isPinned: pinned }).catch(() => undefined);
      }
      useAqvenor.setState((st) => ({
        sessions: st.sessions
          .map((s) => (s.id === id ? { ...s, pinned } : s))
          .sort((a, b) => {
            if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
            return b.updatedAt - a.updatedAt;
          }),
      }));
    },
    createProject: (name, opts) => {
      const mode = S().ui.workMode === "chat" ? "cowork" : S().ui.workMode;
      void (async () => {
        try {
          const created = await projects.create({
            name: name.trim() || "Project",
            workspacePath: opts?.workspacePath,
            description: opts?.description,
            accent: opts?.accent,
          });
          /* stamp the inferred mode so the folder lands in the sidebar we're in */
          const project: Project = { ...mapProject(created), mode };
          useAqvenor.setState((st) => ({
            projects: [...st.projects.filter((p) => p.id !== project.id), project],
          }));
        } catch {
          S().pushToast(
            translate(S().ui.locale, "project.createFailed.title"),
            translate(S().ui.locale, "project.createFailed.desc"),
            "destructive",
          );
        }
      })();
    },
    deleteProject: (id: string) => {
      if (isServerId(id)) {
        void projects.remove(id).catch(() => undefined);
      }
      // the server nulls each member's ProjectId; mirror that locally
      prev.deleteProject(id);
    },
    assignSessionToProject: (sessionId: string, projectId: string | null) => {
      if (isServerId(sessionId)) {
        // empty guid unfiles; a real guid files it (JSON null would be ignored)
        void conversations.patch(sessionId, { projectId: projectId ?? EMPTY_GUID }).catch(() => undefined);
      }
      prev.assignSessionToProject(sessionId, projectId);
    },
    /* newSessionInProject keeps the base (local-placeholder) behaviour: the chat
       is filed under the project immediately and ensureServerSession upgrades it
       to a server conversation — carrying its projectId — on the first message.
       No eager empty server conversation. */
    addCheckpoint: (cp: Checkpoint) => {
      void (async () => {
        try {
          const session = S().sessions.find((s) => s.id === S().currentSessionId);
          const convId = session && isServerId(session.id) ? session.id : S().currentSessionId;
          const files = cp.filesSnapshot.map((f) => f.path);
          const created = await checkpoints.create(
            isServerId(convId) ? convId : "00000000-0000-0000-0000-000000000000",
            cp.label,
            null,
            files,
            !!cp.canvasSnapshot,
          );
          useAqvenor.setState((st) => ({
            checkpoints: [...st.checkpoints, { ...cp, id: created.id }],
          }));
        } catch {
          useAqvenor.setState((st) => ({ checkpoints: [...st.checkpoints, cp] }));
        }
      })();
    },
    restoreCheckpoint: (id: string) => {
      void (async () => {
        if (isServerId(id)) {
          try {
            const res = await checkpoints.restore(id);
            S().pushToast(
              translate(S().ui.locale, "checkpoint.restored.title"),
              tp(S().ui.locale, "checkpoint.restored.count", res.restoredFiles),
            );
            await syncWorkspaceFiles();
            await syncCanvas();
            return;
          } catch {
            S().pushToast(
              translate(S().ui.locale, "checkpoint.restoreFailed.title"),
              translate(S().ui.locale, "checkpoint.restoreFailed.desc"),
              "destructive",
            );
            return;
          }
        }
        prev.restoreCheckpoint(id);
      })();
    },
  });
}

/** Reload the canonical transcript for a server conversation (after runs). */
export async function reloadSession(sessionId?: string): Promise<void> {
  const st = S();
  const id = sessionId ?? st.currentSessionId;
  if (!isServerId(id)) return;
  const detail = await conversations.get(id);
  const { messages, events } = mapDetail(detail);
  useAqvenor.setState((s) => {
    const local = s.sessions.find((x) => x.id === id);
    // A failed/empty provider turn can leave the server conversation with the
    // whole turn rolled back (no persisted messages). The wire already streamed
    // the transcript into the local store, so a shorter/empty server reload must
    // NOT wipe it — that was the "chat fully resets on a provider error" bug.
    // Keep the local messages whenever the server hands back strictly fewer.
    const keepLocal = !!local && local.messages.length > messages.length;
    const nextMessages = keepLocal && local ? local.messages : messages;
    // Don't let a server reload wipe the ChatGPT-style auto-title. The server
    // only titles a conversation after a successful answer; when the model fails
    // (e.g. NVIDIA 451 geo-block, or a missing key) detail.title is still the
    // "New chat" placeholder, which would revert the title we derived locally
    // from the first user message. Keep a meaningful local title whenever the
    // server's is still the default (or the user set it by hand). The check is
    // case-insensitive: the WPF app creates "New Chat" while this renderer
    // compares against "New chat", and that single letter was enough to revert
    // a local title on every reload.
    const isPlaceholderTitle = (v: string | undefined | null) =>
      !v || v.toLowerCase() === "new chat";
    const serverDefault = isPlaceholderTitle(detail.title);
    const localTitle = local?.title;
    const userTitled = local?.titleUserDefined || detail.isTitleUserDefined;
    const nextTitle =
      (serverDefault || userTitled) && localTitle && !isPlaceholderTitle(localTitle)
        ? localTitle
        : detail.title;
    return {
      sessions: s.sessions.map((x) =>
        x.id === id
          ? {
              ...x,
              title: nextTitle,
              titleUserDefined: userTitled ? true : undefined,
              updatedAt: toMs(detail.updatedAt),
              messages: nextMessages,
              events: mergeEvents(x.events, events),
              modelId:
                detail.providerId && detail.modelId
                  ? toCompositeModel(detail.providerId, detail.modelId)
                  : x.modelId,
            }
          : x,
      ),
    };
  });
}

function mergeEvents(local: TrajectoryEvent[], server: TrajectoryEvent[]): TrajectoryEvent[] {
  // keep local-only kinds the server never emits (fork/compact/skills/checkpoint-local)
  const keep = local.filter((e) => ["fork", "compact", "skills"].includes(e.kind));
  return [...server, ...keep].sort((a, b) => a.ts - b.ts);
}

/** Ensure one session is server-backed; returns its conversation id.
 *  Upgrading a placeholder swaps the session object id (local → server GUID).
 *  The current chat is re-pointed as before; any other chat leaves an alias
 *  so dock panels bound to the old id keep following it. */
export async function ensureServerSession(sessionId?: string): Promise<string> {
  const st = S();
  const localId = sessionId ?? st.currentSessionId;
  if (isServerId(localId)) return localId;
  const current = st.sessions.find((s) => s.id === localId);
  // Each chat carries its own agent; newly created server conversations do too.
  const { providerId, modelId } = splitModelId(current?.modelId ?? st.ui.selectedModelId);
  // the upgraded conversation stays in the mode its placeholder belonged to
  const mode = current?.mode ?? st.ui.workMode;
  // and keeps the project it was filed under (Cowork / Code)
  const projectId = current?.projectId ?? null;
  /* Only a real, user-chosen title travels as the title. A placeholder (or a
     title this client derived from the first message) must not be sent: the
     server treats any non-empty title as a hand rename and stops auto-titling
     the chat — the AQV-003 freeze. */
  const explicitTitle = serverCreateTitle(current);
  const created = await conversations.create(explicitTitle, providerId, modelId);
  if (projectId && isServerId(projectId)) {
    await conversations.patch(created.id, { projectId }).catch(() => undefined);
  }
  const summary = mapSummary(created, mode);
  /* The fresh server row is titled "New Chat"; keep the locally derived title
     on screen until the server's own title echo arrives. */
  const keepTitle =
    !explicitTitle && !isPlaceholderTitle(current?.title) ? current!.title : summary.title;
  const session: Session = {
    ...summary,
    title: keepTitle,
    mode,
    projectId,
    titleUserDefined: current?.titleUserDefined,
  };
  // carry over local messages? No — a fresh server transcript starts clean;
  // the run's user message is persisted by the run itself. Drop the empty local
  // placeholder we just upgraded so the mode's list doesn't keep a phantom "New
  // chat" beside the real conversation (a placeholder has no messages; a seed
  // chat with demo history is left in place).
  const dropId = current && current.messages.length === 0 ? localId : null;
  const isCurrent = localId === S().currentSessionId;
  useAqvenor.setState((s) => ({
    sessions: [session, ...s.sessions.filter((x) => x.id !== session.id && x.id !== dropId)],
    ...(isCurrent
      ? {
          currentSessionId: session.id,
          ui: { ...s.ui, activeSessionByMode: { ...s.ui.activeSessionByMode, [mode]: session.id } },
        }
      : {
          sessionAliases: { ...s.sessionAliases, [localId]: session.id },
        }),
  }));
  return session.id;
}

/** Back-compat alias: every pre-multitask caller means the current chat. */
export const reloadCurrentSession = (): Promise<void> => reloadSession();

/* ---------------- workspace files ---------------- */

const serverPaths = new Set<string>();

const langOf = (path: string): DemoFile["language"] => {
  if (path.endsWith(".cs") || path.endsWith(".csproj") || path.endsWith(".slnx")) return "csharp";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".xml") || path.endsWith(".xaml") || path.endsWith(".csproj")) return "xml";
  return "text";
};

export async function syncWorkspaceFiles(): Promise<void> {
  if (!serverMode) return;
  const status = await workspace.status();
  // single source of truth for the open project (item 5) — every surface reads
  // store.workspaceRoot instead of fetching workspace.status() on its own.
  useAqvenor.setState({ workspaceRoot: status.isOpen && status.root ? status.root : null });
  if (!status.isOpen) return;
  const listing = await workspace.list(".", true).catch(() => null);
  if (!listing) return;
  const files: DemoFile[] = listing.entries
    .filter((e) => !e.isDirectory)
    .slice(0, 2000)
    .map((e) => ({ path: e.path.replace(/\//g, "/"), language: langOf(e.path), content: "", modified: false }));
  serverPaths.clear();
  for (const f of files) serverPaths.add(f.path);
  useAqvenor.setState({ files });
}

/** Shared "open a workspace folder" flow (start screen, header chip, palette).
 *  Opens the OS folder picker, opens the folder on the sidecar, updates the
 *  shared workspaceRoot, then syncs files + re-indexes the canvas. Returns the
 *  opened root, or null if cancelled / no sidecar. Throws only when the sidecar
 *  `workspace.open` call fails, so callers can surface the message in a toast. */
export async function openWorkspaceDialog(): Promise<string | null> {
  const bridge = typeof window !== "undefined" ? window.aqvenor : undefined;
  if (!serverMode || !bridge) return null;
  const dir = await bridge.pickFolder();
  if (!dir) return null;
  const res = await workspace.open(dir);
  useAqvenor.setState({ workspaceRoot: res.root });
  await syncWorkspaceFiles().catch(() => undefined);
  await reindexCanvas().catch(() => undefined);
  return res.root;
}

/** Open a workspace folder by a path already known (e.g. a Code project's
 *  recorded workspacePath) — no OS picker. Mirrors openWorkspaceDialog's
 *  post-open sync. Returns the opened root, or null when there is no sidecar. */
export async function openWorkspaceByPath(dir: string): Promise<string | null> {
  if (!serverMode || !dir) return null;
  const res = await workspace.open(dir);
  useAqvenor.setState({ workspaceRoot: res.root });
  await syncWorkspaceFiles().catch(() => undefined);
  await reindexCanvas().catch(() => undefined);
  return res.root;
}

/** Prompt the OS folder picker and return the chosen absolute path (or null).
 *  Used when creating a Code project so it can relate to a workspace folder. */
export async function pickFolderPath(): Promise<string | null> {
  const bridge = typeof window !== "undefined" ? window.aqvenor : undefined;
  if (!bridge) return null;
  return (await bridge.pickFolder()) ?? null;
}

export async function readServerFile(path: string): Promise<string | null> {
  try {
    const res = await workspace.read(path, 1);
    return res.content;
  } catch {
    return null;
  }
}

/** Re-read every open code tab from the server (after agent edits). */
export async function refreshOpenTabs(): Promise<void> {
  if (!serverMode) return;
  const tabs = S().codeTabs;
  for (const path of tabs) {
    if (!serverPaths.has(path)) continue;
    const content = await readServerFile(path);
    if (content == null) continue;
    const current = S().files.find((f) => f.path === path);
    if (current && current.content !== content) {
      useAqvenor.setState((st) => ({
        files: st.files.map((f) => (f.path === path ? { ...f, content, modified: false } : f)),
      }));
    }
  }
}

/* ---------------- canvas ⇄ graph ---------------- */

const NODE_KINDS: NodeKind[] = [
  "file", "folder", "module", "service", "interface", "data", "view", "test",
  "plan", "task", "agent", "model", "external", "note",
];

function toNodeKind(raw: string): NodeKind {
  const lower = raw.toLowerCase();
  return (NODE_KINDS as string[]).includes(lower) ? (lower as NodeKind) : "note";
}

const EDGE_KINDS: EdgeKind[] = ["contains", "depends", "calls", "implements", "relates", "plans"];

function toEdgeKind(raw: string): EdgeKind {
  const lower = raw.toLowerCase();
  return (EDGE_KINDS as string[]).includes(lower) ? (lower as EdgeKind) : "relates";
}

const NODE_STATUSES: CanvasNodeStatus[] = ["pending", "running", "done", "failed"];

// The sidecar sends GraphNodeState.ToString() — "None"/"Pending"/… ; "none" (or absent)
// is an ordinary node and maps to no badge, so the card draws nothing for it.
function toNodeStatus(raw: string | null | undefined): CanvasNodeStatus | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  return (NODE_STATUSES as string[]).includes(lower) ? (lower as CanvasNodeStatus) : undefined;
}

export async function syncCanvas(): Promise<void> {
  if (!serverMode) return;
  const snap = await graph.snapshot().catch(() => null);
  if (!snap) return;
  applyGraphSnapshot(snap);
}

/**
 * Re-pull the graph after the agent drew a plan (submit_plan) and frame it.
 * The sidecar's ServerCanvasPlanSink mutates the shared graph and persists it
 * before the tool-finished event fires, so GET /graph already carries the plan
 * by the time this runs — no new wire event is needed. The fit is a no-op unless
 * the canvas is mounted, so calling it from any surface is safe.
 */
export async function refreshCanvasAfterPlan(): Promise<void> {
  if (!serverMode) return;
  await syncCanvas();
  requestCanvasFit();
}

/**
 * Re-index the graph after an agent run so the canvas reflects files the agent
 * created, moved or deleted. Only runs when a workspace is open (code mode) —
 * chat/cowork have no workspace graph to rebuild. Deliberately does NOT refit
 * the viewport: the user may be looking at the canvas while the run finishes,
 * and the server preserves node positions by id, so the layout stays put and
 * only the structure changes.
 */
export async function refreshCanvasAfterRun(): Promise<void> {
  if (!serverMode || !S().workspaceRoot) return;
  const res = await graph.reindex().catch(() => null);
  if (res) applyGraphSnapshot(res.snapshot);
  else await syncCanvas();
}

/**
 * Rebuild the graph by walking the open workspace folder, then show it.
 * The server does not auto-index on open, so `graph.snapshot()` is empty for a
 * freshly opened project — this is what actually fills the canvas.
 */
export async function reindexCanvas(): Promise<void> {
  if (!serverMode) return;
  const res = await graph.reindex().catch(() => null);
  if (res) {
    applyGraphSnapshot(res.snapshot);
    requestCanvasFit();
    return;
  }
  // reindex unavailable (older sidecar) — fall back to whatever snapshot exists
  await syncCanvas();
  requestCanvasFit();
}

function applyGraphSnapshot(snap: ServerGraphSnapshot): void {
  const nodes: CanvasNode[] = snap.nodes.map((n) => ({
    id: n.id,
    kind: toNodeKind(n.kind),
    title: n.title,
    meta: n.subtitle ?? n.path ?? undefined,
    x: n.x,
    y: n.y,
    w: n.width,
    h: n.height,
    path: n.path ?? undefined,
    note: n.detail ?? undefined,
    status: toNodeStatus(n.status),
  }));
  const edges: CanvasEdge[] = snap.edges.map((e) => ({
    id: e.id,
    from: e.sourceId,
    to: e.targetId,
    kind: toEdgeKind(e.kind),
    note: e.label ?? undefined,
  }));
  useAqvenor.setState((st) => ({
    canvas: {
      ...st.canvas,
      nodes,
      edges,
      selectedIds: [],
      primaryId: null,
      selectedEdgeId: null,
      selectedEdgeIds: [],
    },
  }));
}

export function pushGraphChanges(title: string, changes: GraphChangeInput[]): void {
  if (!serverMode || changes.length === 0) return;
  void graph.apply(title, changes).catch(() => undefined);
}

/** Push a canvas deletion (nodes + incident edges) as one server change set. */
export function pushCanvasDeletion(nodeIds: string[], edgeIds: string[]): void {
  if (!serverMode) return;
  const changes: GraphChangeInput[] = [
    ...edgeIds.map((id): GraphChangeInput => ({ kind: "remove-edge", edgeId: id })),
    ...nodeIds.map((nodeId): GraphChangeInput => ({ kind: "remove-node", nodeId })),
  ];
  pushGraphChanges("Delete selection", changes);
}

/** Push current node positions (auto-layout) as move changes. */
export function pushCanvasMoves(): void {
  if (!serverMode) return;
  const { nodes } = S().canvas;
  pushGraphChanges(
    "Arrange canvas",
    nodes.map((n): GraphChangeInput => ({ kind: "move-node", nodeId: n.id, x: n.x, y: n.y })),
  );
}

/**
 * Pending debounced writes, one timer per path.
 *
 * Per path rather than one global timer, so that typing in a second file cannot
 * cancel an unsaved edit in the first.
 */
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();

/** Newest content queued for a path, so a burst of keystrokes sends one write of the last state. */
const pendingContent = new Map<string, string>();

/**
 * How long typing pauses before the file is written.
 *
 * Long enough that a normal burst of typing produces one request rather than
 * hundreds, short enough that closing the window a moment after stopping has
 * almost always already persisted the edit.
 */
const WRITE_DEBOUNCE_MS = 700;

/** Writes one path now, cancelling its pending timer. Returns the promise for callers that must wait. */
function flushWrite(path: string): Promise<void> | null {
  const timer = pendingWrites.get(path);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingWrites.delete(path);
  }

  const content = pendingContent.get(path);
  if (content === undefined) return null;
  pendingContent.delete(path);

  return workspace
    .write(path, content)
    .then(() => S().markSave(path, "saved"))
    .catch(() => {
      S().markSave(path, "error");
      S().pushToast(translate(S().ui.locale, "file.saveFailed.title"), path, "destructive");
    });
}

/**
 * Writes every path with a queued edit, now.
 *
 * Called wherever the renderer is about to lose the chance to write: a save
 * action, a session export, the tab closing, and window teardown. Without it a
 * debounce is a way to lose the last few characters typed before a quit.
 */
export async function flushPendingWrites(): Promise<void> {
  const inFlight = [...pendingWrites.keys()]
    .map(flushWrite)
    .filter((p): p is Promise<void> => p !== null);

  await Promise.all(inFlight);
}

/** Every path with an edit still queued, for callers that report "unsaved changes". */
export function pendingWritePaths(): string[] {
  return [...pendingWrites.keys()];
}

function installCanvasOverrides(prev: ReturnType<typeof useAqvenor.getState>) {
  useAqvenor.setState({
    openCodeTab: (path: string) => {
      prev.openCodeTab(path);
      if (!serverMode || !serverPaths.has(path)) return;
      const file = S().files.find((f) => f.path === path);
      if (file && file.content) return;
      void readServerFile(path).then((content) => {
        if (content == null) return;
        useAqvenor.setState((st) => ({
          files: st.files.map((f) => (f.path === path ? { ...f, content } : f)),
        }));
      });
    },
    setFileContent: (path: string, content: string) => {
      // In memory immediately: the editor must never wait on a request to show a character.
      prev.setFileContent(path, content);
      if (!serverMode || !serverPaths.has(path)) return;

      // User edit in the Code surface: written straight through, with no approval,
      // because the person typed it themselves. Agent edits arrive via tool runs.
      //
      // Debounced. This used to POST the whole file on every keystroke, which for a
      // large file meant a full-document request per character, and on a flaky
      // connection a toast storm as every one of them failed.
      S().markSave(path, "unsaved");
      pendingContent.set(path, content);

      const existing = pendingWrites.get(path);
      if (existing !== undefined) clearTimeout(existing);

      pendingWrites.set(
        path,
        setTimeout(() => {
          void flushWrite(path);
        }, WRITE_DEBOUNCE_MS),
      );
    },
    addNodes: (nodes) => {
      prev.addNodes(nodes);
      if (!serverMode) return;
      pushGraphChanges(
        "Add nodes",
        nodes.map((n): GraphChangeInput => ({
          kind: "add-node",
          node: {
            id: n.id,
            kind: n.kind,
            title: n.title,
            subtitle: n.meta ?? undefined,
            detail: n.note ?? undefined,
            path: n.path ?? undefined,
            x: n.x,
            y: n.y,
            width: n.w,
            height: n.h,
          },
        })),
      );
    },
    addEdges: (edges) => {
      prev.addEdges(edges);
      if (!serverMode) return;
      pushGraphChanges(
        "Add connections",
        edges.map((e): GraphChangeInput => ({
          kind: "add-edge",
          edge: { id: e.id, sourceId: e.from, targetId: e.to, kind: e.kind, label: e.note ?? undefined },
        })),
      );
    },
    moveNode: (id: string, x: number, y: number, commit?: boolean) => {
      prev.moveNode(id, x, y, commit);
      if (!serverMode || !commit) return;
      pushGraphChanges("Move node", [{ kind: "move-node", nodeId: id, x, y }]);
    },
    setNodeNote: (id: string, note: string | undefined) => {
      prev.setNodeNote(id, note);
      if (!serverMode) return;
      pushGraphChanges("Edit note", [{ kind: "update-node", nodeId: id, detail: note ?? null } as GraphChangeInput]);
    },
    setEdgeNote: (id: string, note: string | undefined) => {
      prev.setEdgeNote(id, note);
      if (!serverMode) return;
      pushGraphChanges("Edit connection label", [{ kind: "update-edge", edgeId: id, label: note ?? null } as GraphChangeInput]);
    },
    updateEdgeKind: (id: string, kind, opts) => {
      prev.updateEdgeKind(id, kind, opts);
      if (!serverMode) return;
      pushGraphChanges("Change connection kind", [{ kind: "update-edge", edgeId: id, edgeKind: kind }]);
    },
    updateEdgeEndpoints: (id: string, from: string, to: string) => {
      const before = S().canvas.edges.find((e) => e.id === id);
      prev.updateEdgeEndpoints(id, from, to);
      if (!serverMode) return;
      pushGraphChanges("Reconnect edge", [
        { kind: "remove-edge", edgeId: id },
        {
          kind: "add-edge",
          edge: {
            id,
            sourceId: from,
            targetId: to,
            kind: before?.kind ?? "relates",
            label: before?.note ?? undefined,
          },
        },
      ]);
    },
    undoCanvas: () => {
      if (!serverMode) {
        prev.undoCanvas();
        return;
      }
      void (async () => {
        try {
          await graph.undo();
        } catch {
          /* nothing to undo — stay quiet */
        }
        await syncCanvas().catch(() => undefined);
      })();
    },
    redoCanvas: () => {
      if (!serverMode) {
        prev.redoCanvas();
        return;
      }
      void (async () => {
        try {
          await graph.redo();
        } catch {
          /* nothing to redo — stay quiet */
        }
        await syncCanvas().catch(() => undefined);
      })();
    },
  });
}

/* ---------------- misc server ops ---------------- */

export async function exportCurrentSession(format: "markdown" | "json" | "text"): Promise<string | null> {
  const id = S().currentSessionId;
  if (!isServerId(id)) return null;
  return exportApi.conversation(id, format).catch(() => null);
}

export { api, getBackendUrl };
