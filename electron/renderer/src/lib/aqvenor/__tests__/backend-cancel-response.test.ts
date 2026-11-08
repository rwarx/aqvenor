// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => { vi.resetModules(); localStorage.clear(); delete window.aqvenor; });
afterEach(() => vi.unstubAllGlobals());

it("accepts cancellation only after the server confirms completion", async () => {
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ cancelled: true, completed: true }), { status: 200 }));
  vi.stubGlobal("fetch", request);
  const { runs } = await import("../backend");
  await expect(runs.cancel("10000000-0000-0000-0000-000000000001")).resolves.toBeUndefined();
  expect(String(request.mock.calls[0][0])).toMatch(/\/api\/runs\/10000000-0000-0000-0000-000000000001\/cancel$/);
  expect(request.mock.calls[0][1]).toMatchObject({ method: "POST" });
});

it.each([{ cancelled: true }, { cancelled: true, completed: false }, { cancelled: false, completed: true }])("rejects an incomplete cancellation acknowledgement %j", async (body) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
  const { runs } = await import("../backend");
  await expect(runs.cancel("run-id")).rejects.toThrow("Server did not confirm that the task stopped");
});

it("propagates a server failure so update installation can retry cancellation", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "The task is still stopping" }), { status: 409 })));
  const { runs } = await import("../backend");
  await expect(runs.cancel("run-id")).rejects.toThrow("The task is still stopping");
});
