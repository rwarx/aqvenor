"use client";

import { useMemo } from "react";
import { useAqvenor } from "./store";
import { tp, translate } from "./i18n";
import type { Locale } from "./types";

export function useT(): ((key: string, ...args: (string | number)[]) => string) & {
  locale: Locale;
  /** plural-aware lookup: t.p("files.count", n) — see tp() in lib/aqvenor/i18n. */
  p: (key: string, n: number) => string;
} {
  const locale = useAqvenor((s) => s.ui.locale);
  /* task 2-c: Object.assign instead of mutating the fn (react-hooks/immutability);
     identical API — callable t(key, …) with t.locale — but stable identity. */
  return useMemo(
    () =>
      Object.assign(
        (key: string, ...args: (string | number)[]) => translate(locale, key, ...args),
        { locale, p: (key: string, n: number) => tp(locale, key, n) },
      ),
    [locale],
  );
}
