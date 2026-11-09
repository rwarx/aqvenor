// @vitest-environment jsdom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorkflowsView from "../../../components/aqvenor/workspace/WorkflowsView";
import { raw, translate } from "../i18n";
import { sendMessage } from "../scenario";
import { isServerMode } from "../sync";
import { engineModeFor, useAqvenor } from "../store";
import { WORKFLOW_RECIPES, recipeBlockReason, recipeControls, recipeTarget, runWorkflowRecipe } from "../recipes";
import type { Locale, Project, Session, WorkMode } from "../types";

vi.mock("../scenario", () => ({ sendMessage: vi.fn() }));
vi.mock("../sync", () => ({ isServerMode: vi.fn() }));

const S = () => useAqvenor.getState();
const fix = WORKFLOW_RECIPES.find((r) => r.id === "fix-test")!;
const readme = WORKFLOW_RECIPES.find((r) => r.id === "draft-readme")!;
const workspaceRoot = "D:\\Projects\\Текущий проект";

function session(id: string, mode: WorkMode, extra: Partial<Session> = {}): Session {
  return {
    id, mode, title: id, createdAt: 1, updatedAt: 1, preview: "",
    messages: [], events: [], goalIds: [], modelId: "test/model", ...extra,
  };
}

function project(workspacePath: string): Project {
  return {
    id: "project", name: "Project", workspacePath, expanded: true, sortOrder: 0,
    conversationCount: 1, lastActivityAt: 1, createdAt: 1, updatedAt: 1, mode: "code",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isServerMode).mockReturnValue(true);
  useAqvenor.setState({
    sessions: [session("chat", "chat"), session("code", "code"), session("cowork", "cowork")],
    currentSessionId: "chat", sessionAliases: {}, drafts: {}, projects: [], approvals: {},
    runningSessions: {}, runner: { status: "idle" }, backendReachable: true, workspaceRoot,
    toasts: [], surface: "workflows", updateClosing: false, workspaceSwitching: false,
    ui: { ...S().ui, workflowBriefs: {}, selectedWorkflow: "fix-test", locale: "en", workMode: "chat", workMethod: "full", agentMode: "off", activeSessionByMode: { code: "code", cowork: "cowork" } },
  });
});

describe("workflow dispatch", () => {
  it("sends an edited task exactly once with the current workspace context", () => {
    expect(runWorkflowRecipe(fix, { brief: "Проверь только форму заказа." })).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining("Проверь только форму заказа."), { sessionId: "code" });
    expect(vi.mocked(sendMessage).mock.calls[0][0]).toContain(workspaceRoot);
  });

  it("refuses an empty brief or unavailable delegated tool without changing the destination", () => {
    const delegated = WORKFLOW_RECIPES.find((r) => r.id === "delegate-review")!;
    expect(runWorkflowRecipe(fix, { brief: "  " })).toBe(false);
    expect(runWorkflowRecipe(delegated, { availableTools: [] })).toBe(false);
    expect(S().surface).toBe("workflows");
    expect(S().currentSessionId).toBe("chat");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(runWorkflowRecipe(delegated, { availableTools: ["delegate_task"] })).toBe(true);
  });
  it("opens the Code chat for a build recipe and asks before changes", () => {
    expect(runWorkflowRecipe(fix)).toBe(true);
    expect(S().ui.workMode).toBe("code");
    expect(S().ui.workMethod).toBe("ask");
    expect(S().ui.agentMode).toBe("build");
    expect(S().resolveSession("code")?.method).toBe("ask");
    expect(S().resolveSession("chat")?.method).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledWith(translate("en", fix.promptKey, workspaceRoot), { sessionId: "code" });
    expect(S().currentSessionId).toBe("code");
    expect(S().surface).toBe("chat");
    expect(S().toasts.at(-1)?.description).toContain("Code · Ask before changes");
  });

  it.each(WORKFLOW_RECIPES.filter((r) => r.mode === "plan"))("runs $id in Cowork / Plan", (recipe) => {
    expect(runWorkflowRecipe(recipe, { availableTools: ["delegate_task"] })).toBe(true);
    expect(S().ui.workMode).toBe("cowork");
    expect(S().ui.workMethod).toBe("plan");
    expect(S().resolveSession("cowork")?.method).toBe("plan");
    expect(sendMessage).toHaveBeenCalledWith(translate("en", recipe.promptKey, workspaceRoot), { sessionId: "cowork" });
  });

  it("creates a correctly tagged chat when the recipe's mode has none", () => {
    useAqvenor.setState({ sessions: [session("chat", "chat")] });
    expect(recipeTarget(fix, S())).toBeUndefined();
    expect(runWorkflowRecipe(fix)).toBe(true);
    expect(S().currentSession()?.mode).toBe("code");
    expect(S().currentSession()?.method).toBe("ask");
    expect(sendMessage).toHaveBeenCalledWith(expect.any(String), { sessionId: S().currentSessionId });
  });

  it("predicts the same remembered, pinned or recent chat as the mode switch", () => {
    useAqvenor.setState({ sessions: [session("chat", "chat"), session("code", "code"), session("recent", "code", { updatedAt: 5 }), session("pinned", "code", { pinned: true })] });
    expect(recipeTarget(fix, S())?.id).toBe("code");
    S().setUi({ activeSessionByMode: { code: "missing" } });
    expect(recipeTarget(fix, S())?.id).toBe("pinned");
    expect(runWorkflowRecipe(fix)).toBe(true);
    expect(S().currentSessionId).toBe("pinned");
  });

  it("allows an independent recipe chat while another chat runs", () => {
    S().setSessionRunner("cowork", { status: "running" });
    expect(recipeBlockReason(fix, S())).toBeNull();
    expect(recipeBlockReason(readme, S())).toBe("busy");
    expect(runWorkflowRecipe(fix)).toBe(true);
    expect(S().sessionRunnerOf("cowork").status).toBe("running");
  });

  it.each(["running", "awaiting-approval"] as const)("refuses a %s target before changing modes or its method", (status) => {
    S().setSessionRunner("code", { status });
    const before = S();
    expect(runWorkflowRecipe(fix)).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(S().ui).toEqual(before.ui);
    expect(S().sessions).toEqual(before.sessions);
    expect(S().currentSessionId).toBe(before.currentSessionId);
    expect(S().surface).toBe("workflows");
  });

  it("rechecks a newly busy target at click time", () => {
    expect(recipeBlockReason(fix, S())).toBeNull();
    S().setSessionRunner("code", { status: "running" });
    expect(runWorkflowRecipe(fix)).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("recipe safeguards", () => {
  it("shows one editable task and no demo skills in the live workflow page", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      flushSync(() => root.render(createElement(WorkflowsView)));
      expect(container.querySelector('textarea[aria-label="Task brief"]')).not.toBeNull();
      expect(container.querySelectorAll("button[data-workflow-id]")).toHaveLength(WORKFLOW_RECIPES.length);
      expect(container.textContent).not.toContain("Skills library");
      expect(container.querySelector('[role="switch"]')).toBeNull();
    } finally { flushSync(() => root.unmount()); }
  });

  it("preserves each edited brief when selecting another recipe or locale", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      flushSync(() => root.render(createElement(WorkflowsView)));
      const edit = container.querySelector<HTMLTextAreaElement>("textarea")!;
      flushSync(() => {
        edit.value = "Only check the coffee form";
        edit.dispatchEvent(new Event("input", { bubbles: true }));
      });
      flushSync(() => container.querySelector<HTMLButtonElement>('[data-workflow-id="draft-readme"]')!.click());
      expect(container.querySelector("textarea")?.value).not.toBe("Only check the coffee form");
      flushSync(() => container.querySelector<HTMLButtonElement>('[data-workflow-id="fix-test"]')!.click());
      expect(container.querySelector("textarea")?.value).toBe("Only check the coffee form");
      flushSync(() => S().setUi({ locale: "ru" }));
      expect(container.querySelector("textarea")?.value).toBe("Only check the coffee form");
    } finally { flushSync(() => root.unmount()); container.remove(); }
  });
  it.each(["updateClosing", "workspaceSwitching"] as const)("does not announce a launch while %s", (flag) => {
    useAqvenor.setState({ [flag]: true });
    const before = S();
    expect(runWorkflowRecipe(fix)).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(S().ui).toEqual(before.ui);
    expect(S().sessions).toEqual(before.sessions);
    expect(S().surface).toBe("workflows");
    expect(S().toasts.at(-1)?.variant).toBe("destructive");
  });

  it("requires a backend even when demo files are available", () => {
    vi.mocked(isServerMode).mockReturnValue(false);
    expect(runWorkflowRecipe(fix)).toBe(false);
    expect(S().toasts.at(-1)?.title).toBe("Agent unavailable");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("refuses a disconnected backend after server mode was initialized", () => {
    useAqvenor.setState({ backendReachable: false });
    expect(recipeBlockReason(fix, S())).toBe("offline");
    expect(runWorkflowRecipe(fix)).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([null, "", "   "])("requires a real workspace root (%s)", (root) => {
    useAqvenor.setState({ workspaceRoot: root });
    expect(recipeBlockReason(fix, S())).toBe("workspace");
    expect(runWorkflowRecipe(fix)).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("preserves another chat's draft and attachment tray", () => {
    S().setDraft("Keep this question", "code");
    S().addDraftAttachment({ id: "file", name: "note.txt", mimeType: "text/plain", sizeKb: 1, textContent: "keep" }, "code");
    const draft = S().draftOf("code");
    expect(runWorkflowRecipe(fix)).toBe(false);
    expect(S().draftOf("code")).toEqual(draft);
    expect(sendMessage).not.toHaveBeenCalled();
    S().setDraft("", "code");
    expect(recipeBlockReason(fix, S())).toBe("draft");
    S().clearDraftAttachments("code");
    expect(recipeBlockReason(fix, S())).toBeNull();
  });

  it("blocks a remembered chat filed under another workspace", () => {
    useAqvenor.setState({ projects: [project("D:\\OtherProject")], sessions: S().sessions.map((s) => s.id === "code" ? { ...s, projectId: "project" } : s) });
    expect(recipeBlockReason(fix, S())).toBe("workspaceMismatch");
    expect(runWorkflowRecipe(fix)).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    useAqvenor.setState({ projects: [project("d:/projects/ТЕКУЩИЙ ПРОЕКТ/")] });
    expect(recipeBlockReason(fix, S())).toBeNull();
  });

  it("blocks the selected workflow whose destination chat is busy", () => {
    S().setSessionRunner("code", { status: "running" });
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      flushSync(() => root.render(createElement(WorkflowsView)));
      const buttons = [...container.querySelectorAll<HTMLButtonElement>("button[data-workflow-run]")];
      expect(buttons.map((button) => button.disabled)).toEqual([true]);
      expect(buttons[0].getAttribute("aria-describedby")).toBe("recipe-fix-test-blocked");
      expect(container.querySelector("#recipe-fix-test-blocked")?.textContent).toContain("this recipe's chat");
    } finally {
      flushSync(() => root.unmount());
    }
  });
});

describe("recipe locale contracts", () => {
  it.each(["en", "ru", "de"] as Locale[])("uses the current workspace and translated prompts in %s", (locale) => {
    S().setUi({ locale });
    for (const recipe of WORKFLOW_RECIPES) {
      expect(raw[locale][recipe.promptKey]).toBeTruthy();
      const prompt = translate(locale, recipe.promptKey, workspaceRoot);
      expect(prompt).toContain(workspaceRoot);
      expect(prompt).not.toMatch(/AuthFlow|TokenService|\{0\}/);
      expect(engineModeFor(recipeControls(recipe).workMode, recipeControls(recipe).workMethod)).toBe(recipe.mode);
    }
    expect(runWorkflowRecipe(readme)).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(translate(locale, readme.promptKey, workspaceRoot), { sessionId: "cowork" });
    for (const reason of ["busy", "offline", "workspace", "draft", "workspaceMismatch"]) {
      expect(raw[locale][`workflows.${reason}.title`]).toBeTruthy();
      expect(raw[locale][`workflows.${reason}.description`]).toBeTruthy();
    }
  });
});
