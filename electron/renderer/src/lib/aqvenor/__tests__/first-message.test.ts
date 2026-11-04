// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversations, runs } from "../backend";
import { ensureServerSession } from "../sync";
import { runAgentConversation, isAgentRunActive } from "../agent-live";
import { useAqvenor } from "../store";

const S = () => useAqvenor.getState();
const id = "10000000-0000-0000-0000-000000000001";
const now = new Date().toISOString();
beforeEach(() => {
  useAqvenor.setState({ sessions: [], sessionAliases: {}, drafts: {}, approvals: {}, runningSessions: {}, mcpServers: [] });
  vi.spyOn(conversations, "create").mockResolvedValue({ id, title: "New Chat", createdAt: now, updatedAt: now, messageCount: 0 });
  vi.spyOn(conversations, "get").mockRejectedValue(new Error("keep streamed transcript"));
});
afterEach(() => vi.restoreAllMocks());

describe("first message from a local chat", () => {
  it("moves the draft and session state once, including a pinned chat alias", async () => {
    const local = S().newSession();
    S().setDraft("question", local);
    S().addDraftAttachment({ id: "file", name: "note.txt", mimeType: "text/plain", sizeKb: 1, textContent: "context" }, local);
    S().setSessionRunner(local, { status: "running" });
    useAqvenor.setState({ focusedChatSessionId: local });
    const result = await Promise.all([ensureServerSession(local), ensureServerSession(local)]);
    expect(result).toEqual([id, id]);
    expect(conversations.create).toHaveBeenCalledTimes(1);
    expect(S().currentSessionId).toBe(id);
    expect(S().focusedChatSessionId).toBe(id);
    expect(S().sessionAliases[local]).toBe(id);
    expect(S().draftOf(id).text).toBe("question");
    expect(S().draftOf(local).attachments[0].id).toBe("file");
    expect(S().runningSessions[local]).toBeUndefined();
    expect(S().runningSessions[id].status).toBe("running");
  });

  it("keeps user and assistant stream events in the visible canonical chat", async () => {
    const local = S().newSession();
    S().addDraftAttachment({ id: "file", name: "note.txt", mimeType: "text/plain", sizeKb: 1, textContent: "context" }, local);
    vi.spyOn(runs, "chatSend").mockImplementation(async (body, emit) => {
      expect(body.conversationId).toBe(id);
      expect(body.attachments?.[0].textContent).toBe("context");
      expect(isAgentRunActive(local)).toBe(true);
      await emit({ type: "event", name: "user-saved", data: { message: { id: "user", content: "hello", createdAt: now } } });
      await emit({ type: "event", name: "assistant-started", data: { message: { id: "answer", createdAt: now } } });
      await emit({ type: "delta", messageId: "answer", text: "reply" });
      await emit({ type: "event", name: "completed", data: {} });
    });
    await runAgentConversation("hello", "off", { sessionId: local });
    expect(S().currentSession()?.messages.map((m) => m.content)).toEqual(["hello", "reply"]);
    expect(S().sessionRunnerOf(id).status).toBe("done");
    expect(S().draftOf(id).attachments).toEqual([]);
    expect(isAgentRunActive(local)).toBe(false);
    expect(conversations.get).toHaveBeenCalledWith(id);
  });
});
