import { useAqvenor } from "./store";
import { isServerMode, loadServerSettings, saveServerSettings, type ServerSettingsSections } from "./sync";
import { translate } from "./i18n";
import type { Locale, ThemeMode } from "./types";

type UiPreferencePatch = {
  theme?: ThemeMode;
  locale?: Locale;
  enterSend?: boolean;
  autoscroll?: boolean;
  confirmDelete?: boolean;
  autoTitles?: boolean;
};

let previousOperation: Promise<unknown> = Promise.resolve();
let revision = 0;
const preferenceRevisions: Partial<Record<keyof UiPreferencePatch, number>> = {};

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const pending = previousOperation.then(operation);
  previousOperation = pending.catch(() => undefined);
  return pending;
}

function serverUiPreferences(settings: ServerSettingsSections): UiPreferencePatch {
  const patch: UiPreferencePatch = {};
  if (typeof settings.chat.sendWithEnter === "boolean") patch.enterSend = settings.chat.sendWithEnter;
  if (typeof settings.chat.autoScroll === "boolean") patch.autoscroll = settings.chat.autoScroll;
  if (typeof settings.general.confirmBeforeDelete === "boolean") patch.confirmDelete = settings.general.confirmBeforeDelete;
  if (typeof settings.general.autoGenerateTitles === "boolean") patch.autoTitles = settings.general.autoGenerateTitles;
  if (settings.general.language !== undefined) {
    const language = settings.general.language;
    patch.locale = language === 1 || language === "Russian" ? "ru" : language === 2 || language === "German" ? "de" : "en";
  }
  if (settings.appearance.theme !== undefined) {
    const theme = settings.appearance.theme;
    patch.theme = theme === 1 || theme === "Light" ? "light" : theme === 2 || theme === "Dark" ? "dark" : "system";
  }
  return patch;
}

/** Read after pending writes and retain preferences changed while this read was waiting. */
export function loadSettingsWithUiPreferences(
  read: () => Promise<ServerSettingsSections | null> = loadServerSettings,
): Promise<ServerSettingsSections | null> {
  const readRevisions = { ...preferenceRevisions };
  return enqueue(async () => {
    const settings = await read();
    if (!settings) return null;
    const patch = Object.fromEntries(Object.entries(serverUiPreferences(settings))
      .filter(([key]) => preferenceRevisions[key as keyof UiPreferencePatch] === readRevisions[key as keyof UiPreferencePatch])) as UiPreferencePatch;
    if (Object.keys(patch).length) useAqvenor.getState().setUi(patch);
    return settings;
  });
}

/** Apply immediately and serialize server writes so rapid switches retain the final choice. */
export function setUiPreferences(patch: UiPreferencePatch): Promise<boolean> {
  for (const key of Object.keys(patch) as (keyof UiPreferencePatch)[]) preferenceRevisions[key] = ++revision;
  useAqvenor.getState().setUi(patch);
  if (!isServerMode()) return Promise.resolve(true);

  const sections: Record<string, Record<string, unknown>> = {};
  if (patch.theme !== undefined) sections.appearance = { theme: patch.theme === "dark" ? "Dark" : patch.theme === "light" ? "Light" : "System" };
  const general: Record<string, unknown> = {};
  if (patch.locale !== undefined) general.language = patch.locale === "ru" ? "Russian" : patch.locale === "de" ? "German" : "English";
  if (patch.confirmDelete !== undefined) general.confirmBeforeDelete = patch.confirmDelete;
  if (patch.autoTitles !== undefined) general.autoGenerateTitles = patch.autoTitles;
  if (Object.keys(general).length) sections.general = general;
  const chat: Record<string, unknown> = {};
  if (patch.enterSend !== undefined) chat.sendWithEnter = patch.enterSend;
  if (patch.autoscroll !== undefined) chat.autoScroll = patch.autoscroll;
  if (Object.keys(chat).length) sections.chat = chat;

  return enqueue(async () => {
    for (const [section, body] of Object.entries(sections)) {
      const result = await saveServerSettings(section, body);
      if (!result.ok || result.refused.length) {
        const state = useAqvenor.getState();
        state.pushToast(translate(state.ui.locale, "settings.saveFailed"), undefined, "destructive");
        return false;
      }
    }
    return true;
  });
}
