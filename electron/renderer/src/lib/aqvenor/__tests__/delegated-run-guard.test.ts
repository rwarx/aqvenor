// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Session } from "../types";

const parentId = "10000000-0000-0000-0000-000000000001";
const childId = "10000000-0000-0000-0000-000000000003";
const childUser: Message = { id: "10000000-0000-0000-0000-000000000006", role: "user", content: "Review form", createdAt: 1, toolCalls: [] };
const childAnswer: Message = { id: "10000000-0000-0000-0000-000000000007", role: "assistant", content: "Checking", createdAt: 2, toolCalls: [], streaming: true };
function session(id: string, messages: Message[] = []): Session {
  return { id, mode: "code", title: id, createdAt: 1, updatedAt: 1, preview: "", messages, events: [], goalIds: [], modelId: "test/model" };
}

beforeEach(() => {
  vi.resetModules(); localStorage.clear();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected delegated guard network request")));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture() {
  const { useAqvenor } = await import("../store");
  const sync = await import("../sync");
  vi.spyOn(sync, "isServerMode").mockReturnValue(true);
  useAqvenor.setState({ sessions: [session(parentId), session(childId, [childUser, childAnswer])], currentSessionId: childId, drafts: { [childId]: { text: "Next task", attachments: [] } }, approvals: {}, runningSessions: { [parentId]: { status: "running" } }, delegatedRuns: { [childId]: { parentSessionId: parentId, runId: "parent-run" } }, sessionAliases: {}, workspaceRoot: "D:/Project", backendReachable: true, updateClosing: false, workspaceSwitching: false, ui: { ...useAqvenor.getState().ui, locale: "en", workMode: "code", activeSessionByMode: { code: childId } } });
  return { useAqvenor, sync };
}

async function installServerActions(f: Awaited<ReturnType<typeof fixture>>) {
  const backend = await import("../backend");
  const saved = f.useAqvenor.getState();
  vi.spyOn(backend, "checkBackend").mockResolvedValue(true);
  vi.spyOn(backend.providers, "list").mockResolvedValue([]);
  vi.spyOn(backend.providers, "allModels").mockResolvedValue([]);
  vi.spyOn(backend.settings, "get").mockResolvedValue({});
  vi.spyOn(backend.conversations, "list").mockResolvedValue([]);
  vi.spyOn(backend.checkpoints, "list").mockResolvedValue([]);
  vi.spyOn(backend.projects, "list").mockResolvedValue([]);
  vi.spyOn(backend.workspace, "status").mockResolvedValue({ isOpen: false });
  vi.spyOn(backend.workspace, "list").mockResolvedValue({ path: ".", isTruncated: false, entries: [] });
  vi.spyOn(backend.graph, "snapshot").mockRejectedValue(new Error("No canvas"));
  await f.sync.hydrateFromBackend();
  f.useAqvenor.setState({ sessions: saved.sessions, currentSessionId: saved.currentSessionId, drafts: saved.drafts, runningSessions: saved.runningSessions, delegatedRuns: saved.delegatedRuns, ui: saved.ui });
  const remove = vi.spyOn(backend.conversations, "remove").mockResolvedValue(undefined);
  const cancel = vi.spyOn(backend.runs, "cancel").mockResolvedValue(undefined);
  return { remove, cancel };
}

describe("delegated child ownership", () => {
  it.each([childId, "child-placeholder"])("refuses deleting delegated chat %s before session hooks, preserving its draft and history", async (requestedId) => {
    const f = await fixture();
    const { onSessionDeleted } = await import("../store");
    const hook = vi.fn(); const unsubscribe = onSessionDeleted(hook);
    f.useAqvenor.setState({ sessionAliases: { "child-placeholder": childId } });
    const before = f.useAqvenor.getState();
    try {
      before.deleteSession(requestedId);
      const after = f.useAqvenor.getState();
      expect(after.sessions).toEqual(before.sessions);
      expect(after.drafts).toEqual(before.drafts);
      expect(after.currentSessionId).toBe(childId);
      expect(after.runningSessions).toEqual(before.runningSessions);
      expect(after.delegatedRuns).toEqual(before.delegatedRuns);
      expect(hook).not.toHaveBeenCalled();
      expect(after.toasts.at(-1)?.description).toContain("parent chat");
    } finally { unsubscribe(); }
  });

  it("guards the installed server-backed delete action before HTTP deletion or parent cancellation", async () => {
    const f = await fixture();
    const { remove, cancel } = await installServerActions(f);
    const before = f.useAqvenor.getState();
    before.deleteSession(childId);
    expect(remove).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
    expect(f.useAqvenor.getState().sessions).toEqual(before.sessions);
    expect(f.useAqvenor.getState().draftOf(childId)).toEqual(before.draftOf(childId));
    f.useAqvenor.getState().releaseDelegatedRun("parent-run");
    f.useAqvenor.getState().deleteSession(childId);
    expect(remove).toHaveBeenCalledExactlyOnceWith(childId);
    expect(f.useAqvenor.getState().resolveSession(childId)).toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("disables deleting an owned child in its real Sidebar menu", async () => {
    const f = await fixture();
    const { remove, cancel } = await installServerActions(f);
    const { Sidebar } = await import("../../../components/aqvenor/shell/Sidebar");
    const { translate } = await import("../i18n");
    f.useAqvenor.getState().setUi({ confirmDelete: false, sidebarCollapsed: false });
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(Sidebar)));
      const title = Array.from(host.querySelectorAll("span[title]")).find((span) => span.textContent === childId)!;
      const actions = title.closest("button")!.querySelector<HTMLElement>(`[aria-label="${translate("en", "session.actions")}"]`)!;
      await act(async () => actions.click());
      const button = Array.from(title.closest("button")!.parentElement!.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Delete")!;
      expect(button.disabled).toBe(true);
      await act(async () => button.click());
      expect(remove).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
      expect(f.useAqvenor.getState().resolveSession(childId)?.messages).toEqual([childUser, childAnswer]);
      expect(f.useAqvenor.getState().draftOf(childId).text).toBe("Next task");
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it("rechecks ownership acquired while preparing the canonical session", async () => {
    const f = await fixture();
    f.useAqvenor.setState({ delegatedRuns: {} });
    vi.spyOn(f.sync, "flushPendingWrites").mockResolvedValue(undefined);
    let finishSession!: (id: string) => void;
    vi.spyOn(f.sync, "ensureServerSession").mockImplementationOnce(() => new Promise((resolve) => { finishSession = resolve; }));
    const { runs } = await import("../backend");
    const request = vi.spyOn(runs, "agentRun").mockResolvedValue(undefined);
    const { runAgentConversation } = await import("../agent-live");
    const sending = runAgentConversation("Next task", "build", { sessionId: childId });
    await vi.waitFor(() => expect(finishSession).toBeTypeOf("function"));
    f.useAqvenor.getState().reserveDelegatedSession(parentId, childId, "parent-run");
    finishSession(childId); await sending;
    expect(request).not.toHaveBeenCalled();
    expect(f.useAqvenor.getState().draftOf(childId).text).toBe("Next task");
  });

  it("disables Retry, Regenerate and Delete on a child assistant without inventing a running child", async () => {
    const f = await fixture();
    const { MessageItem } = await import("../../../components/aqvenor/chat/MessageItem");
    const { translate } = await import("../i18n");
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(MessageItem, { message: { ...childAnswer, error: "Child request failed" }, sessionId: childId })));
      for (const key of ["chat.retry", "chat.regenerate", "common.delete"]) {
        expect(host.querySelector<HTMLButtonElement>(`button[aria-label="${translate("en", key)}"]`)?.disabled).toBe(true);
      }
      expect(f.useAqvenor.getState().sessionRunnerOf(childId).status).toBe("idle");
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it("blocks direct sends before backend preparation and preserves the child draft", async () => {
    const f = await fixture();
    const prepare = vi.spyOn(f.sync, "flushPendingWrites").mockResolvedValue(undefined);
    const { runAgentConversation } = await import("../agent-live");
    await runAgentConversation("Next task", "build", { sessionId: childId });
    expect(prepare).not.toHaveBeenCalled();
    expect(f.useAqvenor.getState().draftOf(childId).text).toBe("Next task");
    expect(f.useAqvenor.getState().sessionRunnerOf(childId).status).toBe("idle");
  });

  it("blocks regeneration before deleting canonical messages or truncating their transcript", async () => {
    const f = await fixture();
    const { conversations } = await import("../backend");
    const truncate = vi.spyOn(conversations, "truncateAfter").mockResolvedValue(undefined);
    const remove = vi.spyOn(conversations, "deleteMessage").mockResolvedValue(undefined);
    const { regenerate } = await import("../scenario");
    regenerate(childId);
    expect(f.useAqvenor.getState().resolveSession(childId)?.messages).toEqual([childUser, childAnswer]);
    expect(truncate).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });

  it("blocks a recipe targeting the child before changing its chat or method", async () => {
    const f = await fixture();
    f.useAqvenor.getState().setDraft("", childId);
    const { WORKFLOW_RECIPES, recipeBlockReason, runWorkflowRecipe } = await import("../recipes");
    const recipe = WORKFLOW_RECIPES.find((recipe) => recipe.id === "fix-test")!;
    const before = f.useAqvenor.getState();
    expect(recipeBlockReason(recipe, before)).toBe("busy");
    expect(runWorkflowRecipe(recipe)).toBe(false);
    expect(f.useAqvenor.getState().ui).toEqual(before.ui);
    expect(f.useAqvenor.getState().sessions).toEqual(before.sessions);
  });

  it("keeps child Composer viewable with Send disabled and a return to its real controller", async () => {
    const f = await fixture();
    const { Composer } = await import("../../../components/aqvenor/chat/Composer");
    const { translate } = await import("../i18n");
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => root.render(createElement<{ targetSessionId?: string }>(Composer, { targetSessionId: childId })));
      expect(host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(true);
      expect(host.querySelector('button[aria-label="Stop"]')).toBeNull();
      expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Next task");
      const back = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === translate("en", "agents.delegated.return"));
      expect(back).toBeDefined();
      await act(async () => back!.click());
      expect(f.useAqvenor.getState().currentSessionId).toBe(parentId);
      await act(async () => f.useAqvenor.getState().releaseDelegatedRun("parent-run"));
      expect(host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(false);
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it("resolves pinned aliases and never releases a newer owner's reservation with old cleanup", async () => {
    const f = await fixture();
    const { delegatedOwnerOf } = await import("../delegation");
    f.useAqvenor.setState({ sessionAliases: { "child-placeholder": childId } });
    expect(delegatedOwnerOf(f.useAqvenor.getState(), "child-placeholder")?.parentSessionId).toBe(parentId);
    f.useAqvenor.getState().reserveDelegatedSession(parentId, childId, "new-run");
    f.useAqvenor.getState().releaseDelegatedRun("parent-run");
    expect(delegatedOwnerOf(f.useAqvenor.getState(), childId)?.runId).toBe("new-run");
  });
});
