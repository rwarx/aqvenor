// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runs } from "../backend";
import { ensureServerSession, flushPendingWrites, syncWorkspaceFiles } from "../sync";
import { hasAgentWorkInFlight, isAgentRunActive, runAgentConversation, stopAgentRun } from "../agent-live";
import { initProjectFileSync } from "../project-files";
import { sendMessage, regenerate } from "../scenario";
import { useAqvenor } from "../store";

vi.mock("../sync", () => ({
  ensureServerSession: vi.fn(), flushPendingWrites: vi.fn(),
  isServerId: () => true, isServerMode: () => false,
  refreshCanvasAfterPlan: vi.fn(), refreshCanvasAfterRun: vi.fn(),
  refreshOpenTabs: vi.fn(), reloadSession: vi.fn(), syncCanvas: vi.fn(), syncWorkspaceFiles: vi.fn(),
}));

const id = "10000000-0000-0000-0000-000000000001";
const S = () => useAqvenor.getState();
let cleanup: (() => void) | undefined;
beforeEach(() => {
  useAqvenor.setState({ sessions: [], drafts: {}, approvals: {}, runningSessions: {}, mcpServers: [], updateClosing: false });
  const local = S().newSession();
  S().setDraft("Keep this question", local);
  S().setUi({ locale: "en" });
  S().addDraftAttachment({ id: "file", name: "note.txt", mimeType: "text/plain", sizeKb: 1, textContent: "context" }, local);
  vi.mocked(flushPendingWrites).mockResolvedValue(undefined);
  vi.mocked(ensureServerSession).mockResolvedValue(id);
  vi.spyOn(runs, "chatSend").mockResolvedValue(undefined);
});
afterEach(() => { cleanup?.(); cleanup = undefined; delete window.aqvenor; useAqvenor.setState({ updateClosing: false }); vi.restoreAllMocks(); vi.clearAllMocks(); });

function closeBridge() {
  let close!: (request: string, forUpdate?: boolean) => void;
  const finishClose = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "aqvenor", { configurable: true, value: {
    onPrepareClose: (callback: typeof close) => { close = callback; return vi.fn(); }, finishClose,
  } });
  cleanup = initProjectFileSync();
  return { close: () => close("work-in-flight-update", true), finishClose };
}

describe("generation during an update restart", () => {
  it("refuses new sends before touching the draft or backend", async () => {
    useAqvenor.setState({ updateClosing: true });
    await runAgentConversation("Keep this question", "off");
    expect(flushPendingWrites).not.toHaveBeenCalled();
    expect(ensureServerSession).not.toHaveBeenCalled();
    expect(runs.chatSend).not.toHaveBeenCalled();
    expect(S().draftOf(S().currentSessionId)).toMatchObject({ text: "Keep this question", attachments: [{ id: "file" }] });
    expect(isAgentRunActive()).toBe(false);
  });

  it.each(["flush", "session"] as const)("refuses a send that resumes after an update starts during %s preparation", async (phase) => {
    let resume!: () => void;
    if (phase === "flush") {
      vi.mocked(flushPendingWrites).mockReturnValueOnce(new Promise<void>((resolve) => { resume = resolve; }));
    } else {
      vi.mocked(ensureServerSession).mockReturnValueOnce(new Promise<string>((resolve) => { resume = () => resolve(id); }));
    }
    const generation = runAgentConversation("Keep this question", "off");
    await vi.waitFor(() => expect(phase === "flush" ? flushPendingWrites : ensureServerSession).toHaveBeenCalledOnce());
    useAqvenor.setState({ updateClosing: true });
    resume();
    await generation;
    expect(runs.chatSend).not.toHaveBeenCalled();
    expect(S().runningSessions).toEqual({});
    expect(S().draftOf(S().currentSessionId)).toMatchObject({ text: "Keep this question", attachments: [{ id: "file" }] });
    expect(isAgentRunActive()).toBe(false);
  });

  it("keeps offline sends and retries from mutating the transcript during restart", () => {
    S().addMessage({ id: "user", role: "user", content: "hello", createdAt: Date.now(), toolCalls: [] });
    S().addMessage({ id: "assistant", role: "assistant", content: "reply", createdAt: Date.now(), toolCalls: [] });
    const messages = S().currentSession()!.messages;
    useAqvenor.setState({ updateClosing: true });
    sendMessage("run demo");
    regenerate();
    expect(S().currentSession()!.messages).toEqual(messages);
    expect(S().draftOf(S().currentSessionId).text).toBe("Keep this question");
    expect(S().runningSessions).toEqual({});
  });

  it("refuses an update while a completed run is still refreshing its files and graph", async () => {
    let refreshed!: () => void;
    vi.mocked(syncWorkspaceFiles).mockReturnValueOnce(new Promise<void>((resolve) => { refreshed = resolve; }));
    vi.mocked(runs.chatSend).mockImplementationOnce(async (_body, emit) => {
      await emit({ type: "event", name: "completed", data: {} });
    });
    const generation = runAgentConversation("hello", "off");
    await vi.waitFor(() => expect(syncWorkspaceFiles).toHaveBeenCalled());
    expect(S().sessionRunnerOf(id).status).toBe("done");
    const { close, finishClose } = closeBridge();
    close();
    try {
      await vi.waitFor(() => expect(finishClose).toHaveBeenCalledExactlyOnceWith("work-in-flight-update", false));
      expect(hasAgentWorkInFlight()).toBe(true);
    } finally { refreshed(); await generation; }
    expect(hasAgentWorkInFlight()).toBe(false);
  });

  it.each(["off", "build"] as const)("allows an update after Stop during %s memory preparation even when cancellation would fail", async (mode) => {
    const mcp = await import("../mcp");
    let finishMemory!: (value: null) => void;
    const memory = vi.spyOn(mcp, "memoryContextFor").mockReturnValueOnce(new Promise((resolve) => { finishMemory = resolve; }));
    const cancel = vi.spyOn(runs, "cancel").mockRejectedValue(new Error("cancel connection lost"));
    const agentRun = vi.spyOn(runs, "agentRun").mockResolvedValue(undefined);
    const generation = runAgentConversation("hello", mode);
    await vi.waitFor(() => expect(memory).toHaveBeenCalledOnce());
    stopAgentRun(id);
    finishMemory(null);
    await generation;
    expect(runs.chatSend).not.toHaveBeenCalled();
    expect(agentRun).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(isAgentRunActive()).toBe(false);
    expect(hasAgentWorkInFlight()).toBe(false);
    const { close, finishClose } = closeBridge();
    close();
    await vi.waitFor(() => expect(finishClose).toHaveBeenCalledExactlyOnceWith("work-in-flight-update", true));
  });

  it.each(["resolved", "rejected"] as const)("refuses an update until stopped-run cancellation is %s and contains its errors", async (outcome) => {
    vi.mocked(runs.chatSend).mockImplementationOnce((_body, _emit, signal) => new Promise<void>((resolve) => {
      signal!.addEventListener("abort", () => resolve(), { once: true });
    }));
    let settleCancel!: () => void;
    vi.spyOn(runs, "cancel").mockReturnValueOnce(new Promise<void>((resolve, reject) => {
      settleCancel = outcome === "resolved" ? () => resolve() : () => reject(new Error("cancel connection lost"));
    }));
    const generation = runAgentConversation("hello", "off");
    await vi.waitFor(() => expect(runs.chatSend).toHaveBeenCalledOnce());
    stopAgentRun(id);
    await generation;
    expect(isAgentRunActive()).toBe(false);
    expect(S().runningSessions).toEqual({});
    const { close, finishClose } = closeBridge();
    close();
    await vi.waitFor(() => expect(finishClose).toHaveBeenCalledExactlyOnceWith("work-in-flight-update", false));
    expect(hasAgentWorkInFlight()).toBe(true);
    settleCancel();
    if (outcome === "rejected") {
      await expect(vi.mocked(runs.cancel).mock.results[0].value).rejects.toThrow("cancel connection lost");
      await Promise.resolve();
      expect(hasAgentWorkInFlight()).toBe(true);
      vi.mocked(runs.cancel).mockRejectedValueOnce(new Error("still offline"));
      finishClose.mockClear();
      close();
      await vi.waitFor(() => expect(finishClose).toHaveBeenCalledExactlyOnceWith("work-in-flight-update", false));
      expect(hasAgentWorkInFlight()).toBe(true);
      expect(S().toasts.at(-1)?.description).toContain("Could not confirm that server tasks stopped");
      vi.mocked(runs.cancel).mockResolvedValueOnce(undefined);
      finishClose.mockClear();
      close();
      await vi.waitFor(() => expect(finishClose).toHaveBeenCalledExactlyOnceWith("work-in-flight-update", true));
      expect(runs.cancel).toHaveBeenCalledTimes(3);
      expect(hasAgentWorkInFlight()).toBe(false);
    } else {
      await vi.waitFor(() => expect(hasAgentWorkInFlight()).toBe(false));
    }
    expect(S().updateClosing).toBe(outcome === "rejected");
  });
});
