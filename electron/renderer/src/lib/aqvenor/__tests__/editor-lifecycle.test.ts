// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspace, type ServerWorkspaceEntry } from "../backend";
import { loadEditorDocument, mergeListedFiles } from "../editor-documents";
import { useAqvenor } from "../store";

const S = () => useAqvenor.getState();
const entry: ServerWorkspaceEntry = { path: "a.txt", name: "a.txt", isDirectory: false, size: 10, modifiedAt: "2026-11-04" };
const document = (content: string) => ({ path: "a.txt", content, firstLine: 1, lineCount: 1, totalLines: 1, size: content.length, isTruncated: false });

beforeEach(() => useAqvenor.setState({ workspaceRoot: "A", files: [{ path: "a.txt", language: "text", content: "original", loadState: "loaded", revision: 0, workspaceRoot: "A" }], saveStatus: {} }));
afterEach(() => vi.restoreAllMocks());

describe("editor load and reload", () => {
  it("keeps the loaded document when refreshing the file listing", () => {
    expect(mergeListedFiles([entry], true)[0].content).toBe("original");
  });

  it("does not carry a document into another project's matching path", () => {
    useAqvenor.setState({ workspaceRoot: "B" });
    expect(mergeListedFiles([entry], true)[0]).toMatchObject({ content: "", loadState: "unloaded", workspaceRoot: "B" });
  });

  it("initially exposes a loading state and loads even an empty file", async () => {
    useAqvenor.setState({ files: [{ path: "a.txt", language: "text", content: "", loadState: "unloaded" }] });
    vi.spyOn(workspace, "readDocument").mockResolvedValue(document(""));
    const request = loadEditorDocument("a.txt");
    expect(S().files[0].loadState).toBe("loading");
    await request;
    expect(S().files[0]).toMatchObject({ content: "", loadState: "loaded" });
  });

  it("reloads clean buffers but never overwrites an unsaved document", async () => {
    const read = vi.spyOn(workspace, "readDocument").mockResolvedValue(document("from disk"));
    await loadEditorDocument("a.txt", true);
    expect(S().files[0].content).toBe("from disk");
    S().setFileContent("a.txt", "my edit");
    S().markSave("a.txt", "unsaved");
    await loadEditorDocument("a.txt", true);
    expect(S().files[0].content).toBe("my edit");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite an edit made while a disk response is pending", async () => {
    let respond!: (value: ReturnType<typeof document>) => void;
    vi.spyOn(workspace, "readDocument").mockReturnValue(new Promise((resolve) => { respond = resolve; }));
    const request = loadEditorDocument("a.txt", true);
    S().setFileContent("a.txt", "newer edit");
    respond(document("old disk response"));
    await request;
    expect(S().files[0].content).toBe("newer edit");
  });

  it("reports failed initial loads instead of opening an empty editable document", async () => {
    useAqvenor.setState({ files: [{ path: "a.txt", language: "text", content: "", loadState: "unloaded" }] });
    vi.spyOn(workspace, "readDocument").mockRejectedValue(new Error("read refused"));
    await loadEditorDocument("a.txt");
    expect(S().files[0]).toMatchObject({ loadState: "error", loadError: "read refused" });
  });
});
