import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
function fixture(allowed = true) {
  const { registerAgentPermissionIpc } = require("../../../../../main/agent-permissions.js");
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  const confirm = vi.fn().mockResolvedValue(allowed);
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ allowCommands: true, allowShellCommands: true })));
  registerAgentPermissionIpc({ handle: (name: string, fn: typeof handlers[string]) => { handlers[name] = fn; } }, {
    ready: Promise.resolve(), getBackendUrl: () => "http://127.0.0.1:45631", authToken: "renderer-secret", hostToken: "private-host-secret", confirm, fetchImpl,
  });
  return { invoke: async (patch: unknown) => handlers["aqvenor:agent-permissions"]({}, patch, "ru"), confirm, fetchImpl };
}

describe("desktop agent permission changes", () => {
  it("does not write permissions when native confirmation is declined", async () => {
    const { invoke, confirm, fetchImpl } = fixture(false);
    expect(await invoke({ allowCommands: true, allowShellCommands: true })).toEqual({ cancelled: true });
    expect(confirm).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("keeps the host credential in the main process request", async () => {
    const { invoke, fetchImpl } = fixture();
    expect(await invoke({ allowCommands: true, allowShellCommands: true })).toEqual({ allowCommands: true, allowShellCommands: true });
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:45631/api/host/agent-permissions");
    expect(request.headers["X-Aqvenor-Host-Token"]).toBe("private-host-secret");
    expect(request.headers.Authorization).toBe("Bearer renderer-secret");
    expect(request.body).toBe('{"allowCommands":true,"allowShellCommands":true}');
  });
  it.each([{}, { allowCommands: "true" }, { allowNetwork: true }, { allowCommands: true, allowedCommands: ["cmd"] }, null])("rejects unsupported input before prompting (%j)", async (patch) => {
    const { invoke, confirm, fetchImpl } = fixture();
    await expect(invoke(patch)).rejects.toThrow();
    expect(confirm).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("allows disabling commands without an enable confirmation", async () => {
    const { invoke, confirm } = fixture();
    await invoke({ allowCommands: false });
    expect(confirm).not.toHaveBeenCalled();
  });
});
