import type { Locale } from "./types";

/* ============================================================
   Locale-aware formatting — one place for numbers, dates and
   units, mirroring the WPF converters (TokenCountConverter and
   friends use the ambient culture). Units themselves (KB, ms, %)
   stay Latin everywhere; what localizes is grouping, decimals
   and the clock/date conventions.
   ============================================================ */

/** BCP 47 tag for Intl: German gets comma decimals, Russian gets its own. */
export function intlLocale(locale: Locale): string {
  return locale === "ru" ? "ru-RU" : locale === "de" ? "de-DE" : "en-US";
}

/** Grouped integer: "73 909" / "73,909" / "73.909" per locale. */
export function fmtInt(n: number, locale: Locale): string {
  return new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 0 }).format(n);
}

/** Fixed decimals with the locale separator: "1.8" / "1,8" / "3.00" / "3,00". */
export function fmtDec(n: number, locale: Locale, digits = 1): string {
  const s = n.toFixed(digits);
  return locale === "en" ? s : s.replace(".", ",");
}

/** One decimal, locale separator: "1.8" / "1,8". */
export function fmt1(n: number, locale: Locale): string {
  return fmtDec(n, locale, 1);
}

/** Compact thousands for token counts: "1.8k" / "1,8k". */
export function fmtCompact(n: number, locale: Locale): string {
  const v = n / 1000;
  return fmt1(v < 10 ? v : Math.round(v), locale) + "k";
}

/** File size from a character count: "1.8 KB" with locale decimals. */
export function fmtKb(chars: number, locale: Locale): string {
  const kb = chars / 1024;
  return fmt1(kb < 10 ? kb : Math.round(kb), locale) + " KB";
}

/** File size from bytes, auto unit: "1.8 KB" / "3.4 MB". */
export function fmtBytes(bytes: number, locale: Locale): string {
  if (bytes < 1024 * 1024) return fmtKb(bytes, locale);
  return fmt1(bytes / (1024 * 1024), locale) + " MB";
}

/** Duration: "640ms" / "3.2s" / "3,2s". */
export function fmtDuration(ms: number, locale: Locale): string {
  if (ms < 1000) return `${ms}ms`;
  return fmt1(ms / 1000, locale) + "s";
}

/** Clock time in the locale's convention (24h for ru/de, 12h for en). */
export function fmtClock(ts: number, locale: Locale): string {
  return new Date(ts).toLocaleTimeString(intlLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Short time without seconds, for message timestamps. */
export function fmtTimeShort(ts: number, locale: Locale): string {
  return new Date(ts).toLocaleTimeString(intlLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Calendar date in the locale's convention. */
export function fmtDate(ts: number, locale: Locale): string {
  return new Date(ts).toLocaleDateString(intlLocale(locale));
}

/** Day divider: weekday, day and month in the locale's words and order. */
export function fmtDay(ts: number, locale: Locale): string {
  return new Date(ts).toLocaleDateString(intlLocale(locale), {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/** USD price with locale grouping/decimals: "$0.023" / "0,023 $". */
export function fmtUsd(n: number, locale: Locale, digits = 3): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}
