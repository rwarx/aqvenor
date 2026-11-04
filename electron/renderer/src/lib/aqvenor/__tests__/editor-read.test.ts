// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspace } from "../backend";
import { readServerFile } from "../sync";
import { useAqvenor } from "../store";

afterEach(() => vi.restoreAllMocks());
beforeEach(() => useAqvenor.setState({ workspaceRoot: "A" }));

describe("editor document reads", () => {
  it("loads the complete document beyond the agent excerpt limit", async () => {
    useAqvenor.setState({ workspaceRoot: "A" });
    const content = "a".repeat(70_000) + "\nLAST LINE\n";
    const read = vi.spyOn(workspace, "readDocument").mockResolvedValue({
      path: "large.txt", content, firstLine: 1, lineCount: 2, totalLines: 2,
      size: content.length, isTruncated: false,
    });
    expect(await readServerFile("large.txt")).toBe(content);
    expect(read).toHaveBeenCalledWith("large.txt", "A");
  });

  it("refuses a partial response instead of opening it as a complete document", async () => {
    vi.spyOn(workspace, "readDocument").mockResolvedValue({
      path: "large.txt", content: "prefix", firstLine: 1, lineCount: 1, totalLines: 10,
      size: 70_000, isTruncated: true,
    });
    expect(await readServerFile("large.txt")).toBeNull();
  });
});
