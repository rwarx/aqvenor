"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, CalendarDays, FileSearch, FlaskConical, FolderOpen, ListChecks, Map as MapIcon, Plus } from "lucide-react";
import type { Message } from "@/lib/aqvenor/types";
import { markChatVisible, unmarkChatVisible, useAqvenor } from "@/lib/aqvenor/store";
import { useT } from "@/lib/aqvenor/useT";
import { fmtDay, fmtTimeShort } from "@/lib/aqvenor/format";
import { sendMessage } from "@/lib/aqvenor/scenario";
import { isServerMode, openWorkspaceDialog, syncWorkspaceFiles } from "@/lib/aqvenor/sync";
import { checkBackend } from "@/lib/aqvenor/backend";
import { MessageItem, FoldedNotice } from "./MessageItem";
import { ApprovalGate } from "./ApprovalGate";
import { Composer } from "./Composer";
import brandMark from "../../../assets/aqvenor-mark.png";
import brandMarkLg from "../../../assets/aqvenor-mark-lg.png";

const SUGGESTIONS = [
  { icon: FileSearch, key: "chat.suggest.tokens", text: "Find every refresh-token usage and explain the flow" },
  { icon: FlaskConical, key: "chat.suggest.tests", text: "Write tests for TokenService" },
  { icon: ListChecks, key: "chat.suggest.plan", text: "Draft a migration plan for the token store" },
  { icon: MapIcon, key: "chat.suggest.explain", text: "Explain the architecture of AuthFlow" },
];

const TIME_GAP_MS = 10 * 60 * 1000; /* dividers appear at ≥10-minute gaps */

interface DividerInfo {
  ts: number;
  day: boolean;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Centered hairline divider with a time chip — rhythm for long transcripts. */
function TimeDivider({ ts }: { ts: number }) {
  const locale = useAqvenor((s) => s.ui.locale);
  const label = fmtTimeShort(ts, locale);
  return (
    <div className="animate-fade my-3 flex items-center gap-3" role="separator" aria-label={label}>
      <span className="h-px flex-1 bg-line-faint" aria-hidden />
      <span className="rounded-full border border-line-faint bg-surface-1 px-2 py-px font-mono text-[9.5px] tracking-[0.06em] text-fg-3">
        {label}
      </span>
      <span className="h-px flex-1 bg-line-faint" aria-hidden />
    </div>
  );
}

/** Calendar-day boundary — stronger chip with the localized date. */
function DayDivider({ ts, label }: { ts: number; label: string }) {
  const locale = useAqvenor((s) => s.ui.locale);
  const date = fmtDay(ts, locale);
  return (
    <div className="animate-fade my-4 flex items-center gap-3" role="separator" aria-label={label + " · " + date}>
      <span className="h-px flex-1 bg-line" aria-hidden />
      <span className="flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-[10px] font-medium text-fg-2">
        <CalendarDays size={10} className="text-accent" aria-hidden />
        <span className="font-mono tracking-[0.04em]">{date}</span>
      </span>
      <span className="h-px flex-1 bg-line" aria-hidden />
    </div>
  );
}

/* Neon corner ticks around the brand mark — staggered pulse while working. */
function NeonCorners() {
  const corners = [
    "left-0 top-0 border-l-2 border-t-2 rounded-tl-md",
    "right-0 top-0 border-r-2 border-t-2 rounded-tr-md",
    "bottom-0 left-0 border-b-2 border-l-2 rounded-bl-md",
    "bottom-0 right-0 border-b-2 border-r-2 rounded-br-md",
  ];
  return (
    <span aria-hidden className="pointer-events-none absolute -inset-4">
      {corners.map((pos, i) => (
        <span
          key={pos}
          style={{ animationDelay: `${i * 0.2}s` }}
          className={`absolute h-5 w-5 animate-neon-corner border-accent ${pos}`}
        />
      ))}
    </span>
  );
}

function StartScreen({ targetSessionId, generating }: { targetSessionId?: string; generating?: boolean }) {
  const t = useT();
  /* suggestions in a pinned panel send into the pinned session — targeted,
     no session switch, sibling chats keep streaming. */
  const sendSuggestion = (text: string) => {
    sendMessage(text, targetSessionId ? { sessionId: targetSessionId } : undefined);
  };
  /* project comes from the shared store.workspaceRoot (item 5 single source of
     truth) — populated by syncWorkspaceFiles on boot and by openWorkspaceDialog. */
  const project = useAqvenor((s) => s.workspaceRoot);
  const workMode = useAqvenor((s) => s.ui.workMode);
  const pushToast = useAqvenor((s) => s.pushToast);
  const projectName = project ? (project.split(/[/\\]/).filter(Boolean).pop() ?? project) : null;
  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return t("chat.greeting.morning");
    if (h < 18) return t("chat.greeting.afternoon");
    return t("chat.greeting.evening");
  })();
  /* Rotating taglines — one per day, deterministic (no flicker between
     re-renders, same line all day in every panel). */
  const TAGLINES = 6;
  const tagline = useMemo(() => {
    const now = new Date();
    const day = Math.floor(now.getTime() / 86_400_000);
    return t(`chat.empty.tagline.${day % TAGLINES}`);
  }, [t]);
  const openWorkspace = () => {
    if (!isServerMode() || !window.aqvenor) {
      pushToast(t("settings.workspace.toast"));
      return;
    }
    void openWorkspaceDialog()
      .then((root) => { if (root) pushToast(t("palette.openWorkspace"), root); })
      .catch((err) =>
        pushToast(t("palette.openWorkspace"), err instanceof Error ? err.message : undefined, "destructive"),
      );
  };
  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden px-6">
      <div className="relative z-10 mb-6 flex flex-col items-center text-center">
        {/* brand mark: recedes into shadow and gains neon corners while working */}
        <span className="relative mb-4 animate-rise" aria-hidden>
          {generating && <NeonCorners />}
          <img
            src={brandMark}
            alt=""
            draggable={false}
            className={`h-[104px] w-[104px] select-none object-contain transition-all duration-500 ${
              generating ? "scale-95 opacity-40 brightness-[0.55]" : "opacity-100"
            }`}
          />
        </span>
        <h1 className="animate-rise text-[26px] font-semibold tracking-[-0.015em] text-fg-1">{greeting}</h1>
        <p className="mt-1.5 animate-rise text-[13px] text-fg-3">{tagline}</p>
      </div>
      {/* project button — only in code mode; chat & cowork need no project */}
      {isServerMode() && workMode === "code" && (
        <button
          type="button"
          onClick={openWorkspace}
          className="aq-focus-ring relative z-10 mb-3 flex h-7 animate-rise items-center gap-1.5 rounded-full border border-line bg-surface-1 px-3 text-[11.5px] text-fg-2 transition-colors hover:border-line-strong hover:bg-surface-2 hover:text-fg-1"
          title={project ?? t("palette.openWorkspace")}
        >
          <FolderOpen size={12} className="text-fg-3" />
          <span className="max-w-[240px] truncate font-mono">{projectName ?? t("sidebar.openFolder")}</span>
        </button>
      )}
      <div className="relative z-10 w-full max-w-[720px] animate-rise">
        <Composer targetSessionId={targetSessionId} />
      </div>
      <div className="relative z-10 mt-1 flex w-full max-w-[720px] flex-wrap justify-center gap-1.5 px-3">
        {SUGGESTIONS.map((s, i) => {
          const Icon = s.icon;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => sendSuggestion(s.text)}
              style={{ animationDelay: `${80 + i * 40}ms` }}
              className="aq-focus-ring aq-lift group flex animate-rise items-center gap-1.5 rounded-full border border-line-faint bg-surface-1 px-3 py-1.5 text-[11.5px] text-fg-2 hover:border-line hover:bg-surface-2 hover:text-fg-1"
              title={s.text}
            >
              <Icon size={12} className="text-fg-3 transition-colors group-hover:text-accent" />
              {t(s.key)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ChatView({ sessionId }: { sessionId?: string } = {}) {
  const t = useT();
  /* Pinned dock panels pass their session: the transcript stays on it while
     the main "chat" panel keeps following the current session. Both follow
     upgrade aliases (placeholder id → server id); the effective id is what
     drafts and sends bind to, so nothing lands on a dropped placeholder. */
  const session = useAqvenor((s) =>
    sessionId ? s.resolveSession(sessionId) : s.sessions.find((x) => x.id === s.currentSessionId),
  );
  const effectiveId = sessionId ? session?.id : undefined;
  const currentSessionId = useAqvenor((s) => s.currentSessionId);
  const setFocusedChat = useAqvenor((s) => s.setFocusedChat);
  /* run state of THIS panel's chat — sibling chats stream independently. */
  const approval = useAqvenor((s) => (effectiveId ? (s.approvals[effectiveId] ?? null) : s.approvalOf()));
  const runnerStatus = useAqvenor((s) =>
    effectiveId ? s.sessionRunnerOf(effectiveId).status : s.sessionRunnerOf().status,
  );
  const newSession = useAqvenor((s) => s.newSession);
  const messages = session?.messages ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrolledAway, setScrolledAway] = useState(false);
  const [scrolledTop, setScrolledTop] = useState(false);

  /* Visibility registry (background-run toasts/badges) + viewing clears the
     badge. Tracks the live session id so upgrades stay followed. */
  const visibleId = effectiveId ?? currentSessionId;
  useEffect(() => {
    markChatVisible(visibleId);
    useAqvenor.getState().markSessionRead(visibleId);
    return () => unmarkChatVisible(visibleId);
  }, [visibleId]);

  const lastSignature = useMemo(() => {
    const last = messages[messages.length - 1];
    if (!last) return 0;
    return messages.length + last.content.length + last.toolCalls.length + (last.blocks?.length ?? 0);
  }, [messages]);

  const generating = runnerStatus === "running" || runnerStatus === "awaiting-approval";

  /* auto-scroll when near bottom */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || scrolledAway || !useAqvenor.getState().ui.autoscroll) return;
    el.scrollTop = el.scrollHeight;
  }, [lastSignature, scrolledAway, approval]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [session?.id]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setScrolledAway(el.scrollHeight - el.scrollTop - el.clientHeight > 120);
    setScrolledTop(el.scrollTop > 8);
  };

  const foldedCount = messages.filter((m) => m.folded).length;

  /* time-gap / calendar-day dividers between messages */
  const dividers = useMemo(() => {
    const map = new Map<string, DividerInfo>();
    for (let i = 1; i < messages.length; i++) {
      const prev = messages[i - 1].createdAt;
      const cur = messages[i].createdAt;
      if (startOfDay(cur) !== startOfDay(prev)) {
        map.set(messages[i].id, { ts: cur, day: true });
      } else if (cur - prev >= TIME_GAP_MS) {
        map.set(messages[i].id, { ts: cur, day: false });
      }
    }
    return map;
  }, [messages]);

  const backendReachable = useAqvenor((s) => s.backendReachable);
  const retryBackend = () => {
    void (async () => {
      if (await checkBackend()) {
        await syncWorkspaceFiles().catch(() => undefined);
      }
    })();
  };

  return (
    <div
      className="relative flex h-full flex-col"
      onFocusCapture={() => setFocusedChat(effectiveId ?? currentSessionId)}
    >
      {/* honest offline state: the sidecar is unreachable, so no run can
         start. Retry re-probes and resyncs; theater never fills the gap. */}
      {backendReachable === false && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b border-warning/40 bg-warning-soft/40 px-3.5 py-1.5"
        >
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-2">
            <span className="font-medium text-warning">{t("run.offline.title")}</span>
            <span className="text-fg-3"> · {t("run.offline.desc")}</span>
          </span>
          <button
            type="button"
            onClick={retryBackend}
            className="aq-focus-ring shrink-0 rounded-xs border border-line-faint px-2 py-0.5 text-[11px] font-medium text-fg-2 transition-colors hover:border-line-strong hover:text-fg-1"
          >
            {t("run.offline.retry")}
          </button>
        </div>
      )}
      {/* new chat — relocated here from the global header corner (Turn 3). Lives
         in the chat's own top-right corner and stays wired to newSession(). */}
      <button
        type="button"
        onClick={() => newSession()}
        className="aq-focus-ring absolute right-3 top-3 z-20 flex h-7 w-7 items-center justify-center rounded-full border border-line bg-surface-2/85 text-fg-2 shadow-subtle backdrop-blur transition-colors hover:-translate-y-0.5 hover:border-line-strong hover:bg-surface-3 hover:text-fg-1"
        aria-label={t("work.newChat")}
        title={t("work.newChat")}
      >
        <Plus size={15} />
      </button>
      {/* transcript (own sub-wrapper so the bottom fade tracks the composer edge) */}
      {sessionId && !session ? (
        <div className="flex h-full flex-col items-center justify-center px-6 text-center">
          <p className="text-[13px] text-fg-3">{t("chat.pinnedMissing")}</p>
        </div>
      ) : messages.length === 0 ? (
        <StartScreen targetSessionId={effectiveId} generating={generating} />
      ) : (
        <>
      <div className="relative min-h-0 flex-1">
        {/* backdrop brand mark: a large pulsing shadow behind the transcript */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center overflow-hidden"
        >
          <img
            src={brandMarkLg}
            alt=""
            draggable={false}
            className={`h-[380px] w-[380px] select-none object-contain brightness-0 transition-all duration-700 sm:h-[440px] sm:w-[440px] ${
              generating
                ? "scale-105 animate-logo-breath [animation-duration:1.8s]"
                : "scale-100 opacity-45"
            }`}
          />
        </div>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="relative z-10 h-full overflow-y-auto"
          role="log"
          aria-label={t("nav.chat")}
        >
            <div className="mx-auto max-w-[820px] px-4 py-4 sm:px-6">
              {foldedCount > 0 && (
                <div className="mb-3">
                  <FoldedNotice count={foldedCount} />
                </div>
              )}
              {messages.map((m: Message) => {
                const d = dividers.get(m.id);
                return (
                  <div key={m.id}>
                    {d && (d.day ? <DayDivider ts={d.ts} label={t("chat.day.label")} /> : <TimeDivider ts={d.ts} />)}
                    <MessageItem message={m} sessionId={effectiveId} />
                  </div>
                );
              })}
              <div className="h-2" />
            </div>
        </div>

        {/* bottom edge fade — reads as depth under the composer */}
        <div
          className={`pointer-events-none absolute inset-x-0 bottom-0 z-[5] h-6 bg-gradient-to-t from-app to-transparent transition-opacity duration-200 ${
            scrolledAway ? "opacity-100" : "opacity-0"
          }`}
          aria-hidden
        />
      </div>

      {/* scroll-position fade at the top edge of the transcript */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 z-[5] h-6 bg-gradient-to-b from-app to-transparent transition-opacity duration-200 ${
          scrolledTop ? "opacity-100" : "opacity-0"
        }`}
        aria-hidden
      />

      {/* jump to latest */}
      {scrolledAway && messages.length > 0 && (
        <button
          type="button"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
            setScrolledAway(false);
          }}
          className="animate-rise absolute bottom-[130px] left-1/2 z-10 flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface-3 px-3 text-[11.5px] font-medium text-fg-2 shadow-overlay transition-all hover:-translate-y-0.5 hover:border-line-strong hover:text-fg-1 hover:shadow-subtle"
        >
          <ArrowDown size={11} />
          {t("chat.jumpToLatest")}
        </button>
      )}

      {/* approval gate + composer */}
      <div className="shrink-0">
        {approval && (
          <div className="mx-auto max-w-[820px] px-3 pb-2 pt-1 sm:px-4">
            <ApprovalGate approval={approval} sessionId={effectiveId} />
          </div>
        )}
        <Composer targetSessionId={effectiveId} />
      </div>
        </>
      )}
    </div>
  );
}
