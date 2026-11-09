"use client";

import { useEffect, useRef, useState } from "react";
import type { MessageBlock, SubAgent } from "@/lib/aqvenor/types";
import { useAqvenor } from "@/lib/aqvenor/store";
import { useT } from "@/lib/aqvenor/useT";
import { openDelegatedConversation } from "@/lib/aqvenor/sync";
import { isDelegatedConversationId } from "@/lib/aqvenor/delegation";
import {
  Bookmark,
  Bot,
  Check,
  ChevronRight,
  Circle,
  ListChecks,
  Loader2,
  Target,
  XCircle,
} from "lucide-react";
import { Overline } from "@/components/aqvenor/ui";
import { fmtCompact } from "@/lib/aqvenor/format";

function PlanCard({ block }: { block: Extract<MessageBlock, { type: "plan" }> }) {
  const t = useT();
  return (
    <div className="my-2 overflow-hidden rounded-md border border-line-faint bg-surface-1">
      <div className="flex items-center gap-2 border-b border-line-faint bg-surface-2/60 px-3 py-2">
        <ListChecks size={13} className="text-accent" />
        <Overline className="!text-fg-2">{t("plan.title")}</Overline>
        <span className="ml-auto font-mono text-[10px] text-fg-3">
          {block.steps.filter((s) => s.status === "done").length}/{block.steps.length}
        </span>
      </div>
      <div className="px-2 py-1.5">
        {block.steps.map((step, i) => (
          <div key={step.id} className="flex items-start gap-2 rounded-sm px-1.5 py-1">
            <span className="mt-[2px] w-4 shrink-0 text-right font-mono text-[10px] text-fg-3">
              {i + 1}
            </span>
            {step.status === "done" ? (
              <Check size={12} className="mt-[3px] shrink-0 text-success" />
            ) : step.status === "running" ? (
              <Loader2 size={12} className="mt-[3px] shrink-0 animate-spin-slow text-warning" />
            ) : step.status === "failed" ? (
              <XCircle size={12} className="mt-[3px] shrink-0 text-error" />
            ) : (
              <Circle size={12} className="mt-[3px] shrink-0 text-fg-3/60" />
            )}
            <span
              className={`text-[12.5px] leading-snug ${
                step.status === "done" ? "text-fg-2" : step.status === "running" ? "font-medium text-fg-1" : "text-fg-1"
              }`}
            >
              {step.title}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ContractCard({ block }: { block: Extract<MessageBlock, { type: "contract" }> }) {
  const t = useT();
  const done = block.items.filter((i) => i.done).length;
  return (
    <div className="my-2 overflow-hidden rounded-md border border-line-faint bg-surface-1">
      <div className="flex items-center gap-2 border-b border-line-faint bg-surface-2/60 px-3 py-2">
        <Target size={13} className="text-accent" />
        <Overline className="!text-fg-2">{block.title || t("contract.title")}</Overline>
        <span className="ml-auto font-mono text-[10px] text-fg-3">
          {done}/{block.items.length}
        </span>
      </div>
      <div className="px-3 py-2">
        <div className="mb-2 h-[3px] overflow-hidden rounded-full bg-sunken">
          <div
            className="h-full rounded-full bg-success transition-all duration-300"
            style={{ width: `${(done / block.items.length) * 100}%` }}
          />
        </div>
        <ul className="space-y-1">
          {block.items.map((item) => (
            <li key={item.id} className="flex items-center gap-2">
              <span
                className={`flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] border transition-colors ${
                  item.done ? "border-success/50 bg-success-soft text-success" : "border-line text-transparent"
                }`}
                aria-hidden
              >
                <Check size={9} strokeWidth={3} />
              </span>
              <span className={`text-[12.5px] ${item.done ? "text-fg-2" : "text-fg-1"}`}>
                {item.text}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function AgentStatus({ status }: { status: SubAgent["status"] }) {
  const t = useT();
  const label = status === "running" ? t("agents.running") : status === "done" ? t("tasks.status.done") : status === "stopped" ? t("tasks.status.stopped") : status === "failed" ? t("agents.failed") : t("agents.pending");
  return <span className={`inline-flex items-center gap-1 font-mono text-[10px] ${status === "running" || status === "stopped" ? "text-warning" : status === "failed" ? "text-error" : status === "done" ? "text-success" : "text-fg-3"}`}>
    {status === "running" ? <Loader2 size={11} className="shrink-0 animate-spin-slow" aria-hidden /> : status === "done" ? <Check size={11} aria-hidden /> : status === "failed" || status === "stopped" ? <XCircle size={11} aria-hidden /> : <Circle size={11} aria-hidden />}
    {label}
  </span>;
}

function SubAgentEntry({ agent }: { agent: SubAgent }) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const open = async () => {
    if (!agent.conversationId || loading) return;
    setLoading(true);
    try { await openDelegatedConversation(agent.conversationId, () => alive.current); }
    catch { if (alive.current) useAqvenor.getState().pushToast(t("agents.openError"), t("error.requestFailed"), "destructive"); }
    finally { if (alive.current) setLoading(false); }
  };
  return <div className="min-w-0 py-2">
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="min-w-0 break-words text-[12px] font-medium text-fg-1">{agent.name}</span>
      <span className="text-[10.5px] text-fg-3">{agent.role}</span>
      <AgentStatus status={agent.status} />
      {agent.tokens !== undefined && <span className="ml-auto font-mono text-[10px] text-fg-3">{fmtCompact(agent.tokens, t.locale)} {t("context.tokensUnit")}</span>}
    </div>
    {agent.summary && <p className="mt-1 max-w-[480px] break-words text-[11.5px] leading-snug text-fg-2">{agent.summary}</p>}
    {isDelegatedConversationId(agent.conversationId) && <button type="button" onClick={() => void open()} disabled={loading} aria-busy={loading} aria-label={`${t("agents.openChat")}: ${agent.name}`}
      className="aq-focus-ring mt-1.5 inline-flex min-h-7 items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-2 text-[11px] font-medium text-fg-2 transition-colors hover:bg-surface-hover hover:text-fg-1 active:bg-sunken disabled:cursor-wait">
      {loading ? <Loader2 size={11} className="animate-spin" aria-hidden /> : <ChevronRight size={11} aria-hidden />}{t("agents.openChat")}
    </button>}
  </div>;
}

function AgentTreeCard({ block }: { block: Extract<MessageBlock, { type: "agenttree" }> }) {
  const t = useT();
  return (
    <div className="my-2 overflow-hidden rounded-md border border-line-faint bg-surface-1">
      <div className="flex items-center gap-2 border-b border-line-faint bg-surface-2/60 px-3 py-2">
        <Bot size={13} className="text-accent" />
        <Overline className="!text-fg-2">{t("agents.title")}</Overline>
        <span className="ml-auto font-mono text-[10px] text-fg-3">
          {block.agents.filter((a) => a.status === "done").length}/{block.agents.length}
        </span>
      </div>
      <div className="px-3 py-2">
        {/* main agent */}
        {block.parentStatus && <div className="flex items-center gap-2 py-1">
          <span className="flex h-5 w-5 items-center justify-center rounded-xs bg-accent-soft text-accent">
            <Bot size={11} />
          </span>
          <span className="text-[12.5px] font-semibold text-fg-1">{t("agents.main")}</span>
          <span className="ml-auto"><AgentStatus status={block.parentStatus} /></span>
        </div>}
        {/* subagents */}
        <div className="ml-[10px] border-l border-line pl-3">
          {block.agents.map((agent) => <SubAgentEntry key={agent.id} agent={agent} />)}
        </div>
      </div>
    </div>
  );
}

function CheckpointCard({ block }: { block: Extract<MessageBlock, { type: "checkpoint" }> }) {
  const t = useT();
  const checkpoints = useAqvenor((s) => s.checkpoints);
  const restoreCheckpoint = useAqvenor((s) => s.restoreCheckpoint);
  const cp = checkpoints.find((c) => c.label === block.label);

  return (
    <div className="my-2 flex items-center gap-2.5 rounded-md border border-line-faint bg-surface-1 px-3 py-2">
      <Bookmark size={12} className="shrink-0 text-warning" />
      <span className="text-[12px] text-fg-2">{t("checkpoint.created", block.label)}</span>
      <span className="truncate font-mono text-[10.5px] text-fg-3">{block.file}</span>
      {cp && (
        <button
          type="button"
          onClick={() => restoreCheckpoint(cp.id)}
          className="ml-auto flex h-6 shrink-0 items-center gap-1 rounded-xs border border-line bg-surface-2 px-2 text-[11px] font-medium text-fg-2 transition-colors hover:border-warning/50 hover:text-warning"
        >
          <ChevronRight size={10} />
          {t("checkpoint.restore")}
        </button>
      )}
    </div>
  );
}

function EventBlock({ block }: { block: Extract<MessageBlock, { type: "event" }> }) {
  return (
    <div
      className={`my-2 flex items-start gap-2.5 rounded-md border px-3 py-2 ${
        block.level === "error"
          ? "border-error/30 bg-error-soft"
          : block.level === "success"
            ? "border-success/30 bg-success-soft"
            : "border-line-faint bg-surface-1"
      }`}
    >
      <span className="text-[12px] font-medium text-fg-1">{block.title}</span>
      {block.detail && <span className="text-[11.5px] text-fg-2">{block.detail}</span>}
    </div>
  );
}

export function MessageBlocks({ blocks }: { blocks: MessageBlock[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.type) {
          case "plan":
            return <PlanCard key={i} block={block} />;
          case "contract":
            return <ContractCard key={i} block={block} />;
          case "agenttree":
            return <AgentTreeCard key={i} block={block} />;
          case "checkpoint":
            return <CheckpointCard key={i} block={block} />;
          case "event":
            return <EventBlock key={i} block={block} />;
          default:
            return null;
        }
      })}
    </>
  );
}
