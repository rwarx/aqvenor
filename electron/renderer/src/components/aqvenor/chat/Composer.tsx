"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  CornerDownLeft,
  FoldVertical,
  ListChecks,
  MessageSquare,
  Mic,
  MicOff,
  Paperclip,
  Pencil,
  Play,
  Square,
  Terminal,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { newId, useAqvenor } from "@/lib/aqvenor/store";
import { useT } from "@/lib/aqvenor/useT";
import { fmtInt } from "@/lib/aqvenor/format";
import { getNodeDragIds, hasNodeDrag } from "@/lib/aqvenor/dnd";
import { attachCanvasNodeToDraft } from "@/lib/aqvenor/attachNode";
import { sendMessage, stopGeneration } from "@/lib/aqvenor/scenario";
import { useModel } from "@/lib/aqvenor/useModel";
import type { WorkMethod, WorkMode, Locale } from "@/lib/aqvenor/types";
import { AqToolButton } from "@/components/aqvenor/ui";
import { ModelPicker } from "./ModelPicker";
import { cn } from "@/lib/utils";

/* autonomy selector (Plan / Ask before changes / Edit automatically / Full access).
   Pins the choice to this panel's chat; the engine mode is derived per chat. */
const METHODS: { id: WorkMethod; labelKey: string; hintKey: string; icon: React.ElementType }[] = [
  { id: "plan", labelKey: "work.method.plan", hintKey: "work.method.plan.hint", icon: ListChecks },
  { id: "ask", labelKey: "work.method.ask", hintKey: "work.method.ask.hint", icon: Wrench },
  { id: "auto", labelKey: "work.method.auto", hintKey: "work.method.auto.hint", icon: Pencil },
  { id: "full", labelKey: "work.method.full", hintKey: "work.method.full.hint", icon: Zap },
];

/* ---------- Web Speech API (typed minimal shims) ---------- */
interface SpeechResultChunk {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechResultEvent {
  resultIndex: number;
  results: { length: number } & Record<number, SpeechResultChunk>;
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
}
type SpeechCtor = new () => SpeechRecognitionLike;

function getSpeechCtor(): SpeechCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechCtor;
    webkitSpeechRecognition?: SpeechCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const SPEECH_LANG: Record<Locale, string> = { en: "en-US", ru: "ru-RU", de: "de-DE" };

export function Composer({ targetSessionId }: { targetSessionId?: string } = {}) {
  const t = useT();
  const ui = useAqvenor((s) => s.ui);
  const setWorkMode = useAqvenor((s) => s.setWorkMode);
  const setWorkMethod = useAqvenor((s) => s.setWorkMethod);
  /* Multitask binding: no prop = the current chat; a pinned dock panel passes
     its own session, so text, tray, model pill and send target stay on it. */
  const currentSessionId = useAqvenor((s) => s.currentSessionId);
  const resolvedId = targetSessionId ?? currentSessionId;
  const draftState = useAqvenor((s) => s.drafts[resolvedId]);
  const draft = draftState?.text ?? "";
  const draftAttachments = draftState?.attachments ?? [];
  const setDraft = useAqvenor((s) => s.setDraft);
  const setDraftFor = (text: string) => setDraft(text, resolvedId);
  const addDraftAttachment = useAqvenor((s) => s.addDraftAttachment);
  const removeDraftAttachment = useAqvenor((s) => s.removeDraftAttachment);
  const sessionModelId = useAqvenor((s) => {
    const id = targetSessionId ?? s.currentSessionId;
    return s.sessions.find((x) => x.id === id)?.modelId ?? s.ui.selectedModelId;
  });
  const recording = useAqvenor((s) => s.recording);
  const setRecording = useAqvenor((s) => s.setRecording);
  const runnerStatus = useAqvenor((s) => s.sessionRunnerOf(resolvedId).status);
  const pushToast = useAqvenor((s) => s.pushToast);
  const approval = useAqvenor((s) => s.approvals[resolvedId] ?? null);

  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [interim, setInterim] = useState("");
  const [liveSpeech, setLiveSpeech] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const dictatingRef = useRef(false);
  const baseDraftRef = useRef("");
  const finalRef = useRef("");

  const generating = runnerStatus === "running" || runnerStatus === "awaiting-approval";
  /* Autonomy of THIS panel's chat (own method or the global default). */
  const sessionMethod = useAqvenor((s) => {
    const id = targetSessionId ?? s.currentSessionId;
    return s.sessions.find((x) => x.id === id)?.method;
  });
  const workMethod = sessionMethod ?? ui.workMethod;
  const activeMethod = METHODS.find((m) => m.id === workMethod) ?? METHODS[1];
  const agentOn = ui.workMode !== "chat";
  const model = useModel(sessionModelId);

  /* ---------- slash commands (typing "/" at the start) ---------- */

  const compactSession = useAqvenor((s) => s.compactSession);

  const slashCommands = useMemo(
    () => [
      {
        id: "chat",
        icon: MessageSquare,
        label: t("work.mode.chat"),
        hint: t("work.mode.chat.hint"),
        run: () => {
          setWorkMode("chat");
          pushToast(t("slash.toast.mode", t("work.mode.chat")));
        },
      },
      {
        id: "plan",
        icon: ListChecks,
        label: t("work.method.plan"),
        hint: t("work.method.plan.hint"),
        run: () => {
          setWorkMode("cowork");
          setWorkMethod("plan", resolvedId);
          pushToast(t("slash.toast.mode", t("work.method.plan")));
        },
      },
      {
        id: "ask",
        icon: Wrench,
        label: t("work.method.ask"),
        hint: t("work.method.ask.hint"),
        run: () => {
          setWorkMode("cowork");
          setWorkMethod("ask", resolvedId);
          pushToast(t("slash.toast.mode", t("work.method.ask")));
        },
      },
      {
        id: "auto",
        icon: Pencil,
        label: t("work.method.auto"),
        hint: t("work.method.auto.hint"),
        run: () => {
          setWorkMode("cowork");
          setWorkMethod("auto", resolvedId);
          pushToast(t("slash.toast.mode", t("work.method.auto")));
        },
      },
      {
        id: "full",
        icon: Zap,
        label: t("work.method.full"),
        hint: t("work.method.full.hint"),
        run: () => {
          setWorkMode("cowork");
          setWorkMethod("full", resolvedId);
          pushToast(t("slash.toast.mode", t("work.method.full")));
        },
      },
      {
        id: "demo",
        icon: Play,
        label: t("slash.cmd.demo"),
        hint: t("slash.cmd.demo.hint"),
        run: () => setDraftFor("run demo"),
      },
      {
        id: "compact",
        icon: FoldVertical,
        label: t("slash.cmd.compact"),
        hint: t("slash.cmd.compact.hint"),
        run: () => compactSession(resolvedId),
      },
    ],
    [t, setWorkMode, setWorkMethod, pushToast, setDraftFor, compactSession, resolvedId],
  );

  const slashQuery =
    draft.startsWith("/") && !draft.slice(1).includes(" ") && !draft.includes("\n")
      ? draft.slice(1).toLowerCase()
      : null;
  const slashItems = useMemo(
    () =>
      slashQuery === null
        ? []
        : slashCommands.filter(
            (c) => c.id.startsWith(slashQuery) || c.id.includes(slashQuery),
          ),
    [slashQuery, slashCommands],
  );
  const slashOpen = slashQuery !== null && slashItems.length > 0 && slashDismissed !== slashQuery;
  const slashActive = slashOpen ? (slashItems[Math.min(slashIdx, slashItems.length - 1)] ?? null) : null;

  const runSlash = (cmd: (typeof slashCommands)[number]) => {
    cmd.run();
    /* mode/compact commands clear the draft; demo keeps its inserted text */
    if (cmd.id !== "demo") setDraftFor("");
    setSlashIdx(0);
    setSlashDismissed(null);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    textareaRef.current?.focus();
  };

  useEffect(() => {
    if (!modeMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setModeMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [modeMenuOpen]);

  useEffect(() => {
    if (!modelOpen) return;
    const onDown = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [modelOpen]);

  /* ---------- dictation (real Web Speech only — no simulated typing) ---------- */

  const stopDictation = () => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    dictatingRef.current = false;
    setLiveSpeech(false);
    setDictating(false);
    setRecording(false);
    setInterim("");
  };

  const startDictation = () => {
    if (dictatingRef.current) return;
    const Ctor = getSpeechCtor();
    if (!Ctor) {
      /* no Web Speech API at all — say so instead of typing for the user */
      pushToast(t("chat.voice.listening"), t("chat.voice.unsupported"), "destructive");
      return;
    }
    const rec = new Ctor();
    recognitionRef.current = rec;
    rec.lang = SPEECH_LANG[ui.locale] ?? "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    baseDraftRef.current = useAqvenor.getState().draftOf(resolvedId).text;
    finalRef.current = "";
    rec.onresult = (event) => {
      let finalChunk = "";
      let interimChunk = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalChunk += result[0].transcript;
        else interimChunk += result[0].transcript;
      }
      if (finalChunk) {
        finalRef.current = `${finalRef.current}${finalChunk}`.trim();
        const next = baseDraftRef.current
          ? `${baseDraftRef.current} ${finalRef.current}`
          : finalRef.current;
        setDraftFor(next);
      }
      setInterim(interimChunk);
    };
    rec.onend = () => {
      /* natural end of utterance — only reset if this instance is still active */
      if (recognitionRef.current !== rec) return;
      recognitionRef.current = null;
      dictatingRef.current = false;
      setDictating(false);
      setLiveSpeech(false);
      setRecording(false);
      setInterim("");
    };
    rec.onerror = (e) => {
      const hard = [
        "not-allowed",
        "service-not-allowed",
        "audio-capture",
        "no-speech",
        "network",
      ].includes(e.error ?? "");
      /* detach so the follow-up onend no-ops */
      if (recognitionRef.current === rec) recognitionRef.current = null;
      if (hard) {
        /* Web Speech present but unusable (headless, no mic, blocked).
           Surface it — typing a canned phrase would be the app lying. */
        pushToast(t("chat.voice.listening"), t("chat.voice.unsupported"), "destructive");
      } else {
        dictatingRef.current = false;
        setDictating(false);
        setLiveSpeech(false);
        setRecording(false);
        setInterim("");
      }
    };
    try {
      rec.start();
      dictatingRef.current = true;
      setDictating(true);
      setLiveSpeech(true);
      setRecording(true);
    } catch {
      recognitionRef.current = null;
      pushToast(t("chat.voice.listening"), t("chat.voice.unsupported"), "destructive");
    }
  };

  /* Ctrl+M via global event. Several composers may be mounted (pinned chats):
     only the one holding keyboard focus answers; otherwise the primary
     (unpinned) composer does, so a single press never dictates twice. */
  const composerBoxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onStart = () => {
      const focused = document.activeElement;
      const mine = composerBoxRef.current?.contains(focused ?? null) ?? false;
      if (mine) {
        startDictation();
        return;
      }
      if (targetSessionId !== undefined) return;
      const inOther = Array.from(document.querySelectorAll("[data-aqvenor-composer]")).some(
        (el) => el !== composerBoxRef.current?.closest("[data-aqvenor-composer]") && el.contains(focused ?? null),
      );
      if (!inOther) startDictation();
    };
    window.addEventListener("aqvenor:dictate", onStart);
    return () => window.removeEventListener("aqvenor:dictate", onStart);
  }, [ui.locale, targetSessionId]);

  /* stop everything on unmount */
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      // Clear the flag this component owns. Without it, switching away from Chat while
      // recording left `recording` true in the store with no component left to clear it,
      // and every later Ctrl+M returned at the `if (store.recording) return` guard —
      // dictation bricked for the rest of the session.
      if (useAqvenor.getState().recording) {
        useAqvenor.getState().setRecording(false);
      }
    };
  }, []);

  const submit = () => {
    if (!draft.trim() || generating) return;
    /* targeted send: this panel's chat streams on its own run — sibling
       chats are untouched, no session switch, no shared text. */
    sendMessage(draft, { sessionId: resolvedId });
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  /* Paperclip → read picked files as text and stage them on this turn.
     Kept text-only and capped so a stray binary can't bloat the request. */
  const onPickFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const MAX_CHARS = 200_000;
    for (const file of Array.from(list)) {
      try {
        const raw = await file.text();
        addDraftAttachment({
          id: newId("att"),
          name: file.name,
          sizeKb: Math.max(1, Math.round(file.size / 1024)),
          mimeType: file.type || "text/plain",
          textContent: raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS) : raw,
        }, resolvedId);
      } catch {
        pushToast(t("composer.attach"), file.name, "destructive");
      }
    }
  };

  const dictationLive = dictating && liveSpeech;

  /* Canvas node / OS file drop: pin the file to this turn. stopPropagation
     keeps the global bundle-import overlay (Files drops) from also firing. */
  const [dropActive, setDropActive] = useState(false);
  const dropAccepts = (e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer?.types ?? []);
    return types.includes("Files") || hasNodeDrag(e);
  };
  const onComposerDrop = (e: React.DragEvent) => {
    if (!dropAccepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropActive(false);
    const nodeIds = getNodeDragIds(e);
    if (nodeIds.length > 0) {
      void (async () => {
        let failed = 0;
        for (const nodeId of nodeIds) {
          if (!(await attachCanvasNodeToDraft(nodeId, resolvedId))) failed++;
        }
        if (failed > 0) pushToast(t("composer.attach"), `${failed}`, "destructive");
        textareaRef.current?.focus();
      })();
      return;
    }
    if (e.dataTransfer?.files?.length) {
      void onPickFiles(e.dataTransfer.files);
      textareaRef.current?.focus();
    }
  };

  return (
    <div ref={composerBoxRef} className="px-3 pb-3 sm:px-4" data-aqvenor-composer>
      <div className="mx-auto max-w-[820px]">
        <div
          onDragOver={(e) => {
            if (!dropAccepts(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDropActive(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropActive(false);
          }}
          onDrop={onComposerDrop}
          className={`rounded-lg border bg-surface-2 shadow-subtle transition-[border-color,box-shadow] duration-150 ${
            dropActive
              ? "border-accent shadow-[0_0_0_3px_var(--aq-accent-soft)]"
              : approval
                ? "border-warning/50"
                : dictationLive
                  ? "border-accent/50 shadow-[0_0_0_3px_var(--aq-accent-soft)]"
                  : "border-line focus-within:border-line-strong focus-within:shadow-[0_0_0_3px_var(--aq-accent-soft)]"
          }`}
        >
          {/* interim transcript ribbon */}
          {(dictating || interim) && (
            <div className="animate-fade border-b border-line-faint bg-accent-soft/40 px-3.5 py-1.5" aria-live="polite">
              <span className="flex items-center gap-2 text-[11.5px] text-fg-2">
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse-dot rounded-full bg-accent" />
                <span className="shrink-0 font-medium text-accent">{t("chat.voice.interim")}</span>
                <span className="truncate italic text-fg-2">{interim || "…"}</span>
                {dictationLive && (
                  <span className="ml-auto hidden shrink-0 font-mono text-[9.5px] uppercase tracking-wider text-fg-3 sm:block">
                    {t("chat.voice.live")}
                  </span>
                )}
              </span>
            </div>
          )}

          {/* textarea + slash command menu */}
          <div className="relative">
            {slashOpen && (
              <div
                id="aq-slash-menu"
                role="listbox"
                aria-label={t("slash.title")}
                className="absolute bottom-[calc(100%+8px)] left-0 z-40 w-[320px] animate-settle overflow-hidden rounded-lg border border-line bg-surface-3 p-1.5 shadow-overlay"
              >
                <div className="flex items-center gap-1.5 px-2 pb-1 pt-0.5">
                  <Terminal size={9} className="text-accent" aria-hidden />
                  <span className="aq-overline">{t("slash.title")}</span>
                  <span className="ml-auto font-mono text-[9px] text-fg-3">↑↓ · enter · esc</span>
                </div>
                {slashItems.map((cmd, i) => {
                  const Icon = cmd.icon;
                  const active = i === Math.min(slashIdx, slashItems.length - 1);
                  return (
                    <button
                      key={cmd.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setSlashIdx(i)}
                      onClick={() => runSlash(cmd)}
                      className={cn(
                        "aq-focus-ring flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left transition-colors",
                        active ? "bg-accent-soft" : "hover:bg-surface-hover",
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-5 w-[54px] shrink-0 items-center justify-center rounded-xs border font-mono text-[10.5px]",
                          active
                            ? "border-accent-border bg-surface-1 text-accent"
                            : "border-line-faint bg-sunken text-fg-2",
                        )}
                      >
                        /{cmd.id}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cn("block truncate text-[12px] font-medium", active ? "text-accent" : "text-fg-1")}>
                          {cmd.label}
                        </span>
                        <span className="block truncate text-[10.5px] text-fg-3">{cmd.hint}</span>
                      </span>
                      {active && <CornerDownLeft size={11} className="shrink-0 text-accent" aria-hidden />}
                    </button>
                  );
                })}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={draft}
              rows={1}
              onChange={(e) => {
                setDraftFor(e.target.value);
                if (!e.target.value.startsWith("/")) setSlashDismissed(null);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
              }}
              onKeyDown={(e) => {
                if (slashOpen && slashItems.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSlashIdx((i) => (i + 1) % slashItems.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlashIdx((i) => (i - 1 + slashItems.length) % slashItems.length);
                    return;
                  }
                  if (e.key === "Tab") {
                    e.preventDefault();
                    setDraftFor(`/${slashActive ? slashActive.id : slashItems[0].id} `);
                    setSlashDismissed(null);
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (slashActive) runSlash(slashActive);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setSlashDismissed(slashQuery);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey && ui.enterSend) {
                  e.preventDefault();
                  submit();
                }
                if (e.key === "Escape" && dictating) {
                  e.stopPropagation();
                  stopDictation();
                }
              }}
              placeholder={
                dictating
                  ? t("chat.voice.listening")
                  : t("composer.placeholder", agentOn ? `· ${t(`work.method.${workMethod}`)}` : "")
              }
              aria-label={t("composer.placeholder", "")}
              aria-autocomplete="list"
              aria-controls="aq-slash-menu"
              className="max-h-[200px] min-h-[44px] w-full resize-none bg-transparent px-3.5 py-3 text-[13.5px] leading-[1.55] text-fg-1 outline-none placeholder:text-fg-3"
            />
          </div>

          {/* staged attachments */}
          {draftAttachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-t border-line-faint px-3 py-2">
              {draftAttachments.map((a) => (
                <span
                  key={a.id}
                  className="flex items-center gap-1.5 rounded-sm border border-line-faint bg-surface-1 px-2 py-1 text-[11px] text-fg-2"
                >
                  <Paperclip size={10} className="shrink-0 text-fg-3" />
                  <span className="max-w-[160px] truncate">{a.name}</span>
                  <span className="font-mono text-[9.5px] text-fg-3">{fmtInt(a.sizeKb, t.locale)} KB</span>
                  <button
                    type="button"
                    onClick={() => removeDraftAttachment(a.id, resolvedId)}
                    aria-label={t("common.delete")}
                    title={t("common.delete")}
                    className="flex h-4 w-4 items-center justify-center rounded-xs text-fg-3 transition-colors hover:bg-surface-hover hover:text-fg-1"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* footer */}
          <div className="flex items-center gap-1 border-t border-line-faint px-2 py-1.5">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                void onPickFiles(e.target.files);
                e.target.value = ""; // allow re-picking the same file
              }}
            />
            <AqToolButton
              onClick={() => fileInputRef.current?.click()}
              aria-label={t("composer.attach")}
              title={t("composer.attach")}
            >
              <Paperclip size={14} />
            </AqToolButton>

            {/* work-method selector — autonomy while coworking (hidden in plain Chat) */}
            {agentOn && (
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setModeMenuOpen((v) => !v)}
                className="aq-focus-ring flex h-7 items-center gap-1.5 rounded-sm bg-accent-soft px-2 text-[12px] font-medium text-accent transition-colors hover:bg-accent-soft"
                aria-haspopup="menu"
                aria-expanded={modeMenuOpen}
                title={t("agent.tooltip")}
              >
                <activeMethod.icon size={13} />
                <span className="hidden sm:inline">
                  {`${t("work.method")} · ${t(`work.method.${workMethod}`)}`}
                </span>
                <ChevronDown size={11} className="text-fg-3" />
              </button>
              {modeMenuOpen && (
                <div
                  role="menu"
                  className="absolute bottom-[calc(100%+6px)] left-0 z-40 w-[290px] animate-settle overflow-hidden rounded-lg border border-line bg-surface-3 p-1.5 shadow-overlay"
                >
                  {METHODS.map((method) => {
                    const selected = workMethod === method.id;
                    const Icon = method.icon;
                    return (
                      <button
                        key={method.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        onClick={() => {
                          setWorkMethod(method.id, resolvedId);
                          setModeMenuOpen(false);
                        }}
                        className={`aq-focus-ring flex w-full items-start gap-2.5 rounded-sm px-2.5 py-2 text-left transition-colors ${
                          selected ? "bg-accent-soft" : "hover:bg-surface-hover"
                        }`}
                      >
                        {selected ? (
                          <Check size={13} className="mt-[2px] shrink-0 text-accent" />
                        ) : (
                          <Icon size={13} className="mt-[2px] shrink-0 text-fg-3" />
                        )}
                        <span className="min-w-0">
                          <span
                            className={`block text-[12.5px] font-medium ${selected ? "text-accent" : "text-fg-1"}`}
                          >
                            {t(method.labelKey)}
                          </span>
                          <span className="block text-[11px] leading-snug text-fg-3">{t(method.hintKey)}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            )}

            {/* right cluster — model · mic · send */}
            <div className="ml-auto flex items-center gap-1">
              {/* model pill */}
              <div className="relative" ref={modelRef}>
                <button
                  type="button"
                  onClick={() => setModelOpen((v) => !v)}
                  className="aq-focus-ring hidden h-7 items-center gap-1.5 rounded-sm px-2 text-[11.5px] text-fg-2 transition-colors hover:bg-surface-hover hover:text-fg-1 md:flex"
                  aria-label={t("composer.selectModel")}
                  title={t("composer.selectModel")}
                >
                  <span className="max-w-[140px] truncate font-medium text-fg-1">
                    {model?.name ?? t("status.noModel")}
                  </span>
                  <ChevronDown size={11} className="text-fg-3" />
                </button>
                {modelOpen && (
                  <div className="absolute bottom-[calc(100%+6px)] right-0 z-40 animate-settle">
                    <ModelPicker sessionId={resolvedId} onClose={() => setModelOpen(false)} />
                  </div>
                )}
              </div>

              {dictating ? (
                <button
                  type="button"
                  onClick={stopDictation}
                  className="aq-focus-ring flex h-7 items-center gap-1.5 rounded-sm bg-error-soft px-2 text-[11.5px] font-medium text-error transition-colors hover:bg-error-soft"
                  aria-label={t("chat.voice.stop")}
                  title={t("chat.voice.stop")}
                >
                  <MicOff size={13} className="animate-pulse-dot" />
                  <span className="hidden sm:inline">{t("chat.voice.stop")}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={startDictation}
                  className={`aq-focus-ring flex h-7 items-center justify-center rounded-sm px-2 transition-colors ${
                    recording
                      ? "bg-accent-soft text-accent"
                      : "text-fg-3 hover:bg-surface-hover hover:text-fg-1"
                  }`}
                  aria-label={t("composer.voice")}
                  title={`${t("composer.voice")} · Ctrl+M`}
                >
                  <Mic size={14} className={recording ? "animate-pulse-dot" : undefined} />
                </button>
              )}

              {generating ? (
                <button
                  type="button"
                  onClick={() => stopGeneration(resolvedId)}
                  className="aq-focus-ring flex h-8 w-8 items-center justify-center rounded-full bg-surface-3 text-fg-1 transition-colors hover:bg-surface-hover"
                  aria-label={t("chat.stop")}
                  title={t("chat.stop")}
                >
                  <Square size={12} className="fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={submit}
                  disabled={!draft.trim()}
                  className="aq-focus-ring flex h-8 w-8 items-center justify-center rounded-full bg-accent text-on-accent transition-all duration-100 hover:bg-accent-hover active:translate-y-px disabled:pointer-events-none disabled:opacity-40"
                  aria-label={t("composer.send")}
                  title={t("composer.send")}
                >
                  <ArrowUp size={16} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* Ctrl+M handler exposed for the global keyboard layer */
export function triggerDictation() {
  const store = useAqvenor.getState();
  if (store.recording) return;

  // Only mark the store as recording if someone can hear about it. The listener lives in
  // Composer, so on any other surface the event goes nowhere — and setting the flag anyway left
  // `recording` stuck true, which made this function a no-op from then on. Either the surface is
  // showing Chat, or there is nothing to dictate into and the press should do nothing at all.
  if (!document.querySelector("[data-aqvenor-composer]")) return;

  store.setRecording(true);
  window.dispatchEvent(new CustomEvent("aqvenor:dictate"));
}
