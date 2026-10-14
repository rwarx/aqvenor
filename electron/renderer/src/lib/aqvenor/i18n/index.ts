import type { Locale } from "../types";
import type { Dictionary } from "./types-dict";
import { en } from "./en";
import { ru } from "./ru";
import { de } from "./de";

export type { Dictionary };

const raw: Record<Locale, Dictionary> = { en, ru, de };

/* Merged with English fallback so partial dictionaries never break the UI */
export const dictionaries: Record<Locale, Dictionary> = {
  en,
  ru: { ...en, ...ru },
  de: { ...en, ...de },
};

export function translate(locale: Locale, key: string, ...args: (string | number)[]): string {
  const dict = dictionaries[locale] ?? en;
  let value = dict[key] ?? en[key] ?? key;
  args.forEach((arg, i) => {
    value = value.replaceAll(`{${i}}`, String(arg));
  });
  return value;
}

/* Plural-aware lookup, mirroring WPF GraphWords.Form: `${key}.one/.few/.many`.
   Russian picks one/few/many by the Slavic count rules; English/German pick
   `.one` for 1 and fall back to the base key (the other form) otherwise.
   Crucially, the fallback never crosses locales mid-key: when the current
   locale intentionally defines no forms (its base covers every n, e.g. a
   rephrased or terse form), the base is used rather than English's form —
   otherwise a Russian UI would show an English singular for n=1. */
export function tp(locale: Locale, key: string, n: number): string {
  const own = raw[locale] ?? en;
  const hasOwn = (k: string) => own[k] !== undefined;
  let template: string | undefined;
  if (locale === "ru") {
    const m = Math.abs(n) % 100;
    const d = m % 10;
    const form = m >= 11 && m <= 14 ? "many" : d === 1 ? "one" : d >= 2 && d <= 4 ? "few" : "many";
    const fk = key + "." + form;
    if (hasOwn(fk)) {
      template = own[fk];
    } else if (hasOwn(key + ".one") || hasOwn(key + ".few") || hasOwn(key + ".many")) {
      template = en[fk]; // partial translation: may be undefined → base below
    }
    // else: this locale's base covers every n → fall through to it
  } else if (Math.abs(n) === 1) {
    if (hasOwn(key + ".one")) {
      template = own[key + ".one"];
    } else if (!hasOwn(key)) {
      template = en[key + ".one"];
    }
  }
  template = template ?? own[key] ?? en[key] ?? key;
  return template.replaceAll("{0}", String(n));
}

export const locales: { id: Locale; label: string; native: string }[] = [
  { id: "en", label: "English", native: "EN" },
  { id: "ru", label: "Русский", native: "RU" },
  { id: "de", label: "Deutsch", native: "DE" },
];

export { raw };
