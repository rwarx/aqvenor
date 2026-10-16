"use client";

/* ============================================================
   Real agent driver — runs chat/agent turns against the .NET
   sidecar and maps the NDJSON stream onto the store primitives
   (messages, tool calls, approvals, trajectory events).
   No scripted content: everything on screen arrived on the wire.
   ============================================================ */

import { checkpoints, runs, type RunAttachment, type StreamFrame } from "./backend";
import { ensureServerSession, isServerId, refreshCanvasAfterPlan, refreshCanvasAfterRun, refreshOpenTabs, reloadSession, syncCanvas, syncWorkspaceFiles } from "./sync";
import { failPendingApprovals, isChatVisible, newId, onSessionDeleted, useAqvenor, waitForApproval } from "./store";
import { translate } from "./i18n";
import type { AgentMode, Approval, Attachment, DiffLine, Message, ToolCall } from "./types";

const S = () => useAqvenor.getState();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface ActiveRun {
  runId: string;
  abort: AbortController;
}

/* Live runs keyed by chat session: three chats side by side run three
   independent generations. Stopping one never touches the others. */
const activeRuns = new Map<string, ActiveRun>();

export function stopAgentRun(sessionId?: string) {
  const sid = sessionId ?? S().currentSessionId;
  const activeRun = activeRuns.get(sid);
  if (!activeRun) return;
  const { runId, abort } = activeRun;
  activeRuns.delete(sid);
  // Mark aborted first so a gate that is mid-wait bails cleanly (see handleApproval),
  // then release any pending approval so the server thread unblocks and the gate closes.
  abort.abort();
  if (S().approvalOf(sid)) S().resolveApproval("denied", undefined, sid);
  S().clearSessionRunner(sid);
  void runs.cancel(runId);
}

export function isAgentRunActive(sessionId?: string) {
  if (sessionId !== undefined) return activeRuns.has(sessionId);
  return activeRuns.size > 0;
}

/* Deleting a chat stops its run: the stream would otherwise pour into a
   dropped transcript while the server keeps burning tokens. Registered here
   (not imported by the store) to avoid a module cycle. */
onSessionDeleted((sid) => stopAgentRun(sid));

/** Extract workspace-relative file paths from tool arguments (best effort). */
function argPaths(argsJson: string): string[] {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const out: string[] = [];
    for (const key of ["path", "workspacePath", "file", "filePath", "directory", "from", "to"]) {
      const v = args[key];
      if (typeof v === "string" && v.length > 0 && v.length < 300) out.push(v);
    }
    return [...new Set(out)].slice(0, 8);
  } catch {
    return [];
  }
}

function parseDiffLines(preview: string): DiffLine[] | undefined {
  if (!preview || !preview.includes("\n")) return undefined;
  const lines = preview.split("\n").slice(0, 120);
  return lines.map((text): DiffLine => {
    if (text.startsWith("@@")) return { kind: "header", text };
    if (text.startsWith("+") && !text.startsWith("+++")) return { kind: "add", text };
    if (text.startsWith("-") && !text.startsWith("---")) return { kind: "del", text };
    return { kind: "context", text };
  });
}

const RISK_CONSEQUENCE: Record<string, string> = {
  Write: "Changes files in the folder you opened.",
  Execute: "Runs a program on this computer.",
  Read: "Reads from the folder you opened.",
};

function outcomeToState(outcome: string): ToolCall["state"] {
  if (outcome === "Succeeded") return "succeeded";
  if (outcome === "Failed") return "failed";
  if (outcome === "Denied") return "denied";
  return "abandoned";
}

function riskToUi(risk: string): ToolCall["risk"] {
  if (risk === "Execute") return "execute";
  if (risk === "Write") return "write";
  return "read";
}

export async function runAgentConversation(
  text: string,
  mode: AgentMode,
  opts?: { rebindUserId?: string; sessionId?: string },
): Promise<void> {
  const store = S();
  const locale = store.ui.locale;
  // The run belongs to one chat: concurrent runs in different chats coexist,
  // a second send into the SAME chat is still refused while it streams.
  let sid = opts?.sessionId ?? store.currentSessionId;
  if (isAgentRunActive(sid)) {
    store.pushToast(translate(locale, "run.busy.title"), translate(locale, "run.busy.desc"), "destructive");
    return;
  }
  const trimmed = text.trim();
  if (!trimmed) return;

  let conversationId: string;
  try {
    conversationId = await ensureServerSession(sid);
  } catch {
    store.pushToast(translate(locale, "run.noBackend.title"), translate(locale, "run.noBackend.desc"), "destructive");
    return;
  }
  // A first send upgrades the placeholder (local id → server GUID); the run
  // must write to the upgraded session, not the dropped placeholder.
  sid = S().sessionAliases[sid] ?? sid;

  // Each chat keeps its own agent: the picker's choice is stored on the
  // session, the global stays the default for chats created from here on.
  const sessionModel = store.resolveSession(sid)?.modelId ?? store.ui.selectedModelId;
  const { providerId, modelId } = splitComposite(sessionModel);
  // The sidecar types runId/conversationId as `Guid?` and constrains the
  // approval/cancel routes to `{runId:guid}`. A `newId("run")` prefixed id
  // fails Guid binding → /api/chat/send & /api/agent/run return 400 before
  // streaming. Mint a real UUID so the whole run lifecycle binds.
  const runId = crypto.randomUUID();
  const abort = new AbortController();
  activeRuns.set(sid, { runId, abort });

  store.setSessionRunner(sid, { status: "running", label: mode === "off" ? "Answering" : "Working" });
  store.setDraft("", sid);

  // Files staged on the paperclip travel with this one turn, then the tray clears.
  const staged = store.draftOf(sid).attachments;
  const runAttachments: RunAttachment[] | undefined =
    staged.length > 0
      ? staged.map((a) => ({ fileName: a.name, mimeType: a.mimeType, textContent: a.textContent }))
      : undefined;
  const displayAttachments: Attachment[] | undefined =
    staged.length > 0 ? staged.map((a) => ({ id: a.id, name: a.name, sizeKb: a.sizeKb })) : undefined;
  store.clearDraftAttachments(sid);

  let assistantId: string | null = null;
  let needsReload = false;
  // On retry we keep the failed turn's user bubble locally; the wire then persists a fresh
  // user message. Rebind the kept bubble onto that new id instead of appending a duplicate.
  let rebindUserId = opts?.rebindUserId ?? null;

  const ensureAssistant = (serverId: string, createdAt: string) => {
    if (assistantId) return assistantId;
    const msg: Message = {
      id: serverId,
      role: "assistant",
      content: "",
      createdAt: Date.parse(createdAt) || Date.now(),
      modelId: sessionModel,
      providerId,
      streaming: true,
      toolCalls: [],
      live: true,
    };
    assistantId = serverId;
    S().addMessage(msg, sid);
    return serverId;
  };

  const finishStreaming = () => {
    S().flushMessageBuffer(sid);
    if (assistantId) S().updateMessage(assistantId, { streaming: false }, sid);
  };

  const fail = async (title: string, fatal: boolean) => {
    finishStreaming();
    // Pin the error onto the assistant bubble so it shows inline immediately,
    // even before the server reload — a failed run must never look like an
    // empty reply. reloadSession re-applies the same error from the wire.
    if (assistantId) S().updateMessage(assistantId, { error: title }, sid);
    S().addEvent({ id: newId("ev"), ts: Date.now(), kind: "error", title, status: "failed" }, sid);
    S().clearSessionRunner(sid);
    if (fatal) S().pushToast(title, undefined, "destructive");
    if (!isChatVisible(sid)) {
      const chatTitle = S().resolveSession(sid)?.title ?? translate(S().ui.locale, "nav.chat");
      S().pushToast(chatTitle, title, "destructive");
      S().bumpUnread(sid);
    }
    try {
      await reloadSession(sid);
    } catch {
      /* keep the local transcript */
    }
    await refreshAfterRun();
  };

  const refreshAfterRun = async () => {
    // Agent edits land on disk through the server tools; the Files/Code
    // surfaces read the store, so re-pull what changed.
    try {
      await syncWorkspaceFiles();
      await refreshOpenTabs();
      // and re-index the spatial graph so the canvas reflects created / moved /
      // deleted files automatically (no manual "Refresh graph" needed).
      await refreshCanvasAfterRun();
    } catch {
      /* files stay as they were */
    }
  };

  const complete = async (label: string, inputTokens?: number, outputTokens?: number, ms?: number) => {
    S().flushMessageBuffer(sid);
    if (assistantId && (inputTokens || outputTokens)) {
      S().updateMessage(assistantId, {
        streaming: false,
        usage: { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0, ms: ms ?? 0 },
      }, sid);
    } else {
      finishStreaming();
    }
    S().setSessionRunner(sid, { status: "done", label: label || "Completed" });
    try {
      await reloadSession(sid);
    } catch {
      /* keep the local transcript */
    }
    await refreshAfterRun();
    // A chat that finished out of sight must knock: toast + sidebar badge.
    // A visible panel needs neither — the answer is already on screen.
    if (!isChatVisible(sid)) {
      const title = S().resolveSession(sid)?.title ?? translate(S().ui.locale, "nav.chat");
      S().pushToast(title, label || translate(S().ui.locale, "tasks.status.done"));
      S().bumpUnread(sid);
    }
  };

  const handleApproval = async (data: Record<string, unknown>) => {
    const approvalId = data["approvalId"] as string;
    const tool = (data["toolName"] as string) ?? translate(S().ui.locale, "tool.unnamed");
    const risk = (data["risk"] as string) ?? "Read";
    const summary = (data["summary"] as string) ?? undefined;
    const preview = (data["preview"] as string) ?? undefined;
    const argsNote = (data["argumentsJson"] as string) ?? undefined;

    // checkpoint-before-edit, like the prototype: capture the files this call may touch
    if ((risk === "Write" || risk === "Execute") && isServerId(conversationId)) {
      const paths = argPaths(argsNote ?? "{}");
      if (paths.length > 0 || risk === "Execute") {
        void checkpoints
          .create(conversationId, `before ${tool}`, assistantId, paths, true)
          .then((c) =>
            checkpoints
              .get(c.id)
              .then((full) =>
                S().addCheckpoint?.({
                  id: full.id,
                  label: full.label,
                  createdAt: Date.parse(full.createdAt) || Date.now(),
                  filesSnapshot: Object.entries(full.files).map(([path, content]) => ({ path, content })),
                  sessionId: conversationId,
                  message: assistantId ?? "",
                }),
              )
              .catch(() => undefined),
          )
          .catch(() => undefined);
      }
    }

    const approval: Approval = {
      id: approvalId,
      tool,
      risk: riskToUi(risk),
      headline: summary || tool,
      consequence: RISK_CONSEQUENCE[risk] ?? RISK_CONSEQUENCE.Read,
      diff: preview ? parseDiffLines(preview) : undefined,
      argsNote: argsNote && argsNote.length < 500 ? argsNote : undefined,
      allowForRunAvailable: risk !== "Execute",
    };
    S().setApproval(approval, sid);
    S().setSessionRunner(sid, { status: "awaiting-approval", label: translate(S().ui.locale, "tasks.waitingForYou") });
    S().addEvent({
      id: newId("ev"),
      ts: Date.now(),
      kind: "approval",
      title: `${tool} · ${translate(S().ui.locale, "approval.pending.title")}`,
      status: "warning",
    }, sid);
    const decision = await waitForApproval(approvalId, sid);
    if (abort.signal.aborted) return; // stopped while waiting — the gate was already released
    S().setSessionRunner(sid, { status: "running", label: translate(S().ui.locale, "main.ai.working") });
    const outcome =
      decision.decision === "allowed" ? "allowed" : decision.decision === "allowed-for-run" ? "allowed-for-run" : "denied";
    try {
      await runs.answerApproval(runId, approvalId, outcome, decision.reason);
    } catch {
      /* run may have ended while answering */
    }
    S().addEvent({
      id: newId("ev"),
      ts: Date.now(),
      kind: "approval",
      title: `${tool} · ${translate(S().ui.locale, outcome === "denied" ? "approval.outcome.denied" : outcome === "allowed-for-run" ? "approval.outcome.allowedRun" : "approval.outcome.allowed")}`,
      status: outcome === "denied" ? "failed" : "done",
    });
  };

  // Approvals are served through the run registry, not the NDJSON stream: the server
  // blocks the agent thread on a PendingApproval and expects the renderer to poll for it
  // (GET /api/runs/{runId}/approval → the question, or 204 while none is pending).
  // We poll concurrently with the stream and feed any new question into handleApproval,
  // which shows the gate, waits for the user, then POSTs the decision back.
  let lastHandledApprovalId: string | null = null;
  let pollActive = false;

  /**
 * Polls for an approval question until the run ends.
 *
 * Bounded, because the alternative was an unbounded loop: a sidecar that dies mid-run makes every
 * poll fail, `pending` stays null, and the loop spun at two requests a second forever with nothing on
 * screen. Eight consecutive failures ends it and says so.
 */
const MAX_CONSECUTIVE_POLL_FAILURES = 8;

  const pollApprovals = async () => {
    pollActive = true;
    let failures = 0;

    while (pollActive && activeRuns.get(sid)?.runId === runId && !abort.signal.aborted) {
      let pending: Awaited<ReturnType<typeof runs.approval>> = null;

      try {
        pending = await runs.approval(runId);
        failures = 0;
      } catch {
        failures += 1;

        if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          S().pushToast(
            translate(S().ui.locale, "run.contactLost.title"),
            translate(S().ui.locale, "run.contactLost.desc"),
            "destructive",
          );
          abort.abort();
          return;
        }
      }

      if (pending && pending.approvalId !== lastHandledApprovalId) {
        lastHandledApprovalId = pending.approvalId;
        await handleApproval(pending as unknown as Record<string, unknown>);
      } else {
        await sleep(500);
      }
    }
  };

  const onFrame = async (frame: StreamFrame) => {
    const st = S();

    // Keepalive, not content. The server writes one of these every five seconds while a run is
    // producing nothing, because a reasoning model can go quiet for minutes and an idle TCP
    // connection gets closed by Kestrel or any proxy in front of it. It must be dropped before the
    // buffer is flushed below: a ping is not a structural boundary, and treating it as one would
    // force a flush and an extra render every five seconds of every wait.
    if (frame.type === "ping") return;

    const data = (frame.data ?? {}) as Record<string, unknown>;
    if (frame.type === "delta" && frame.text) {
      const id = (frame.messageId as string) ?? assistantId;
      if (id) {
        if (!assistantId) ensureAssistant(id, new Date().toISOString());
        st.appendToMessageBuffered(id, frame.text, sid);
      }
      return;
    }
    // Any non-delta frame is a structural boundary (tool call, completion,
    // error, reload). Commit buffered stream text first so transcript order
    // and content stay exact.
    st.flushMessageBuffer(sid);
    if (frame.type === "error") {
      await fail((frame.message as string) || translate(S().ui.locale, "error.requestFailed"), false);
      return;
    }
    if (frame.type !== "event") return;
    switch (frame.name) {
      case "user-saved": {
        const m = data["message"] as { id: string; content: string; createdAt: string };
        const createdAt = Date.parse(m.createdAt) || Date.now();
        const rebindTarget = rebindUserId
          ? st.resolveSession(sid)?.messages.find((x) => x.id === rebindUserId)
          : undefined;
        if (rebindTarget) {
          // retry: reuse the kept user bubble by rebinding its id onto the freshly-persisted
          // server message — never append a second identical user bubble.
          st.updateMessage(rebindUserId as string, {
            id: m.id,
            content: m.content,
            createdAt,
            attachments: displayAttachments,
          }, sid);
        } else {
          st.addMessage({
            id: m.id,
            role: "user",
            content: m.content,
            createdAt,
            toolCalls: [],
            attachments: displayAttachments,
          }, sid);
        }
        rebindUserId = null;
        st.addEvent({ id: newId("ev"), ts: Date.now(), kind: "request", title: m.content.slice(0, 80), status: "done" }, sid);
        break;
      }
      case "assistant-started":
      case "step-started": {
        const m = data["message"] as { id: string; createdAt: string };
        ensureAssistant(m.id, m.createdAt);
        break;
      }
      case "reasoning-delta": {
        const id = data["messageId"] as string;
        const cur = st.resolveSession(sid)?.messages.find((x) => x.id === id);
        if (cur) st.updateMessage(id, { reasoning: (cur.reasoning ?? "") + ((data["text"] as string) ?? "") }, sid);
        break;
      }
      case "tool-proposed": {
        const call = data["call"] as { id: string; name: string; argumentsJson: string };
        const msgId = (data["messageId"] as string) ?? assistantId;
        if (!msgId) break;
        st.addToolCall(msgId, {
          id: call.id,
          tool: call.name,
          risk: riskToUi((data["risk"] as string) ?? "Read"),
          state: "proposed",
          headline: call.name,
        }, sid);
        st.addEvent({ id: newId("ev"), ts: Date.now(), kind: "tool", title: `${call.name} · proposed`, status: "running" }, sid);
        break;
      }
      case "tool-started": {
        const call = data["call"] as { id: string };
        const msgId = (data["messageId"] as string) ?? assistantId;
        if (msgId && call) st.updateToolCall(msgId, call.id, { state: "running" }, sid);
        break;
      }
      case "tool-finished": {
        const call = data["call"] as { id: string; name: string };
        const outcome = (data["outcome"] as string) ?? "Failed";
        const row = data["message"] as { content: string; createdAt: string } | undefined;
        const summary = (data["summary"] as string) ?? undefined;
        const detail = (data["detail"] as string) ?? undefined;
        const owner =
          st.resolveSession(sid)?.messages.find((m) => m.toolCalls.some((t) => t.id === call.id)) ?? null;
        const body = row?.content ? row.content.slice(0, 4000) : undefined;
        if (owner) {
          st.updateToolCall(owner.id, call.id, {
            state: outcomeToState(outcome),
            headline: summary || owner.toolCalls.find((t) => t.id === call.id)?.headline || call.name,
            body,
          }, sid);
          if (detail && detail !== body) {
            // surface the diff separately when the tool offered one
            st.updateToolCall(owner.id, call.id, { body: detail.slice(0, 4000) }, sid);
          }
        }
        st.addEvent({
          id: newId("ev"),
          ts: Date.now(),
          kind: outcome === "Succeeded" ? "tool" : outcome === "Denied" ? "approval" : "error",
          title: `${call.name} · ${outcome.toLowerCase()}`,
          status: outcome === "Succeeded" ? "done" : outcome === "Denied" ? "warning" : "failed",
        }, sid);
        // submit_plan draws onto the shared graph server-side (ServerCanvasPlanSink);
        // re-pull it so the plan appears on the canvas without a dedicated wire event.
        if (call.name === "submit_plan" && outcome === "Succeeded") {
          void refreshCanvasAfterPlan().catch(() => undefined);
        }
        // The incremental canvas tools (add_nodes / link_nodes / set_node_status) mutate
        // the same graph a piece at a time. A plain GET reflects the change in place —
        // no reindex (that is for file edits) and no fit (that would fight the user's
        // viewport mid-build); read_canvas changes nothing, so it needs no refresh.
        if (
          outcome === "Succeeded" &&
          (call.name === "add_nodes" || call.name === "link_nodes" || call.name === "set_node_status")
        ) {
          void syncCanvas().catch(() => undefined);
        }
        break;
      }
      case "step-completed": {
        const id = data["messageId"] as string;
        if (id) {
          st.updateMessage(id, {
            usage: {
              inputTokens: (data["inputTokens"] as number) ?? 0,
              outputTokens: (data["outputTokens"] as number) ?? 0,
              ms: 0,
            },
          }, sid);
        }
        break;
      }
      case "completed": {
        await complete(translate(S().ui.locale, "tasks.status.done"), data["inputTokens"] as number, data["outputTokens"] as number, data["generationTimeMs"] as number);
        if (activeRuns.get(sid)?.runId === runId) activeRuns.delete(sid);
        break;
      }
      case "run-completed": {
        const reason = (data["reason"] as string) ?? "Answered";
        await complete(
          reason === "Answered"
            ? translate(S().ui.locale, "tasks.status.done")
            : reason === "StepLimit"
              ? translate(S().ui.locale, "run.stop.stepLimit")
              : translate(S().ui.locale, "run.stop.timeLimit"),
        );
        if (reason !== "Answered") {
          st.pushToast(
            translate(S().ui.locale, reason === "StepLimit" ? "run.stop.stepLimit" : "run.stop.timeLimit"),
            translate(S().ui.locale, "run.stop.continueHint"),
          );
        }
        if (activeRuns.get(sid)?.runId === runId) activeRuns.delete(sid);
        break;
      }
      case "cancelled": {
        finishStreaming();
        st.addEvent({ id: newId("ev"), ts: Date.now(), kind: "complete", title: translate(S().ui.locale, "chat.stopped"), status: "warning" }, sid);
        st.setSessionRunner(sid, { status: "stopped", label: translate(S().ui.locale, "tasks.status.stopped") });
        try {
          await reloadSession(sid);
        } catch {
          /* keep local */
        }
        await refreshAfterRun();
        if (activeRuns.get(sid)?.runId === runId) activeRuns.delete(sid);
        break;
      }
      case "title": {
        const conv = data["conversationId"] as string;
        const title = data["title"] as string;
        // Local-only: the server generated this title, so applying it must not
        // PATCH back, and a hand-renamed chat (titleUserDefined) is left alone.
        if (conv && title) st.applyAutoTitle(conv, title);
        break;
      }
      case "compacted": {
        needsReload = true;
        st.addEvent({
          id: newId("ev"),
          ts: Date.now(),
          kind: "compact",
          title: `Folded ${data["messagesFolded"] ?? 0} message(s)`,
          status: "done",
        }, sid);
        break;
      }
      default:
        break;
    }
  };

  // Plain chat ("off") never proposes tools, so it needs no approval poll.
  const pollPromise = mode === "off" ? null : pollApprovals();

  try {
    const attachments: RunAttachment[] | undefined = runAttachments;
    // Canvas selection travels with the turn (capped): what "this" points at.
    const focusNodeIds = store.canvas.selectedIds.slice(0, 20);
    const focus = focusNodeIds.length > 0 ? focusNodeIds : undefined;
    if (mode === "off") {
      await runs.chatSend(
        { runId, conversationId, content: trimmed, providerId, modelId, attachments, focusNodeIds: focus },
        onFrame,
        abort.signal,
      );
    } else {
      const serverMode = mode === "plan" ? "Plan" : mode === "plancanvas" ? "PlanCanvas" : "Build";
      await runs.agentRun(
        { runId, conversationId, content: trimmed, providerId, modelId, mode: serverMode, attachments, focusNodeIds: focus },
        onFrame,
        abort.signal,
      );
    }
  } catch (err) {
    if (abort.signal.aborted || S().sessionRunnerOf(sid).status === "stopped") {
      finishStreaming();
      S().setSessionRunner(sid, { status: "stopped", label: "Stopped" });
      try {
        await reloadSession(sid);
      } catch {
        /* keep local */
      }
      await refreshAfterRun();
    } else {
      await fail(err instanceof Error ? err.message : translate(S().ui.locale, "error.requestFailed"), true);
    }
  } finally {
    pollActive = false;
    if (activeRuns.get(sid)?.runId === runId) activeRuns.delete(sid);
    if (pollPromise) await pollPromise.catch(() => undefined);

    // Nothing can answer an approval question now, so anything still waiting must be released.
    // A waiter left open blocks the frame handler, which blocks the run — the user would watch a
    // spinner with no error and no way to tell whether it was still working.
    // Scoped to this chat: another chat's open question survives our ending.
    failPendingApprovals("The run ended before this question was answered.", sid);
  }
}

function splitComposite(composite: string): { providerId: string; modelId: string } {
  const i = composite.indexOf("/");
  if (i < 0) return { providerId: "openrouter", modelId: composite };
  return { providerId: composite.slice(0, i), modelId: composite.slice(i + 1) };
}
