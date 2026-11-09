// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../components/aqvenor/settings/McpSettings", () => ({ McpSettings: () => null }));
vi.mock("../../../components/aqvenor/settings/UpdatesSettings", () => ({ UpdatesSettings: () => createElement("div", null, "Update controls") }));
vi.mock("../../../components/aqvenor/chat/ProviderStudio", () => ({ ProviderStudioLauncher: () => createElement("div", null, "Provider controls") }));

let mounted: Root | undefined;
let container: HTMLDivElement | undefined;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); localStorage.clear();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected settings-test network request")));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  delete window.aqvenor;
  Reflect.deleteProperty(navigator, "clipboard");
});
afterEach(async () => {
  if (mounted) await act(async () => mounted!.unmount());
  mounted = undefined; container?.remove(); container = undefined;
  vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "clipboard");
});

async function mount(server = false) {
  const { useAqvenor } = await import("../store");
  const sync = await import("../sync");
  const backend = await import("../backend");
  useAqvenor.getState().setUi({ locale: "en" });
  const saved = { general: {}, appearance: {}, chat: {}, agent: {}, storage: {}, canvas: {} };
  vi.spyOn(sync, "isServerMode").mockReturnValue(server);
  const load = vi.spyOn(sync, "loadServerSettings").mockImplementation(async () => saved);
  const put = vi.spyOn(backend.settings, "put").mockImplementation(async (section, patch) => {
    Object.assign(saved[section as keyof typeof saved], patch);
    return { refused: [] };
  });
  vi.spyOn(backend.workspace, "status").mockResolvedValue({ isOpen: false });
  vi.spyOn(backend.meta, "info").mockRejectedValue(new Error("No diagnostics in fixture"));
  vi.spyOn(backend.meta, "health").mockRejectedValue(new Error("No diagnostics in fixture"));
  vi.spyOn(backend.tools, "list").mockResolvedValue([]);
  const { default: SettingsView } = await import("../../../components/aqvenor/settings/SettingsView");
  container = document.createElement("div"); document.body.appendChild(container);
  mounted = createRoot(container);
  await act(async () => mounted!.render(createElement(SettingsView)));
  return { element: container, useAqvenor, put, saved, load, SettingsView };
}

async function click(element: Element, label: string) {
  const button = [...element.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

async function search(element: Element, text: string) {
  const input = element.querySelector<HTMLInputElement>('input[aria-label="Search settings…"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("settings navigation", () => {
  it("shows seven focused categories and switches panels without a long combined form", async () => {
    const { element } = await mount();
    expect(element.querySelectorAll("nav button[data-settings-category]")).toHaveLength(7);
    expect(element.querySelector("#settings-appearance")).not.toBeNull();
    expect(element.querySelector("#settings-models")).toBeNull();
    expect(element.textContent).not.toContain("Render Markdown");
    await click(element, "Models & Providers");
    expect(element.querySelector("#settings-models")).not.toBeNull();
    expect(element.querySelector("#settings-appearance")).toBeNull();
    expect(element.querySelector('nav button[aria-current="page"]')?.textContent).toBe("Models & Providers");
    await click(element, "App updates");
    expect(element.querySelector("#settings-updates")?.textContent).toContain("Update controls");
  });

  it("finds localized nested advanced settings and restores category navigation after clearing search", async () => {
    const { element, useAqvenor } = await mount();
    await act(async () => useAqvenor.getState().setUi({ locale: "ru" }));
    const input = element.querySelector<HTMLInputElement>('input[aria-label="Поиск по настройкам…"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "логи");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(element.querySelector("#settings-data")).not.toBeNull();
    expect(element.querySelector("#settings-appearance")).toBeNull();
    expect(element.querySelectorAll("nav button[data-settings-category]")).toHaveLength(1);
    await click(element, "Очистить поиск");
    expect(element.querySelectorAll("nav button[data-settings-category]")).toHaveLength(7);
    expect(element.querySelector("#settings-appearance")).not.toBeNull();
  });

  it("reports no results without falling back to unrelated controls", async () => {
    const { element } = await mount();
    await search(element, "there-is-no-such-setting");
    expect(element.textContent).toContain("No settings match.");
    expect(element.querySelector("section")).toBeNull();
  });

  it("finds a setting by its displayed label rather than only by category keywords", async () => {
    const { element } = await mount();
    await search(element, "Repeat limit");
    expect(element.querySelector("#settings-agent")).not.toBeNull();
    expect(element.querySelector("#settings-models")).toBeNull();
  });

  it("keeps service controls collapsed and does not present demo skills as agent settings", async () => {
    const { element } = await mount();
    await click(element, "Advanced");
    const disclosures = [...element.querySelectorAll<HTMLDetailsElement>("details")];
    expect(disclosures).toHaveLength(4);
    expect(disclosures.every((disclosure) => !disclosure.open)).toBe(true);
    expect(element.textContent).not.toContain("Agent skills");
    await search(element, "logs");
    expect(element.querySelector<HTMLDetailsElement>("details")?.open).toBe(true);
  });

  it("persists theme, language and chat toggles to the backend and retains chat values when reopened", async () => {
    const { element, useAqvenor, put, saved, SettingsView } = await mount(true);
    await click(element, "Light");
    await click(element, "Deutsch");
    const enter = element.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Mit Enter senden"]')!;
    const scroll = element.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Transkript automatisch scrollen"]')!;
    await act(async () => { enter.click(); scroll.click(); await vi.advanceTimersByTimeAsync(800); });
    expect(put).toHaveBeenCalledWith("appearance", { theme: "Light" });
    expect(put).toHaveBeenCalledWith("general", { language: "German" });
    expect(put).toHaveBeenCalledWith("chat", { sendWithEnter: false });
    expect(put).toHaveBeenCalledWith("chat", { autoScroll: false });
    expect(saved.chat).toMatchObject({ sendWithEnter: false, autoScroll: false });
    await act(async () => mounted!.unmount()); mounted = undefined;
    useAqvenor.getState().setUi({ enterSend: true, autoscroll: true });
    mounted = createRoot(element);
    await act(async () => mounted!.render(createElement(SettingsView)));
    expect(useAqvenor.getState().ui).toMatchObject({ enterSend: false, autoscroll: false });
  });

  it("serializes rapid preference changes so a slower first save cannot replace the final choice", async () => {
    const { put, useAqvenor } = await mount(true);
    let release!: (value: { refused: string[] }) => void;
    put.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const { setUiPreferences } = await import("../ui-preferences");
    const first = setUiPreferences({ theme: "light" });
    const second = setUiPreferences({ theme: "dark" });
    await act(async () => { await Promise.resolve(); });
    expect(put).toHaveBeenCalledTimes(1);
    expect(useAqvenor.getState().ui.theme).toBe("dark");
    await act(async () => { release({ refused: [] }); await Promise.all([first, second]); });
    expect(put.mock.calls.map((call) => call[1])).toEqual([{ theme: "Light" }, { theme: "Dark" }]);
  });

  it("waits for a preference save started before Settings mounts before reading server values", async () => {
    const { element, put, load, saved, useAqvenor, SettingsView } = await mount(true);
    Object.assign(saved.appearance, { theme: "Dark" });
    useAqvenor.getState().setUi({ theme: "dark" });
    let finishPut!: () => void;
    put.mockImplementationOnce(async (section, patch) => {
      await new Promise<void>((resolve) => { finishPut = resolve; });
      Object.assign(saved[section as keyof typeof saved], patch);
      return { refused: [] };
    });
    const { setUiPreferences } = await import("../ui-preferences");
    let preferenceSave!: Promise<boolean>;
    await act(async () => { preferenceSave = setUiPreferences({ theme: "light" }); await Promise.resolve(); });
    const previousReads = load.mock.calls.length;
    await act(async () => mounted!.unmount()); mounted = createRoot(element);
    await act(async () => mounted!.render(createElement(SettingsView)));
    expect(load).toHaveBeenCalledTimes(previousReads);
    expect(useAqvenor.getState().ui.theme).toBe("light");
    await act(async () => { finishPut(); expect(await preferenceSave).toBe(true); });
    expect(load).toHaveBeenCalledTimes(previousReads + 1);
    expect(saved.appearance).toMatchObject({ theme: "Light" });
    expect(useAqvenor.getState().ui.theme).toBe("light");
  });

  it("keeps a preference changed during a slow Settings read and hydrates unchanged fields", async () => {
    const { element, put, load, saved, useAqvenor, SettingsView } = await mount(true);
    Object.assign(saved.appearance, { theme: "Dark" });
    Object.assign(saved.chat, { autoScroll: false });
    useAqvenor.getState().setUi({ theme: "dark", autoscroll: true });
    const stale = structuredClone(saved);
    let finishGet!: (value: typeof saved) => void;
    load.mockImplementationOnce(() => new Promise((resolve) => { finishGet = resolve; }));
    await act(async () => mounted!.unmount()); mounted = createRoot(element);
    await act(async () => mounted!.render(createElement(SettingsView)));
    const { setUiPreferences } = await import("../ui-preferences");
    const preferenceSave = setUiPreferences({ theme: "light" });
    expect(useAqvenor.getState().ui.theme).toBe("light");
    expect(put).not.toHaveBeenCalled();
    await act(async () => { finishGet(stale); expect(await preferenceSave).toBe(true); });
    expect(saved.appearance).toMatchObject({ theme: "Light" });
    expect(useAqvenor.getState().ui).toMatchObject({ theme: "light", autoscroll: false });
  });

  it("reports a failed preference save and keeps the next change retryable", async () => {
    const { put, useAqvenor } = await mount(true);
    put.mockRejectedValueOnce(new Error("Sidecar stopped"));
    const toast = vi.spyOn(useAqvenor.getState(), "pushToast");
    const { setUiPreferences } = await import("../ui-preferences");
    await act(async () => { expect(await setUiPreferences({ enterSend: false })).toBe(false); });
    expect(toast).toHaveBeenCalledWith("Could not save the setting", undefined, "destructive");
    await act(async () => { expect(await setUiPreferences({ enterSend: true })).toBe(true); });
    expect(put).toHaveBeenLastCalledWith("chat", { sendWithEnter: true });
  });

  it("reports clipboard failure without claiming a configuration snapshot was copied", async () => {
    const { element, useAqvenor } = await mount(true);
    const toast = vi.spyOn(useAqvenor.getState(), "pushToast");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("Clipboard unavailable")) } });
    await click(element, "Advanced");
    await click(element, "Copy snapshot");
    expect(toast).not.toHaveBeenCalledWith("Snapshot copied — no secrets inside.");
    expect(toast).toHaveBeenCalledWith("Could not copy the snapshot. Check clipboard access and try again.", undefined, "destructive");
  });
});
