import { describe, expect, it } from "vitest";
import {
  DOCK_LAYOUT_VERSION,
  PANEL_MIN_HEIGHT,
  PANEL_MIN_WIDTH,
  readSavedLayout,
  splitFits,
  stripFloats,
} from "../dock-layout";

describe("saved dock layouts", () => {
  const layout = { grid: { root: {} }, panels: { chat: {} }, activeGroup: "1" };

  it("restores a layout saved by the tabbed dock", () => {
    expect(readSavedLayout({ v: DOCK_LAYOUT_VERSION, layout })).toEqual(layout);
  });

  it("drops a legacy layout from the tiling dock instead of restoring the wall of columns", () => {
    // v1 was saved bare, with no envelope at all
    expect(readSavedLayout(layout)).toBeNull();
    // and an explicit older version is dropped just the same
    expect(readSavedLayout({ v: 1, layout })).toBeNull();
  });

  it("drops garbage without throwing", () => {
    expect(readSavedLayout(undefined)).toBeNull();
    expect(readSavedLayout(null)).toBeNull();
    expect(readSavedLayout("nope")).toBeNull();
    expect(readSavedLayout({ v: DOCK_LAYOUT_VERSION })).toBeNull();
    expect(readSavedLayout({ v: DOCK_LAYOUT_VERSION, layout: 42 })).toBeNull();
  });

  it("never persists floats or popouts", () => {
    const stripped = stripFloats({
      ...layout,
      floatingGroups: [{ id: "float-1" }],
      popoutGroups: [{ id: "popout-1" }],
    });
    expect(stripped).toEqual(layout);
  });
});

describe("split guard (AQV-002)", () => {
  const dock = (width: number, groups: number) => ({
    width,
    height: 900,
    groups: Array.from({ length: groups }, () => ({})),
  });

  it("allows a second column in a normal window", () => {
    expect(splitFits(dock(1100, 1), "right")).toBe(true);
  });

  it("refuses the column that would fall under the readable minimum", () => {
    // 8 groups already: a ninth column would be ~120px — the 2px-button regime
    expect(splitFits(dock(1100, 8), "right")).toBe(false);
    // even a wide window runs out at some point: 1100/5 = 220 < 260
    expect(splitFits(dock(1100, 4), "right")).toBe(false);
    // three columns still fit at 275 each
    expect(splitFits(dock(1100, 3), "right")).toBe(true);
  });

  it("measures rows against the height, not the width", () => {
    expect(splitFits({ width: 2000, height: 900, groups: [{}] }, "below")).toBe(true);
    expect(splitFits({ width: 2000, height: 300, groups: [{}] }, "below")).toBe(false);
    expect(PANEL_MIN_HEIGHT).toBeGreaterThan(120);
  });

  it("does not block a split before the dock has been measured", () => {
    expect(splitFits({ width: 0, height: 0, groups: [] }, "right")).toBe(true);
  });

  it("keeps a readable floor", () => {
    expect(PANEL_MIN_WIDTH).toBeGreaterThanOrEqual(220);
  });
});
