import { translate } from "./i18n";
import type { Locale, Message, MessageBlock, SubAgent } from "./types";

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isDelegatedConversationId = (value: unknown): value is string => typeof value === "string" && CONVERSATION_ID.test(value);

export interface DelegatedRunOwner { parentSessionId: string; runId: string }
interface DelegationState {
  delegatedRuns: Record<string, DelegatedRunOwner>;
  sessionAliases: Record<string, string>;
}

/** A child is controlled by its parent until that run's cleanup completes. */
export function delegatedOwnerOf(state: DelegationState, sessionId: string): DelegatedRunOwner | undefined {
  return state.delegatedRuns[state.sessionAliases[sessionId] ?? sessionId];
}

export function refuseDelegatedSend(state: DelegationState & { ui: { locale: Locale }; pushToast: (title: string, description?: string, variant?: "default" | "destructive") => void }, sessionId: string): boolean {
  if (!delegatedOwnerOf(state, sessionId)) return false;
  state.pushToast(translate(state.ui.locale, "agents.delegated.title"), translate(state.ui.locale, "agents.delegated.hint"), "destructive");
  return true;
}

function statusOf(value: unknown): SubAgent["status"] | null {
  if (value === "running" || value === "done" || value === "stopped") return value;
  if (value === "error" || value === "incomplete") return "failed";
  return null;
}

/** Both the live events and the persisted delegate_task result carry this roster. */
export function delegatedAgent(data: Record<string, unknown>, callId: string, locale: Locale): SubAgent | null {
  const conversationId = data.conversationId ?? data.childConversationId;
  const status = statusOf(data.status);
  if (!callId || !isDelegatedConversationId(conversationId) || !status) return null;
  return {
    id: callId,
    conversationId,
    name: typeof data.title === "string" && data.title.trim() ? data.title.trim().slice(0, 200) : translate(locale, "agents.task"),
    role: translate(locale, "agents.task"),
    status,
    steps: typeof data.steps === "number" && Number.isInteger(data.steps) && data.steps >= 0 ? data.steps : undefined,
    summary: typeof data.answer === "string" ? data.answer.slice(0, 4000) : undefined,
  };
}

export function delegatedAgentFromResult(json: string | undefined | null, callId: string, locale: Locale): SubAgent | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? delegatedAgent(parsed as Record<string, unknown>, callId, locale) : null;
  } catch { return null; }
}

export function withDelegatedAgent(message: Message, agent: SubAgent, parentStatus: SubAgent["status"] = "running"): MessageBlock[] {
  const blocks = message.blocks ?? [];
  const prior = blocks.find((block) => block.type === "agenttree");
  const agents = prior?.type === "agenttree" ? prior.agents : [];
  const old = agents.find((entry) => entry.id === agent.id);
  const next = { ...old, ...agent, summary: agent.summary ?? old?.summary };
  const roster: MessageBlock = { type: "agenttree", parentStatus, agents: old ? agents.map((entry) => entry.id === agent.id ? next : entry) : [...agents, next] };
  return prior ? blocks.map((block) => block === prior ? roster : block) : [...blocks, roster];
}

export function finishDelegatedAgents(message: Message, status: SubAgent["status"]): MessageBlock[] | undefined {
  return message.blocks?.map((block) => block.type === "agenttree" ? {
    ...block,
    parentStatus: status,
    agents: block.agents.map((agent) => (status === "stopped" || status === "failed") && (agent.status === "running" || agent.status === "pending") ? { ...agent, status } : agent),
  } : block);
}
