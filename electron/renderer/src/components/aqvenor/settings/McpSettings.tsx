"use client";

import { Fragment, useEffect, useState } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  CircleAlert,
  CircleDot,
  Cpu,
  Globe,
  Image as ImageIcon,
  MonitorSmartphone,
  PlugZap,
  Plus,
  Trash2,
  Wrench,
} from "lucide-react";
import { useAqvenor } from "@/lib/aqvenor/store";
import { useT } from "@/lib/aqvenor/useT";
import { MCP_BUILTINS, probeMcpServers } from "@/lib/aqvenor/mcp";
import type { McpServerConfig } from "@/lib/aqvenor/types";
import { Divider, AqCard, Overline } from "@/components/aqvenor/ui";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const BUILTIN_ICONS: Record<string, React.ElementType> = {
  memory: Brain,
  thinking: Cpu,
  computer: MonitorSmartphone,
};

function StatusPill({ state }: { state: "connected" | "error" | "connecting" | "off" }) {
  const t = useT();
  const label = t(`mcp.state.${state}`);
  return (
    <span
      className={cn(
        "flex h-5 items-center gap-1.5 rounded-full border px-2 text-[10.5px] font-medium",
        state === "connected"
          ? "border-success/40 bg-success-soft/40 text-success"
          : state === "error"
            ? "border-error/40 bg-error-soft/40 text-error"
            : state === "connecting"
              ? "border-line-faint bg-sunken text-fg-3"
              : "border-line-faint bg-sunken text-fg-3",
      )}
    >
      {state === "connected" ? (
        <CircleDot size={9} aria-hidden />
      ) : state === "error" ? (
        <CircleAlert size={9} aria-hidden />
      ) : (
        <CircleDot size={9} className="animate-pulse-dot" aria-hidden />
      )}
      {label}
    </span>
  );
}

function ServerRow({ server }: { server: McpServerConfig }) {
  const t = useT();
  const status = useAqvenor((s) => s.mcpStatus[server.id]);
  const setEnabled = useAqvenor((s) => s.setMcpServerEnabled);
  const remove = useAqvenor((s) => s.removeMcpServer);
  const [open, setOpen] = useState(false);

  const state: "connected" | "error" | "connecting" | "off" = !server.enabled
    ? "off"
    : (status?.state ?? "connecting");
  const Icon = server.transport === "builtin" ? (BUILTIN_ICONS[server.target] ?? PlugZap) : Globe;

  return (
    <div className="py-2.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-xs border border-line bg-sunken text-fg-2">
            <Icon size={12} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-medium text-fg-1">{server.name}</span>
              <span className="shrink-0 rounded-xs border border-line-faint bg-sunken px-1.5 font-mono text-[9.5px] uppercase tracking-wide text-fg-3">
                {server.transport === "builtin" ? "built-in" : "http"}
              </span>
            </div>
            {server.transport === "http" && (
              <span className="block max-w-[320px] truncate font-mono text-[10px] text-fg-3" title={server.target}>
                {server.target}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <StatusPill state={state} />
          {(status?.tools?.length ?? 0) > 0 && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="aq-focus-ring flex h-6 items-center gap-1 rounded-xs border border-line-faint px-1.5 font-mono text-[10px] text-fg-3 transition-colors hover:border-line hover:text-fg-1"
              aria-expanded={open}
            >
              <Wrench size={9} aria-hidden />
              {status.tools.length}
              <ChevronDown size={9} className={cn("transition-transform", open && "rotate-180")} aria-hidden />
            </button>
          )}
          <Switch
            checked={server.enabled}
            onCheckedChange={(v) => setEnabled(server.id, v)}
            aria-label={server.name}
          />
          <button
            type="button"
            onClick={() => remove(server.id)}
            aria-label={t("mcp.remove")}
            title={t("mcp.remove")}
            className="aq-focus-ring flex h-6 w-6 items-center justify-center rounded-xs text-fg-3 transition-colors hover:bg-error-soft hover:text-error"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      {status?.error && (
        <p className="mt-1 text-[11px] leading-snug text-error">{status.error}</p>
      )}
      {open && (status?.tools?.length ?? 0) > 0 && (
        <div className="mt-2 flex flex-col gap-1 rounded-sm border border-line-faint bg-sunken p-1.5">
          {status.tools.map((tool) => (
            <div key={tool.name} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-1 py-0.5">
              <span className="shrink-0 font-mono text-[11px] text-fg-1">{tool.name}</span>
              <span className="min-w-0 flex-1 truncate text-[10.5px] text-fg-3" title={tool.description}>
                {tool.description}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function McpSettings() {
  const t = useT();
  const servers = useAqvenor((s) => s.mcpServers);
  const addServer = useAqvenor((s) => s.addMcpServer);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);

  /* re-probe whenever the set of enabled servers changes (install, toggle,
     remove) and once on mount */
  const enabledKey = servers.filter((s) => s.enabled).map((s) => s.id).join(",");
  useEffect(() => {
    if (enabledKey) void probeMcpServers();
  }, [enabledKey]);

  const installed = new Set(servers.filter((s) => s.transport === "builtin").map((s) => s.target));

  const addRemote = () => {
    const cleanUrl = url.trim();
    const cleanName = name.trim() || cleanUrl.replace(/^https?:\/\//, "").split("/")[0];
    if (!/^https?:\/\/.+/i.test(cleanUrl)) {
      setUrlError(t("mcp.add.badUrl"));
      return;
    }
    setUrlError(null);
    addServer({ name: cleanName, transport: "http", target: cleanUrl });
    setName("");
    setUrl("");
  };

  return (
    <div className="space-y-3">
      {/* connected servers */}
      <AqCard className="px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[13px] font-medium text-fg-1">{t("mcp.connected")}</div>
          <span className="font-mono text-[10.5px] text-fg-3">{servers.length}</span>
        </div>
        {servers.length === 0 ? (
          <p className="mt-1.5 text-[12px] leading-snug text-fg-3">{t("mcp.empty")}</p>
        ) : (
          <div className="mt-1">
            {servers.map((s, i) => (
              <Fragment key={s.id}>
                {i > 0 && <Divider />}
                <ServerRow server={s} />
              </Fragment>
            ))}
          </div>
        )}
      </AqCard>

      {/* one-click built-ins */}
      <div>
        <Overline>{t("mcp.builtins")}</Overline>
        <p className="mt-1.5 text-[12px] leading-snug text-fg-3">{t("mcp.builtins.hint")}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {MCP_BUILTINS.map((preset) => {
          const Icon = BUILTIN_ICONS[preset.key] ?? PlugZap;
          const already = installed.has(preset.key);
          return (
            <AqCard key={preset.key} className="flex flex-col gap-2 p-3">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-xs border border-line bg-sunken text-accent">
                  <Icon size={14} />
                </span>
                <span className="text-[12.5px] font-semibold text-fg-1">{t(preset.nameKey)}</span>
              </div>
              <p className="min-h-[42px] text-[11px] leading-snug text-fg-3">{t(preset.descKey)}</p>
              <button
                type="button"
                disabled={already}
                onClick={() => {
                  addServer({ name: t(preset.nameKey), transport: "builtin", target: preset.key });
                }}
                className={cn(
                  "aq-focus-ring flex h-7 items-center justify-center gap-1.5 rounded-sm border text-[11.5px] font-medium transition-colors",
                  already
                    ? "cursor-default border-line-faint bg-sunken text-fg-3"
                    : "border-accent-border bg-accent-soft text-accent hover:border-accent hover:bg-accent-soft",
                )}
              >
                {already ? (
                  <>
                    <Check size={12} aria-hidden />
                    {t("mcp.installed")}
                  </>
                ) : (
                  <>
                    <PlugZap size={12} aria-hidden />
                    {t("mcp.install")}
                  </>
                )}
              </button>
            </AqCard>
          );
        })}
      </div>

      {/* add a remote server */}
      <div>
        <Overline>{t("mcp.add")}</Overline>
        <p className="mt-1.5 text-[12px] leading-snug text-fg-3">{t("mcp.add.hint")}</p>
      </div>
      <AqCard className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("mcp.add.name")}
          aria-label={t("mcp.add.name")}
          maxLength={60}
          className="aq-focus-ring h-8 w-[160px] rounded-sm border border-line bg-sunken px-2.5 text-[12px] text-fg-1 placeholder:text-fg-3"
        />
        <input
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setUrlError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") addRemote();
          }}
          placeholder="https://example.com/mcp"
          aria-label={t("mcp.add.url")}
          className="aq-focus-ring h-8 min-w-[200px] flex-1 rounded-sm border border-line bg-sunken px-2.5 font-mono text-[11.5px] text-fg-1 placeholder:text-fg-3"
        />
        <button
          type="button"
          onClick={addRemote}
          disabled={!url.trim()}
          className="aq-focus-ring flex h-8 items-center gap-1.5 rounded-sm bg-accent px-3 text-[12px] font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-40"
        >
          <Plus size={13} aria-hidden />
          {t("mcp.add.button")}
        </button>
      </AqCard>
      {urlError && <p className="text-[11px] text-error">{urlError}</p>}

      <p className="flex items-start gap-2 text-[11.5px] leading-snug text-fg-3">
        <ImageIcon size={12} className="mt-0.5 shrink-0" aria-hidden />
        <span>{t("mcp.projectNote")}</span>
      </p>
    </div>
  );
}
