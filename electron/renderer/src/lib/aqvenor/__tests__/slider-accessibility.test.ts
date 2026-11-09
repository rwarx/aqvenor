// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Slider } from "../../../components/ui/slider";

let mounted: Root | undefined;
let container: HTMLDivElement | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div");
  document.body.appendChild(container);
  mounted = createRoot(container);
});
afterEach(async () => {
  if (mounted) await act(async () => mounted!.unmount());
  mounted = undefined;
  container?.remove();
  container = undefined;
  vi.unstubAllGlobals();
});

describe("slider accessibility", () => {
  it("names the focusable slider using the label supplied by settings", async () => {
    await act(async () => mounted!.render(createElement(Slider, { defaultValue: [50], "aria-label": "Sidebar width" })));
    const thumb = container!.querySelector<HTMLElement>('[role="slider"]')!;
    expect(thumb.getAttribute("aria-label")).toBe("Sidebar width");
    expect(thumb.tabIndex).toBe(0);
    expect(thumb.getAttribute("aria-valuenow")).toBe("50");
  });

  it("places references to the label and instructions on the accessible control", async () => {
    await act(async () => mounted!.render(createElement(Slider, {
      defaultValue: [10], "aria-labelledby": "setting-title", "aria-describedby": "setting-help",
    })));
    const thumb = container!.querySelector('[role="slider"]')!;
    expect(thumb.getAttribute("aria-labelledby")).toBe("setting-title");
    expect(thumb.getAttribute("aria-describedby")).toBe("setting-help");
  });

  it("retains the supplied accessible name for both controls in a range", async () => {
    await act(async () => mounted!.render(createElement(Slider, { defaultValue: [20, 80], "aria-label": "Price range" })));
    const thumbs = [...container!.querySelectorAll('[role="slider"]')];
    expect(thumbs).toHaveLength(2);
    expect(thumbs.map((thumb) => thumb.getAttribute("aria-label"))).toEqual(["Price range", "Price range"]);
    expect(thumbs.map((thumb) => thumb.getAttribute("aria-valuenow"))).toEqual(["20", "80"]);
  });

  it("preserves Radix's default minimum and maximum names when no custom name is supplied", async () => {
    await act(async () => mounted!.render(createElement(Slider, { defaultValue: [20, 80] })));
    const thumbs = [...container!.querySelectorAll('[role="slider"]')];
    expect(thumbs.map((thumb) => thumb.getAttribute("aria-label"))).toEqual(["Minimum", "Maximum"]);
  });
});
