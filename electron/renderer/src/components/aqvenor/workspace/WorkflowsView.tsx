"use client";

import { useEffect, useRef, useState } from "react";
import { Check, FileText, FlaskConical, GitCompare, Globe, Loader2, Play, Settings2, Terminal, Users, Wrench } from "lucide-react";
import { useAqvenor } from "@/lib/aqvenor/store";
import { useT } from "@/lib/aqvenor/useT";
import { tools as toolsApi } from "@/lib/aqvenor/backend";
import { isServerMode } from "@/lib/aqvenor/sync";
import { WORKFLOW_RECIPES, recipeBlockReason, recipeControls, recipeTarget, runWorkflowRecipe, type WorkflowRecipe } from "@/lib/aqvenor/recipes";
import { AqGhostButton, AqPrimaryButton } from "@/components/aqvenor/ui";
import { ModelPicker } from "../chat/ModelPicker";
import { cn } from "@/lib/utils";

const ICONS: Record<WorkflowRecipe["id"], React.ElementType> = {
  "fix-test": FlaskConical, "draft-readme": FileText, "refactor-service": Wrench,
  "review-changes": GitCompare, landing: Globe, "delegate-review": Users, "shell-check": Terminal,
};

const CAPABILITIES = ["delegate_task", "run_command", "run_shell"] as const;

export default function WorkflowsView() {
  const t = useT();
  const state = useAqvenor();
  const [toolNames, setToolNames] = useState<string[] | null>(null);
  const [toolError, setToolError] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const pickerDialog = useRef<HTMLDivElement>(null);
  const offline = !isServerMode() || state.backendReachable === false;
  const selected = WORKFLOW_RECIPES.find((item) => item.id === state.ui.selectedWorkflow) ?? WORKFLOW_RECIPES[0];
  const { workMode, workMethod } = recipeControls(selected);
  const target = recipeTarget(selected, state);
  const modelId = target?.modelId ?? state.ui.selectedModelId;
  const model = state.providers.flatMap((provider) => provider.models).find((item) => item.id === modelId);
  const defaultBrief = t(selected.promptKey, state.workspaceRoot ?? "");
  const editedBrief = state.ui.workflowBriefs?.[selected.id];
  const brief = editedBrief ?? defaultBrief;
  const options = { brief, availableTools: toolNames ?? [] };
  const blocked = recipeBlockReason(selected, state, options);
  const running = target ? state.sessionRunnerOf(target.id) : { status: "idle" as const };
  const busy = running.status === "running" || running.status === "awaiting-approval";
  const recent = state.sessions.filter((session) => session.messages.some((message) => message.live) && session.events.some((event) => event.kind === "request"))
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);

  useEffect(() => {
    let cancelled = false;
    setToolNames(null);
    setToolError(false);
    if (!isServerMode() || state.backendReachable === false) { setToolNames([]); return; }
    void toolsApi.list().then((tools) => {
      if (!cancelled) setToolNames(tools.map((tool) => tool.name));
    }).catch(() => { if (!cancelled) setToolError(true); });
    return () => { cancelled = true; };
  }, [state.backendReachable]);

  useEffect(() => {
    if (!pickerOpen) return;
    const trigger = modelTrigger.current;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const dialog = pickerDialog.current;
      if (!dialog) return;
      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')];
      const first = controls[0]; const last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [pickerOpen]);

  function configureTools() {
    state.setUi({ settingsCategory: "advanced" });
    state.setSurface("settings");
  }

  return (
    <div className="@container/workflows h-full min-w-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 @lg/workflows:px-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[30px] font-semibold leading-tight tracking-tight text-fg-1">{t("workflows.title")}</h1>
            <p className="mt-2 max-w-xl text-[12px] leading-relaxed text-fg-2">{t("workflows.builder.subtitle")}</p>
          </div>
          <AqGhostButton onClick={configureTools}><Settings2 size={14} aria-hidden />{t("workflows.builder.configure")}</AqGhostButton>
        </header>

        <div className="grid min-w-0 gap-5 @3xl/workflows:grid-cols-[220px_minmax(0,1fr)]">
          <nav aria-label={t("workflows.builder.choose")} className="min-w-0">
            <h2 className="mb-2 text-[12px] font-medium text-fg-3">{t("workflows.builder.choose")}</h2>
            <div className="grid min-w-0 gap-1 @lg/workflows:grid-cols-2 @3xl/workflows:grid-cols-1">
              {WORKFLOW_RECIPES.map((recipe) => {
                const Icon = ICONS[recipe.id];
                return <button key={recipe.id} type="button" data-workflow-id={recipe.id}
                  aria-pressed={selected.id === recipe.id}
                  onClick={() => { state.setUi({ selectedWorkflow: recipe.id }); setPickerOpen(false); }}
                  className={cn("aq-focus-ring flex min-w-0 items-start gap-2 rounded-md border px-3 py-3 text-left text-[12px] leading-snug transition-colors hover:bg-surface-hover active:bg-sunken", selected.id === recipe.id ? "border-accent-border bg-accent-soft text-fg-1" : "border-transparent text-fg-2")}>
                  <Icon size={15} className="mt-px shrink-0" aria-hidden /><span className="min-w-0 break-words">{t(recipe.nameKey)}</span>
                </button>;
              })}
            </div>
          </nav>

          <section className="min-w-0 rounded-lg border border-line-faint bg-surface-2 p-4 @lg/workflows:p-5" aria-label={t(selected.nameKey)}>
            <h2 className="text-[18px] font-semibold text-fg-1">{t(selected.nameKey)}</h2>
            <p className="mt-2 text-[12px] leading-relaxed text-fg-2">{t(selected.descKey)}</p>
            <ol className="my-4 flex flex-wrap gap-x-4 gap-y-2 text-[11px] text-fg-3">
              {selected.stepKeys.map((key, i) => <li key={key} className="flex items-center gap-1.5"><span className="text-fg-2">{i + 1}.</span>{t(key)}</li>)}
            </ol>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="workflow-brief" className="text-[12px] font-medium text-fg-1">{t("workflows.builder.brief")}</label>
              {editedBrief !== undefined && <AqGhostButton onClick={() => {
                const next = { ...state.ui.workflowBriefs }; delete next[selected.id]; state.setUi({ workflowBriefs: next });
              }}>{t("workflows.builder.reset")}</AqGhostButton>}
            </div>
            <textarea id="workflow-brief" aria-label={t("workflows.builder.brief")} aria-invalid={!brief.trim()}
              value={brief} rows={7} onInput={(event) => state.setUi({ workflowBriefs: { ...state.ui.workflowBriefs, [selected.id]: event.currentTarget.value } })}
              onChange={() => undefined}
              className="aq-focus-ring mt-2 block w-full min-w-0 resize-y rounded-md border border-line bg-sunken p-3 text-[12px] leading-relaxed text-fg-1 placeholder:text-fg-3" />
            <dl className="mt-4 grid min-w-0 gap-3 text-[11px] @lg/workflows:grid-cols-2">
              <div className="min-w-0"><dt className="text-fg-3">{t("workflows.builder.workspace")}</dt><dd className="mt-1 break-all text-fg-2">{state.workspaceRoot || t("workflows.workspace.title")}</dd></div>
              <div className="min-w-0"><dt className="text-fg-3">{t("workflows.builder.model")}</dt><dd className="mt-1"><button ref={modelTrigger} type="button" title={model?.name ?? modelId} className="aq-focus-ring block max-w-full truncate rounded-sm text-left text-fg-1 underline decoration-line underline-offset-4 hover:text-accent" onClick={() => setPickerOpen(true)}>{model?.name ?? modelId ?? t("picker.filterPlaceholder")}</button></dd></div>
              <div><dt className="text-fg-3">{t("workflows.builder.method")}</dt><dd className="mt-1 text-fg-2">{t(`work.mode.${workMode}`)} / {t(`work.method.${workMethod}`)}</dd></div>
              <div><dt className="text-fg-3">{t("workflows.builder.result")}</dt><dd className="mt-1 text-fg-2">{t("workflows.builder.resultHint")}</dd></div>
            </dl>
            <footer className="mt-5 border-t border-line-faint pt-4">
              {blocked && <p role="status" id={`recipe-${selected.id}-blocked`} className="mb-3 text-[12px] leading-relaxed text-fg-2">{t(`workflows.${blocked}.description`)}</p>}
              <AqPrimaryButton data-workflow-run className="h-9 justify-center" disabled={blocked !== null} aria-busy={busy}
                aria-describedby={blocked ? `recipe-${selected.id}-blocked` : undefined}
                onClick={() => runWorkflowRecipe(selected, editedBrief === undefined ? { availableTools: toolNames ?? [] } : options)}>
                {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Play size={14} aria-hidden />}{busy ? t("workflows.busy.title") : t("workflows.run")}
              </AqPrimaryButton>
              <p className="mt-2 text-[11px] leading-relaxed text-fg-3">{t("workflows.builder.launchHint")}</p>
            </footer>
          </section>
        </div>

        <section className="border-t border-line-faint pt-4" aria-label={t("workflows.builder.capabilities")}>
          <h2 className="text-[13px] font-medium text-fg-1">{t("workflows.builder.capabilities")}</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-fg-3">{t("workflows.builder.capabilitiesHint")}</p>
          <ul className="mt-3 grid min-w-0 gap-2 @lg/workflows:grid-cols-3">
            {CAPABILITIES.map((name) => <li key={name} className="min-w-0 rounded-md border border-line-faint px-3 py-2 text-[12px]">
              <div className="text-fg-2">{t(`workflows.capability.${name}`)}</div>
              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-fg-3">
                {toolNames?.includes(name) && <Check size={12} aria-hidden />}
                {offline ? t("workflows.offline.title") : toolError ? t("workflows.builder.loadError") : toolNames === null ? t("workflows.builder.loading") : t(toolNames.includes(name) ? "workflows.builder.available" : "workflows.builder.disabled")}
              </div>
            </li>)}
          </ul>
        </section>

        <section aria-label={t("workflows.builder.recent")}>
          <h2 className="text-[13px] font-medium text-fg-1">{t("workflows.builder.recent")}</h2>
          {recent.length ? <ul className="mt-2 divide-y divide-line-faint">{recent.map((session) => <li key={session.id}><button type="button" className="aq-focus-ring flex w-full min-w-0 items-center justify-between gap-3 rounded-sm py-2 text-left text-[12px] text-fg-2 hover:text-fg-1" onClick={() => { state.selectSession(session.id); state.setSurface("chat"); }}><span className="min-w-0 truncate">{session.title}</span><span className="shrink-0 text-[11px] text-fg-3">{t(`tasks.status.${state.sessionRunnerOf(session.id).status}`)}</span></button></li>)}</ul>
            : <p className="mt-2 text-[12px] leading-relaxed text-fg-3">{t("workflows.builder.recentEmpty")}</p>}
        </section>
      </div>
      {pickerOpen && <div ref={pickerDialog} className="fixed inset-0 z-50 flex items-start justify-center bg-scrim px-3 pt-16" role="dialog" aria-modal="true" aria-label={t("workflows.builder.model")} onClick={() => setPickerOpen(false)}><div className="max-w-full" onClick={(event) => event.stopPropagation()}><ModelPicker sessionId={target?.id} onClose={() => setPickerOpen(false)} /></div></div>}
    </div>
  );
}
