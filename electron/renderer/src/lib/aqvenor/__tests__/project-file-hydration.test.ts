// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerWorkspaceEntry } from "../backend";

const root = "D:\\mcp-project-a";
const otherRoot = "D:\\mcp-project-b";
const configPath = ".aqvenor/mcp.json";
const config = JSON.stringify({ version: 1, servers: [
  { name: "Project tools", transport: "http", target: "https://example.com/mcp", enabled: true },
] });
const entry = (path: string, isDirectory = false): ServerWorkspaceEntry => ({
  path, name: path.split("/").at(-1)!, isDirectory, size: 10, modifiedAt: "2026-11-09T00:00:00Z",
});
const listing = (path: string, entries: ServerWorkspaceEntry[]) => ({ path, entries, isTruncated: false });
const document = { path: configPath, content: config, firstLine: 1, lineCount: 1, totalLines: 1, size: config.length, isTruncated: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  delete window.aqvenor;
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected project-hydration network request")));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture() {
  const { workspace } = await import("../backend");
  const { useAqvenor } = await import("../store");
  const sync = await import("../sync");
  vi.spyOn(sync, "isServerMode").mockReturnValue(true);
  useAqvenor.setState({ workspaceRoot: root, mcpServers: [] });
  const status = vi.spyOn(workspace, "status").mockResolvedValue({ isOpen: true, root });
  const list = vi.spyOn(workspace, "list").mockImplementation(async (path = ".") =>
    path === "." ? listing(path, [entry(".aqvenor", true)]) : listing(path, [entry(configPath)]));
  const read = vi.spyOn(workspace, "readDocument").mockResolvedValue(document);
  const { hydrateProjectFiles } = await import("../project-files");
  return { status, list, read, useAqvenor, hydrateProjectFiles };
}

describe("optional project MCP hydration", () => {
  it("does not read a missing configuration in a fresh project", async () => {
    const f = await fixture();
    f.list.mockResolvedValueOnce(listing(".", [entry(".aqvenor", true)]));
    f.list.mockResolvedValueOnce(listing(".aqvenor", [entry(".aqvenor/README.md")]));
    await f.hydrateProjectFiles();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.useAqvenor.getState().mcpServers).toEqual([]);
  });

  it("does not request a missing .aqvenor directory or its configuration", async () => {
    const f = await fixture();
    f.list.mockResolvedValueOnce(listing(".", []));
    await f.hydrateProjectFiles();
    expect(f.list).toHaveBeenCalledExactlyOnceWith(".", false);
    expect(f.read).not.toHaveBeenCalled();
  });

  it("reads an indexed configuration with the expected-root lease and imports it disabled", async () => {
    const f = await fixture();
    await f.hydrateProjectFiles();
    expect(f.read).toHaveBeenCalledExactlyOnceWith(configPath, root);
    expect(f.useAqvenor.getState().mcpServers).toEqual([
      expect.objectContaining({ name: "Project tools", target: "https://example.com/mcp", projectRoot: root, enabled: false }),
    ]);
  });

  it("does not read when the server workspace already differs from the captured root", async () => {
    const f = await fixture();
    f.status.mockResolvedValueOnce({ isOpen: true, root: otherRoot });
    await f.hydrateProjectFiles();
    expect(f.list).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.useAqvenor.getState().mcpServers).toEqual([]);
  });

  it("discards an index received after the person switches workspaces", async () => {
    const f = await fixture();
    const pending = deferred<ReturnType<typeof listing>>();
    f.list.mockImplementationOnce(() => pending.promise);
    const hydration = f.hydrateProjectFiles();
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
    f.useAqvenor.setState({ workspaceRoot: otherRoot });
    pending.resolve(listing(".", [entry(".aqvenor", true)]));
    await hydration;
    expect(f.list).toHaveBeenCalledOnce();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.useAqvenor.getState().mcpServers).toEqual([]);
  });

  it("discards a document received after switching workspaces", async () => {
    const f = await fixture();
    const pending = deferred<typeof document>();
    f.read.mockReturnValueOnce(pending.promise);
    const hydration = f.hydrateProjectFiles();
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
    f.useAqvenor.setState({ workspaceRoot: otherRoot });
    pending.resolve(document);
    await hydration;
    expect(f.useAqvenor.getState().mcpServers).toEqual([]);
  });
});
