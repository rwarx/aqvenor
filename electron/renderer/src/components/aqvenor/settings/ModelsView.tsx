"use client";

import { useMemo, useState } from "react";
import { Check, Eye, Search, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAqvenor } from "@/lib/aqvenor/store";
import { useT } from "@/lib/aqvenor/useT";
import { fmtDec } from "@/lib/aqvenor/format";
import type { ModelInfo } from "@/lib/aqvenor/types";
import { ProviderStudioLauncher } from "@/components/aqvenor/chat/ProviderStudio";
import { Divider, AqBadge, Overline } from "@/components/aqvenor/ui";

/* ============================================================
   PROVIDERS — opencode-style key management (ProviderStudio)
   + the model catalogue. Keys are managed inside the studio;
   this surface only sets the default model.
   ============================================================ */

/* ------------------------------------------------------------
   Model catalogue — grouped by provider, click to set default.
   ------------------------------------------------------------ */

function Catalogue() {
  const t = useT();
  const providers = useAqvenor((s) => s.providers);
  const selectedModelId = useAqvenor((s) => s.ui.selectedModelId);
  const setUi = useAqvenor((s) => s.setUi);
  const pushToast = useAqvenor((s) => s.pushToast);
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const groups = useMemo(
    () =>
      providers
        .map((p) => ({
          provider: p,
          models: q
            ? p.models.filter(
                (m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
              )
            : p.models,
        }))
        .filter((g) => g.models.length > 0),
    [providers, q],
  );

  const select = (m: ModelInfo) => {
    if (m.id === selectedModelId) return;
    setUi({ selectedModelId: m.id });
    pushToast(t("providers.toast.updated"), m.name);
  };

  return (
    <section>
      <Overline>{t("providers.catalogue")}</Overline>
      <p className="mt-1.5 text-[12px] leading-snug text-fg-3">{t("providers.catalogue.hint")}</p>

      <div className="relative mt-3">
        <Search
          size={13}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3"
          aria-hidden
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("picker.filterPlaceholder")}
          aria-label={t("picker.filterPlaceholder")}
          className="aq-focus-ring h-8 w-full rounded-sm border border-line bg-sunken pl-8 pr-2.5 text-[12.5px] text-fg-1 placeholder:text-fg-3"
        />
      </div>

      {groups.length === 0 ? (
        <p className="mt-4 text-[12.5px] text-fg-3">{t("picker.empty", query.trim())}</p>
      ) : (
        <div className="mt-4 space-y-5">
          {groups.map(({ provider, models }) => (
            <div key={provider.id}>
              <div className="flex items-baseline justify-between">
                <Overline>{provider.name}</Overline>
                <span className="font-mono text-[10.5px] text-fg-3">{models.length}</span>
              </div>
              <div className="mt-1.5 space-y-0.5">
                {models.map((m) => {
                  const selected = m.id === selectedModelId;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => select(m)}
                      aria-pressed={selected}
                      className={cn(
                        "aq-focus-ring flex w-full items-center justify-between gap-3 rounded-sm border px-2.5 py-2 text-left transition-colors duration-100",
                        selected
                          ? "border-accent bg-accent-soft"
                          : "border-transparent hover:bg-surface-hover",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {selected ? (
                          <Check
                            size={12}
                            strokeWidth={2.25}
                            className="shrink-0 text-accent"
                            aria-hidden
                          />
                        ) : (
                          <span className="w-3 shrink-0" aria-hidden />
                        )}
                        <span className="truncate text-[13px] font-medium text-fg-1">{m.name}</span>
                        <span className="hidden truncate font-mono text-[10.5px] text-fg-3 sm:inline">
                          {m.id}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <AqBadge>{m.contextK}K</AqBadge>
                        {m.vision && (
                          <AqBadge>
                            <Eye size={10} className="mr-1" aria-hidden />
                            {t("picker.vision")}
                          </AqBadge>
                        )}
                        {m.tools && (
                          <AqBadge>
                            <Wrench size={10} className="mr-1" aria-hidden />
                            {t("picker.tools")}
                          </AqBadge>
                        )}
                        {m.pricePrompt !== undefined && (
                          <span className="font-mono text-[10.5px] text-fg-3">
                            ${fmtDec(m.pricePrompt, t.locale, 2)}/M
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="mt-4 text-[11px] text-fg-3">{t("picker.footer")}</p>
    </section>
  );
}

/* ------------------------------------------------------------
   Surface — full-height, own scrolling, no outer chrome.
   ------------------------------------------------------------ */

export default function ModelsView() {
  const t = useT();
  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto max-w-[860px] space-y-8 px-6 py-6">
        <header>
          <Overline>{t("providers.overline")}</Overline>
          <h1 className="mt-1 text-[15px] font-semibold text-fg-1">{t("providers.title")}</h1>
          <p className="mt-1 text-[12.5px] text-fg-3">{t("providers.subtitle")}</p>
        </header>

        <ProviderStudioLauncher />

        <Divider />

        <Catalogue />
      </div>
    </div>
  );
}
