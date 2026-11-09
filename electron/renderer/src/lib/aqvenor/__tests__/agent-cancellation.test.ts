// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamFrame, ServerConversationDetail } from "../backend";

const sessionId = "10000000-0000-0000-0000-000000000001";
const assistantId = "10000000-0000-0000-0000-000000000002";
const timestamp = "2026-11-09T00:00:00Z";

beforeEach(() => {
  vi.resetModules(); localStorage.clear();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected cancellation-test network request")));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function detail(status = "Cancelled"): ServerConversationDetail {
  return { id: sessionId, title: "Canonical prior turn", createdAt: timestamp, updatedAt: timestamp,
    messages: [{ id: assistantId, conversationId: sessionId, role: "Assistant", content: "", status,
      sequenceNumber: 1, createdAt: timestamp, attachments: [], isContextSummary: false, isCompacted: false }],
  };
}

async function fixture() {
  const { useAqvenor } = await import("../store");
  const backend = await import("../backend");
  const sync = await import("../sync");
  const agent = await import("../agent-live");
  useAqvenor.setState({ sessions: [], drafts: {}, approvals: {}, runningSessions: {}, mcpServers: [], updateClosing: false });
  const localId = useAqvenor.getState().newSession();
  useAqvenor.setState((state) => ({ sessions: state.sessions.map((session) => session.id === localId ? { ...session, id: sessionId } : session), currentSessionId: sessionId }));
  useAqvenor.getState().setUi({ locale: "en" });
  vi.spyOn(sync, "flushPendingWrites").mockResolvedValue(undefined);
  vi.spyOn(sync, "ensureServerSession").mockResolvedValue(sessionId);
  vi.spyOn(sync, "syncWorkspaceFiles").mockResolvedValue(undefined);
  vi.spyOn(sync, "refreshOpenTabs").mockResolvedValue(undefined);
  vi.spyOn(sync, "refreshCanvasAfterRun").mockResolvedValue(undefined);
  const get = vi.spyOn(backend.conversations, "get").mockResolvedValue(detail());
  const cancel = vi.spyOn(backend.runs, "cancel").mockResolvedValue(undefined);
  const message = () => useAqvenor.getState().resolveSession(sessionId)!.messages.find((message) => message.id === assistantId)!;
  return { useAqvenor, backend, sync, agent, get, cancel, message };
}

describe("stopped assistant messages", () => {
  it.each([
    ["OutputLimit", "run.stop.outputLimit"],
    ["StepLimit", "run.stop.stepLimit"],
    ["TimeLimit", "run.stop.timeLimit"],
  ])("keeps partial text and reports %s as an unfinished run", async (reason, labelKey) => {
    const f = await fixture();
    const { translate } = await import("../i18n");
    const canonical = detail("Complete");
    f.get.mockResolvedValue({ ...canonical, messages: canonical.messages.map((message) => ({ ...message, content: "Partial result" })) });
    vi.spyOn(f.backend.runs, "approval").mockResolvedValue(null);
    vi.spyOn(f.backend.runs, "agentRun").mockImplementationOnce(async (_body, emit) => {
      await emit({ type: "event", name: "step-started", data: { message: { id: assistantId, createdAt: timestamp } } });
      await emit({ type: "delta", messageId: assistantId, text: "Partial result" });
      await emit({ type: "event", name: "run-completed", data: { reason } });
    });
    await f.agent.runAgentConversation("Create a page", "build");
    expect(f.message()).toMatchObject({ content: "Partial result", streaming: false });
    expect(f.useAqvenor.getState().sessionRunnerOf(sessionId)).toMatchObject({ status: "stopped", label: translate("en", labelKey) });
    expect(f.useAqvenor.getState().toasts.at(-1)?.title).toBe(translate("en", labelKey));
    if (reason === "OutputLimit") expect(f.useAqvenor.getState().toasts.at(-1)?.description).toBe(translate("en", "run.stop.outputLimit.desc"));
  });

  it("retains a new draft attachment when Stop happens while memory is loading, before the first server frame", async () => {
    const f = await fixture();
    const mcp = await import("../mcp");
    let finishMemory!: (value: null) => void;
    const memory = vi.spyOn(mcp, "memoryContextFor").mockReturnValueOnce(new Promise((resolve) => { finishMemory = resolve; }));
    const send = vi.spyOn(f.backend.runs, "chatSend").mockResolvedValue(undefined);
    const generation = f.agent.runAgentConversation("first prompt", "off");
    await vi.waitFor(() => expect(memory).toHaveBeenCalledOnce());
    expect(f.agent.isAgentRunActive(sessionId)).toBe(true);
    expect(f.message()).toBeUndefined();
    f.agent.stopAgentRun(sessionId);
    f.useAqvenor.getState().setDraft("next prompt", sessionId);
    f.useAqvenor.getState().addDraftAttachment({ id: "next-file", name: "next.txt", mimeType: "text/plain", sizeKb: 1, textContent: "Next turn context" }, sessionId);
    finishMemory(null);
    await generation;
    await vi.waitFor(() => expect(f.agent.hasAgentWorkInFlight()).toBe(false));
    expect(send).not.toHaveBeenCalled();
    expect(f.useAqvenor.getState().draftOf(sessionId)).toMatchObject({ text: "next prompt", attachments: [{ id: "next-file" }] });
  });

  it("consumes only the attachment snapshot sent by the run and retains files staged during memory loading", async () => {
    const f = await fixture();
    const mcp = await import("../mcp");
    f.useAqvenor.getState().addDraftAttachment({ id: "sent-file", name: "sent.txt", mimeType: "text/plain", sizeKb: 1, textContent: "This turn context" }, sessionId);
    let finishMemory!: (value: null) => void;
    const memory = vi.spyOn(mcp, "memoryContextFor").mockReturnValueOnce(new Promise((resolve) => { finishMemory = resolve; }));
    const send = vi.spyOn(f.backend.runs, "chatSend").mockImplementationOnce(async (_body, emit) => { await emit({ type: "event", name: "completed", data: {} }); });
    const generation = f.agent.runAgentConversation("first prompt", "off");
    await vi.waitFor(() => expect(memory).toHaveBeenCalledOnce());
    f.useAqvenor.getState().addDraftAttachment({ id: "next-file", name: "next.txt", mimeType: "text/plain", sizeKb: 1, textContent: "Next turn context" }, sessionId);
    finishMemory(null); await generation;
    expect(send.mock.calls[0][0].attachments).toEqual([{ fileName: "sent.txt", mimeType: "text/plain", textContent: "This turn context" }]);
    expect(f.useAqvenor.getState().draftOf(sessionId).attachments).toMatchObject([{ id: "next-file" }]);
  });

  it("shows Thinking for an assistant that is still streaming in an active run", async () => {
    const f = await fixture();
    f.useAqvenor.getState().addMessage({ id: assistantId, role: "assistant", content: "", createdAt: 1, toolCalls: [], streaming: true }, sessionId);
    f.useAqvenor.getState().setSessionRunner(sessionId, { status: "running" });
    const { MessageItem } = await import("../../../components/aqvenor/chat/MessageItem");
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    await act(async () => root.render(createElement(MessageItem, { message: f.message(), sessionId })));
    expect(host.textContent).toContain("Thinking");
    expect(host.textContent).not.toContain("Stopped");
    await act(async () => root.unmount()); host.remove();
  });

  it.each(["reject", "resolve"] as const)("finishes the placeholder immediately and reloads only after cancellation when the transport ends by %s", async (ending) => {
    const f = await fixture();
    let acknowledged = false;
    let finishCancel!: () => void;
    f.cancel.mockImplementationOnce(() => new Promise<void>((resolve) => { finishCancel = () => { acknowledged = true; resolve(); }; }));
    f.get.mockImplementation(async () => detail(acknowledged ? "Cancelled" : "Streaming"));
    vi.spyOn(f.backend.runs, "chatSend").mockImplementationOnce(async (_body, emit, signal) => {
      await emit({ type: "event", name: "assistant-started", data: { message: { id: assistantId, createdAt: timestamp } } });
      await new Promise<void>((resolve, reject) => signal!.addEventListener("abort", () => ending === "reject" ? reject(new DOMException("Stopped", "AbortError")) : resolve(), { once: true }));
    });
    const generation = f.agent.runAgentConversation("hello", "off");
    await vi.waitFor(() => expect(f.message()?.streaming).toBe(true));
    f.agent.stopAgentRun(sessionId);
    const immediatelyStopped = f.message();
    await generation;
    try {
      expect(f.get).not.toHaveBeenCalled();
      expect(immediatelyStopped).toMatchObject({ streaming: false, cancelled: true });
      expect(f.message()).toMatchObject({ streaming: false, cancelled: true, content: "" });
      expect(f.agent.hasAgentWorkInFlight()).toBe(true);
    } finally { finishCancel(); }
    await vi.waitFor(() => expect(f.agent.hasAgentWorkInFlight()).toBe(false));
    expect(f.get).toHaveBeenCalledOnce();
    expect(f.message()).toMatchObject({ streaming: false, cancelled: true });
    const { MessageItem } = await import("../../../components/aqvenor/chat/MessageItem");
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    await act(async () => root.render(createElement(MessageItem, { message: f.message(), sessionId })));
    expect(host.textContent).toContain("Stopped");
    expect(host.textContent).not.toContain("Thinking");
    await act(async () => root.unmount()); host.remove();
  });

  it("does not accept queued stream frames after Stop", async () => {
    const f = await fixture();
    let emit!: (frame: StreamFrame) => void | Promise<void>;
    vi.spyOn(f.backend.runs, "chatSend").mockImplementationOnce(async (_body, onFrame, signal) => {
      emit = onFrame;
      await emit({ type: "event", name: "assistant-started", data: { message: { id: assistantId, createdAt: timestamp } } });
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
    });
    const generation = f.agent.runAgentConversation("hello", "off");
    await vi.waitFor(() => expect(f.message()).toBeDefined());
    f.agent.stopAgentRun(sessionId);
    await emit({ type: "delta", text: "Late content", messageId: assistantId });
    await generation;
    await vi.waitFor(() => expect(f.agent.hasAgentWorkInFlight()).toBe(false));
    expect(f.message().content).toBe("");
  });

  it("does not apply a stopped turn's delayed canonical reload after a newer run starts", async () => {
    const f = await fixture();
    let finishGet!: (value: ServerConversationDetail) => void;
    f.get.mockImplementationOnce(() => new Promise((resolve) => { finishGet = resolve; }));
    const send = vi.spyOn(f.backend.runs, "chatSend");
    send.mockImplementationOnce(async (_body, emit, signal) => {
      await emit({ type: "event", name: "assistant-started", data: { message: { id: assistantId, createdAt: timestamp } } });
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
    });
    const first = f.agent.runAgentConversation("first", "off");
    await vi.waitFor(() => expect(f.message()).toBeDefined());
    f.agent.stopAgentRun(sessionId); await first;
    await vi.waitFor(() => expect(f.get).toHaveBeenCalledOnce());
    send.mockImplementationOnce(async (_body, _emit, signal) => {
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
    });
    const second = f.agent.runAgentConversation("second", "off");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    f.useAqvenor.setState((state) => ({ sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, title: "Newer turn title" } : session) }));
    finishGet(detail());
    await vi.waitFor(() => expect(f.agent.hasAgentWorkInFlight()).toBe(true));
    await Promise.resolve(); await Promise.resolve();
    expect(f.useAqvenor.getState().resolveSession(sessionId)!.title).toBe("Newer turn title");
    expect(f.useAqvenor.getState().sessionRunnerOf(sessionId).status).toBe("running");
    f.agent.stopAgentRun(sessionId); await second;
    await vi.waitFor(() => expect(f.agent.hasAgentWorkInFlight()).toBe(false));
  });
});
