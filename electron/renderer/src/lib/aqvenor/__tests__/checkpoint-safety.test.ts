import { describe, expect, it } from "vitest";
import { canApplyCheckpoint } from "../checkpoint-safety";
import type { Checkpoint } from "../types";

const cp: Checkpoint = { id: "id", label: "before", createdAt: 1, filesSnapshot: [], formatVersion: 2, workspaceRoot: "D:/A", sessionId: "chat", message: "" };
describe("checkpoint workspace boundary", () => {
  it("accepts a complete snapshot only in its recorded workspace", () => {
    expect(canApplyCheckpoint(cp, "d:/a", true)).toBe(true);
    expect(canApplyCheckpoint(cp, "D:/B", true)).toBe(false);
    expect(canApplyCheckpoint(cp, null, true)).toBe(false);
  });
  it("refuses potentially truncated legacy snapshots", () => {
    expect(canApplyCheckpoint({ ...cp, formatVersion: undefined }, "D:/A", true)).toBe(false);
    expect(canApplyCheckpoint({ ...cp, formatVersion: 1 }, "D:/A", true)).toBe(false);
    expect(canApplyCheckpoint(cp, null, false)).toBe(true);
  });
});
