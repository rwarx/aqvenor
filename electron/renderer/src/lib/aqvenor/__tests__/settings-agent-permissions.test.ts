// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../components/aqvenor/settings/McpSettings", () => ({ McpSettings: () => null }));
vi.mock("../../../components/aqvenor/settings/UpdatesSettings", () => ({ UpdatesSettings: () => null }));
vi.mock("../../../components/aqvenor/chat/ProviderStudio", () => ({ ProviderStudioLauncher: () => null }));

let mounted: Root | undefined;
let element: HTMLDivElement | undefined;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); localStorage.clear();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected permissions-test network request")));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  delete window.aqvenor;
});
afterEach(async () => {
  if (mounted) await act(async () => mounted!.unmount());
  mounted = undefined; element?.remove(); element = undefined;
  vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); delete window.aqvenor;
});

async function fixture(options: { bridge?: boolean; allowCommands?: boolean; allowShellCommands?: boolean; category?: "general" | "advanced" } = {}) {
  const { useAqvenor } = await import("../store");
  const sync = await import("../sync"); const backend = await import("../backend"); const { translate } = await import("../i18n");
  useAqvenor.getState().setUi({ locale: "en", settingsCategory: options.category ?? "advanced" });
  const saved = { general: {}, appearance: {}, chat: {}, agent: { allowCommands: options.allowCommands ?? false, allowShellCommands: options.allowShellCommands ?? false, allowSubagents: true }, storage: {}, canvas: {} };
  vi.spyOn(sync, "isServerMode").mockReturnValue(true);
  const load = vi.spyOn(sync, "loadServerSettings").mockResolvedValue(saved);
  const put = vi.spyOn(backend.settings, "put").mockImplementation(async (section, patch) => { Object.assign(saved[section as keyof typeof saved], patch); return { refused: [] }; });
  vi.spyOn(backend.workspace, "status").mockResolvedValue({ isOpen: false });
  vi.spyOn(backend.meta, "info").mockRejectedValue(new Error("No diagnostics"));
  vi.spyOn(backend.meta, "health").mockRejectedValue(new Error("No diagnostics"));
  const tools = vi.spyOn(backend.tools, "list").mockResolvedValue([]);
  const permission = vi.fn().mockResolvedValue({ allowCommands: true, allowShellCommands: false });
  if (options.bridge !== false) window.aqvenor = { agentPermissions: permission } as unknown as NonNullable<Window["aqvenor"]>;
  const { default: SettingsView } = await import("../../../components/aqvenor/settings/SettingsView");
  element = document.createElement("div"); document.body.append(element); mounted = createRoot(element);
  await act(async () => mounted!.render(createElement(SettingsView)));
  const toggle = (key: string) => element!.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${translate("en", key)}"]`)!;
  return { useAqvenor, permission, put, tools, toggle, translate, load, saved, SettingsView };
}

describe("desktop agent permissions", () => {
  it("opens the requested Advanced category and waits for accepted native permission before showing it enabled", async () => {
    const f = await fixture();
    expect(element!.querySelector('nav button[aria-current="page"]')?.getAttribute("data-settings-category")).toBe("advanced");
    const commands = f.toggle("settings.commands.allow");
    expect(commands.disabled).toBe(false);
    let accept!: (value: { allowCommands: boolean; allowShellCommands: boolean }) => void;
    f.permission.mockReturnValueOnce(new Promise((resolve) => { accept = resolve; }));
    await act(async () => commands.click());
    expect(f.permission).toHaveBeenCalledWith({ allowCommands: true }, "en");
    expect(commands.getAttribute("aria-checked")).toBe("false");
    expect(commands.disabled).toBe(true);
    await act(async () => accept({ allowCommands: true, allowShellCommands: false }));
    expect(commands.getAttribute("aria-checked")).toBe("true");
    expect(commands.disabled).toBe(false);
    expect(f.tools).toHaveBeenCalledTimes(2);
    expect(f.put).not.toHaveBeenCalled();
  });

  it("leaves permissions unchanged when native confirmation is cancelled and lets the user retry", async () => {
    const f = await fixture(); f.permission.mockResolvedValueOnce({ cancelled: true });
    const commands = f.toggle("settings.commands.allow");
    await act(async () => commands.click());
    expect(commands.getAttribute("aria-checked")).toBe("false");
    expect(commands.disabled).toBe(false);
    expect(f.tools).toHaveBeenCalledTimes(1);
    await act(async () => commands.click());
    expect(commands.getAttribute("aria-checked")).toBe("true");
  });

  it("reports a failed privileged save without changing values or posting an ordinary settings patch", async () => {
    const f = await fixture(); f.permission.mockRejectedValueOnce(new Error("Host denied the operation"));
    const commands = f.toggle("settings.commands.allow");
    await act(async () => commands.click());
    expect(commands.getAttribute("aria-checked")).toBe("false");
    expect(commands.disabled).toBe(false);
    expect(f.useAqvenor.getState().toasts.at(-1)?.variant).toBe("destructive");
    expect(f.put).not.toHaveBeenCalled();
  });

  it("disables permission editing without the desktop bridge and keeps shell unavailable until programs are enabled", async () => {
    const f = await fixture({ bridge: false });
    expect(f.toggle("settings.commands.allow").disabled).toBe(true);
    expect(f.toggle("settings.commands.allowShell").disabled).toBe(true);
  });

  it("does not let an earlier Settings read replace the permissions accepted by the host", async () => {
    const f = await fixture();
    let finishRead!: (value: typeof f.saved) => void;
    f.load.mockReturnValueOnce(new Promise((resolve) => { finishRead = resolve; }));
    await act(async () => mounted!.unmount());
    mounted = createRoot(element!);
    await act(async () => mounted!.render(createElement(f.SettingsView)));
    const commands = f.toggle("settings.commands.allow");
    await act(async () => commands.click());
    expect(commands.getAttribute("aria-checked")).toBe("true");
    await act(async () => finishRead(f.saved));
    expect(commands.getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the setting retryable when the host does not return its actual flags", async () => {
    const f = await fixture(); f.permission.mockResolvedValueOnce({});
    const commands = f.toggle("settings.commands.allow");
    await act(async () => commands.click());
    expect(commands.getAttribute("aria-checked")).toBe("false");
    expect(commands.disabled).toBe(false);
    expect(f.useAqvenor.getState().toasts.at(-1)?.variant).toBe("destructive");
  });

  it("requests shell execution through the host and reflects both actual flags returned when programs are disabled", async () => {
    const f = await fixture({ allowCommands: true });
    f.permission.mockResolvedValueOnce({ allowCommands: true, allowShellCommands: true });
    const shell = f.toggle("settings.commands.allowShell");
    await act(async () => shell.click());
    expect(f.permission).toHaveBeenCalledWith({ allowShellCommands: true }, "en");
    expect(shell.getAttribute("aria-checked")).toBe("true");
    f.permission.mockResolvedValueOnce({ allowCommands: false, allowShellCommands: false });
    await act(async () => f.toggle("settings.commands.allow").click());
    expect(shell.getAttribute("aria-checked")).toBe("false");
    expect(shell.disabled).toBe(true);
    expect(f.toggle("settings.network.allow").disabled).toBe(true);
    expect(f.toggle("settings.external.allow").disabled).toBe(true);
  });

  it("persists the subagent capability through the ordinary agent section without sending locked permissions", async () => {
    const f = await fixture({ category: "general" });
    const agentNav = element!.querySelector<HTMLButtonElement>('nav button[data-settings-category="agent"]')!;
    await act(async () => agentNav.click());
    const subagents = f.toggle("settings.agent.allowSubagents");
    expect(subagents.getAttribute("aria-checked")).toBe("true");
    await act(async () => { subagents.click(); await vi.advanceTimersByTimeAsync(800); });
    expect(f.put).toHaveBeenCalledWith("agent", { allowSubagents: false });
    expect(f.permission).not.toHaveBeenCalled();
  });
});
