// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../scenario", () => ({ sendMessage: vi.fn() }));
vi.mock("../sync", () => ({ isServerMode: vi.fn() }));
let mounted: Root | undefined;
let element: HTMLDivElement | undefined;
beforeEach(() => { vi.resetModules(); localStorage.clear(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => { if (mounted) await act(async () => mounted!.unmount()); mounted = undefined; element?.remove(); element = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture(offline = false) {
  const { useAqvenor } = await import("../store");
  const { isServerMode } = await import("../sync");
  const backend = await import("../backend");
  const { translate } = await import("../i18n");
  vi.mocked(isServerMode).mockReturnValue(!offline);
  const tools = vi.spyOn(backend.tools, "list").mockResolvedValue([]);
  useAqvenor.setState({ sessions: [], drafts: {}, approvals: {}, runningSessions: {}, workspaceRoot: "D:\\Project", backendReachable: !offline });
  useAqvenor.getState().setUi({ locale: "en", selectedWorkflow: "landing", selectedModelId: "test/model" });
  useAqvenor.setState({ providers: [{ id: "test", name: "Test", endpoint: "http://fixture.invalid", builtin: false, state: "connected", models: [{ id: "test/model", providerId: "test", name: "Selected model", contextK: 128, tools: true }] }] });
  const { default: WorkflowsView } = await import("../../../components/aqvenor/workspace/WorkflowsView");
  element = document.createElement("div"); document.body.append(element); mounted = createRoot(element);
  await act(async () => mounted!.render(createElement(WorkflowsView)));
  const modelTrigger = () => [...element!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Selected model")!;
  return { tools, translate, modelTrigger };
}

describe("workflow keyboard and availability", () => {
  it("shows unavailable capability states offline without a perpetual loading message", async () => {
    const f = await fixture(true);
    expect(element!.textContent).not.toContain(f.translate("en", "workflows.builder.loading"));
    expect(element!.textContent).toContain(f.translate("en", "workflows.offline.title"));
    expect(f.tools).not.toHaveBeenCalled();
  });

  it("returns keyboard focus to the model trigger after Escape", async () => {
    const f = await fixture(); const trigger = f.modelTrigger();
    await act(async () => { trigger.focus(); trigger.click(); });
    expect(element!.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(element!.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps Tab and Shift+Tab inside the model picker", async () => {
    const f = await fixture();
    await act(async () => f.modelTrigger().click());
    const dialog = element!.querySelector('[role="dialog"]')!;
    const input = dialog.querySelector<HTMLInputElement>("input")!;
    const last = [...dialog.querySelectorAll<HTMLButtonElement>("button")].at(-1)!;
    await act(async () => { last.focus(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(input);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(last);
  });
});
