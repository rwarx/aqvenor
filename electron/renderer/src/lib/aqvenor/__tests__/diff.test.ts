import { describe, expect, it } from "vitest";
import { applyHunkSelection, computeHunks, computeUnifiedDiff } from "../diff";

describe("null-tolerant diff (rehydrated files lose bodies)", () => {
  it("diffs missing content as empty instead of crashing", () => {
    expect(computeUnifiedDiff(undefined, undefined)).toEqual([]);
    expect(computeUnifiedDiff(null, "a\n")).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "add", text: "a" })]),
    );
    expect(computeUnifiedDiff("a\n", undefined)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "del", text: "a" })]),
    );
    expect(computeHunks(undefined, "a\n").length).toBeGreaterThan(0);
    expect(applyHunkSelection(undefined, undefined, new Set())).toBe("");
  });

  it("still diffs real texts exactly", () => {
    const lines = computeUnifiedDiff("a\nb\n", "a\nc\n");
    expect(lines.some((l) => l.kind === "del" && l.text === "b")).toBe(true);
    expect(lines.some((l) => l.kind === "add" && l.text === "c")).toBe(true);
  });
});
