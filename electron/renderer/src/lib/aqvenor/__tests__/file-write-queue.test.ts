import { afterEach, describe, expect, it, vi } from "vitest";
import { FileWriteQueue } from "../file-write-queue";
const entry = (content: string, revision: number) => ({ path: "file.txt", root: "A", content, revision });
afterEach(() => vi.useRealTimers());
describe("file writes under network failures and concurrent edits", () => {
  it("retains a failed payload for an explicit retry", async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const q = new FileWriteQueue(write, vi.fn());
    q.enqueue(entry("latest", 1));
    await expect(q.flushAll()).rejects.toThrow("offline");
    expect(q.paths()).toEqual(["file.txt"]);
    await q.flushAll();
    expect(write).toHaveBeenLastCalledWith(entry("latest", 1));
    expect(q.paths()).toEqual([]);
  });
  it("waits for in-flight writes and serializes a newer revision after them", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((r) => { release = r; });
    const write = vi.fn().mockReturnValueOnce(blocked).mockResolvedValue(undefined);
    const report = vi.fn();
    const q = new FileWriteQueue(write, report);
    q.enqueue(entry("old", 1));
    await vi.advanceTimersByTimeAsync(700);
    q.enqueue(entry("new", 2));
    let done = false;
    const flush = q.flushAll().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    release();
    await flush;
    expect(write.mock.calls.map((call) => call[0].content)).toEqual(["old", "new"]);
    expect(report).toHaveBeenLastCalledWith(entry("new", 2), "saved");
  });
  it("keeps identical paths in different projects separate", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const q = new FileWriteQueue(write, vi.fn());
    q.enqueue(entry("A content", 1));
    q.enqueue({ ...entry("B content", 1), root: "B" });
    await q.flushAll();
    expect(write.mock.calls.map((call) => call[0].root).sort()).toEqual(["A", "B"]);
  });
});
