import { describe, expect, it } from "vitest";
import { computePopupPlacement } from "../../../hooks/use-anchored-popup";

const viewport = { width: 1280, height: 800 };

describe("anchored popup placement (AQV-005)", () => {
  it("opens above a composer pill that sits at the bottom of the window", () => {
    const anchor = { left: 1000, top: 700, right: 1160, bottom: 728 };
    const p = computePopupPlacement(anchor, { width: 420, height: 470 }, viewport);
    expect(p.side).toBe("top");
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(anchor.top);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });

  it("stays inside the viewport no matter how the anchor is scrolled", () => {
    // The old absolute popup measured y ≈ −18858 inside a scrolled dock panel.
    for (const top of [-20000, -600, 0, 40, 390, 760, 2000]) {
      const anchor = { left: 900, top, right: 1100, bottom: top + 28 };
      const p = computePopupPlacement(anchor, { width: 420, height: 470 }, viewport);
      expect(p.top).toBeGreaterThanOrEqual(0);
      expect(p.top).toBeLessThan(viewport.height);
      expect(p.left).toBeGreaterThanOrEqual(0);
      expect(p.left + p.width).toBeLessThanOrEqual(viewport.width);
    }
  });

  it("right-aligns to the pill and clamps at the right edge", () => {
    const anchor = { left: 1200, top: 600, right: 1276, bottom: 628 };
    const p = computePopupPlacement(anchor, { width: 420, height: 470 }, viewport);
    expect(p.left + p.width).toBeLessThanOrEqual(viewport.width - 8);
  });

  it("flips below the anchor when there is clearly more room underneath", () => {
    const anchor = { left: 100, top: 60, right: 300, bottom: 88 };
    const p = computePopupPlacement(anchor, { width: 290, height: 300 }, viewport);
    expect(p.side).toBe("bottom");
    expect(p.top).toBeGreaterThanOrEqual(anchor.bottom);
  });

  it("shrinks to the room that is actually there", () => {
    const anchor = { left: 100, top: 300, right: 300, bottom: 328 };
    const p = computePopupPlacement(anchor, { width: 290, height: 600 }, { width: 1280, height: 420 });
    expect(p.maxHeight).toBeLessThanOrEqual(600);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(420);
  });

  it("never wider than the window allows", () => {
    const p = computePopupPlacement(
      { left: 10, top: 400, right: 300, bottom: 428 },
      { width: 420, height: 200 },
      { width: 360, height: 800 },
    );
    expect(p.width).toBeLessThanOrEqual(360 - 16);
    expect(p.left).toBeGreaterThanOrEqual(0);
  });
});
