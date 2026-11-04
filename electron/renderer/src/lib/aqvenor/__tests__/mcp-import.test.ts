// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { importMcpServers } from "../mcp";
import { useAqvenor } from "../store";
describe("project MCP imports", () => {
  it("imports without enabling or probing, and does not retain another project's servers", () => {
    useAqvenor.setState({ mcpServers: [] });
    const file = { servers: [{ name: "Remote", transport: "http", target: "https://example.com/mcp", enabled: true }] };
    expect(importMcpServers(file, "A")).toBe(1);
    expect(useAqvenor.getState().mcpServers[0]).toMatchObject({ enabled: false, projectRoot: "A" });
    importMcpServers(file, "B");
    expect(useAqvenor.getState().mcpServers).toHaveLength(1);
    expect(useAqvenor.getState().mcpServers[0]).toMatchObject({ enabled: false, projectRoot: "B" });
  });
});
