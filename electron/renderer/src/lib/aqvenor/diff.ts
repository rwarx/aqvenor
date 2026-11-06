import type { DiffLine } from "./types";

/* ============================================================
   Unified line diff with context collapsing + hunks.
   Used by the checkpoint review view in the Code surface:
   compares a checkpoint's file snapshot against the current
   content and renders through the chat DiffView component.
   ============================================================ */

/** Split text into lines, dropping a single trailing newline.
 *  Null-tolerant: rehydrated file entries lose their content (persist strips
 *  bodies), so callers may hand over undefined — diff against empty. */
function toLines(text: string | null | undefined): string[] {
  const src = text ?? "";
  const body = src.endsWith("\n") ? src.slice(0, -1) : src;
  return body.length ? body.split("\n") : [];
}

type LineOp = { op: "keep" | "del" | "add"; line: string };

/* Keep the legacy tie breaking for small files, with a table capped at
   256 KiB. Large files never allocate a table proportional to n * m. */
const SMALL_DIFF_CELLS = 65_536;
/* Myers' frontier and saved paths have a fixed memory ceiling (about
   4 MiB), and the work budget also bounds repeated-line comparisons.
   A difficult remaining region becomes one replacement, preserving every
   line so accepting/rejecting it still reconstructs the file exactly. */
const MAX_EDIT_DISTANCE = 1_024;
const MAX_DIFF_WORK = 1_000_000;

function smallLcsOps(a: string[], b: string[], aStart: number, aEnd: number, bStart: number, bEnd: number): LineOp[] {
  const n = aEnd - aStart;
  const m = bEnd - bStart;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[aStart + i] === b[bStart + j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[aStart + i] === b[bStart + j]) {
      ops.push({ op: "keep", line: a[aStart + i] });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ op: "del", line: a[aStart + i] });
      i++;
    } else {
      ops.push({ op: "add", line: b[bStart + j] });
      j++;
    }
  }
  while (i < n) ops.push({ op: "del", line: a[aStart + i++] });
  while (j < m) ops.push({ op: "add", line: b[bStart + j++] });
  return ops;
}

/** Shortest edit script in O((n + m) * edits) work, subject to fixed caps. */
function myersOps(a: string[], b: string[], aStart: number, aEnd: number, bStart: number, bEnd: number): LineOp[] | null {
  const n = aEnd - aStart;
  const m = bEnd - bStart;
  const maxDistance = Math.min(MAX_EDIT_DISTANCE, n + m);
  const offset = maxDistance + 1;
  const frontier = new Int32Array(2 * maxDistance + 3).fill(-1);
  frontier[offset + 1] = 0;
  const trace: Int32Array[] = [];
  let work = 0;

  for (let distance = 0; distance <= maxDistance; distance++) {
    const path = new Int32Array(2 * distance + 1);
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (++work > MAX_DIFF_WORK) return null;
      let x = diagonal === -distance || (diagonal !== distance && frontier[offset + diagonal - 1] < frontier[offset + diagonal + 1])
        ? frontier[offset + diagonal + 1]
        : frontier[offset + diagonal - 1] + 1;
      let y = x - diagonal;
      while (x < n && y < m) {
        if (++work > MAX_DIFF_WORK) return null;
        if (a[aStart + x] !== b[bStart + y]) break;
        x++;
        y++;
      }
      frontier[offset + diagonal] = x;
      path[diagonal + distance] = x;
      if (x >= n && y >= m) {
        trace.push(path);
        return backtrackMyers(a, b, aStart, bStart, n, m, trace);
      }
    }
    trace.push(path);
  }
  return null;
}

function backtrackMyers(a: string[], b: string[], aStart: number, bStart: number, x: number, y: number, trace: Int32Array[]): LineOp[] {
  const ops: LineOp[] = [];
  for (let distance = trace.length - 1; distance > 0; distance--) {
    const diagonal = x - y;
    const previous = trace[distance - 1];
    const previousOffset = distance - 1;
    const previousDiagonal = diagonal === -distance || (diagonal !== distance && previous[diagonal - 1 + previousOffset] < previous[diagonal + 1 + previousOffset])
      ? diagonal + 1
      : diagonal - 1;
    const previousX = previous[previousDiagonal + previousOffset];
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      ops.push({ op: "keep", line: a[aStart + --x] });
      y--;
    }
    if (x === previousX) ops.push({ op: "add", line: b[bStart + --y] });
    else ops.push({ op: "del", line: a[aStart + --x] });
  }
  while (x > 0 && y > 0) {
    ops.push({ op: "keep", line: a[aStart + --x] });
    y--;
  }
  return ops.reverse();
}

function lcsOps(a: string[], b: string[]): LineOp[] {
  if ((a.length + 1) * (b.length + 1) <= SMALL_DIFF_CELLS) {
    return smallLcsOps(a, b, 0, a.length, 0, b.length);
  }

  const ops: LineOp[] = [];
  let start = 0;
  let aEnd = a.length;
  let bEnd = b.length;
  while (start < aEnd && start < bEnd && a[start] === b[start]) {
    ops.push({ op: "keep", line: a[start++] });
  }
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }

  if (aEnd === start || bEnd === start) {
    for (let i = start; i < aEnd; i++) ops.push({ op: "del", line: a[i] });
    for (let i = start; i < bEnd; i++) ops.push({ op: "add", line: b[i] });
  } else {
    const middle = (aEnd - start + 1) * (bEnd - start + 1) <= SMALL_DIFF_CELLS
      ? smallLcsOps(a, b, start, aEnd, start, bEnd)
      : myersOps(a, b, start, aEnd, start, bEnd);
    if (middle) {
      for (const op of middle) ops.push(op);
    } else {
      for (let i = start; i < aEnd; i++) ops.push({ op: "del", line: a[i] });
      for (let i = start; i < bEnd; i++) ops.push({ op: "add", line: b[i] });
    }
  }
  for (let i = aEnd; i < a.length; i++) ops.push({ op: "keep", line: a[i] });
  return ops;
}

const CONTEXT = 3; /* context lines around each change */

/**
 * Computes a unified diff (old → new) as DiffLine[] with
 * `header` hunk markers in git style. Empty when identical.
 */
export function computeUnifiedDiff(oldText: string | null | undefined, newText: string | null | undefined): DiffLine[] {
  const a = toLines(oldText);
  const b = toLines(newText);
  if (a.join("\n") === b.join("\n")) return [];

  const ops = lcsOps(a, b);
  /* mark windows of CONTEXT around every change */
  const visible = new Uint8Array(ops.length);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].op === "keep") continue;
    for (let w = Math.max(0, k - CONTEXT); w <= Math.min(ops.length - 1, k + CONTEXT); w++) {
      visible[w] = 1;
    }
  }

  /* walk old/new line numbers for hunk headers */
  let oldNo = 0;
  let newNo = 0;
  const out: DiffLine[] = [];
  let inHunk = false;
  let skippedSinceHunk = false;
  for (let k = 0; k < ops.length; k++) {
    const o = ops[k];
    if (o.op !== "add") oldNo++;
    if (o.op !== "del") newNo++;
    if (visible[k]) {
      if (!inHunk) {
        if (skippedSinceHunk) out.push({ kind: "context", text: "⋯" });
        out.push({
          kind: "header",
          text: `@@ ${oldNo},${countHunk(ops, visible, k, "old")} → ${newNo},${countHunk(ops, visible, k, "new")} @@`,
        });
        inHunk = true;
      }
      out.push({ kind: o.op === "keep" ? "context" : o.op === "del" ? "del" : "add", text: o.line });
    } else {
      if (inHunk) {
        inHunk = false;
        skippedSinceHunk = true;
      }
    }
  }
  return out;
}

/** number of old/new lines the hunk starting at `start` will emit */
function countHunk(
  ops: LineOp[],
  visible: Uint8Array,
  start: number,
  which: "old" | "new",
): number {
  let count = 0;
  for (let k = start; k < ops.length && visible[k]; k++) {
    const op = ops[k].op;
    if (op === "keep" || (which === "old" ? op === "del" : op === "add")) count++;
  }
  return count;
}

/** +/− stats as {add, del} over a DiffLine[] */
export function diffStats(lines: DiffLine[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.kind === "add") add++;
    else if (l.kind === "del") del++;
  }
  return { add, del };
}

/* ============================================================
   Per-hunk selection (Tier 1 #5). A "hunk" is a maximal run of
   changed lines (del/add) between runs of unchanged context.
   Accepting a hunk keeps the NEW lines; rejecting keeps the OLD
   lines. This lets the review screen apply changes piecemeal,
   reconstructing a file that mixes accepted + reverted regions.
   ============================================================ */

export interface Hunk {
  /** stable index within the file's ordered hunk list */
  index: number;
  /** 1-based OLD position; insertions use the next line (length + 1 at EOF). */
  oldStart: number;
  /** 1-based line where the change begins in the NEW text */
  newStart: number;
  oldLines: string[];
  newLines: string[];
}

/** Ordered hunks between the two texts. Empty when identical. */
export function computeHunks(oldText: string | null | undefined, newText: string | null | undefined): Hunk[] {
  const ops = lcsOps(toLines(oldText), toLines(newText));
  const hunks: Hunk[] = [];
  let oldNo = 0;
  let newNo = 0;
  let cur: { oldStart: number; newStart: number; oldLines: string[]; newLines: string[] } | null = null;
  const flush = () => {
    if (cur) {
      hunks.push({ index: hunks.length, ...cur });
      cur = null;
    }
  };
  for (const o of ops) {
    if (o.op === "keep") {
      flush();
      oldNo++;
      newNo++;
    } else {
      if (!cur) cur = { oldStart: oldNo + 1, newStart: newNo + 1, oldLines: [], newLines: [] };
      if (o.op === "del") {
        cur.oldLines.push(o.line);
        oldNo++;
      } else {
        cur.newLines.push(o.line);
        newNo++;
      }
    }
  }
  flush();
  return hunks;
}

/**
 * Reconstruct file content from `oldText`→`newText` keeping only the hunks
 * whose index is in `accepted` (rejected hunks fall back to the old lines).
 * With all hunks accepted the result equals `newText`; with none, `oldText`.
 */
export function applyHunkSelection(oldText: string | null | undefined, newText: string | null | undefined, accepted: Set<number>): string {
  if (accepted.size === 0) return oldText ?? "";
  const ops = lcsOps(toLines(oldText), toLines(newText));
  const out: string[] = [];
  let hunkIdx = -1;
  let acceptedCount = 0;
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op === "keep") {
      out.push(ops[i].line);
      i++;
      continue;
    }
    hunkIdx++;
    const keep = accepted.has(hunkIdx);
    if (keep) acceptedCount++;
    while (i < ops.length && ops[i].op !== "keep") {
      /* Append individually: a large hunk would exceed push's argument
         limit if its lines were spread into the call. */
      if (ops[i].op === (keep ? "add" : "del")) out.push(ops[i].line);
      i++;
    }
  }
  if (acceptedCount === 0) return oldText ?? "";
  if (acceptedCount === hunkIdx + 1) return newText ?? "";
  const keepNewline = (newText ?? "").endsWith("\n");
  return out.join("\n") + (out.length && keepNewline ? "\n" : "");
}

/** DiffLine[] for a single hunk (with its own header), for per-hunk rendering. */
export function hunkDiffLines(h: Hunk): DiffLine[] {
  const lines: DiffLine[] = [
    { kind: "header", text: `@@ -${h.oldStart},${h.oldLines.length} +${h.newStart},${h.newLines.length} @@` },
  ];
  for (const l of h.oldLines) lines.push({ kind: "del", text: l });
  for (const l of h.newLines) lines.push({ kind: "add", text: l });
  return lines;
}
