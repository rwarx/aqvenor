"use client";

import { useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Blocks,
  Check,
  Cpu,
  ExternalLink,
  Loader2,
  Orbit,
  Plus,
  RefreshCw,
  Route,
  Search,
  Server,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Waves,
  Wind,
  X,
  Zap,
} from "lucide-react";
import { useAqvenor } from "@/lib/aqvenor/store";
import { useT } from "@/lib/aqvenor/useT";
import { providers as providersApi } from "@/lib/aqvenor/backend";
import { isServerMode, refreshProviders } from "@/lib/aqvenor/sync";
import { CONNECT_PRESETS, type ConnectPreset } from "@/lib/aqvenor/data";
import type { Provider } from "@/lib/aqvenor/types";
import {
  AqBadge,
  AqGhostButton,
  AqPrimaryButton,
  AqToolButton,
  Overline,
  StatusDot,
} from "@/components/aqvenor/ui";

const PROVIDER_ICONS: Record<string, LucideIcon> = {
  openrouter: Route, nvidia: Cpu, openai: Sparkles, anthropic: Blocks,
  groq: Zap, xai: Orbit, mistral: Wind, deepseek: Waves,
};
const iconFor = (id: string): LucideIcon => PROVIDER_ICONS[id] ?? Server;

function openExternal(url: string) {
  if (window.aqvenor?.openExternal) void window.aqvenor.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
function EnableToggle({ on, busy, onToggle }: { on: boolean; busy: boolean; onToggle: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={busy} onClick={onToggle}
      className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-surface-4"} ${busy ? "opacity-50" : ""}`}>
      <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-all ${on ? "left-[16px]" : "left-[2px]"}`} aria-hidden />
    </button>
  );
}

/* Shared DPAPI key lifecycle — set → test → refresh, remove, test. */
function KeyField({ provider }: { provider: Provider }) {
  const t = useT();
  const setProviderState = useAqvenor((s) => s.setProviderState);
  const pushToast = useAqvenor((s) => s.pushToast);
  const [draft, setDraft] = useState("");
  const [keyed, setKeyed] = useState(provider.state === "connected");
  const busy = provider.state === "testing";
  /* A stored key must stay manageable even when its last test failed — a
     "failed" row still has a key in DPAPI, so keep Test/Remove reachable
     (otherwise the row is stuck offering only "add key" with no way out). */
  const hasKey = provider.state === "connected" || provider.state === "failed" || provider.state === "unknown" || (busy && keyed);

  const runTransition = (withKey: boolean) => {
    const key = draft.trim();
    if (withKey && !key) return;
    if (!isServerMode()) {
      setKeyed(true);
      setDraft("");
      setProviderState(provider.id, { state: "testing" });
      window.setTimeout(() => {
        setProviderState(provider.id, { state: "connected", statusMessage: t.p("providers.modelsCached", provider.models.length) });
        pushToast(t("providers.toast.connected", provider.name), t("providers.toast.connected.desc"));
      }, 900);
      return;
    }
    void (async () => {
      setProviderState(provider.id, { state: "testing" });
      try {
        if (withKey) { await providersApi.setKey(provider.id, key); setKeyed(true); setDraft(""); }
        const test = await providersApi.test(provider.id).catch(() => ({ success: false as boolean, message: undefined as string | undefined }));
        await refreshProviders().catch(() => undefined);
        const fresh = useAqvenor.getState().providers.find((p) => p.id === provider.id);
        const ok = test.success && (fresh?.state === "connected" || withKey);
        setProviderState(provider.id, { state: ok ? "connected" : "failed", statusMessage: ok ? (test.message ?? t.p("providers.modelsCached", fresh?.models.length ?? 0)) : (test.message ?? undefined) });
        if (ok) pushToast(t("providers.toast.connected", provider.name), t("providers.toast.connected.desc"));
        else pushToast(t("providers.failed"), test.message, "destructive");
      } catch (err) {
        setProviderState(provider.id, { state: "failed", statusMessage: undefined });
        pushToast(t("providers.failed"), err instanceof Error ? err.message : undefined, "destructive");
      }
    })();
  };
  const removeKey = () => {
    setKeyed(false);
    setDraft("");
    if (!isServerMode()) {
      setProviderState(provider.id, { state: "missing-key", statusMessage: undefined });
      pushToast(t("providers.toast.removed"), provider.name);
      return;
    }
    void (async () => {
      await providersApi.deleteKey(provider.id).catch(() => undefined);
      await refreshProviders().catch(() => undefined);
      setProviderState(provider.id, { state: "missing-key", statusMessage: undefined });
      pushToast(t("providers.toast.removed"), provider.name);
    })();
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {hasKey ? (
        <>
          <span className="rounded-xs border border-line bg-sunken px-2 py-1 font-mono text-[11px] text-fg-2">
            •••••••• · {t("providers.protected")}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <AqGhostButton onClick={() => runTransition(false)} disabled={busy}>{t("providers.test")}</AqGhostButton>
            <AqGhostButton onClick={removeKey} disabled={busy}>{t("providers.removeKey")}</AqGhostButton>
          </div>
        </>
      ) : (
        <>
          <input type="password" value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) runTransition(true); }}
            placeholder={t("providers.key")} disabled={busy} aria-label={`${provider.name} — ${t("providers.key")}`}
            className="aq-focus-ring h-7 min-w-0 flex-1 rounded-sm border border-line bg-sunken px-2.5 font-mono text-[12px] text-fg-1 placeholder:font-sans placeholder:text-fg-3 disabled:opacity-50" />
          <AqPrimaryButton onClick={() => runTransition(true)} disabled={busy || !draft.trim()}>{t("providers.addKey")}</AqPrimaryButton>
        </>
      )}
    </div>
  );
}
function ManageRow({ provider }: { provider: Provider }) {
  const t = useT();
  const setProviderState = useAqvenor((s) => s.setProviderState);
  const pushToast = useAqvenor((s) => s.pushToast);
  const selectedModelId = useAqvenor((s) => s.ui.selectedModelId);
  const setUi = useAqvenor((s) => s.setUi);
  const [expanded, setExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const Icon = iconFor(provider.id);
  const enabled = provider.enabled !== false;

  const dot =
    provider.state === "connected" ? { color: "success" as const, pulse: false }
    : provider.state === "testing" ? { color: "warning" as const, pulse: true }
    : provider.state === "failed" ? { color: "error" as const, pulse: false }
    : { color: "muted" as const, pulse: false };

  const toggleEnabled = () => {
    const next = !enabled;
    setProviderState(provider.id, { enabled: next });
    if (!isServerMode()) return;
    void providersApi.setEnabled(provider.id, next)
      .then(() => refreshProviders())
      .catch(() => {
        setProviderState(provider.id, { enabled: !next });
        pushToast(t("providerStudio.enableFailed"), provider.name, "destructive");
      });
  };

  const doRefresh = () => {
    setRefreshing(true);
    if (!isServerMode()) {
      window.setTimeout(() => { setRefreshing(false); pushToast(t("providerStudio.refreshed"), provider.name); }, 700);
      return;
    }
    void providersApi.refresh(provider.id)
      .then(() => refreshProviders())
      .then(() => pushToast(t("providerStudio.refreshed"), provider.name))
      .catch(() => pushToast(t("providers.failed"), provider.name, "destructive"))
      .finally(() => setRefreshing(false));
  };

  const removeCustom = () => {
    if (isServerMode()) void providersApi.removeCustom(provider.id).then(() => refreshProviders()).catch(() => undefined);
    else useAqvenor.setState({ providers: useAqvenor.getState().providers.filter((p) => p.id !== provider.id) });
    pushToast(t("providerStudio.removed"), provider.name);
  };

  const modelCount = provider.models.length;
  const canRemove = !provider.builtin;

  return (
    <div className={`rounded-md border border-line-faint bg-surface-2 transition-opacity ${enabled ? "" : "opacity-55"}`}>
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-line bg-sunken text-fg-2">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <button type="button" onClick={() => setExpanded((v) => !v)}
          className="aq-focus-ring flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium text-fg-1">{provider.name}</span>
            {canRemove && <AqBadge tone="neutral">{t("providerStudio.custom")}</AqBadge>}
          </span>
          <span className="flex items-center gap-1.5">
            <StatusDot color={dot.color} pulse={dot.pulse} />
            <span className="text-[11px] text-fg-3">
              {provider.state === "connected"
                ? t.p("providerStudio.modelCount", modelCount)
                : provider.state === "testing"
                  ? t("providers.testing")
                  : provider.state === "failed"
                    ? (provider.statusMessage ?? t("providers.failed"))
                    : provider.state === "unknown"
                      ? t("providers.untested")
                      : t("providers.missingKey")}
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <AqToolButton onClick={doRefresh} disabled={refreshing} title={t("providerStudio.refresh")} aria-label={t("providerStudio.refresh")}>
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
          </AqToolButton>
          {canRemove && (
            <AqToolButton onClick={removeCustom} title={t("providerStudio.removeProvider")} aria-label={t("providerStudio.removeProvider")}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </AqToolButton>
          )}
          <EnableToggle on={enabled} busy={false} onToggle={toggleEnabled} />
        </div>
      </div>

      {expanded && (
        <div className="border-t border-line-faint px-3 py-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <Overline>{t("providerStudio.apiKey")}</Overline>
            {provider.apiKeyUrl && (
              <button type="button" onClick={() => openExternal(provider.apiKeyUrl!)}
                className="aq-focus-ring inline-flex items-center gap-1 text-[11px] text-accent hover:underline">
                {t("providerStudio.getKey")}
                <ExternalLink className="h-3 w-3" aria-hidden />
              </button>
            )}
          </div>
          <KeyField provider={provider} />

          {modelCount > 0 && (
            <div className="mt-3">
              <Overline className="mb-1.5">{t("providerStudio.models")}</Overline>
              <div className="flex max-h-52 flex-col gap-0.5 overflow-y-auto">
                {provider.models.slice(0, 40).map((m) => {
                  const active = m.id === selectedModelId;
                  return (
                    <button key={m.id} type="button" onClick={() => setUi({ selectedModelId: m.id })}
                      className={`aq-focus-ring flex items-center justify-between gap-2 rounded-sm px-2 py-1 text-left transition-colors ${active ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-surface-hover"}`}>
                      <span className="truncate font-mono text-[11.5px]">{m.name}</span>
                      {active
                        ? <span className="flex shrink-0 items-center gap-1 text-[10px]"><Check className="h-3 w-3" aria-hidden />{t("providerStudio.defaultSet")}</span>
                        : <span className="shrink-0 font-mono text-[10px] text-fg-3">{m.contextK}K</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ManagePanel() {
  const t = useT();
  const providersList = useAqvenor((s) => s.providers);
  const setProviderStudioOpen = useAqvenor((s) => s.setProviderStudioOpen);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return providersList;
    return providersList.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
  }, [providersList, query]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={t("providerStudio.searchPlaceholder")} aria-label={t("providerStudio.searchPlaceholder")}
            className="aq-focus-ring h-8 w-full rounded-sm border border-line bg-sunken pl-8 pr-2.5 text-[12.5px] text-fg-1 placeholder:text-fg-3" />
        </div>
        <AqPrimaryButton onClick={() => setProviderStudioOpen(true, "connect")}>
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t("providerStudio.connectProvider")}
        </AqPrimaryButton>
      </div>
      {filtered.length === 0 ? (
        <p className="py-8 text-center text-[12.5px] text-fg-3">{t("providerStudio.empty", query.trim())}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((p) => <ManageRow key={p.id} provider={p} />)}
        </div>
      )}
    </div>
  );
}

function PresetCard({ preset, present, busy, onAdd, onManage }: {
  preset: ConnectPreset; present: boolean; busy: boolean; onAdd: () => void; onManage: () => void;
}) {
  const t = useT();
  const Icon = iconFor(preset.builtinId ?? "");
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-line-faint bg-surface-2 px-3 py-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-line bg-sunken text-fg-2">
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-fg-1">{preset.name}</span>
          {preset.local && <AqBadge tone="neutral">{t("providerStudio.local")}</AqBadge>}
        </span>
        <span className="truncate font-mono text-[10.5px] text-fg-3">{preset.baseUrl}</span>
      </div>
      {present ? (
        <AqGhostButton onClick={onManage}><Check className="h-3.5 w-3.5" aria-hidden />{t("providerStudio.alreadyAdded")}</AqGhostButton>
      ) : (
        <AqPrimaryButton onClick={onAdd} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
          {t("providerStudio.add")}
        </AqPrimaryButton>
      )}
    </div>
  );
}

function ConnectPanel() {
  const t = useT();
  const providersList = useAqvenor((s) => s.providers);
  const pushToast = useAqvenor((s) => s.pushToast);
  const setProviderStudioOpen = useAqvenor((s) => s.setProviderStudioOpen);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");

  const present = (preset: ConnectPreset) =>
    preset.builtinId
      ? providersList.some((p) => p.id === preset.builtinId)
      : providersList.some((p) => p.name.toLowerCase() === preset.name.toLowerCase());

  const addProvider = async (label: string, pname: string, burl: string, apiKeyUrl?: string, builtinId?: string) => {
    setBusyKey(label);
    try {
      if (!isServerMode()) {
        const id = builtinId ?? pname.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        if (!useAqvenor.getState().providers.some((p) => p.id === id)) {
          useAqvenor.setState((st) => ({
            providers: [...st.providers, {
              id, name: pname, endpoint: apiKeyUrl ?? burl, state: "missing-key" as const,
              models: [], builtin: false, enabled: true, apiKeyUrl,
            }],
          }));
        }
      } else {
        await providersApi.addCustom(pname, burl);
        await refreshProviders();
      }
      pushToast(t("providerStudio.added", pname));
      setProviderStudioOpen(true, "manage");
    } catch (err) {
      pushToast(t("providerStudio.addFailed"), err instanceof Error ? err.message : pname, "destructive");
    } finally {
      setBusyKey(null);
    }
  };

  const customs = providersList.filter((p) => !p.builtin);

  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={() => setProviderStudioOpen(true, "manage")}
        className="aq-focus-ring inline-flex w-fit items-center gap-1 text-[11.5px] text-fg-3 hover:text-fg-1">
        ← {t("common.back")}
      </button>

      <div>
        <Overline className="mb-2">{t("providerStudio.presetsTitle")}</Overline>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {CONNECT_PRESETS.map((preset) => (
            <PresetCard key={preset.name} preset={preset} present={present(preset)} busy={busyKey === preset.name}
              onAdd={() => void addProvider(preset.name, preset.name, preset.baseUrl, preset.apiKeyUrl, preset.builtinId)}
              onManage={() => setProviderStudioOpen(true, "manage")} />
          ))}
        </div>
      </div>

      <div>
        <Overline className="mb-2">{t("providerStudio.customTitle")}</Overline>
        <div className="flex flex-col gap-2 rounded-md border border-line-faint bg-surface-2 p-3">
          <div className="flex flex-col gap-1.5 sm:flex-row">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("providerStudio.name")}
              aria-label={t("providerStudio.name")}
              className="aq-focus-ring h-8 flex-1 rounded-sm border border-line bg-sunken px-2.5 text-[12.5px] text-fg-1 placeholder:text-fg-3" />
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={t("providerStudio.baseUrl")}
              aria-label={t("providerStudio.baseUrl")}
              className="aq-focus-ring h-8 flex-[1.4] rounded-sm border border-line bg-sunken px-2.5 font-mono text-[11.5px] text-fg-1 placeholder:font-sans placeholder:text-fg-3" />
          </div>
          <AqPrimaryButton className="w-fit" disabled={!name.trim() || !baseUrl.trim() || busyKey === "__manual__"}
            onClick={() => { const n = name.trim(); const b = baseUrl.trim(); if (n && b) void addProvider("__manual__", n, b).then(() => { setName(""); setBaseUrl(""); }); }}>
            {busyKey === "__manual__" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
            {t("providerStudio.add")}
          </AqPrimaryButton>
        </div>
      </div>

      {customs.length > 0 && (
        <div>
          <Overline className="mb-2">{t("providerStudio.existingCustom")}</Overline>
          <div className="flex flex-col gap-2">
            {customs.map((p) => <ManageRow key={p.id} provider={p} />)}
          </div>
        </div>
      )}
    </div>
  );
}

/* Compact entry point embedded on settings surfaces — opens the studio. */
export function ProviderStudioLauncher() {
  const t = useT();
  const providersList = useAqvenor((s) => s.providers);
  const setProviderStudioOpen = useAqvenor((s) => s.setProviderStudioOpen);
  const connected = providersList.filter((p) => p.state === "connected").length;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-line-faint bg-surface-2 px-4 py-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line bg-sunken text-accent">
        <Blocks className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 text-[13px] font-medium text-fg-1">
          {t("providerStudio.title")}
          <AqBadge tone={connected > 0 ? "success" : "neutral"}>{connected}/{providersList.length}</AqBadge>
        </span>
        <span className="truncate text-[11.5px] text-fg-3">{t("providerStudio.subtitle")}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <AqGhostButton onClick={() => setProviderStudioOpen(true, "connect")}>
          <Plus className="h-3.5 w-3.5" aria-hidden />{t("providerStudio.connectProvider")}
        </AqGhostButton>
        <AqPrimaryButton onClick={() => setProviderStudioOpen(true, "manage")}>
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />{t("providerStudio.tab.manage")}
        </AqPrimaryButton>
      </div>
    </div>
  );
}

export function ProviderStudio() {
  const open = useAqvenor((s) => s.providerStudioOpen);
  const tab = useAqvenor((s) => s.providerStudioTab);
  const setProviderStudioOpen = useAqvenor((s) => s.setProviderStudioOpen);
  const t = useT();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setProviderStudioOpen(false); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={t("providerStudio.title")}>
      <div className="absolute inset-0 bg-scrim backdrop-blur-[2px]" onClick={() => setProviderStudioOpen(false)} aria-hidden />
      <div className="relative flex max-h-[88vh] w-full max-w-[720px] animate-rise flex-col overflow-hidden rounded-xl border border-line bg-surface-1 shadow-overlay">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line bg-surface-2 text-accent">
            <Blocks className="h-4 w-4" aria-hidden />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[14px] font-semibold text-fg-1">{t("providerStudio.title")}</span>
            <span className="truncate text-[11.5px] text-fg-3">{t("providerStudio.subtitle")}</span>
          </div>
          <div className="flex items-center gap-1 rounded-md border border-line-faint bg-surface-2 p-0.5">
            <AqGhostButton active={tab !== "connect"} onClick={() => setProviderStudioOpen(true, "manage")}>
              <Server className="h-3.5 w-3.5" aria-hidden />{t("providerStudio.tab.manage")}
            </AqGhostButton>
            <AqGhostButton active={tab === "connect"} onClick={() => setProviderStudioOpen(true, "connect")}>
              <Plus className="h-3.5 w-3.5" aria-hidden />{t("providerStudio.tab.connect")}
            </AqGhostButton>
          </div>
          <button type="button" onClick={() => setProviderStudioOpen(false)} aria-label={t("common.close")}
            className="aq-focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-fg-3 hover:bg-surface-hover hover:text-fg-1">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {tab === "connect" ? <ConnectPanel /> : <ManagePanel />}
        </div>
      </div>
    </div>
  );
}
