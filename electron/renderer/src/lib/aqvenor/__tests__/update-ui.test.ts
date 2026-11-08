// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateState } from "../updates";

let mounted: Root | undefined;
let container: HTMLDivElement | undefined;
const idle: UpdateState = { status: "idle", currentVersion: "0.3.2-alpha", channel: "alpha", version: null, percent: null, checkedAt: null, error: null };
beforeEach(() => {
  vi.resetModules(); localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  delete window.aqvenor;
});
afterEach(async () => {
  if (mounted) await act(async () => mounted!.unmount());
  mounted = undefined; container?.remove(); container = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.aqvenor;
});

async function mount(initial = idle) {
  let receive!: (state: UpdateState) => void;
  const unsubscribe = vi.fn();
  const bridge = {
    getState: vi.fn().mockResolvedValue(initial), check: vi.fn().mockResolvedValue(idle), install: vi.fn().mockResolvedValue({ ...initial, status: "installing" }),
    onChanged: (callback: typeof receive) => { receive = callback; return unsubscribe; },
  };
  Object.defineProperty(window, "aqvenor", { configurable: true, value: { updates: bridge } });
  const { useAqvenor } = await import("../store");
  useAqvenor.getState().setUi({ locale: "en" });
  const { UpdatesSettings } = await import("../../../components/aqvenor/settings/UpdatesSettings");
  container = document.createElement("div"); document.body.appendChild(container);
  mounted = createRoot(container);
  await act(async () => mounted!.render(createElement(UpdatesSettings)));
  return { bridge, receive: (state: UpdateState) => receive(state), unsubscribe, element: container };
}

describe("desktop update controls", () => {
  it("shows the installed version and release channel", async () => {
    const { element } = await mount();
    expect(element.textContent).toContain("Installed version: 0.3.2-alpha");
    expect(element.textContent).toContain("Release channel: Alpha");
  });

  it("shows download progress and requires a restart action for a downloaded update", async () => {
    const { bridge, receive, element, unsubscribe } = await mount();
    const check = element.querySelector<HTMLButtonElement>("button")!;
    await act(async () => check.click());
    expect(bridge.check).toHaveBeenCalledOnce();
    await act(async () => receive({ ...idle, status: "downloading", version: "0.3.3-alpha", percent: 37 }));
    expect(element.querySelector<HTMLProgressElement>("progress")?.value).toBe(37);
    expect(element.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    await act(async () => receive({ ...idle, status: "downloaded", version: "0.3.3-alpha", percent: 100 }));
    expect(bridge.install).not.toHaveBeenCalled();
    const restart = element.querySelector<HTMLButtonElement>("button")!;
    expect(restart.textContent).toContain("Restart and install");
    await act(async () => restart.click());
    expect(bridge.install).toHaveBeenCalledOnce();
    expect(element.textContent).toContain("Saving work and restarting");
    await act(async () => mounted!.unmount()); mounted = undefined;
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps a newer downloaded event when an earlier manual-check IPC later rejects", async () => {
    const { bridge, receive, element } = await mount();
    let reject!: (error: Error) => void;
    bridge.check.mockReturnValueOnce(new Promise((_, failure) => { reject = failure; }));
    await act(async () => element.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => receive({ ...idle, status: "downloaded", version: "0.3.3-alpha", percent: 100 }));
    await act(async () => reject(new Error("old IPC failed")));
    expect(element.textContent).toContain("0.3.3-alpha is ready to install");
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(element.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
  });

  it("keeps restart retry available after saving fails and disables checks in development", async () => {
    const { receive, element } = await mount({ ...idle, status: "downloaded", version: "0.3.3-alpha", percent: 100, error: "save" });
    expect(element.querySelector('[role="alert"]')?.textContent).toContain("pending work could not be saved");
    expect(element.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
    await act(async () => receive({ ...idle, status: "disabled", error: "development" }));
    expect(element.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    expect(element.textContent).toContain("Development builds do not check or download updates");
  });
});
