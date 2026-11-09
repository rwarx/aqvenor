// @vitest-environment jsdom
import { act, createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const serverId = "10000000-0000-0000-0000-000000000001";
const secondId = "10000000-0000-0000-0000-000000000002";
const timestamp = "2026-11-06T03:00:00Z";
let mounted: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Every server operation below is intercepted; an omitted mock must fail locally.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request in hydration test")));
  localStorage.clear();
  delete window.aqvenor;
});

afterEach(async () => {
  if (mounted) await act(async () => mounted!.unmount());
  mounted = undefined;
  container?.remove();
  container = undefined;
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock("@/components/aqvenor/shell/DockWorkspace");
  vi.doUnmock("@/lib/aqvenor/project-files");
  delete window.aqvenor;
});

async function fixture() {
  const backend = await import("../backend");
  const { useAqvenor } = await import("../store");
  const sync = await import("../sync");
  await Promise.resolve();
  const summary = { id: serverId, title: "Saved chat", createdAt: timestamp, updatedAt: timestamp, messageCount: 0 };
  const health = vi.spyOn(backend, "checkBackend").mockImplementation(async () => {
    useAqvenor.getState().setBackendReachable(true);
    return true;
  });
  const providerList = vi.spyOn(backend.providers, "list").mockResolvedValue([]);
  vi.spyOn(backend.providers, "allModels").mockResolvedValue([]);
  vi.spyOn(backend.settings, "get").mockResolvedValue({});
  const conversationList = vi.spyOn(backend.conversations, "list").mockResolvedValue([summary]);
  const transcript = vi.spyOn(backend.conversations, "get").mockResolvedValue({ ...summary, messages: [] });
  vi.spyOn(backend.checkpoints, "list").mockResolvedValue([]);
  vi.spyOn(backend.projects, "list").mockResolvedValue([]);
  vi.spyOn(backend.graph, "snapshot").mockRejectedValue(new Error("No persisted canvas"));
  const workspaceStatus = vi.spyOn(backend.workspace, "status").mockResolvedValue({ isOpen: false });
  const workspaceList = vi.spyOn(backend.workspace, "list").mockResolvedValue({ path: ".", isTruncated: false, entries: [] });
  const workspaceWrite = vi.spyOn(backend.workspace, "write").mockResolvedValue({ created: false, linesAfter: 1 });
  return { backend, sync, useAqvenor, health, providerList, conversationList, transcript, workspaceStatus, workspaceList, workspaceWrite };
}

async function mountApp() {
  // Keep the actual application shell and two real ChatViews/Composers mounted;
  // replace only the dock engine, which requires Chromium layout observers.
  vi.doMock("@/components/aqvenor/shell/DockWorkspace", async () => {
    const { ChatView } = await import("../../../components/aqvenor/chat/ChatView");
    const ChatPanel: ComponentType<{ sessionId?: string }> = ChatView;
    return {
      DOCK_SURFACE_MIME: "application/x-aqvenor-surface",
      DockWorkspace: () => createElement("div", { "data-testid": "two-chat-panels" },
        createElement(ChatPanel, { sessionId: serverId }),
        createElement(ChatPanel, { sessionId: secondId }),
      ),
    };
  });
  vi.doMock("@/lib/aqvenor/project-files", () => ({ initProjectFileSync: () => () => {} }));
  const { AqvenorApp } = await import("../../../components/aqvenor/AqvenorApp");
  container = document.createElement("div");
  document.body.appendChild(container);
  mounted = createRoot(container);
  await act(async () => mounted!.render(createElement(AqvenorApp)));
  return container;
}

describe("retryable backend hydration", () => {
  it("shows an empty server's blank composer without sample chats or files when no workspace is open", async () => {
    const f = await fixture();
    f.conversationList.mockResolvedValue([]);
    expect(f.useAqvenor.getState().sessions.map((session) => session.id)).toEqual(["seed-1", "seed-2", "current"]);
    expect(f.useAqvenor.getState().files.length).toBeGreaterThan(0);

    expect(await f.sync.hydrateFromBackend()).toEqual({ ok: true, sessions: 0, providers: 0 });
    await f.sync.syncWorkspaceFiles();
    const state = f.useAqvenor.getState();
    expect(state.sessions.map((session) => session.id)).toEqual(["current"]);
    expect(state.sessions[0].messages).toEqual([]);
    expect(state.currentSessionId).toBe("current");
    expect(state.workspaceRoot).toBeNull();
    expect(state.files).toEqual([]);
    expect(f.workspaceList).not.toHaveBeenCalled();
  });

  it("retains genuine offline history, composer drafts and edited documents during server hydration", async () => {
    const f = await fixture();
    f.conversationList.mockResolvedValue([]);
    const localId = f.useAqvenor.getState().newSession();
    f.useAqvenor.setState((state) => ({
      sessions: state.sessions.map((session) => session.id === localId ? {
        ...session, title: "Landing page draft", messages: [{
          id: "my-offline-message", role: "user", content: "Build a coffee landing page", createdAt: 1, toolCalls: [],
        }],
      } : session),
      drafts: { [localId]: { text: "Use a warm ivory palette", attachments: [] } },
      files: [...state.files, { path: "landing.html", language: "text", content: "<h1>My own draft</h1>", loadState: "loaded", revision: 1 }],
      codeTabs: ["README.md", "landing.html"], activeCodeTab: "README.md",
    }));
    const localSession = f.useAqvenor.getState().sessions.find((session) => session.id === localId)!;
    const draft = f.useAqvenor.getState().drafts[localId];
    const localFile = f.useAqvenor.getState().files.find((file) => file.path === "landing.html")!;

    await f.sync.hydrateFromBackend();
    await f.sync.syncWorkspaceFiles();
    const state = f.useAqvenor.getState();
    expect(state.sessions.find((session) => session.id === localId)).toEqual(localSession);
    expect(state.currentSessionId).toBe(localId);
    expect(state.drafts[localId]).toEqual(draft);
    expect(state.files).toEqual([localFile]);
    expect(state.codeTabs).toEqual(["landing.html"]);
    expect(state.activeCodeTab).toBe("landing.html");
    expect(state.sessions.some((session) => session.id.startsWith("seed-"))).toBe(false);
  });

  it("preserves a sample conversation or document that the person has turned into their own draft", async () => {
    const f = await fixture();
    f.conversationList.mockResolvedValue([]);
    f.useAqvenor.setState((state) => ({
      currentSessionId: "seed-1",
      drafts: { "seed-1": { text: "Apply this to my own project", attachments: [] } },
      sessions: state.sessions.map((session) => session.id === "seed-2" ? {
        ...session, messages: [...session.messages, {
          id: "my-followup", role: "user", content: "Now explain my own architecture", createdAt: 1, toolCalls: [],
        }],
      } : session),
    }));
    f.useAqvenor.getState().setFileContent("README.md", "# My own landing project");
    const sessions = f.useAqvenor.getState().sessions;
    const ownFile = f.useAqvenor.getState().files.find((file) => file.path === "README.md")!;

    await f.sync.hydrateFromBackend();
    await f.sync.syncWorkspaceFiles();
    expect(f.useAqvenor.getState().sessions).toEqual(expect.arrayContaining(sessions));
    expect(f.useAqvenor.getState().drafts["seed-1"].text).toBe("Apply this to my own project");
    expect(f.useAqvenor.getState().currentSessionId).toBe("seed-1");
    expect(f.useAqvenor.getState().files).toEqual([ownFile]);
  });

  it("removes unchanged samples restored from the older metadata cache and repairs their selected chat", async () => {
    const f = await fixture();
    f.conversationList.mockResolvedValue([]);
    f.useAqvenor.setState((state) => ({
      currentSessionId: "seed-2",
      ui: { ...state.ui, activeSessionByMode: { chat: "seed-2" } },
      sessions: state.sessions.map((session) => ({ ...session, createdAt: 1, updatedAt: 2,
        messages: session.messages.map((message) => ({ ...message, createdAt: 1 })),
      })),
      files: state.files.map((file) => {
        const { content: _body, ...metadata } = file;
        return metadata as typeof file;
      }),
    }));

    await f.sync.hydrateFromBackend();
    await f.sync.syncWorkspaceFiles();
    const state = f.useAqvenor.getState();
    expect(state.sessions.map((session) => session.id)).toEqual(["current"]);
    expect(state.currentSessionId).toBe("current");
    expect(state.ui.activeSessionByMode.chat).toBe("current");
    expect(state.files).toEqual([]);
  });

  it("preserves a genuine legacy README metadata entry and its tab and context", async () => {
    const f = await fixture();
    f.conversationList.mockResolvedValue([]);
    // Older real workspace caches omitted bodies and ownership, but explicitly
    // recorded modified:false. An unchanged bundled sample has no such field.
    const ownReadme = { path: "README.md", language: "markdown" as const, modified: false };
    const context = { path: "README.md", tokens: 42, reason: "pinned" as const };
    f.useAqvenor.setState((state) => ({
      files: state.files.map((file) => {
        if (file.path === "README.md") return ownReadme as typeof file;
        const { content: _body, ...metadata } = file;
        return metadata as typeof file;
      }),
      codeTabs: ["README.md"], activeCodeTab: "README.md", contextFiles: [context],
    }));

    await f.sync.hydrateFromBackend();
    await f.sync.syncWorkspaceFiles();
    const state = f.useAqvenor.getState();
    expect(state.files).toEqual([ownReadme]);
    expect(state.codeTabs).toEqual(["README.md"]);
    expect(state.activeCodeTab).toBe("README.md");
    expect(state.contextFiles).toEqual([context]);
  });

  it("opens a fresh blank composer when the removed sample was the only chat in this mode", async () => {
    const f = await fixture();
    f.conversationList.mockResolvedValue([]);
    f.useAqvenor.setState((state) => ({
      sessions: state.sessions.filter((session) => session.id !== "current"), currentSessionId: "seed-1",
    }));
    await f.sync.hydrateFromBackend();
    const state = f.useAqvenor.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({ id: state.currentSessionId, title: "New chat", messages: [], mode: "chat" });
    expect(state.currentSessionId.startsWith("seed-")).toBe(false);
  });

  it("shares startup hydration and installs each server action only once", async () => {
    const f = await fixture();
    let answer!: (ok: boolean) => void;
    f.health.mockReturnValueOnce(new Promise<boolean>((resolve) => { answer = resolve; }));
    const first = f.sync.hydrateFromBackend();
    const second = f.sync.hydrateFromBackend();
    expect(f.health).toHaveBeenCalledTimes(1);
    answer(true);
    expect(await Promise.all([first, second])).toEqual([
      { ok: true, sessions: 1, providers: 0 },
      { ok: true, sessions: 1, providers: 0 },
    ]);
    expect(f.providerList).toHaveBeenCalledTimes(1);
    expect(f.conversationList).toHaveBeenCalledTimes(1);
    const select = f.useAqvenor.getState().selectSession;
    const edit = f.useAqvenor.getState().setFileContent;
    expect((await f.sync.hydrateFromBackend()).ok).toBe(true);
    expect(f.useAqvenor.getState().selectSession).toBe(select);
    expect(f.useAqvenor.getState().setFileContent).toBe(edit);
    f.useAqvenor.getState().selectSession(serverId);
    await Promise.resolve();
    expect(f.transcript).toHaveBeenCalledExactlyOnceWith(serverId);
    expect(f.health).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries after all cold-start health attempts failed", async () => {
    const f = await fixture();
    f.health.mockResolvedValue(false);
    const initial = f.sync.hydrateFromBackend();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(await initial).toEqual({ ok: false, sessions: 0, providers: 0 });
    expect(f.health).toHaveBeenCalledTimes(5);
    expect(f.sync.isServerMode()).toBe(false);
    expect(f.providerList).not.toHaveBeenCalled();

    f.health.mockResolvedValue(true);
    expect(await f.sync.hydrateFromBackend()).toEqual({ ok: true, sessions: 1, providers: 0 });
    expect(f.sync.isServerMode()).toBe(true);
    expect(f.providerList).toHaveBeenCalledTimes(1);
    expect(f.conversationList).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clears a rejected hydration so the next attempt can install working server actions", async () => {
    const f = await fixture();
    f.providerList.mockRejectedValueOnce(new Error("Sidecar stopped during provider load"));
    await expect(f.sync.hydrateFromBackend()).rejects.toThrow("Sidecar stopped");
    expect(f.sync.isServerMode()).toBe(false);
    expect((await f.sync.hydrateFromBackend()).ok).toBe(true);
    f.useAqvenor.getState().selectSession(serverId);
    await Promise.resolve();
    expect(f.transcript).toHaveBeenCalledExactlyOnceWith(serverId);
    expect(f.providerList).toHaveBeenCalledTimes(2);
    expect(f.conversationList).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("global backend connection UI", () => {
  it("keeps both chat drafts and dirty files intact across exit and manual retry, with one global banner", async () => {
    const f = await fixture();
    let sidecarExit!: (code: number | null) => void;
    const unsubscribe = vi.fn();
    Object.defineProperty(window, "aqvenor", { configurable: true, value: {
      onSidecarGone: vi.fn((callback: typeof sidecarExit) => { sidecarExit = callback; return unsubscribe; }),
      view: { setZoom: vi.fn() },
      win: { isMaximized: vi.fn().mockResolvedValue(false), onMaximizedChanged: vi.fn(() => () => {}) },
    } });
    f.workspaceStatus.mockResolvedValue({ isOpen: true, root: "D:\\project" });
    f.workspaceList.mockResolvedValue({ path: ".", isTruncated: false, entries: [
      { path: "draft.txt", name: "draft.txt", isDirectory: false, size: 8, modifiedAt: timestamp },
    ] });
    f.useAqvenor.setState({ workspaceRoot: "D:\\project" });
    await f.sync.hydrateFromBackend();
    await vi.dynamicImportSettled();
    const state = f.useAqvenor.getState();
    f.useAqvenor.setState({
      hydrated: true,
      currentSessionId: serverId,
      sessions: [...state.sessions, { ...state.sessions[0], id: secondId, title: "Second chat" }],
      drafts: { [serverId]: { text: "unsent first question", attachments: [] }, [secondId]: { text: "unsent second question", attachments: [] } },
      files: [{ path: "draft.txt", language: "text", content: "my unsaved document", loadState: "loaded", workspaceRoot: "D:\\project", revision: 7 }],
      workspaceRoot: "D:\\project",
      codeTabs: ["draft.txt"], activeCodeTab: "draft.txt", saveStatus: { "draft.txt": "unsaved" },
      ui: { ...state.ui, modeChosen: true, workMode: "chat", theme: "dark", locale: "en", appZoom: 1 },
    });
    const drafts = f.useAqvenor.getState().drafts;
    const files = f.useAqvenor.getState().files;
    const app = await mountApp();
    const composers = () => [...app.querySelectorAll<HTMLTextAreaElement>("textarea")].map((textarea) => textarea.value);
    expect(composers()).toEqual(["unsent first question", "unsent second question"]);
    expect(app.querySelectorAll('[role="alert"]')).toHaveLength(0);

    await act(async () => { sidecarExit(1); await vi.dynamicImportSettled(); });
    expect(app.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(f.useAqvenor.getState().backendReachable).toBe(false);
    const retry = app.querySelector<HTMLButtonElement>('[role="alert"] button')!;
    await act(async () => { retry.click(); await vi.dynamicImportSettled(); });
    expect(app.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(composers()).toEqual(["unsent first question", "unsent second question"]);
    expect(f.useAqvenor.getState().drafts).toEqual(drafts);
    expect(f.useAqvenor.getState().files).toEqual(files);
    expect(f.useAqvenor.getState().saveStatus).toEqual({ "draft.txt": "unsaved" });
    expect(f.useAqvenor.getState().codeTabs).toEqual(["draft.txt"]);
    expect(f.workspaceWrite).not.toHaveBeenCalled();
    expect(f.providerList).toHaveBeenCalledTimes(1);
    await act(async () => mounted!.unmount());
    mounted = undefined;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("automatically hydrates when a later desktop poll succeeds after failed startup", async () => {
    const f = await fixture();
    f.health.mockImplementation(async () => { f.useAqvenor.getState().setBackendReachable(false); return false; });
    const initial = f.sync.hydrateFromBackend();
    await vi.advanceTimersByTimeAsync(14_000);
    expect((await initial).ok).toBe(false);
    Object.defineProperty(window, "aqvenor", { configurable: true, value: { onSidecarGone: vi.fn(() => () => {}) } });
    const { BackendConnectionBanner } = await import("../../../components/aqvenor/shell/BackendConnectionBanner");
    container = document.createElement("div");
    document.body.appendChild(container);
    mounted = createRoot(container);
    await act(async () => mounted!.render(createElement(BackendConnectionBanner)));
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);

    f.health.mockImplementation(async () => { f.useAqvenor.getState().setBackendReachable(true); return true; });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(f.sync.isServerMode()).toBe(true);
    expect(f.providerList).toHaveBeenCalledTimes(1);
    expect(f.conversationList).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
