"use client";

/* ============================================================
   Image generation — the /image command.
   Calls the sidecar's /api/ai/image (which drives the provider's
   image path) and lands the result in the chat as a markdown
   figure, with the same streaming/error bubble treatment a text
   run gets.
   ============================================================ */

import { ai } from "./backend";
import { newId, useAqvenor } from "./store";
import { resolveModel } from "./useModel";
import { looksLikeImageGenModel } from "./data";
import { translate } from "./i18n";
import type { Locale, ModelInfo } from "./types";

/** The model an /image run should use: this chat's own model when it can
 *  generate, else the first image-capable model in the catalogue. */
function pickImageModel(sessionModelId: string): ModelInfo | undefined {
  const providers = useAqvenor.getState().providers;
  const own = resolveModel(providers, sessionModelId);
  if (own?.imageGen) return own;
  for (const p of providers) {
    const found = p.models.find((m) => m.imageGen || looksLikeImageGenModel(m.id));
    if (found) return found;
  }
  return undefined;
}

export async function generateImage(prompt: string, sessionId?: string): Promise<void> {
  const st = useAqvenor.getState();
  const sid = sessionId ?? st.focusedChat();
  const session = st.resolveSession(sid);
  const locale = st.ui.locale;

  const model = pickImageModel(session?.modelId ?? st.ui.selectedModelId);
  if (!model) {
    st.pushToast(translate(locale, "imagegen.noModel.title"), translate(locale, "imagegen.noModel.desc"), "destructive");
    return;
  }
  const providerId = model.providerId;
  /* composite ids ("openrouter/google/gemini-…") split at the first slash;
     the raw model id keeps the rest, which is what the provider expects */
  const slash = model.id.indexOf("/");
  const modelId = providerId === "openrouter" && slash > 0 ? model.id.slice(slash + 1) : model.id;

  const msgId = newId("m");
  st.setSessionRunner(sid, { status: "running", label: translate(locale, "imagegen.working") });
  st.addMessage(
    {
      id: msgId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      modelId: model.id,
      providerId,
      streaming: true,
      toolCalls: [],
      live: true,
    },
    sid,
  );

  try {
    const res = await ai.image({ providerId, modelId, prompt });
    const alt = res.revisedPrompt?.slice(0, 120) ?? prompt.slice(0, 120);
    const md = `![${alt.replace(/[[\]]/g, "")}](${res.image})`;
    useAqvenor.getState().updateMessage(msgId, { content: md, streaming: false }, sid);
    useAqvenor.getState().setSessionRunner(sid, { status: "done", label: translate(locale, "tasks.status.done") });
    setTimeout(() => useAqvenor.getState().clearSessionRunner(sid), 1500);
  } catch (err) {
    const message = err instanceof Error ? err.message : translate(locale, "error.requestFailed");
    useAqvenor.getState().updateMessage(msgId, { streaming: false, error: message }, sid);
    useAqvenor.getState().clearSessionRunner(sid);
  }
}

/** Sequential-thinking scaffold (the /think command): wraps the person's
 *  problem in the numbered-thought protocol exposed by the thinking MCP
 *  server, so any chat model follows the same disciplined shape. */
export function wrapSequentialThinking(problem: string, locale: Locale): string {
  const head = translate(locale, "imagegen.think.scaffold");
  return `${head}\n\n${problem}`;
}
