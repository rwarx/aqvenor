// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => { vi.resetModules(); localStorage.clear(); delete window.aqvenor; });
afterEach(() => vi.unstubAllGlobals());

it("returns a rejected canonical snapshot from HTTP 400 so it is not retried as a lost mutation", async () => {
  const body = { error: "Invalid node", applied: 0, rejected: ["Invalid node"], saved: false,
    snapshot: { nodes: [], edges: [], version: 0, workspaceRoot: "A" } };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 400 })));
  const { graph } = await import("../backend");
  await expect(graph.apply("Invalid", [{ kind: "add-node", node: { id: "x", kind: "unknown", title: "X", x: 0, y: 0 } }], "A")).resolves.toEqual(body);
});

it("keeps a workspace conflict and a malformed rejection as failures", async () => {
  const request = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: "Project changed" }), { status: 409 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Bad request" }), { status: 400 }));
  vi.stubGlobal("fetch", request);
  const { graph } = await import("../backend");
  await expect(graph.apply("Edit", [], "A")).rejects.toThrow("Project changed");
  await expect(graph.apply("Edit", [], "A")).rejects.toThrow("Bad request");
});
