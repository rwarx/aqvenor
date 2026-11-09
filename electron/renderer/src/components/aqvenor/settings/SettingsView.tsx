"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  FolderOpen,
  Github,
  Lock,
  Loader2,
  Monitor,
  Moon,
  RotateCcw,
  Search,
  Sun,
  Terminal,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { APP_ZOOM_PRESETS, applyAppZoom, useAqvenor } from "@/lib/aqvenor/store";
import { useT } from "@/lib/aqvenor/useT";
import { fmtDec } from "@/lib/aqvenor/format";
import { loadSettingsWithUiPreferences, setUiPreferences } from "@/lib/aqvenor/ui-preferences";
import {
  meta as metaApi,
  settings as settingsApi,
  tools as toolsApi,
  workspace as workspaceApi,
  type ServerTool,
} from "@/lib/aqvenor/backend";
import {
  SERVER_LOCKED_SETTINGS,
  isServerMode,
  loadServerSettings,
  openWorkspaceByPath,
  saveServerSettings,
} from "@/lib/aqvenor/sync";
import type { Locale, ThemeMode } from "@/lib/aqvenor/types";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Divider,
  AqCard,
  AqGhostButton,
  Keycap,
  Overline,
} from "@/components/aqvenor/ui";
import { McpSettings } from "./McpSettings";
import { UpdatesSettings } from "./UpdatesSettings";
import { ProviderStudioLauncher } from "../chat/ProviderStudio";
import pkg from "../../../../../package.json";

/* ============================================================
   SETTINGS — categorized, searchable, honest.
   Every control reads and writes the same backend section; controls the
   server refuses stay locked; desktop-owned command permissions use the
   privileged host bridge and reflect its confirmed result.
   ============================================================ */

const APP_VERSION: string =
  (pkg as unknown as { version?: string }).version ?? "0.0.0";

/* Fixed palette data for the theme preview strips. Each card previews its own
   palette, so the "other" theme's colors must be literal — they are data, not
   live styling. */
const DARK_STRIP = ["#131417", "#1a1c1f", "#212327", "#292b30", "#2c2e33"];
const LIGHT_STRIP = ["#f3f4f6", "#f8f9fb", "#ffffff", "#eceef1", "#e9ebee"];
const DARK_ACCENT = "#ffffff";
const LIGHT_ACCENT = "#202429";

const LOCALE_LABELS: Record<Locale, string> = { en: "EN", ru: "Рус", de: "Deutsch" };

const SHORTCUTS: { action: string; keys: string[] }[] = [
  { action: "shortcuts.newChat", keys: ["Ctrl", "N"] },
  { action: "shortcuts.commandPalette", keys: ["Ctrl", "Shift", "P"] },
  { action: "shortcuts.checkpointJump", keys: ["Ctrl", "Shift", "K"] },
  { action: "shortcuts.sidebar", keys: ["Ctrl", "B"] },
  { action: "shortcuts.canvas", keys: ["Ctrl", "G"] },
  { action: "shortcuts.voice", keys: ["Ctrl", "M"] },
  { action: "shortcuts.contextPanel", keys: ["Ctrl", "Alt", "I"] },
  { action: "shortcuts.settings", keys: ["Ctrl", ","] },
  { action: "shortcuts.stop", keys: ["Esc"] },
  { action: "shortcuts.back", keys: ["Alt", "←"] },
  { action: "shortcuts.forward", keys: ["Alt", "→"] },
];

/* Category navigation: label + search keywords. Search matches the translated
   label and keywords, so Russian and German queries find their section. */
type CategoryId =
  | "general"
  | "appearance"
  | "interface"
  | "language"
  | "models"
  | "agent"
  | "permissions"
  | "tools"
  | "mcp"
  | "context"
  | "workspace"
  | "shortcuts"
  | "data"
  | "diagnostics"
  | "updates"
  | "about";

const CATEGORIES: { id: CategoryId; label: string; keywords: string }[] = [
  { id: "general", label: "settings.nav.general", keywords: "settings.nav.general.kw" },
  { id: "appearance", label: "settings.appearance", keywords: "settings.nav.appearance.kw" },
  { id: "interface", label: "settings.interface", keywords: "settings.nav.interface.kw" },
  { id: "language", label: "settings.nav.language", keywords: "settings.nav.language.kw" },
  { id: "models", label: "settings.nav.models", keywords: "settings.nav.models.kw" },
  { id: "agent", label: "settings.agent", keywords: "settings.nav.agent.kw" },
  { id: "permissions", label: "settings.nav.permissions", keywords: "settings.nav.permissions.kw" },
  { id: "tools", label: "settings.nav.tools", keywords: "settings.nav.tools.kw" },
  { id: "mcp", label: "settings.nav.mcp", keywords: "settings.nav.mcp.kw" },
  { id: "context", label: "settings.nav.context", keywords: "settings.nav.context.kw" },
  { id: "workspace", label: "settings.workspace", keywords: "settings.nav.workspace.kw" },
  { id: "shortcuts", label: "settings.shortcuts", keywords: "settings.nav.shortcuts.kw" },
  { id: "data", label: "settings.nav.data", keywords: "settings.nav.data.kw" },
  { id: "diagnostics", label: "settings.nav.diagnostics", keywords: "settings.nav.diagnostics.kw" },
  { id: "updates", label: "update.title", keywords: "update.keywords" },
  { id: "about", label: "settings.about", keywords: "settings.nav.about.kw" },
];

type SettingsGroup = "general" | "models" | "agent" | "workspace" | "integrations" | "updates" | "advanced";
const GROUPS: { id: SettingsGroup; label: string; hint: string; sections: CategoryId[] }[] = [
  { id: "general", label: "settings.nav.general", hint: "settings.group.general.hint", sections: ["general", "appearance", "interface", "language", "shortcuts"] },
  { id: "models", label: "settings.nav.models", hint: "settings.models.hint", sections: ["models"] },
  { id: "agent", label: "settings.agent", hint: "settings.group.agent.hint", sections: ["agent", "context"] },
  { id: "workspace", label: "settings.workspace", hint: "settings.group.workspace.hint", sections: ["workspace"] },
  { id: "integrations", label: "settings.group.integrations", hint: "settings.mcp.hint", sections: ["mcp"] },
  { id: "updates", label: "update.title", hint: "settings.group.updates.hint", sections: ["updates", "about"] },
  { id: "advanced", label: "settings.group.advanced", hint: "settings.group.advanced.hint", sections: ["permissions", "tools", "data", "diagnostics"] },
];

const SEARCH_LABELS: Partial<Record<CategoryId, string[]>> = {
  general: ["settings.confirmDelete", "settings.autoTitles"],
  appearance: ["settings.theme", "settings.sidebarWidth", "theme.dark", "theme.light", "theme.system"],
  interface: ["settings.enterSend", "settings.autoscroll", "settings.appScale"],
  language: ["language"],
  models: ["providerStudio.apiKey", "settings.sampling", "settings.temperature", "settings.topP", "settings.maxTokens"],
  agent: ["settings.agent.allowSubagents", "settings.maxSteps", "settings.timeLimit", "settings.maxIdentical", "settings.budgets", "settings.maxFile", "settings.maxReadChars", "settings.maxList", "settings.maxSearch", "settings.commands.timeout", "settings.commands.maxOutput", "settings.network.timeout", "settings.network.maxResponse"],
  permissions: ["settings.commands.allow", "settings.commands.allowShell", "settings.network.allow", "settings.external.allow", "settings.commands.allowed", "settings.policy"],
  tools: ["settings.toolsRegistry"],
  mcp: ["mcp.connected", "mcp.builtins", "mcp.add", "mcp.builtin.memory.name", "mcp.builtin.thinking.name", "mcp.builtin.computer.name"],
  context: ["settings.systemPrompt", "settings.autoCompact", "settings.compactAt", "settings.keepRecent", "settings.historyCap", "settings.attachments", "settings.maxAttachmentKB", "settings.maxAttachmentChars"],
  workspace: ["settings.workspace.openFolder", "settings.indexNodes", "settings.contextShare"],
  shortcuts: SHORTCUTS.map((shortcut) => shortcut.action),
  data: ["settings.dataPaths", "settings.path.data", "settings.path.db", "settings.path.logs", "settings.path.attachments", "settings.logLevel", "settings.logRetention"],
  diagnostics: ["settings.sidecarVersion", "settings.snapshot", "settings.reset"],
};

/* Sections whose controls need the sidecar; offline they show a note. */
const SERVER_SECTIONS: CategoryId[] = [
  "models",
  "agent",
  "permissions",
  "tools",
  "context",
  "workspace",
  "data",
  "diagnostics",
];

/* ---------- command-allowlist helpers (WPF parity) ---------- */

/* Split the allowlist textarea into bare tokens on comma/semicolon/whitespace,
   mirroring the WPF SettingsViewModel.Tokenize. */
function tokenizeCommands(text: string): string[] {
  return text
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* Tokens that can't name a bare program: anything carrying a path separator,
   drive colon, or shell/glob metacharacter. The backend allowlist matches by
   bare program name, so these would never match and are dropped. */
function droppedCommandTokens(tokens: string[]): string[] {
  return tokens.filter((tok) => /[\\/:*?"<>|]/.test(tok));
}

const clampInt = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Math.round(n)));

/* ---------- small layout helpers ---------- */

function Disclosure({ title, children, forceOpen = false }: { title: string; children: ReactNode; forceOpen?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      open={expanded || forceOpen}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="group rounded-md border border-line-faint bg-surface-1"
    >
      <summary className="aq-focus-ring flex cursor-pointer list-none items-center justify-between gap-3 rounded-md px-4 py-3 text-[13px] font-medium text-fg-2 transition-colors hover:bg-surface-hover hover:text-fg-1 [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown size={14} className="shrink-0 group-open:rotate-180" aria-hidden />
      </summary>
      <div className="space-y-3 border-t border-line-faint p-4">{children}</div>
    </details>
  );
}

function Section({
  id,
  overline,
  hint,
  collapsed,
  forceOpen,
  children,
}: {
  id: string;
  overline: string;
  hint?: string;
  collapsed?: boolean;
  forceOpen?: boolean;
  children: ReactNode;
}) {
  const content = (
    <section id={id} className="scroll-mt-2 space-y-3">
      <div>
        {!collapsed && <Overline>{overline}</Overline>}
        {hint ? <p className="mt-1.5 text-[12px] leading-snug text-fg-3">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
  return collapsed ? <Disclosure title={overline} forceOpen={forceOpen}>{content}</Disclosure> : content;
}

function Row({ label, hint, children }: { label: ReactNode; hint?: string; children?: ReactNode }) {
  return (
    <div className="@container/setting-row py-2.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="min-w-0 text-[13px] font-medium text-fg-1 [overflow-wrap:anywhere]">{label}</span>
        {children && <div className="min-w-0 max-w-full [&>div]:min-w-0 [&>div]:max-w-full">{children}</div>}
      </div>
      {hint ? <p className="mt-1 text-[11.5px] leading-snug text-fg-3">{hint}</p> : null}
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Row label={label}>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </Row>
  );
}

/* A containment switch the server refuses over HTTP: rendered from the live
   value, disabled, with the reason next to it — never an editable toggle
   that would pretend to work. */
function LockedRow({ label, checked, hint }: { label: string; checked: boolean; hint: string }) {
  const t = useT();
  return (
    <div className="py-2.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-fg-1 [overflow-wrap:anywhere]">
          {label}
          <span title={t("settings.locked.note")} className="text-fg-3" aria-hidden>
            <Lock size={12} />
          </span>
        </span>
        <Switch checked={checked} disabled aria-label={label} />
      </div>
      <p className="mt-1 text-[11.5px] leading-snug text-fg-3">{hint}</p>
    </div>
  );
}

/* ---------- theme card with fixed palette preview ---------- */

function ThemeCard({
  mode,
  selected,
  onSelect,
}: {
  mode: ThemeMode;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const dark = mode !== "light";
  const strip = mode === "light" ? LIGHT_STRIP : DARK_STRIP;
  const accent = mode === "light" ? LIGHT_ACCENT : DARK_ACCENT;
  const label = mode === "dark" ? t("theme.dark") : mode === "light" ? t("theme.light") : t("theme.system");
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "aq-focus-ring min-w-0 rounded-md border p-3 text-left transition-colors duration-100",
        selected
          ? "border-accent bg-accent-soft"
          : "border-line-faint bg-surface-1 hover:border-line hover:bg-surface-hover",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 [&>svg]:shrink-0">
        {mode === "light" ? (
          <Sun size={14} strokeWidth={1.75} className="text-fg-2" aria-hidden />
        ) : mode === "dark" ? (
          <Moon size={14} strokeWidth={1.75} className="text-fg-2" aria-hidden />
        ) : (
          <Monitor size={14} strokeWidth={1.75} className="text-fg-2" aria-hidden />
        )}
        <span className="min-w-0 text-[13px] font-medium text-fg-1 [overflow-wrap:anywhere]">{label}</span>
        {selected ? (
          <Check size={12} strokeWidth={2.25} className="ml-auto text-accent" aria-hidden />
        ) : null}
      </div>
      <div className="mt-3 flex h-4 overflow-hidden rounded-xs border border-line" aria-hidden>
        {strip.map((c) => (
          <span key={c} className="h-full flex-1" style={{ background: c }} />
        ))}
        <span className="h-full w-3.5" style={{ background: accent }} />
      </div>
    </button>
  );
}

/* ---------- surface ---------- */

export default function SettingsView() {
  const t = useT();
  const ui = useAqvenor((s) => s.ui);
  const setUi = useAqvenor((s) => s.setUi);
  const pushToast = useAqvenor((s) => s.pushToast);

  /* search + nav */
  const [search, setSearch] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<SettingsGroup>(() => GROUPS.find((group) => group.id === ui.settingsCategory)?.id ?? "general");
  const contentRef = useRef<HTMLDivElement>(null);
  const query = search.trim().toLowerCase();
  const currentGroup = GROUPS.find((group) => group.id === selectedGroup)!;
  const visible = (id: CategoryId) => {
    if (!query) return currentGroup.sections.includes(id);
    const c = CATEGORIES.find((x) => x.id === id);
    if (!c) return false;
    const group = GROUPS.find((item) => item.sections.includes(id));
    return [c.label, c.keywords, ...(group ? [group.label] : []), ...(SEARCH_LABELS[id] ?? [])].map((key) => t(key)).join(" ").toLowerCase().includes(query);
  };
  const matchCount = CATEGORIES.filter((c) => visible(c.id)).length;
  const selectGroup = (id: SettingsGroup) => {
    setSelectedGroup(id);
    setSearch("");
    if (contentRef.current) contentRef.current.scrollTop = 0;
  };

  /* local state — chat/model values persist server-side, ui prefs locally */
  const [systemPrompt, setSystemPrompt] = useState(
    "You are Aqvenor, a desktop coding agent. Prefer minimal diffs, and ask before anything you cannot take back.",
  );
  const [temperature, setTemperature] = useState(0.7);
  const [tempEnabled, setTempEnabled] = useState(true);
  const [topP, setTopP] = useState(1);
  const [topPEnabled, setTopPEnabled] = useState(false);
  const [maxTokens, setMaxTokens] = useState("8192");
  const [tokensEnabled, setTokensEnabled] = useState(true);
  const [timeLimit, setTimeLimit] = useState("10");
  /* file budgets (backend AgentSettings caps) */
  const [maxFileKB, setMaxFileKB] = useState("512");
  const [maxListEntries, setMaxListEntries] = useState("400");
  const [maxSearchResults, setMaxSearchResults] = useState("150");
  const [maxReadChars, setMaxReadChars] = useState("60000");
  const [maxIdentical, setMaxIdentical] = useState("3");
  /* context: attachments + compaction + history */
  const [attachKB, setAttachKB] = useState("1024");
  const [attachChars, setAttachChars] = useState("120000");
  const [autoCompact, setAutoCompact] = useState(true);
  const [compactPct, setCompactPct] = useState("85");
  const [keepRecent, setKeepRecent] = useState("8");
  const [historyCap, setHistoryCap] = useState("100");
  /* workspace: canvas index budgets */
  const [indexNodes, setIndexNodes] = useState("20000");
  const [contextSharePct, setContextSharePct] = useState("40");
  /* data: log controls */
  const [logLevel, setLogLevel] = useState("Information");
  const [logDays, setLogDays] = useState("7");
  /* Command gates are changed through the host, never an ordinary HTTP patch. */
  const [allowCommands, setAllowCommands] = useState(false);
  const [allowShellCommands, setAllowShellCommands] = useState(false);
  const [allowSubagents, setAllowSubagents] = useState(true);
  const [permissionsBusy, setPermissionsBusy] = useState(false);
  const permissionsPending = useRef(false);
  const permissionsRevision = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [allowedCommands, setAllowedCommands] = useState("");
  const [commandTimeout, setCommandTimeout] = useState("120");
  const [maxCmdOutput, setMaxCmdOutput] = useState("20000");
  /* network fetch gate — display only, same reason */
  const [allowNetwork, setAllowNetwork] = useState(false);
  const [fetchTimeout, setFetchTimeout] = useState("30");
  const [maxFetch, setMaxFetch] = useState("20000");
  /* out-of-project file gate — display only, same reason */
  const [allowExternalFiles, setAllowExternalFiles] = useState(false);
  const [wsName, setWsName] = useState<string | null>(null);
  const [wsRoot, setWsRoot] = useState<string | null>(null);
  /* diagnostics + tools */
  const [metaInfo, setMetaInfo] = useState<Record<string, string | undefined> | null>(null);
  const [sidecarVersion, setSidecarVersion] = useState<string | null>(null);
  const [toolsList, setToolsList] = useState<ServerTool[] | null>(null);
  const [resetArmed, setResetArmed] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* Pending patches keyed by section, merged so several fields edited within the
     debounce window all persist. The backend PUT is a partial patch, so shipping
     several keys together applies each without clobbering the rest. */
  const pendingSaves = useRef<Map<string, Record<string, unknown>>>(new Map());

  const numOr = (v: string, fallback: number) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  };

  /* Apply a fetched settings tree to every local field (mount + post-reset). */
  const applySettings = (s: {
    general: Record<string, unknown>;
    appearance?: Record<string, unknown>;
    chat: Record<string, unknown>;
    agent: Record<string, unknown>;
    storage: Record<string, unknown>;
    canvas: Record<string, unknown>;
  }, skipCommandPermissions = false) => {
    if (typeof s.chat["systemPrompt"] === "string") setSystemPrompt(s.chat["systemPrompt"] as string);
    if (typeof s.chat["temperature"] === "number") {
      setTemperature(s.chat["temperature"] as number);
      setTempEnabled(true);
    } else {
      setTempEnabled(false);
    }
    if (typeof s.chat["topP"] === "number") {
      setTopP(s.chat["topP"] as number);
      setTopPEnabled(true);
    } else {
      setTopPEnabled(false);
    }
    if (typeof s.chat["maxTokens"] === "number") {
      setMaxTokens(String(s.chat["maxTokens"]));
      setTokensEnabled(true);
    } else {
      setTokensEnabled(false);
    }
    if (typeof s.agent["maxSteps"] === "number") setUi({ maxSteps: s.agent["maxSteps"] as number });
    if (typeof s.agent["maxDurationSeconds"] === "number") {
      const secs = s.agent["maxDurationSeconds"] as number;
      setTimeLimit(String(secs > 0 ? Math.round(secs / 60) : 0));
    }
    if (typeof s.agent["maxFileBytes"] === "number")
      setMaxFileKB(String(Math.round((s.agent["maxFileBytes"] as number) / 1024)));
    if (typeof s.agent["maxListEntries"] === "number") setMaxListEntries(String(s.agent["maxListEntries"]));
    if (typeof s.agent["maxSearchResults"] === "number") setMaxSearchResults(String(s.agent["maxSearchResults"]));
    if (typeof s.agent["maxReadCharacters"] === "number") setMaxReadChars(String(s.agent["maxReadCharacters"]));
    if (typeof s.agent["maxIdenticalCalls"] === "number") setMaxIdentical(String(s.agent["maxIdenticalCalls"]));
    if (!skipCommandPermissions) {
      if (typeof s.agent["allowCommands"] === "boolean") setAllowCommands(s.agent["allowCommands"] as boolean);
      if (typeof s.agent["allowShellCommands"] === "boolean") setAllowShellCommands(s.agent["allowShellCommands"] as boolean);
    }
    if (typeof s.agent["allowSubagents"] === "boolean") setAllowSubagents(s.agent["allowSubagents"] as boolean);
    if (Array.isArray(s.agent["allowedCommands"])) {
      setAllowedCommands((s.agent["allowedCommands"] as unknown[]).filter((x) => typeof x === "string").join(", "));
    }
    if (typeof s.agent["commandTimeoutSeconds"] === "number") setCommandTimeout(String(s.agent["commandTimeoutSeconds"]));
    if (typeof s.agent["maxCommandOutputCharacters"] === "number") setMaxCmdOutput(String(s.agent["maxCommandOutputCharacters"]));
    if (typeof s.agent["allowNetwork"] === "boolean") setAllowNetwork(s.agent["allowNetwork"] as boolean);
    if (typeof s.agent["fetchTimeoutSeconds"] === "number") setFetchTimeout(String(s.agent["fetchTimeoutSeconds"]));
    if (typeof s.agent["maxFetchResponseCharacters"] === "number") setMaxFetch(String(s.agent["maxFetchResponseCharacters"]));
    if (typeof s.agent["allowExternalFiles"] === "boolean") setAllowExternalFiles(s.agent["allowExternalFiles"] as boolean);
    if (typeof s.chat["autoCompact"] === "boolean") setAutoCompact(s.chat["autoCompact"] as boolean);
    if (typeof s.chat["compactAtPercent"] === "number") setCompactPct(String(s.chat["compactAtPercent"]));
    if (typeof s.chat["compactKeepRecentMessages"] === "number") setKeepRecent(String(s.chat["compactKeepRecentMessages"]));
    if (typeof s.chat["maxHistoryMessages"] === "number") setHistoryCap(String(s.chat["maxHistoryMessages"]));
    if (typeof s.storage["maxAttachmentBytes"] === "number")
      setAttachKB(String(Math.round((s.storage["maxAttachmentBytes"] as number) / 1024)));
    if (typeof s.storage["maxAttachmentCharacters"] === "number")
      setAttachChars(String(s.storage["maxAttachmentCharacters"]));
    if (typeof s.storage["minimumLogLevel"] === "string") setLogLevel(s.storage["minimumLogLevel"] as string);
    if (typeof s.storage["logRetentionDays"] === "number") setLogDays(String(s.storage["logRetentionDays"]));
    if (typeof s.canvas["maxIndexedNodes"] === "number") setIndexNodes(String(s.canvas["maxIndexedNodes"]));
    if (typeof s.canvas["maxContextShare"] === "number")
      setContextSharePct(String(Math.round((s.canvas["maxContextShare"] as number) * 100)));
  };

  /* server-backed settings (no-op offline) */
  useEffect(() => {
    if (!isServerMode()) return;
    let cancelled = false;
    void (async () => {
      const initialPermissionsRevision = permissionsRevision.current;
      const s = await loadSettingsWithUiPreferences();
      if (!s || cancelled) return;
      applySettings(s, initialPermissionsRevision !== permissionsRevision.current);
      try {
        const st = await workspaceApi.status();
        if (!cancelled && st.isOpen && st.root) {
          setWsRoot(st.root);
          setWsName(st.root.split(/[/\\]/).filter(Boolean).pop() ?? st.root);
        }
      } catch {
        /* workspace row stays empty */
      }
      try {
        const meta = await metaApi.info();
        if (!cancelled) {
          setMetaInfo({
            data: meta.dataDirectory,
            db: meta.databasePath,
            logs: meta.logsDirectory,
            attachments: meta.attachmentsDirectory,
          });
        }
      } catch {
        /* diagnostics paths stay empty */
      }
      try {
        const health = await metaApi.health();
        if (!cancelled && health.version) setSidecarVersion(health.version);
      } catch {
        /* version row stays empty */
      }
      try {
        const tools = await toolsApi.list();
        if (!cancelled) setToolsList(tools);
      } catch {
        /* registry table stays empty */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flushSaves = () => {
    const batch = pendingSaves.current;
    pendingSaves.current = new Map();
    for (const [section, body] of batch) {
      void saveServerSettings(section, body).then(({ ok, refused }) => {
        if (!ok) pushToast(t("settings.saveFailed") ?? "Save failed", undefined, "destructive");
        else if (refused.length > 0)
          pushToast(t("settings.locked.refused"), refused.join(", "), "destructive");
        else if (section === "agent" && "allowSubagents" in body)
          void toolsApi.list().then((tools) => { if (alive.current) setToolsList(tools); }).catch(() => undefined);
      });
    }
  };

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      // persist anything still pending when the panel unmounts
      flushSaves();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const saveSoon = (section: string, body: Record<string, unknown>) => {
    if (!isServerMode()) return;
    /* Containment switches never leave this surface: the sidecar refuses them
       by name, so sending them would only produce refused noise. */
    const writable = Object.fromEntries(
      Object.entries(body).filter(([k]) => !SERVER_LOCKED_SETTINGS.has(k)),
    );
    if (Object.keys(writable).length === 0) return;
    const prev = pendingSaves.current.get(section) ?? {};
    pendingSaves.current.set(section, { ...prev, ...writable });
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSaves, 800);
  };

  const permissionsAvailable = isServerMode() && typeof window.aqvenor?.agentPermissions === "function";
  const requestPermissions = async (patch: { allowCommands?: boolean; allowShellCommands?: boolean }) => {
    const change = window.aqvenor?.agentPermissions;
    if (!permissionsAvailable || !change || permissionsPending.current) return;
    permissionsPending.current = true;
    setPermissionsBusy(true);
    try {
      const actual = await change(patch, ui.locale);
      if (!alive.current || actual.cancelled) return;
      if (typeof actual.allowCommands !== "boolean" && typeof actual.allowShellCommands !== "boolean") throw new Error("Command permission response was incomplete.");
      permissionsRevision.current += 1;
      if (typeof actual.allowCommands === "boolean") setAllowCommands(actual.allowCommands);
      if (typeof actual.allowShellCommands === "boolean") setAllowShellCommands(actual.allowShellCommands);
      try { const tools = await toolsApi.list(); if (alive.current) setToolsList(tools); }
      catch { /* The accepted permission remains valid if the registry refresh fails. */ }
    } catch {
      if (alive.current) pushToast(t("settings.saveFailed"), undefined, "destructive");
    } finally {
      permissionsPending.current = false;
      if (alive.current) setPermissionsBusy(false);
    }
  };

  const resetSection = (name: string) => {
    if (resetArmed !== name) {
      setResetArmed(name);
      return;
    }
    setResetArmed(null);
    if (!isServerMode()) return;
    void (async () => {
      try {
        const s = await loadSettingsWithUiPreferences(async () => {
          await settingsApi.reset(name);
          return loadServerSettings();
        });
        if (s) applySettings(s);
        pushToast(t("settings.reset.done"));
      } catch {
        pushToast(t("settings.saveFailed") ?? "Save failed", undefined, "destructive");
      }
    })();
  };

  const copySnapshot = () => {
    if (!isServerMode()) return;
    void (async () => {
      const s = await loadServerSettings();
      if (!s) {
        pushToast(t("settings.saveFailed") ?? "Save failed", undefined, "destructive");
        return;
      }
      // Settings rows never hold secrets (keys live in DPAPI files), so the
      // snapshot is safe to paste into an issue or a doc.
      try {
        if (!navigator.clipboard) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(JSON.stringify(s, null, 2));
        pushToast(t("settings.snapshot.copied"));
      } catch {
        pushToast(t("settings.snapshot.copyFailed"), undefined, "destructive");
      }
    })();
  };

  const openWorkspace = () => {
    if (!isServerMode() || !window.aqvenor) {
      pushToast(t("settings.workspace.toast"));
      return;
    }
    void (async () => {
      const dir = await window.aqvenor!.pickFolder();
      if (!dir) return;
      try {
        const root = await openWorkspaceByPath(dir);
        if (!root) return;
        setWsRoot(root);
        setWsName(root.split(/[/\\]/).filter(Boolean).pop() ?? root);
        pushToast(t("settings.workspace.opened", root) ?? root);
      } catch (err) {
        pushToast(t("settings.workspace.failed") ?? "Cannot open that folder", err instanceof Error ? err.message : undefined, "destructive");
      }
    })();
  };
  /* WPF-parity allowlist validation shown under the textarea */
  const cmdTokens = tokenizeCommands(allowedCommands);
  const cmdDropped = droppedCommandTokens(cmdTokens);
  const cmdProblem = !allowCommands
    ? null
    : cmdDropped.length > 0
      ? t("settings.commands.warnDropped", cmdDropped.join(", "))
      : cmdTokens.length === 0
        ? t("settings.commands.warnEmpty")
        : null;

  const offline = !isServerMode();

  return (
    <div className="@container/settings h-full w-full min-h-0 min-w-0 overflow-hidden">
    <div className="flex h-full w-full min-h-0 min-w-0 flex-col @3xl/settings:flex-row @3xl/settings:gap-6">
      {/* category nav */}
      <nav
        aria-label={t("settings.title")}
        className="flex min-w-0 shrink-0 flex-col gap-3 border-b border-line-faint p-4 @3xl/settings:w-52 @3xl/settings:overflow-y-auto @3xl/settings:border-b-0 @3xl/settings:py-6 @3xl/settings:pl-6 @3xl/settings:pr-0"
      >
        <div className="relative mb-3">
          <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("settings.search.placeholder")}
            aria-label={t("settings.search.placeholder")}
            className="aq-focus-ring h-8 w-full min-w-0 rounded-sm border border-line bg-sunken pl-8 pr-8 text-[12px] text-fg-1 outline-none placeholder:text-fg-3"
          />
          {search && (
            <button type="button" onClick={() => setSearch("")} aria-label={t("settings.search.clear")} className="aq-focus-ring absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-sm text-fg-3 hover:bg-surface-hover hover:text-fg-1">
              <X size={12} aria-hidden />
              <span className="sr-only">{t("settings.search.clear")}</span>
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1 @3xl/settings:flex-col @3xl/settings:gap-px">
        {GROUPS.filter((group) => !query || group.sections.some(visible)).map((group) => (
          <button
            key={group.id}
            type="button"
            data-settings-category={group.id}
            aria-current={!query && selectedGroup === group.id ? "page" : undefined}
            onClick={() => selectGroup(group.id)}
            className={cn("aq-focus-ring rounded-sm px-2.5 py-2 text-left text-[12.5px] font-medium transition-colors", !query && selectedGroup === group.id ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-surface-hover hover:text-fg-1")}
          >
            {t(group.label)}
          </button>
        ))}
        </div>
        {matchCount === 0 && (
          <p className="px-2.5 py-2 text-[12px] text-fg-3">{t("settings.search.empty")}</p>
        )}
      </nav>

      {/* content */}
      <div ref={contentRef} className="@container/settings-content min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] space-y-8 px-4 py-6 @lg/settings-content:px-6">
          <div>
            <h1 className="text-[24px] font-semibold tracking-tight text-fg-1">{query ? t("settings.search.results") : t(currentGroup.label)}</h1>
            {!query && <p className="mt-1.5 text-[12px] leading-relaxed text-fg-3">{t(currentGroup.hint)}</p>}
          </div>
          {matchCount === 0 && (
            <p className="py-8 text-center text-[13px] text-fg-3">{t("settings.search.empty")}</p>
          )}

          {visible("general") && (
            <Section id="settings-general" overline={t("settings.nav.general")}>
              <AqCard className="px-4 py-3">
                <ToggleRow
                  label={t("settings.confirmDelete")}
                  checked={ui.confirmDelete}
                  onChange={(v) => { void setUiPreferences({ confirmDelete: v }); }}
                />
                <Divider />
                <ToggleRow
                  label={t("settings.autoTitles")}
                  checked={ui.autoTitles}
                  onChange={(v) => { void setUiPreferences({ autoTitles: v }); }}
                />
              </AqCard>
            </Section>
          )}

          {visible("appearance") && (
            <Section id="settings-appearance" overline={t("settings.appearance")} hint={t("settings.theme.hint")}>
              <AqCard className="@container/theme p-4">
                <div className="text-[13px] font-medium text-fg-1">{t("settings.theme")}</div>
                <div className="mt-2.5 grid grid-cols-1 gap-3 @min-[30rem]/theme:grid-cols-3">
                  <ThemeCard
                    mode="dark"
                    selected={ui.theme === "dark"}
                    onSelect={() => { void setUiPreferences({ theme: "dark" }); }}
                  />
                  <ThemeCard
                    mode="light"
                    selected={ui.theme === "light"}
                    onSelect={() => { void setUiPreferences({ theme: "light" }); }}
                  />
                  <ThemeCard
                    mode="system"
                    selected={ui.theme === "system"}
                    onSelect={() => { void setUiPreferences({ theme: "system" }); }}
                  />
                </div>

                <Divider className="my-4" />

                <Row label={t("settings.sidebarWidth")}>
                  <div className="flex items-center gap-3">
                    <Slider
                      className="min-w-0 w-36 @min-[30rem]/setting-row:w-44"
                      min={200}
                      max={420}
                      step={2}
                      value={[ui.sidebarWidth]}
                      onValueChange={([v]) => setUi({ sidebarWidth: v })}
                      aria-label={t("settings.sidebarWidth")}
                    />
                    <span className="w-11 shrink-0 text-right font-mono text-[11px] text-fg-3">
                      {ui.sidebarWidth}px
                    </span>
                  </div>
                </Row>
              </AqCard>
            </Section>
          )}

          {visible("interface") && (
            <Section id="settings-interface" overline={t("settings.interface")}>
              <AqCard className="px-4 py-3">
                <ToggleRow
                  label={t("settings.enterSend")}
                  checked={ui.enterSend}
                  onChange={(v) => { void setUiPreferences({ enterSend: v }); }}
                />
                <Divider />
                <ToggleRow
                  label={t("settings.autoscroll")}
                  checked={ui.autoscroll}
                  onChange={(v) => { void setUiPreferences({ autoscroll: v }); }}
                />
                <Divider />
                <Row label={t("settings.appScale")}>
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    {APP_ZOOM_PRESETS.map((z) => {
                      const active = Math.abs((ui.appZoom ?? 1) - z) < 0.001;
                      return (
                        <button
                          key={z}
                          type="button"
                          onClick={() => {
                            setUi({ appZoom: z });
                            applyAppZoom(z);
                          }}
                          aria-pressed={active}
                          className={cn(
                            "aq-focus-ring h-7 rounded-sm border px-2.5 text-[12px] font-medium tabular-nums transition-colors duration-100",
                            active
                              ? "border-accent-border bg-accent-soft text-accent"
                              : "border-line-faint text-fg-2 hover:border-line hover:bg-surface-hover hover:text-fg-1",
                          )}
                        >
                          {Math.round(z * 100)}%
                        </button>
                      );
                    })}
                  </div>
                </Row>
              </AqCard>
            </Section>
          )}

          {visible("language") && (
            <Section id="settings-language" overline={t("settings.nav.language")}>
              <AqCard className="p-4">
                <Row label={t("language")}>
                  <div className="flex flex-wrap gap-1.5">
                    {(Object.keys(LOCALE_LABELS) as Locale[]).map((loc) => (
                      <button
                        key={loc}
                        type="button"
                        onClick={() => { void setUiPreferences({ locale: loc }); }}
                        aria-pressed={ui.locale === loc}
                        className={cn(
                          "aq-focus-ring h-7 rounded-sm border px-3 text-[12px] font-medium transition-colors duration-100",
                          ui.locale === loc
                            ? "border-accent-border bg-accent-soft text-accent"
                            : "border-line-faint text-fg-2 hover:border-line hover:bg-surface-hover hover:text-fg-1",
                        )}
                      >
                        {LOCALE_LABELS[loc]}
                      </button>
                    ))}
                  </div>
                </Row>
              </AqCard>
            </Section>
          )}

          {visible("models") && (
            <Section id="settings-models" overline={t("settings.nav.models")} hint={t("settings.models.hint")}>
              <div className="[&>div>div:last-child]:max-w-full [&>div>div:last-child]:flex-wrap">
                <ProviderStudioLauncher />
              </div>
              <Disclosure title={t("settings.sampling")} forceOpen={!!query}>
              <AqCard className="px-4 py-3">
                <Row label={t("settings.temperature")}>
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={tempEnabled}
                      onCheckedChange={(v) => {
                        setTempEnabled(v);
                        saveSoon("chat", { temperature: v ? temperature : null });
                      }}
                      aria-label={t("settings.sampling.off")}
                      title={t("settings.sampling.off")}
                    />
                    <Slider
                      className="min-w-0 w-36 @min-[30rem]/setting-row:w-44"
                      min={0}
                      max={2}
                      step={0.1}
                      disabled={!tempEnabled}
                      value={[temperature]}
                      onValueChange={([v]) => {
                        setTemperature(v);
                        saveSoon("chat", { temperature: v });
                      }}
                      aria-label={t("settings.temperature")}
                    />
                    <span className="w-11 shrink-0 text-right font-mono text-[11px] text-fg-3">
                      {tempEnabled ? fmtDec(temperature, t.locale) : t("settings.sampling.off")}
                    </span>
                  </div>
                </Row>
                <Divider />
                <Row label={t("settings.topP")}>
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={topPEnabled}
                      onCheckedChange={(v) => {
                        setTopPEnabled(v);
                        saveSoon("chat", { topP: v ? topP : null });
                      }}
                      aria-label={t("settings.sampling.off")}
                      title={t("settings.sampling.off")}
                    />
                    <Slider
                      className="min-w-0 w-36 @min-[30rem]/setting-row:w-44"
                      min={0}
                      max={1}
                      step={0.05}
                      disabled={!topPEnabled}
                      value={[topP]}
                      onValueChange={([v]) => {
                        setTopP(v);
                        saveSoon("chat", { topP: v });
                      }}
                      aria-label={t("settings.topP")}
                    />
                    <span className="w-11 shrink-0 text-right font-mono text-[11px] text-fg-3">
                      {topPEnabled ? fmtDec(topP, t.locale) : t("settings.sampling.off")}
                    </span>
                  </div>
                </Row>
                <Divider />
                <Row label={t("settings.maxTokens")}>
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={tokensEnabled}
                      onCheckedChange={(v) => {
                        setTokensEnabled(v);
                        const n = parseInt(maxTokens, 10);
                        saveSoon("chat", { maxTokens: v && Number.isFinite(n) && n > 0 ? n : null });
                      }}
                      aria-label={t("settings.sampling.off")}
                      title={t("settings.sampling.off")}
                    />
                    <input
                      type="number"
                      min={256}
                      step={256}
                      disabled={!tokensEnabled}
                      value={maxTokens}
                      onChange={(e) => {
                        setMaxTokens(e.target.value);
                        const n = parseInt(e.target.value, 10);
                        if (Number.isFinite(n) && n > 0) saveSoon("chat", { maxTokens: n });
                      }}
                      aria-label={t("settings.maxTokens")}
                      className="aq-focus-ring h-7 w-24 rounded-sm border border-line bg-sunken px-2.5 text-right font-mono text-[12px] text-fg-1 disabled:opacity-50"
                    />
                  </div>
                </Row>
              </AqCard>
              </Disclosure>
            </Section>
          )}

          {visible("agent") && (
            <Section id="settings-agent" overline={t("settings.agent")}>
              <AqCard className="px-4 py-3">
                <Row label={t("settings.agent.allowSubagents")} hint={t("settings.agent.subagentsHint")}>
                  <Switch checked={allowSubagents} disabled={!isServerMode()} aria-label={t("settings.agent.allowSubagents")} onCheckedChange={(value) => { setAllowSubagents(value); saveSoon("agent", { allowSubagents: value }); }} />
                </Row>
                <Divider />
                <Row label={t("settings.maxSteps")}>
                  <div className="flex items-center gap-3">
                    <Slider
                      className="min-w-0 w-36 @min-[30rem]/setting-row:w-44"
                      min={1}
                      max={100}
                      step={1}
                      value={[ui.maxSteps]}
                      onValueChange={([v]) => {
                        const rounded = Math.round(v);
                        setUi({ maxSteps: rounded });
                        saveSoon("agent", { maxSteps: rounded });
                      }}
                      aria-label={t("settings.maxSteps")}
                    />
                    <span className="w-11 shrink-0 text-right font-mono text-[11px] text-fg-3">
                      {ui.maxSteps}
                    </span>
                  </div>
                </Row>
                <Divider />
                <Row label={t("settings.timeLimit")} hint={t("settings.timeLimit.hint")}>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={timeLimit}
                      onChange={(e) => {
                        setTimeLimit(e.target.value);
                        const n = parseInt(e.target.value, 10);
                        if (Number.isFinite(n) && n >= 0) saveSoon("agent", { maxDurationSeconds: n * 60 });
                      }}
                      aria-label={t("settings.timeLimit")}
                      className="aq-focus-ring h-7 w-20 rounded-sm border border-line bg-sunken px-2.5 text-right font-mono text-[12px] text-fg-1"
                    />
                    <span className="text-[11px] text-fg-3">{t("settings.minutes")}</span>
                  </div>
                </Row>
                <Divider />
                <Row label={t("settings.maxIdentical")}>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      step={1}
                      value={maxIdentical}
                      onChange={(e) => {
                        setMaxIdentical(e.target.value);
                        const n = parseInt(e.target.value, 10);
                        if (Number.isFinite(n)) saveSoon("agent", { maxIdenticalCalls: clampInt(n, 0, 1000) });
                      }}
                      aria-label={t("settings.maxIdentical")}
                      className="aq-focus-ring h-7 w-20 rounded-sm border border-line bg-sunken px-2.5 text-right font-mono text-[12px] text-fg-1"
                    />
                    <span className="text-[11px] text-fg-3">{t("settings.maxIdentical.unit")}</span>
                  </div>
                </Row>
              </AqCard>

              <Disclosure title={t("settings.budgets")} forceOpen={!!query}>
                <p className="text-[12px] leading-snug text-fg-3">{t("settings.budgets.hint")}</p>
                <AqCard className="px-4 py-3">
                  <Row label={t("settings.maxFile")}>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        step={64}
                        value={maxFileKB}
                        onChange={(e) => {
                          setMaxFileKB(e.target.value);
                          const n = parseInt(e.target.value, 10);
                          if (Number.isFinite(n) && n > 0) saveSoon("agent", { maxFileBytes: clampInt(n, 1, 102400) * 1024 });
                        }}
                        aria-label={t("settings.maxFile")}
                        className="aq-focus-ring h-7 w-24 rounded-sm border border-line bg-sunken px-2.5 text-right font-mono text-[12px] text-fg-1"
                      />
                      <span className="text-[11px] text-fg-3">KB</span>
                    </div>
                  </Row>
                  <Divider />
                  <Row label={t("settings.maxReadChars")}>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1000}
                        step={1000}
                        value={maxReadChars}
                        onChange={(e) => {
                          setMaxReadChars(e.target.value);
                          const n = parseInt(e.target.value, 10);
                          if (Number.isFinite(n)) saveSoon("agent", { maxReadCharacters: clampInt(n, 1000, 10000000) });
                        }}
                        aria-label={t("settings.maxReadChars")}
                        className="aq-focus-ring h-7 w-24 rounded-sm border border-line bg-sunken px-2.5 text-right font-mono text-[12px] text-fg-1"
                      />
                      <span className="text-[11px] text-fg-3">{t("settings.commands.chars")}</span>
                    </div>
                  </Row>
                  <Divider />
                  <Row label={t("settings.maxList")}>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        max={10000}
                        step={50}
                        value={maxListEntries}
                        onChange={(e) => {
                          setMaxListEntries(e.target.value);
                          const n = parseInt(e.target.value, 10);
                          if (Number.isFinite(n)) saveSoon("agent", { maxListEntries: clampInt(n, 1, 10000) });
                        }}
                        aria-label={t("settings.maxList")}
                        className="aq-focus-ring h-7 w-20 rounded-sm border border-line bg-sunken px-2.5 text-right font-mono text-[12px] text-fg-1"
                      />
                      <span className="text-[11px] text-fg-3">{t("settings.maxList.unit")}</span>
                    </div>
                  </Row>
                  <Divider />
                  <Row label={t("settings.maxSearch")}>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        max={5000}
                        step={25}
                        value={maxSearchResults}
                        onChange={(e) => {
                          setMaxSearchResults(e.target.value);
                          const n = parseInt(e.target.value, 10);
                          if (Number.isFinite(n)) saveSoon("agent", { maxSearchResults: clampInt(n, 1, 5000) });
                        }}
                        aria-label={t("settings.maxSearch")}
                        className="aq-focus-ring h-7 w-20 rounded-sm border border-line bg-sunken px-2.5 text-right font-mono text-[12px] text-fg-1"
                      />
                      <span className="text-[11px] text-fg-3">{t("settings.maxSearch.unit")}</span>
                    </div>
                  </Row>
                  <Divider />
                  <Row label={t("settings.commands.timeout")}>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={5}
                        max={3600}
                        step={5}
                        value={commandTimeout}
                        onChange={(e) => {
                          setCommandTimeout(e.target.value);
                          const n = parseInt(e.target.value, 10);
                          if (Number.isFinite(n)) saveSoon("agent", { commandTimeoutSeconds: clampInt(n, 5, 3600) });
                        }}
                        aria-label={t("settings.commands.timeout")}
                        className="aq-focus-ring h-7 w-20 rounded-sm border border-line bg-sunken px-2.5 text-right font-mono text-[12px] text-fg-1"
                      />
                      <span className="text-[11px] text-fg-3">{t("settings.commands.sec")}</span>
                    </div>
                  </Row>
                  <Divider />
                  <Row label={t("settings.commands.maxOutput")}>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1000}
                        max={200000}
                        step={1000}
                        value={maxCmdOutput}
                        onChange={(e) => {
                          setMaxCmdOutput(e.target.value);
                          const n = parseInt(e.target.value, 10);
                          if (Number.isFinite(n)) saveSoon("agent", { maxCommandOutputCharacters: clampInt(n, 1000, 200000) });
                        }}
                        aria-label={t("settings.commands.maxOutput")}
                        className="aq-focus-ring h-7 w-24 rounded-sm border border-line bg-sunken px-2.5 text-right font-mono text-[12px] text-fg-1"
                      />
                      <span className="text-[11px] text-fg-3">{t("settings.commands.chars")}</span>
                    </div>
                  </Row>
                  <Divider />
                  <Row label={t("settings.network.timeout")}>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={5}
                        max={300}
                        step={5}
                        value={fetchTimeout}
                        onChange={(e) => {
                          setFetchTimeout(e.target.value);
                          const n = parseInt(e.target.value, 10);
                          if (Number.isFinite(n)) saveSoon("agent", { fetchTimeoutSeconds: clampInt(n, 5, 300) });
                        }}
                        aria-label={t("settings.network.timeout")}
                        className="aq-focus-ring h-7 w-20 rounded-sm border border-line bg-sunken px-2.5 text-right font-mono text-[12px] text-fg-1"
                      />
                      <span className="text-[11px] text-fg-3">{t("settings.commands.sec")}</span>
                    </div>
                  </Row>
                  <Divider />
                  <Row label={t("settings.network.maxResponse")}>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1000}
                        max={200000}
                        step={1000}
                        value={maxFetch}
                        onChange={(e) => {
                          setMaxFetch(e.target.value);
                          const n = parseInt(e.target.value, 10);
                          if (Number.isFinite(n)) saveSoon("agent", { maxFetchResponseCharacters: clampInt(n, 1000, 200000) });
                        }}
                        aria-label={t("settings.network.maxResponse")}
                        className="aq-focus-ring h-7 w-24 rounded-sm border border-line bg-sunken px-2.5 text-right font-mono text-[12px] text-fg-1"
                      />
                      <span className="text-[11px] text-fg-3">{t("settings.commands.chars")}</span>
                    </div>
                  </Row>
                </AqCard>
              </Disclosure>
            </Section>
          )}

          {visible("permissions") && (
            <Section id="settings-permissions" collapsed forceOpen={!!query} overline={t("settings.nav.permissions")} hint={t("settings.permissions.hint")}>
              <AqCard className="px-4 py-3">
                <Row label={t("settings.commands.allow")} hint={permissionsAvailable ? t("settings.commands.allowWarn") : t("settings.capabilitiesUnavailable")}>
                  <span className="inline-flex items-center gap-2">
                    {permissionsBusy && <Loader2 size={12} className="animate-spin text-fg-2" aria-hidden />}
                    <Switch checked={allowCommands} disabled={!permissionsAvailable || permissionsBusy} aria-busy={permissionsBusy} aria-label={t("settings.commands.allow")} onCheckedChange={(value) => void requestPermissions({ allowCommands: value })} />
                  </span>
                </Row>
                <Divider />
                <Row label={t("settings.commands.allowShell")} hint={t("settings.commands.allowShellHint")}>
                  <Switch checked={allowShellCommands} disabled={!permissionsAvailable || permissionsBusy || !allowCommands} aria-busy={permissionsBusy} aria-label={t("settings.commands.allowShell")} onCheckedChange={(value) => void requestPermissions({ allowShellCommands: value })} />
                </Row>
                <Divider />
                <LockedRow
                  label={t("settings.network.allow")}
                  checked={allowNetwork}
                  hint={t("settings.network.allowWarn")}
                />
                <Divider />
                <LockedRow
                  label={t("settings.external.allow")}
                  checked={allowExternalFiles}
                  hint={t("settings.external.allowWarn")}
                />
                <Divider />
                <div className="py-2.5 first:pt-0 last:pb-0">
                  <div className="text-[13px] font-medium text-fg-1">{t("settings.commands.allowed")}</div>
                  <p className="mt-1 text-[11.5px] leading-snug text-fg-3">{t("settings.locked.listNote")}</p>
                  <div className="mt-2 rounded-sm border border-line bg-sunken p-2.5 font-mono text-[12px] leading-relaxed text-fg-2">
                    {allowedCommands || "—"}
                  </div>
                  {cmdProblem ? (
                    <div className="mt-2 flex items-start gap-2 text-[11.5px] leading-snug text-warning">
                      <AlertTriangle size={13} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden />
                      <span>{cmdProblem}</span>
                    </div>
                  ) : null}
                </div>
              </AqCard>

              <div className="space-y-3">
                <div>
                  <Overline>{t("settings.policy")}</Overline>
                  <p className="mt-1.5 text-[12px] leading-snug text-fg-3">{t("settings.policy.hint")}</p>
                </div>
                <AqCard className="px-4 py-3">
                  <Row label={t("settings.policy.execute")}>
                    <span className="text-[11.5px] text-fg-3">{t("settings.policy.execute.desc")}</span>
                  </Row>
                  <Divider />
                  <Row label={t("settings.policy.write")}>
                    <span className="text-[11.5px] text-fg-3">{t("settings.policy.write.desc")}</span>
                  </Row>
                  <Divider />
                  <Row label={t("settings.policy.read")}>
                    <span className="text-[11.5px] text-fg-3">{t("settings.policy.read.desc")}</span>
                  </Row>
                  <Divider />
                  <Row label={t("settings.policy.full")}>
                    <span className="text-[11.5px] text-fg-3">{t("settings.policy.full.desc")}</span>
                  </Row>
                </AqCard>
              </div>

              <p className="flex items-start gap-2 text-[12px] leading-snug text-fg-3">
                <Lock size={12} className="mt-0.5 shrink-0" aria-hidden />
                <span>{t("settings.locked.note")}</span>
              </p>
            </Section>
          )}

          {visible("tools") && (
            <Section id="settings-tools" collapsed forceOpen={!!query} overline={t("settings.toolsRegistry")}>
              <AqCard className="px-4 py-3">
                <div className="text-[13px] font-medium text-fg-1">{t("settings.toolsRegistry")}</div>
                {offline ? (
                  <p className="mt-1.5 text-[12px] leading-snug text-fg-3">{t("settings.unavailable")}</p>
                ) : toolsList === null ? (
                  <p className="mt-1.5 text-[12px] leading-snug text-fg-3">…</p>
                ) : (
                  <div className="mt-2 flex flex-col gap-1">
                    {toolsList.map((tool) => (
                      <div
                        key={tool.name}
                        className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-xs px-2 py-1.5 hover:bg-surface-hover"
                      >
                        <span className="shrink-0 font-mono text-[12px] text-fg-1">{tool.name}</span>
                        <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-3" title={tool.description}>
                          {tool.description}
                        </span>
                        <span className="shrink-0 font-mono text-[10.5px] uppercase tracking-wide text-fg-3">
                          {tool.risk}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </AqCard>

            </Section>
          )}

          {visible("mcp") && (
            <Section id="settings-mcp" overline={t("settings.nav.mcp")}>
              <p className="text-[12px] leading-snug text-fg-3">{t("settings.mcp.hint")}</p>
              <div className="@container/integrations">
                <div className="[&_.grid]:grid-cols-1 @xl/integrations:[&_.grid]:grid-cols-3 [&_input]:min-w-0 [&_input]:max-w-full">
                  <McpSettings />
                </div>
              </div>
            </Section>
          )}

          {visible("context") && (
            <Section id="settings-context" overline={t("settings.nav.context")}>
              <AqCard className="p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="text-[13px] font-medium text-fg-1">{t("settings.systemPrompt")}</span>
                  <span className="text-[11px] text-fg-3">{t("settings.systemPrompt.hint")}</span>
                </div>
                <textarea
                  value={systemPrompt}
                  onChange={(e) => {
                    setSystemPrompt(e.target.value);
                    saveSoon("chat", { systemPrompt: e.target.value });
                  }}
                  rows={3}
                  spellCheck={false}
                  aria-label={t("settings.systemPrompt")}
                  className="aq-focus-ring mt-2 w-full resize-y rounded-sm border border-line bg-sunken p-2.5 font-mono text-[12.5px] leading-relaxed text-fg-1"
                />

                <Divider className="my-4" />

                <ToggleRow
                  label={t("settings.autoCompact")}
                  checked={autoCompact}
                  onChange={(v) => {
                    setAutoCompact(v);
                    saveSoon("chat", { autoCompact: v });
                  }}
                />
                <Divider />
                <Row label={t("settings.compactAt")}>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={10}
                      max={100}
                      step={1}
                      value={compactPct}
                      onChange={(e) => {
                        setCompactPct(e.target.value);
                        const n = parseInt(e.target.value, 10);
                        if (Number.isFinite(n)) saveSoon("chat", { compactAtPercent: clampInt(n, 10, 100) });
                      }}
                      aria-label={t("settings.compactAt")}
                      className="aq-focus-ring h-7 w-20 rounded-sm border border-line bg-sunken px-2.5 text-right font-mono text-[12px] text-fg-1"
                    />
                    <span className="text-[11px] text-fg-3">%</span>
                  </div>
                </Row>
                <Divider />
                <Row label={t("settings.keepRecent")}>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={keepRecent}
                      onChange={(e) => {
                        setKeepRecent(e.target.value);
                        const n = parseInt(e.target.value, 10);
                        if (Number.isFinite(n)) saveSoon("chat", { compactKeepRecentMessages: clampInt(n, 0, 100) });
                      }}
                      aria-label={t("settings.keepRecent")}
                      className="aq-focus-ring h-7 w-20 rounded-sm border border-line bg-sunken px-2.5 text-right font-mono text-[12px] text-fg-1"
                    />
                  </div>
                </Row>
                <Divider />
                <Row label={t("settings.historyCap")}>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={2}
                      max={1000}
                      step={1}
                      value={historyCap}
                      onChange={(e) => {
                        setHistoryCap(e.target.value);
                        const n = parseInt(e.target.value, 10);
                        if (Number.isFinite(n)) saveSoon("chat", { maxHistoryMessages: clampInt(n, 2, 1000) });
                      }}
                      aria-label={t("settings.historyCap")}
                      className="aq-focus-ring h-7 w-20 rounded-sm border border-line bg-sunken px-2.5 text-right font-mono text-[12px] text-fg-1"
                    />
                  </div>
                </Row>
              </AqCard>

              <div className="space-y-3">
                <div>
                  <Overline>{t("settings.attachments")}</Overline>
                  <p className="mt-1.5 text-[12px] leading-snug text-fg-3">{t("settings.attachments.hint")}</p>
                </div>
                <AqCard className="px-4 py-3">
                  <Row label={t("settings.maxAttachmentKB")}>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        step={64}
                        value={attachKB}
                        onChange={(e) => {
                          setAttachKB(e.target.value);
                          const n = parseInt(e.target.value, 10);
                          if (Number.isFinite(n) && n > 0) saveSoon("storage", { maxAttachmentBytes: clampInt(n, 1, 102400) * 1024 });
                        }}
                        aria-label={t("settings.maxAttachmentKB")}
                        className="aq-focus-ring h-7 w-24 rounded-sm border border-line bg-sunken px-2.5 text-right font-mono text-[12px] text-fg-1"
                      />
                      <span className="text-[11px] text-fg-3">KB</span>
                    </div>
                  </Row>
                  <Divider />
                  <Row label={t("settings.maxAttachmentChars")}>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1000}
                        step={1000}
                        value={attachChars}
                        onChange={(e) => {
                          setAttachChars(e.target.value);
                          const n = parseInt(e.target.value, 10);
                          if (Number.isFinite(n)) saveSoon("storage", { maxAttachmentCharacters: clampInt(n, 1000, 10000000) });
                        }}
                        aria-label={t("settings.maxAttachmentChars")}
                        className="aq-focus-ring h-7 w-24 rounded-sm border border-line bg-sunken px-2.5 text-right font-mono text-[12px] text-fg-1"
                      />
                      <span className="text-[11px] text-fg-3">{t("settings.commands.chars")}</span>
                    </div>
                  </Row>
                </AqCard>
              </div>
            </Section>
          )}

          {visible("workspace") && (
            <Section id="settings-workspace" overline={t("settings.workspace")}>
              <AqCard className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5 first:pt-0 last:pb-0">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-line bg-surface-hover text-fg-2"
                      aria-hidden
                    >
                      <FolderOpen size={14} strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium leading-tight text-fg-1">
                        {wsName ?? t("settings.workspace.none")}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[10.5px] leading-tight text-fg-3">
                        {wsRoot ?? t("settings.workspace.noneHint")}
                      </div>
                    </div>
                  </div>
                  <AqGhostButton className="ml-auto" onClick={openWorkspace}>
                    {t("settings.workspace.openFolder")}
                  </AqGhostButton>
                </div>

                <Divider />

                <Row label={t("settings.indexNodes")} hint={t("settings.indexNodes.hint")}>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={100}
                      max={200000}
                      step={1000}
                      value={indexNodes}
                      onChange={(e) => {
                        setIndexNodes(e.target.value);
                        const n = parseInt(e.target.value, 10);
                        if (Number.isFinite(n)) saveSoon("canvas", { maxIndexedNodes: clampInt(n, 100, 200000) });
                      }}
                      aria-label={t("settings.indexNodes")}
                      className="aq-focus-ring h-7 w-24 rounded-sm border border-line bg-sunken px-2.5 text-right font-mono text-[12px] text-fg-1"
                    />
                  </div>
                </Row>
                <Divider />
                <Row label={t("settings.contextShare")} hint={t("settings.contextShare.hint")}>
                  <div className="flex items-center gap-3">
                    <Slider
                      className="min-w-0 w-36 @min-[30rem]/setting-row:w-44"
                      min={5}
                      max={100}
                      step={5}
                      value={[numOr(contextSharePct, 40)]}
                      onValueChange={([v]) => {
                        const rounded = Math.round(v);
                        setContextSharePct(String(rounded));
                        saveSoon("canvas", { maxContextShare: rounded / 100 });
                      }}
                      aria-label={t("settings.contextShare")}
                    />
                    <span className="w-11 shrink-0 text-right font-mono text-[11px] text-fg-3">
                      {contextSharePct}%
                    </span>
                  </div>
                </Row>
              </AqCard>
            </Section>
          )}

          {visible("shortcuts") && (
            <Section id="settings-shortcuts" collapsed forceOpen={!!query} overline={t("settings.shortcuts")} hint={t("settings.shortcuts.hint")}>
              <AqCard className="px-4 py-3">
                {SHORTCUTS.map((sc, i) => (
                  <Fragment key={sc.action}>
                    {i > 0 && <Divider />}
                    <div className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0">
                      <span className="min-w-0 truncate text-[13px] text-fg-2">{t(sc.action)}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        {sc.keys.map((k) => (
                          <Keycap key={k}>{k}</Keycap>
                        ))}
                      </span>
                    </div>
                  </Fragment>
                ))}
              </AqCard>
            </Section>
          )}

          {visible("data") && (
            <Section id="settings-data" collapsed forceOpen={!!query} overline={t("settings.nav.data")}>
              <AqCard className="p-4">
                <div className="text-[13px] font-medium text-fg-1">{t("settings.dataPaths")}</div>
                {offline || !metaInfo ? (
                  <p className="mt-1.5 text-[12px] leading-snug text-fg-3">{t("settings.unavailable")}</p>
                ) : (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {(
                      [
                        ["settings.path.data", metaInfo.data],
                        ["settings.path.db", metaInfo.db],
                        ["settings.path.logs", metaInfo.logs],
                        ["settings.path.attachments", metaInfo.attachments],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                        <span className="text-[12px] text-fg-2">{t(label)}</span>
                        <span className="max-w-full truncate font-mono text-[11px] text-fg-3" title={value ?? ""}>
                          {value ?? "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <Divider className="my-4" />

                <Row label={t("settings.logLevel")} hint={t("settings.restartNote")}>
                  <select
                    value={logLevel}
                    onChange={(e) => {
                      setLogLevel(e.target.value);
                      saveSoon("storage", { minimumLogLevel: e.target.value });
                    }}
                    aria-label={t("settings.logLevel")}
                    className="aq-focus-ring h-7 rounded-sm border border-line bg-sunken px-2 text-[12px] text-fg-1"
                  >
                    {["Trace", "Debug", "Information", "Warning", "Error"].map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                </Row>
                <Divider />
                <Row label={t("settings.logRetention")} hint={t("settings.restartNote")}>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={365}
                      step={1}
                      value={logDays}
                      onChange={(e) => {
                        setLogDays(e.target.value);
                        const n = parseInt(e.target.value, 10);
                        if (Number.isFinite(n)) saveSoon("storage", { logRetentionDays: clampInt(n, 1, 365) });
                      }}
                      aria-label={t("settings.logRetention")}
                      className="aq-focus-ring h-7 w-20 rounded-sm border border-line bg-sunken px-2.5 text-right font-mono text-[12px] text-fg-1"
                    />
                    <span className="text-[11px] text-fg-3">{t("settings.days")}</span>
                  </div>
                </Row>
              </AqCard>
            </Section>
          )}

          {visible("diagnostics") && (
            <Section id="settings-diagnostics" collapsed forceOpen={!!query} overline={t("settings.nav.diagnostics")}>
              <AqCard className="px-4 py-3">
                <Row label={t("settings.sidecarVersion")}>
                  <span className="font-mono text-[12px] text-fg-2">
                    {sidecarVersion ? `v${sidecarVersion}` : offline ? t("settings.unavailable") : "…"}
                  </span>
                </Row>
                <Divider />
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-fg-1">{t("settings.snapshot")}</div>
                    <div className="mt-0.5 text-[11.5px] leading-snug text-fg-3">{t("settings.snapshot.hint")}</div>
                  </div>
                  <AqGhostButton className="ml-auto" onClick={copySnapshot} disabled={offline}>
                    <Copy size={13} aria-hidden />
                    {t("settings.snapshot.copy")}
                  </AqGhostButton>
                </div>
              </AqCard>

              <div className="space-y-3">
                <div>
                  <Overline>{t("settings.reset")}</Overline>
                  <p className="mt-1.5 text-[12px] leading-snug text-fg-3">{t("settings.reset.hint")}</p>
                </div>
                <AqCard className="px-4 py-3">
                  {(
                    [
                      ["general", t("settings.nav.general")],
                      ["appearance", t("settings.appearance")],
                      ["chat", t("settings.chat")],
                      ["storage", t("settings.nav.storage")],
                      ["agent", t("settings.agent")],
                      ["canvas", t("settings.nav.canvas")],
                    ] as const
                  ).map(([name, label], i) => (
                    <Fragment key={name}>
                      {i > 0 && <Divider />}
                      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2 first:pt-0 last:pb-0">
                        <span className="text-[13px] text-fg-2">{label}</span>
                        <AqGhostButton
                          onClick={() => resetSection(name)}
                          disabled={offline}
                          aria-label={`${t("settings.resetOne")} — ${label}`}
                          className="text-error hover:bg-error-soft hover:text-error"
                        >
                          <RotateCcw size={13} aria-hidden />
                          {resetArmed === name ? t("settings.reset.confirm") : t("settings.resetOne")}
                        </AqGhostButton>
                      </div>
                    </Fragment>
                  ))}
                </AqCard>
              </div>
            </Section>
          )}

          {visible("updates") && (
            <Section id="settings-updates" overline={t("update.title")}>
              <UpdatesSettings />
            </Section>
          )}

          {visible("about") && (
            <Section id="settings-about" overline={t("settings.about")}>
              <AqCard className="p-4">
                <div className="flex items-center gap-3">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-accent text-on-accent"
                    aria-hidden
                  >
                    <Terminal size={15} strokeWidth={2} />
                  </span>
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-semibold leading-tight text-fg-1">
                      {t("app.name")}
                    </div>
                    <div className="mt-0.5 text-[11.5px] leading-tight text-fg-3">
                      {t("settings.version")} {APP_VERSION}
                    </div>
                  </div>
                </div>

                <Divider className="my-3.5" />

                <p className="text-[12px] leading-relaxed text-fg-2">{t("settings.about.line")}</p>
                <p className="mt-1.5 text-[12px] leading-relaxed text-fg-3">{t("settings.durability")}</p>

                {/* GitHub — opens the project page in the external browser via the
                   Electron bridge (shell.openExternal), with a plain-web fallback. */}
                <button
                  type="button"
                  onClick={() => {
                    const url = "https://github.com/rwarx/aqvenor";
                    if (window.aqvenor?.openExternal) void window.aqvenor.openExternal(url);
                    else window.open(url, "_blank", "noreferrer");
                  }}
                  title={t("settings.about.repo")}
                  className="aq-focus-ring mt-3 inline-flex items-center gap-1.5 rounded-xs text-[12px] font-medium text-accent transition-colors hover:underline"
                >
                  <Github size={14} strokeWidth={2} aria-hidden />
                  {t("settings.about.repo")}
                  <ArrowUpRight size={12} strokeWidth={2} aria-hidden />
                </button>
              </AqCard>
            </Section>
          )}
        </div>
      </div>
    </div>
    </div>
  );
}
