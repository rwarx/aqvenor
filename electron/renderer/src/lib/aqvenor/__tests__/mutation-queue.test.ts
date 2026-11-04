import { describe, expect, it, vi } from "vitest";
import { MutationQueue } from "../mutation-queue";
describe("graph mutation retries", () => {
  it("retains the failed command and retries it before later edits with the same id", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const q = new MutationQueue(send);
    q.enqueue({ id: "first" });
    await expect(q.flush()).rejects.toThrow("offline");
    q.enqueue({ id: "second" });
    await q.flush();
    expect(send.mock.calls.map((call) => call[0].id)).toEqual(["first", "first", "second"]);
  });
});
