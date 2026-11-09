// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerProvider } from "../backend";

let root: Root | undefined;
let element: HTMLDivElement | undefined;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected provider-launcher network request")));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  element?.remove(); element = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function provider(id: string, hasApiKey = false, connectionState = "NotConfigured"): ServerProvider {
  return { id, name: id, hasApiKey, connectionState, isEnabled: true, cachedModelCount: 0, isCustom: false };
}

async function fixture(list: ServerProvider[]) {
  const { useAqvenor } = await import("../store");
  const backend = await import("../backend");
  const sync = await import("../sync");
  useAqvenor.setState({ providers: [] });
  useAqvenor.getState().setUi({ locale: "ru" });
  vi.spyOn(backend, "checkBackend").mockResolvedValue(true);
  const get = vi.spyOn(backend.providers, "list").mockResolvedValue(list);
  vi.spyOn(backend.providers, "allModels").mockResolvedValue([]);
  vi.spyOn(backend.providers, "models").mockResolvedValue([]);
  await sync.refreshProviders();
  const { ProviderStudioLauncher } = await import("../../../components/aqvenor/chat/ProviderStudio");
  element = document.createElement("div"); document.body.appendChild(element);
  root = createRoot(element);
  await act(async () => root!.render(createElement(ProviderStudioLauncher)));
  return { useAqvenor, get, sync, element };
}

describe("provider launcher key summary", () => {
  it("counts stored keys after restart while keeping untested connections unknown", async () => {
    const f = await fixture([
      provider("nvidia", true, "Unknown"), provider("openrouter", true, "Unknown"),
      ...["openai", "anthropic", "groq", "xai", "mistral", "deepseek"].map((id) => provider(id)),
    ]);
    expect(f.element.textContent).toContain("2/8");
    expect(f.element.textContent).toContain("Сохранённые API-ключи: 2");
    expect(f.element.textContent).not.toContain("Подключайте провайдеров");
    expect(f.useAqvenor.getState().providers.filter((p) => p.state === "connected")).toHaveLength(0);
    expect(f.useAqvenor.getState().providers[0]).toMatchObject({ hasApiKey: true, state: "unknown" });
  });

  it("counts failed stored keys without presenting a successful connection", async () => {
    const f = await fixture([provider("openrouter", true, "Failed"), provider("nvidia", false, "Unknown")]);
    expect(f.element.textContent).toContain("1/2");
    expect(f.useAqvenor.getState().providers[0]).toMatchObject({ hasApiKey: true, state: "failed" });
    expect(f.element.querySelector(".text-success")).toBeNull();
  });

  it("updates the summary after key removal and offers connection when no keys remain", async () => {
    const f = await fixture([provider("nvidia", true, "Connected"), provider("openrouter", true, "Unknown")]);
    f.get.mockResolvedValue([provider("nvidia"), provider("openrouter", true, "Unknown")]);
    await act(async () => f.sync.refreshProviders());
    expect(f.element.textContent).toContain("1/2");
    f.get.mockResolvedValue([provider("nvidia"), provider("openrouter")]);
    await act(async () => f.sync.refreshProviders());
    expect(f.element.textContent).toContain("0/2");
    expect(f.element.textContent).toContain("Подключайте провайдеров");
    expect(f.useAqvenor.getState().providers.every((p) => p.hasApiKey === false)).toBe(true);
  });
});
