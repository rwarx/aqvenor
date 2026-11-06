import { describe, expect, it } from "vitest";
import { applyHunkSelection, computeHunks, computeUnifiedDiff, diffStats, hunkDiffLines, type Hunk } from "../diff";

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

/** Independent reconstruction through hunk coordinates, rather than the
 * internal edit script used by applyHunkSelection. */
function selectHunks(oldLines: string[], hunks: Hunk[], accepted: Set<number>): string[] {
  const result: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    while (cursor < hunk.oldStart - 1) result.push(oldLines[cursor++]);
    for (const line of accepted.has(hunk.index) ? hunk.newLines : hunk.oldLines) result.push(line);
    cursor += hunk.oldLines.length;
  }
  while (cursor < oldLines.length) result.push(oldLines[cursor++]);
  return result;
}

/** A small reference oracle uses linear memory and checks edit minimality. */
function lcsLength(a: string[], b: string[]): number {
  const row = new Uint32Array(b.length + 1);
  for (const line of a) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const previous = row[j];
      row[j] = line === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = previous;
    }
  }
  return row[b.length];
}

describe("hunk selection and ordinary diff compatibility", () => {
  it("keeps deletion-first matching for ambiguous repeated lines", () => {
    expect(computeHunks("a\nb\n", "b\nb\n")).toEqual([
      { index: 0, oldStart: 1, newStart: 1, oldLines: ["a"], newLines: [] },
      { index: 1, oldStart: 3, newStart: 2, oldLines: [], newLines: ["b"] },
    ]);
    expect(computeUnifiedDiff("a\nb\n", "a\nc\n")).toEqual([
      { kind: "header", text: "@@ 1,2 → 1,2 @@" },
      { kind: "context", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "c" },
    ]);
  });

  it("keeps insertion, replacement and deletion independently selectable", () => {
    const oldText = "first\nkeep-a\nold\nkeep-b\nremoved\nlast\n";
    const newText = "inserted\nfirst\nkeep-a\nnew\nkeep-b\nlast\n";
    const hunks = computeHunks(oldText, newText);
    expect(hunks).toEqual([
      { index: 0, oldStart: 1, newStart: 1, oldLines: [], newLines: ["inserted"] },
      { index: 1, oldStart: 3, newStart: 4, oldLines: ["old"], newLines: ["new"] },
      { index: 2, oldStart: 5, newStart: 6, oldLines: ["removed"], newLines: [] },
    ]);
    for (let mask = 0; mask < 8; mask++) {
      const accepted = new Set(hunks.filter((h) => mask & (1 << h.index)).map((h) => h.index));
      const expected = selectHunks(oldText.slice(0, -1).split("\n"), hunks, accepted).join("\n") + "\n";
      expect(applyHunkSelection(oldText, newText, accepted)).toBe(expected);
    }
    expect(hunkDiffLines(hunks[1])).toEqual([
      { kind: "header", text: "@@ -3,1 +4,1 @@" },
      { kind: "del", text: "old" },
      { kind: "add", text: "new" },
    ]);
  });

  it("returns exact endpoints, including blank files and trailing newlines", () => {
    for (const [oldText, newText] of [["\n", "a\n"], ["a\n", "\n"], ["a", "b\n"], ["a\n\n", "b"]]) {
      const hunks = computeHunks(oldText, newText);
      expect(applyHunkSelection(oldText, newText, new Set())).toBe(oldText);
      expect(applyHunkSelection(oldText, newText, new Set(hunks.map((h) => h.index)))).toBe(newText);
      expect(applyHunkSelection(oldText, newText, new Set([999]))).toBe(oldText);
    }
  });
});

describe("bounded diff for large files", () => {
  it("computes minimal Myers edits for insertions and deletions across a large span", () => {
    const oldLines = Array.from({ length: 400 }, (_, i) => `line-${i}`);
    const newLines = oldLines.slice(1);
    newLines.splice(199, 0, "new-middle");
    newLines.push("new-last");
    const oldText = oldLines.join("\n") + "\n";
    const newText = newLines.join("\n") + "\n";
    const hunks = computeHunks(oldText, newText);
    expect(hunks).toEqual([
      { index: 0, oldStart: 1, newStart: 1, oldLines: ["line-0"], newLines: [] },
      { index: 1, oldStart: 201, newStart: 200, oldLines: [], newLines: ["new-middle"] },
      { index: 2, oldStart: 401, newStart: 401, oldLines: [], newLines: ["new-last"] },
    ]);
    expect(diffStats(computeUnifiedDiff(oldText, newText))).toEqual({ add: 2, del: 1 });
    expect(selectHunks(oldLines, hunks, new Set([0, 1, 2]))).toEqual(newLines);
    expect(applyHunkSelection(oldText, newText, new Set([0, 2]))).toBe(oldLines.slice(1).concat("new-last").join("\n") + "\n");
  });

  it("matches a reference LCS on deterministic random repeated-line files", () => {
    let seed = 0x12345678;
    const randomLine = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return `line-${seed % 24}`;
    };
    for (let trial = 0; trial < 12; trial++) {
      // 300 * 300 exceeds the small-file table cap and exercises Myers.
      const oldLines = Array.from({ length: 300 }, randomLine);
      const newLines = Array.from({ length: 310 }, randomLine);
      const oldText = oldLines.join("\n");
      const newText = newLines.join("\n");
      const hunks = computeHunks(oldText, newText);
      const common = lcsLength(oldLines, newLines);
      const stats = diffStats(computeUnifiedDiff(oldText, newText));
      expect(stats).toEqual({ add: newLines.length - common, del: oldLines.length - common });
      expect(selectHunks(oldLines, hunks, new Set(hunks.map((h) => h.index)))).toEqual(newLines);
      const accepted = new Set(hunks.filter((h) => h.index % 2 === 0).map((h) => h.index));
      expect(applyHunkSelection(oldText, newText, accepted)).toBe(selectHunks(oldLines, hunks, accepted).join("\n"));
    }
  });

  it("keeps widely separated edits in a 50,000-line file as individual hunks", () => {
    const oldLines = Array.from({ length: 50_000 }, (_, i) => `line-${i}`);
    const newLines = oldLines.slice();
    const changed = [5, 25_000, 49_994];
    for (const index of changed) newLines[index] = `changed-${index}`;
    const oldText = oldLines.join("\n") + "\n";
    const newText = newLines.join("\n") + "\n";
    const hunks = computeHunks(oldText, newText);
    expect(hunks).toEqual(changed.map((line, index) => ({
      index, oldStart: line + 1, newStart: line + 1, oldLines: [oldLines[line]], newLines: [newLines[line]],
    })));
    const unified = computeUnifiedDiff(oldText, newText);
    expect(diffStats(unified)).toEqual({ add: 3, del: 3 });
    expect(unified.filter((line) => line.kind === "header")).toHaveLength(3);
    expect(unified.filter((line) => line.text === "⋯")).toHaveLength(2);
    expect(unified).toHaveLength(29);
    const partlyAccepted = oldLines.slice();
    partlyAccepted[25_000] = newLines[25_000];
    expect(applyHunkSelection(oldText, newText, new Set([1]))).toBe(partlyAccepted.join("\n") + "\n");
    expect(applyHunkSelection(oldText, newText, new Set([0, 1, 2]))).toBe(newText);
    expect(computeHunks(oldText, oldText)).toEqual([]);
    expect(computeUnifiedDiff(oldText, oldText)).toEqual([]);
  });

  it("bounds a 120,000-line replacement while preserving its surrounding context and selections", () => {
    const oldBody = Array.from({ length: 120_000 }, (_, i) => `old-${i}`);
    const newBody = Array.from({ length: 120_000 }, (_, i) => `new-${i}`);
    const prefix = ["prefix-1", "prefix-2", "prefix-3"];
    const suffix = ["suffix-1", "suffix-2", "suffix-3"];
    const oldText = prefix.concat(oldBody, suffix).join("\n") + "\n";
    const newText = prefix.concat(newBody, suffix).join("\n") + "\n";
    const hunks = computeHunks(oldText, newText);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toEqual({ index: 0, oldStart: 4, newStart: 4, oldLines: oldBody, newLines: newBody });
    expect(applyHunkSelection(oldText, newText, new Set([0]))).toBe(newText);
    expect(applyHunkSelection(oldText, newText, new Set())).toBe(oldText);
    const unified = computeUnifiedDiff(oldText, newText);
    expect(diffStats(unified)).toEqual({ add: 120_000, del: 120_000 });
    expect(unified[0]).toEqual({ kind: "header", text: "@@ 1,120006 → 1,120006 @@" });
    expect(unified[1]).toEqual({ kind: "context", text: "prefix-1" });
    expect(unified[unified.length - 1]).toEqual({ kind: "context", text: "suffix-3" });
  });

  it("handles an empty side without searching an edit path", () => {
    const text = Array.from({ length: 150_000 }, (_, i) => `line-${i}`).join("\n") + "\n";
    const insertion = computeHunks("", text);
    expect(insertion).toHaveLength(1);
    expect(insertion[0].oldLines).toEqual([]);
    expect(insertion[0].newLines).toHaveLength(150_000);
    expect(applyHunkSelection("", text, new Set([0]))).toBe(text);
    const deletion = computeHunks(text, "");
    expect(deletion).toHaveLength(1);
    expect(deletion[0].oldLines).toHaveLength(150_000);
    expect(deletion[0].newLines).toEqual([]);
    expect(applyHunkSelection(text, "", new Set([0]))).toBe("");
  });
});
