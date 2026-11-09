// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConversationDetail, ServerMessage, StreamFrame } from "../backend";

const parentId = "10000000-0000-0000-0000-000000000001";
const assistantId = "10000000-0000-0000-0000-000000000002";
const childId = "10000000-0000-0000-0000-000000000003";
const timestamp = "2026-11-09T00:00:00Z";
const call = { id: "delegate-call", name: "delegate_task", argumentsJson: JSON.stringify({ task: "Review the form", title: "Form review" }) };
const result = (status: string) => JSON.stringify({ parentConversationId: parentId, conversationId: childId, title: "Form review", status, steps: 2, answer: "Validate the email field." });

function row(id: string, role: string, sequenceNumber: number, extra: Partial<ServerMessage> = {}): ServerMessage {
  return { id, role, sequenceNumber, conversationId: parentId, content: "", createdAt: timestamp,
    status: "Complete", attachments: [], isContextSummary: false, isCompacted: false, ...extra };
}
function detail(messages: ServerMessage[], id = parentId): ServerConversationDetail {
  return { id, title: "Review", createdAt: timestamp, updatedAt: timestamp, providerId: "openrouter", modelId: "auto", messages };
}

beforeEach(() => {
  vi.resetModules(); localStorage.clear();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected delegation-test network request")));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture() {
  const { useAqvenor } = await import("../store");
  const backend = await import("../backend");
  const sync = await import("../sync");
  const agent = await import("../agent-live");
  const mcp = await import("../mcp");
  useAqvenor.setState({ sessions: [], drafts: {}, approvals: {}, runningSessions: {}, mcpServers: [], updateClosing: false, workspaceSwitching: false });
  const localId = useAqvenor.getState().newSession();
  useAqvenor.setState((state) => ({ sessions: state.sessions.map((session) => session.id === localId ? { ...session, id: parentId, mode: "code" } : session), currentSessionId: parentId }));
  useAqvenor.getState().setUi({ locale: "en" });
  vi.spyOn(sync, "flushPendingWrites").mockResolvedValue(undefined);
  vi.spyOn(sync, "ensureServerSession").mockResolvedValue(parentId);
  vi.spyOn(sync, "syncWorkspaceFiles").mockResolvedValue(undefined);
  vi.spyOn(sync, "refreshOpenTabs").mockResolvedValue(undefined);
  vi.spyOn(sync, "refreshCanvasAfterRun").mockResolvedValue(undefined);
  vi.spyOn(mcp, "memoryContextFor").mockResolvedValue(null);
  vi.spyOn(mcp, "rememberRun").mockResolvedValue(undefined);
  vi.spyOn(backend.runs, "approval").mockResolvedValue(null);
  vi.spyOn(backend.runs, "cancel").mockResolvedValue(undefined);
  const get = vi.spyOn(backend.conversations, "get").mockResolvedValue(detail([]));
  const message = () => useAqvenor.getState().resolveSession(parentId)!.messages.find((message) => message.id === assistantId)!;
  return { useAqvenor, backend, sync, agent, get, message };
}

describe("canonical tool ownership", () => {
  it("keeps shell execution risk after a transcript reload", async () => {
    const { mapDetail } = await import("../sync");
    const shell = { id: "shell-call", name: "run_shell", argumentsJson: "{}" };
    const mapped = mapDetail(detail([row(assistantId, "Assistant", 1, { toolCallsJson: JSON.stringify([shell]) }),
      row("tool", "Tool", 2, { toolCallId: shell.id, toolName: shell.name, content: "Exit code: 0", toolSucceeded: true })]));
    expect(mapped.messages[0].toolCalls[0].risk).toBe("execute");
  });

  it("attaches each orphan tool row only to its nearest preceding assistant, including equal timestamps", async () => {
    const { mapDetail } = await import("../sync");
    const mapped = mapDetail(detail([
      row("a1", "Assistant", 1), row("t1", "Tool", 2, { toolCallId: "orphan-1", toolName: "read_file", toolSucceeded: true }),
      row("u2", "User", 3), row("a2", "Assistant", 4), row("t2", "Tool", 5, { toolCallId: "orphan-2", toolName: "read_file", toolSucceeded: true }),
    ]));
    expect(mapped.messages.filter((message) => message.role === "assistant").map((message) => message.toolCalls.map((tool) => tool.id))).toEqual([["orphan-1"], ["orphan-2"]]);
  });

  it("does not duplicate a stored later call under an earlier assistant", async () => {
    const { mapDetail } = await import("../sync");
    const mapped = mapDetail(detail([row("a1", "Assistant", 1), row("a2", "Assistant", 2, { toolCallsJson: JSON.stringify([call]) }),
      row("tool", "Tool", 3, { toolCallId: call.id, toolName: call.name, content: result("done"), toolSucceeded: true })]));
    expect(mapped.messages.map((message) => message.toolCalls.map((tool) => tool.id))).toEqual([[], [call.id]]);
  });
});

describe("delegation reload", () => {
  it("retains running parent status when a later child has already completed", async () => {
    const { mapDetail } = await import("../sync");
    const second = { ...call, id: "second-call" };
    const mapped = mapDetail(detail([row(assistantId, "Assistant", 1, { toolCallsJson: JSON.stringify([call, second]) }),
      row("tool1", "Tool", 2, { toolCallId: call.id, toolName: call.name, content: result("running") }),
      row("tool2", "Tool", 3, { toolCallId: second.id, toolName: second.name, content: result("done"), toolSucceeded: true })]));
    expect(mapped.messages[0].blocks?.find((block) => block.type === "agenttree")).toEqual(expect.objectContaining({ parentStatus: "running", agents: [expect.objectContaining({ status: "running" }), expect.objectContaining({ status: "done" })] }));
  });

  it.each([["running", "running"], ["done", "done"], ["error", "failed"], ["incomplete", "failed"], ["stopped", "stopped"]])("restores %s child state and its chat link", async (serverStatus, uiStatus) => {
    const { mapDetail } = await import("../sync");
    const mapped = mapDetail(detail([row(assistantId, "Assistant", 1, { toolCallsJson: JSON.stringify([call]) }),
      row("tool", "Tool", 2, { toolCallId: call.id, toolName: call.name, content: result(serverStatus), toolSucceeded: serverStatus === "done" })]));
    expect(mapped.messages[0].blocks).toEqual([expect.objectContaining({ type: "agenttree", parentStatus: serverStatus === "running" ? "running" : "done", agents: [expect.objectContaining({ id: call.id, name: "Form review", conversationId: childId, status: uiStatus, steps: 2 })] })]);
    expect(mapped.events.some((event) => event.kind === "subagent")).toBe(true);
  });

  it("does not create a clickable chat link from malformed tool JSON or a non-conversation identifier", async () => {
    const { mapDetail } = await import("../sync");
    for (const content of ["{broken", JSON.stringify({ conversationId: "../../other", title: "Wrong", status: "done" })]) {
      const mapped = mapDetail(detail([row(assistantId, "Assistant", 1, { toolCallsJson: JSON.stringify([call]) }), row("tool", "Tool", 2, { toolCallId: call.id, content, toolSucceeded: false })]));
      const roster = mapped.messages[0].blocks?.find((block) => block.type === "agenttree");
      expect(roster?.type === "agenttree" && roster.agents.some((agent) => agent.conversationId)).toBe(false);
    }
  });
});

describe("live delegation", () => {
  it.each(["deferred", "failed"] as const)("preserves stopped parent and child state through %s cancellation after eight approval-poll failures", async (cancellationMode) => {
    const f = await fixture();
    const { delegatedOwnerOf } = await import("../delegation");
    const approval = vi.spyOn(f.backend.runs, "approval").mockRejectedValue(new Error("Sidecar contact lost"));
    let acknowledgeCancellation!: () => void;
    const cancel = vi.spyOn(f.backend.runs, "cancel");
    if (cancellationMode === "deferred") cancel.mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledgeCancellation = resolve; }));
    else cancel.mockRejectedValueOnce(new Error("Cancellation unavailable"));
    f.get.mockResolvedValue(detail([
      row(assistantId, "Assistant", 1, { content: "Partial parent answer", status: "Cancelled", toolCallsJson: JSON.stringify([call]) }),
      row("child-tool", "Tool", 2, { toolCallId: call.id, toolName: call.name, content: result("stopped"), toolSucceeded: false }),
    ]));
    vi.spyOn(f.backend.runs, "agentRun").mockImplementationOnce(async (_body, emit, signal) => {
      await emit({ type: "event", name: "step-started", data: { message: { id: assistantId, createdAt: timestamp } } });
      await emit({ type: "delta", messageId: assistantId, text: "Partial parent answer" });
      await emit({ type: "event", name: "subagent-started", data: { parentMessageId: assistantId, toolCallId: call.id, childConversationId: childId, title: "Form review", status: "running", steps: 0 } });
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
    });
    vi.useFakeTimers();
    const generation = f.agent.runAgentConversation("Inspect the project", "build");
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.message()?.streaming).toBe(true);
      f.useAqvenor.getState().setDraft("Next task remains unsent", parentId);
      f.useAqvenor.getState().addDraftAttachment({ id: "next-context", name: "next.txt", sizeKb: 1, mimeType: "text/plain", textContent: "For the next turn" }, parentId);
      await vi.advanceTimersByTimeAsync(3500);
      await generation;
      expect(approval).toHaveBeenCalledTimes(8);
      expect(cancel).toHaveBeenCalledOnce();
      expect(f.get).not.toHaveBeenCalled();
      expect(f.message()).toEqual(expect.objectContaining({ content: "Partial parent answer", streaming: false, cancelled: true }));
      expect(f.message().blocks?.find((block) => block.type === "agenttree")).toEqual(expect.objectContaining({ parentStatus: "stopped", agents: [expect.objectContaining({ status: "stopped" })] }));
      expect(f.useAqvenor.getState().draftOf(parentId)).toEqual(expect.objectContaining({ text: "Next task remains unsent", attachments: [expect.objectContaining({ id: "next-context" })] }));
      expect(delegatedOwnerOf(f.useAqvenor.getState(), childId)?.parentSessionId).toBe(parentId);
      expect(f.agent.hasAgentWorkInFlight()).toBe(true);
      if (cancellationMode === "deferred") {
        acknowledgeCancellation();
        await vi.advanceTimersByTimeAsync(0);
        expect(cancel).toHaveBeenCalledOnce();
      } else {
        cancel.mockResolvedValue(undefined);
        expect(await f.agent.retryAgentCancellations()).toBe(true);
        expect(cancel).toHaveBeenCalledTimes(2);
      }
      expect(delegatedOwnerOf(f.useAqvenor.getState(), childId)).toBeUndefined();
      expect(f.agent.hasAgentWorkInFlight()).toBe(false);
      expect(f.useAqvenor.getState().draftOf(parentId).text).toBe("Next task remains unsent");
    } finally {
      f.agent.stopAgentRun(parentId);
      acknowledgeCancellation?.();
      cancel.mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(4000);
      await generation;
      await f.agent.retryAgentCancellations();
      vi.useRealTimers();
    }
  });

  it("retains a child's reservation on transport failure until a failed cancellation can be retried", async () => {
    const f = await fixture();
    const { delegatedOwnerOf } = await import("../delegation");
    const cancel = vi.spyOn(f.backend.runs, "cancel").mockRejectedValueOnce(new Error("Cancellation unavailable"));
    vi.spyOn(f.backend.runs, "agentRun").mockImplementationOnce(async (_body, emit) => {
      await emit({ type: "event", name: "step-started", data: { message: { id: assistantId, createdAt: timestamp } } });
      await emit({ type: "event", name: "subagent-started", data: { parentMessageId: assistantId, toolCallId: call.id, childConversationId: childId, title: "Form review", status: "running", steps: 0 } });
      throw new Error("Stream disconnected");
    });
    await f.agent.runAgentConversation("Inspect the project", "build");
    try {
      expect(cancel).toHaveBeenCalledOnce();
      expect(delegatedOwnerOf(f.useAqvenor.getState(), childId)?.parentSessionId).toBe(parentId);
      expect(f.agent.hasAgentWorkInFlight()).toBe(true);
    } finally {
      cancel.mockResolvedValue(undefined);
      await f.agent.retryAgentCancellations();
    }
    expect(delegatedOwnerOf(f.useAqvenor.getState(), childId)).toBeUndefined();
    expect(f.agent.hasAgentWorkInFlight()).toBe(false);
  });

  it("releases child ownership only after the parent stream finishes, preserving the historical chat", async () => {
    const f = await fixture();
    const { delegatedOwnerOf } = await import("../delegation");
    let emit!: (frame: StreamFrame) => void | Promise<void>;
    let finishStream!: () => void;
    vi.spyOn(f.backend.runs, "agentRun").mockImplementationOnce(async (_body, onFrame) => {
      emit = onFrame;
      await emit({ type: "event", name: "step-started", data: { message: { id: assistantId, createdAt: timestamp } } });
      await new Promise<void>((resolve) => { finishStream = resolve; });
    });
    const generation = f.agent.runAgentConversation("Inspect the project", "build");
    await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
    try {
      const data = { parentMessageId: assistantId, toolCallId: call.id, childConversationId: childId, title: "Form review", status: "running", steps: 0 };
      await emit({ type: "event", name: "subagent-started", data });
      await emit({ type: "event", name: "subagent-completed", data: { ...data, status: "done", steps: 2 } });
      await emit({ type: "event", name: "run-completed", data: { reason: "Answered" } });
      expect(delegatedOwnerOf(f.useAqvenor.getState(), childId)?.parentSessionId).toBe(parentId);
    } finally { finishStream(); await generation; }
    expect(delegatedOwnerOf(f.useAqvenor.getState(), childId)).toBeUndefined();
    f.useAqvenor.getState().setSessionRunner(parentId, { status: "running" });
    expect(delegatedOwnerOf(f.useAqvenor.getState(), childId)).toBeUndefined();
  });

  it("updates child steps on progress without adding a trajectory event for each step", async () => {
    const f = await fixture();
    let emit!: (frame: StreamFrame) => void | Promise<void>;
    vi.spyOn(f.backend.runs, "agentRun").mockImplementationOnce(async (_body, onFrame, signal) => {
      emit = onFrame;
      await emit({ type: "event", name: "step-started", data: { message: { id: assistantId, createdAt: timestamp } } });
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
    });
    const generation = f.agent.runAgentConversation("Inspect the project", "build");
    try {
      await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
      const data = { parentMessageId: assistantId, toolCallId: call.id, childConversationId: childId, title: "Form review", status: "running", steps: 0 };
      await emit({ type: "event", name: "subagent-started", data });
      const eventCount = f.useAqvenor.getState().resolveSession(parentId)!.events.length;
      for (let steps = 1; steps <= 3; steps++) await emit({ type: "event", name: "subagent-progress", data: { ...data, steps, phase: "step-completed" } });
      expect(f.message().blocks?.find((block) => block.type === "agenttree")).toEqual(expect.objectContaining({ agents: [expect.objectContaining({ status: "running", steps: 3 })] }));
      expect(f.useAqvenor.getState().resolveSession(parentId)!.events).toHaveLength(eventCount);
    } finally {
      f.agent.stopAgentRun(parentId); await generation;
      await vi.waitFor(() => expect(f.agent.hasAgentWorkInFlight()).toBe(false));
    }
  });

  it("keeps a completed child reserved through parent Stop until cancellation is confirmed", async () => {
    const f = await fixture();
    const { delegatedOwnerOf } = await import("../delegation");
    let emit!: (frame: StreamFrame) => void | Promise<void>;
    let finishCancel!: () => void;
    vi.spyOn(f.backend.runs, "cancel").mockImplementationOnce(() => new Promise<void>((resolve) => { finishCancel = resolve; }));
    vi.spyOn(f.backend.runs, "agentRun").mockImplementationOnce(async (_body, onFrame, signal) => {
      emit = onFrame;
      await emit({ type: "event", name: "step-started", data: { message: { id: assistantId, createdAt: timestamp } } });
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
    });
    const generation = f.agent.runAgentConversation("Inspect the project", "build");
    await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
    const data = { parentMessageId: assistantId, toolCallId: call.id, childConversationId: childId, title: "Form review", status: "running", steps: 0 };
    try {
      await emit({ type: "event", name: "subagent-started", data });
      await emit({ type: "event", name: "subagent-completed", data: { ...data, status: "done", steps: 3 } });
      expect(delegatedOwnerOf(f.useAqvenor.getState(), childId)?.parentSessionId).toBe(parentId);
      expect(f.useAqvenor.getState().sessionRunnerOf(childId).status).toBe("idle");
      f.agent.stopAgentRun(parentId); await generation;
      await vi.waitFor(() => expect(finishCancel).toBeTypeOf("function"));
      expect(delegatedOwnerOf(f.useAqvenor.getState(), childId)?.parentSessionId).toBe(parentId);
    } finally {
      f.agent.stopAgentRun(parentId); await generation;
      await vi.waitFor(() => expect(finishCancel).toBeTypeOf("function"));
      finishCancel?.();
      await vi.waitFor(() => expect(f.agent.hasAgentWorkInFlight()).toBe(false));
    }
    expect(delegatedOwnerOf(f.useAqvenor.getState(), childId)).toBeUndefined();
  });

  it("creates distinct live assistant steps so a later step can own a delegation", async () => {
    const f = await fixture();
    let emit!: (frame: StreamFrame) => void | Promise<void>;
    const nextAssistant = "10000000-0000-0000-0000-000000000005";
    vi.spyOn(f.backend.runs, "agentRun").mockImplementationOnce(async (_body, onFrame, signal) => {
      emit = onFrame;
      await emit({ type: "event", name: "step-started", data: { message: { id: assistantId, createdAt: timestamp } } });
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
    });
    const generation = f.agent.runAgentConversation("Inspect the project", "build");
    try {
      await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
      await emit({ type: "delta", messageId: assistantId, text: "First step" });
      await emit({ type: "event", name: "step-started", data: { message: { id: nextAssistant, createdAt: timestamp } } });
      await emit({ type: "delta", messageId: nextAssistant, text: "Second step" });
      await emit({ type: "event", name: "subagent-started", data: { parentMessageId: nextAssistant, toolCallId: call.id, childConversationId: childId, title: "Form review", status: "running", steps: 0 } });
      const messages = f.useAqvenor.getState().resolveSession(parentId)!.messages;
      expect(messages.map((message) => message.content)).toEqual(["First step", "Second step"]);
      expect(messages[0].blocks).toBeUndefined();
      expect(messages[1].blocks?.some((block) => block.type === "agenttree")).toBe(true);
    } finally {
      f.agent.stopAgentRun(parentId); await generation;
      await vi.waitFor(() => expect(f.agent.hasAgentWorkInFlight()).toBe(false));
    }
    const stopped = f.useAqvenor.getState().resolveSession(parentId)!.messages;
    expect(stopped[0].cancelled).toBeFalsy();
    expect(stopped[1].cancelled).toBe(true);
  });

  it("shows the real child lifecycle without changing chats and ignores frames after Stop", async () => {
    const f = await fixture();
    let emit!: (frame: StreamFrame) => void | Promise<void>;
    vi.spyOn(f.backend.runs, "agentRun").mockImplementationOnce(async (_body, onFrame, signal) => {
      emit = onFrame;
      await emit({ type: "event", name: "step-started", data: { message: { id: assistantId, createdAt: timestamp } } });
      await emit({ type: "event", name: "tool-proposed", data: { messageId: assistantId, call, risk: "Read" } });
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
    });
    const generation = f.agent.runAgentConversation("Inspect the project", "build");
    await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
    const data = { parentMessageId: assistantId, toolCallId: call.id, childConversationId: childId, title: "Form review", status: "running", steps: 0 };
    await emit({ type: "event", name: "subagent-started", data });
    expect(f.message().blocks).toEqual([expect.objectContaining({ type: "agenttree", parentStatus: "running", agents: [expect.objectContaining({ conversationId: childId, status: "running" })] })]);
    await emit({ type: "event", name: "subagent-completed", data: { ...data, status: "done", steps: 2 } });
    expect(f.message().blocks?.find((block) => block.type === "agenttree")).toEqual(expect.objectContaining({ agents: [expect.objectContaining({ status: "done", steps: 2 })] }));
    await emit({ type: "event", name: "subagent-started", data: { ...data, toolCallId: "second-call", childConversationId: "10000000-0000-0000-0000-000000000004" } });
    f.agent.stopAgentRun(parentId);
    await emit({ type: "event", name: "subagent-completed", data: { ...data, toolCallId: "second-call", status: "done" } });
    await generation;
    await vi.waitFor(() => expect(f.agent.hasAgentWorkInFlight()).toBe(false));
    const roster = f.message().blocks?.find((block) => block.type === "agenttree");
    expect(roster).toEqual(expect.objectContaining({ parentStatus: "stopped", agents: [expect.objectContaining({ status: "done" }), expect.objectContaining({ status: "stopped" })] }));
    expect(f.useAqvenor.getState().currentSessionId).toBe(parentId);
  });
});

describe("subagent transcript navigation", () => {
  it("does not fetch the transcript twice when the real server-backed select action is installed", async () => {
    const f = await fixture();
    vi.spyOn(f.backend, "checkBackend").mockResolvedValue(true);
    vi.spyOn(f.backend.providers, "list").mockResolvedValue([]);
    vi.spyOn(f.backend.providers, "allModels").mockResolvedValue([]);
    vi.spyOn(f.backend.settings, "get").mockResolvedValue({});
    vi.spyOn(f.backend.conversations, "list").mockResolvedValue([{ id: parentId, title: "Parent", createdAt: timestamp, updatedAt: timestamp, messageCount: 0 }]);
    vi.spyOn(f.backend.checkpoints, "list").mockResolvedValue([]);
    vi.spyOn(f.backend.projects, "list").mockResolvedValue([]);
    vi.spyOn(f.backend.workspace, "status").mockResolvedValue({ isOpen: false });
    vi.spyOn(f.backend.workspace, "list").mockResolvedValue({ path: ".", isTruncated: false, entries: [] });
    vi.spyOn(f.backend.graph, "snapshot").mockRejectedValue(new Error("No canvas"));
    await f.sync.hydrateFromBackend();
    f.get.mockClear(); f.get.mockResolvedValue(detail([], childId));
    expect(await f.sync.openDelegatedConversation(childId)).toBe(true);
    expect(f.get).toHaveBeenCalledTimes(1);
  });

  it("keeps a later navigation when a slow child conversation finishes loading", async () => {
    const f = await fixture();
    let finish!: (value: ServerConversationDetail) => void;
    f.get.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const opening = f.sync.openDelegatedConversation(childId);
    f.useAqvenor.getState().selectSession("another-chat");
    finish(detail([], childId));
    expect(await opening).toBe(false);
    expect(f.useAqvenor.getState().currentSessionId).toBe("another-chat");
    expect(f.useAqvenor.getState().resolveSession(childId)).toBeUndefined();
  });

  it("rejects an unavailable child without navigating or leaving a loading button", async () => {
    const f = await fixture(); f.get.mockRejectedValueOnce(new Error("Not found"));
    const { MessageBlocks } = await import("../../../components/aqvenor/chat/blocks");
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(MessageBlocks, { blocks: [{ type: "agenttree", parentStatus: "done", agents: [{ id: call.id, name: "Form review", role: "Task", status: "failed", conversationId: childId }] }] })));
      const button = host.querySelector("button")!;
      await act(async () => button.click());
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-busy")).toBe("false");
      expect(f.useAqvenor.getState().currentSessionId).toBe(parentId);
      expect(f.useAqvenor.getState().resolveSession(childId)).toBeUndefined();
      expect(f.useAqvenor.getState().toasts.at(-1)?.variant).toBe("destructive");
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it("loads a real child conversation once and opens it without creating a new server chat", async () => {
    const f = await fixture();
    f.get.mockResolvedValue(detail([row("child-answer", "Assistant", 1, { conversationId: childId, content: "The form is correct." })], childId));
    const { MessageBlocks } = await import("../../../components/aqvenor/chat/blocks");
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(MessageBlocks, { blocks: [{ type: "agenttree", parentStatus: "done", agents: [{ id: call.id, name: "Form review", role: "Task", status: "done", conversationId: childId }] }] })));
      expect(host.textContent).not.toContain("running");
      expect(host.textContent).toContain("1/1");
      const button = host.querySelector("button")!;
      expect(button).not.toBeNull();
      await act(async () => button.click());
      expect(f.get).toHaveBeenCalledWith(childId);
      expect(f.useAqvenor.getState().currentSessionId).toBe(childId);
      expect(f.useAqvenor.getState().resolveSession(childId)?.messages[0].content).toBe("The form is correct.");
      expect(f.useAqvenor.getState().resolveSession(childId)?.mode).toBe("cowork");
      expect(f.useAqvenor.getState().resolveSession(parentId)).toBeDefined();
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
});
