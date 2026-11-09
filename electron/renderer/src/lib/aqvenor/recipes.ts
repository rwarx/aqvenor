import { sendMessage } from "./scenario";
import { sessionModeOf, useAqvenor } from "./store";
import { isServerMode } from "./sync";
import { translate } from "./i18n";
import { delegatedOwnerOf } from "./delegation";
import type { Session, WorkMethod, WorkMode } from "./types";

export interface WorkflowRecipe {
  id: "fix-test" | "draft-readme" | "refactor-service" | "review-changes" | "landing" | "delegate-review" | "shell-check";
  mode: "build" | "plan";
  nameKey: string;
  descKey: string;
  stepKeys: string[];
  promptKey: string;
  requiredTool?: "delegate_task" | "run_shell";
}

function recipe(
  id: WorkflowRecipe["id"],
  mode: WorkflowRecipe["mode"],
  key: string,
): WorkflowRecipe {
  const prefix = `workflows.recipe.${key}`;
  return {
    id, mode,
    nameKey: `${prefix}.name`,
    descKey: `${prefix}.desc`,
    stepKeys: [1, 2, 3, 4].map((step) => `${prefix}.s${step}`),
    promptKey: `${prefix}.prompt`,
  };
}

export const WORKFLOW_RECIPES: WorkflowRecipe[] = [
  recipe("fix-test", "build", "fixTest"),
  recipe("draft-readme", "plan", "readme"),
  recipe("refactor-service", "build", "refactor"),
  recipe("review-changes", "plan", "review"),
  recipe("landing", "build", "landing"),
  { ...recipe("delegate-review", "plan", "delegate"), requiredTool: "delegate_task" },
  { ...recipe("shell-check", "build", "shell"), requiredTool: "run_shell" },
];

export function recipeControls(recipe: WorkflowRecipe): { workMode: WorkMode; workMethod: WorkMethod } {
  return recipe.mode === "build"
    ? { workMode: "code", workMethod: "ask" }
    : { workMode: "cowork", workMethod: "plan" };
}

type WorkflowState = ReturnType<typeof useAqvenor.getState>;
export type RecipeBlockReason = "offline" | "workspace" | "busy" | "draft" | "workspaceMismatch" | "transition" | "tools" | "empty";

export interface WorkflowLaunchOptions {
  brief?: string;
  availableTools?: readonly string[];
}

/** Predict the chat setWorkMode opens, so a refused launch changes no UI or chat state. */
export function recipeTarget(recipe: WorkflowRecipe, state: WorkflowState): Session | undefined {
  const { workMode } = recipeControls(recipe);
  if (state.ui.workMode === workMode) return state.resolveSession(state.currentSessionId);
  const remembered = state.sessions.find((s) => s.id === state.ui.activeSessionByMode[workMode]);
  if (remembered && sessionModeOf(remembered) === workMode) return remembered;
  return state.sessions
    .filter((s) => sessionModeOf(s) === workMode)
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt)[0];
}

function sameWorkspace(a: string, b: string): boolean {
  const clean = (path: string) => path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const left = clean(a);
  const right = clean(b);
  // Windows workspace paths are case-insensitive; POSIX paths are not.
  return /^[a-z]:\//i.test(left) && /^[a-z]:\//i.test(right)
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function recipeBlockReason(recipe: WorkflowRecipe, state: WorkflowState, options?: WorkflowLaunchOptions): RecipeBlockReason | null {
  if (state.updateClosing || state.workspaceSwitching) return "transition";
  // Offline playback is the explicit demo command. Recipes need the real workspace agent.
  if (!isServerMode() || state.backendReachable === false) return "offline";
  if (!state.workspaceRoot?.trim()) return "workspace";
  if (options?.brief !== undefined && !options.brief.trim()) return "empty";
  if (recipe.requiredTool && !options?.availableTools?.includes(recipe.requiredTool)) return "tools";
  const target = recipeTarget(recipe, state);
  if (!target) return null; // setWorkMode will create an empty chat for this mode.
  const status = state.sessionRunnerOf(target.id).status;
  if (status === "running" || status === "awaiting-approval" || state.approvalOf(target.id) || delegatedOwnerOf(state, target.id)) return "busy";
  // sendMessage consumes the target chat's draft and attachment tray.
  const draft = state.draftOf(target.id);
  if (draft.text.trim() || draft.attachments.length) return "draft";
  const projectRoot = state.projects.find((p) => p.id === target.projectId)?.workspacePath;
  if (projectRoot && !sameWorkspace(projectRoot, state.workspaceRoot)) return "workspaceMismatch";
  return null;
}

export function recipeModeLabel(recipe: WorkflowRecipe, state: WorkflowState): string {
  const { workMode, workMethod } = recipeControls(recipe);
  return `${translate(state.ui.locale, `work.mode.${workMode}`)} · ${translate(state.ui.locale, `work.method.${workMethod}`)}`;
}

/** Recheck at click time: a sibling panel may have started a run since the card rendered. */
export function runWorkflowRecipe(recipe: WorkflowRecipe, options?: WorkflowLaunchOptions): boolean {
  const state = useAqvenor.getState();
  const locale = state.ui.locale;
  const blocked = recipeBlockReason(recipe, state, options);
  if (blocked) {
    state.pushToast(
      translate(locale, `workflows.${blocked}.title`),
      translate(locale, `workflows.${blocked}.description`),
      "destructive",
    );
    return false;
  }
  const prompt = options?.brief === undefined
    ? translate(locale, recipe.promptKey, state.workspaceRoot!)
    : `${translate(locale, "workflows.customContext", state.workspaceRoot!)}\n\n${options.brief.trim()}`;
  const { workMode, workMethod } = recipeControls(recipe);
  state.setWorkMode(workMode);
  const targetId = useAqvenor.getState().currentSessionId;
  state.setWorkMethod(workMethod, targetId);
  sendMessage(prompt, { sessionId: targetId });
  state.setSurface("chat");
  state.pushToast(
    translate(locale, recipe.nameKey),
    translate(locale, "workflows.started.description", recipeModeLabel(recipe, useAqvenor.getState())),
  );
  return true;
}
