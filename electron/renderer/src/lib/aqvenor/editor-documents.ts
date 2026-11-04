import { workspace, type ServerWorkspaceEntry } from "./backend";
import { useAqvenor } from "./store";
import type { DemoFile } from "./types";

const requests = new Map<string, Promise<void>>();
const dirty = (path: string) => ["unsaved", "saving", "error"].includes(useAqvenor.getState().saveStatus[path]);

export async function readCompleteDocument(path: string, root = useAqvenor.getState().workspaceRoot) {
  if (!root) throw new Error("Open a project before loading its documents.");
  const result = await workspace.readDocument(path, root);
  if (result.isTruncated) throw new Error("The document is incomplete and cannot be edited.");
  return result;
}

/** A listing supplies metadata; it must never replace a loaded document with an empty body. */
export function mergeListedFiles(entries: ServerWorkspaceEntry[], sameWorkspace: boolean): DemoFile[] {
  const previous = new Map(useAqvenor.getState().files.map((file) => [file.path, file]));
  return entries.filter((entry) => !entry.isDirectory).map((entry) => {
    const path = entry.path.replace(/\\/g, "/");
    const existing = sameWorkspace ? previous.get(path) : undefined;
    if (existing && existing.workspaceRoot === useAqvenor.getState().workspaceRoot && typeof existing.content === "string") return existing;
    const language: DemoFile["language"] = /\.(cs|csproj|slnx)$/.test(path) ? "csharp"
      : path.endsWith(".json") ? "json" : path.endsWith(".md") ? "markdown"
      : /\.(xml|xaml)$/.test(path) ? "xml" : "text";
    return { path, language, content: "", modified: false, loadState: "unloaded", revision: 0, workspaceRoot: useAqvenor.getState().workspaceRoot ?? undefined };
  });
}

/** Disk refreshes never overwrite a dirty buffer or a newer edit made while the read was pending. */
export function loadEditorDocument(path: string, force = false): Promise<void> {
  const state = useAqvenor.getState();
  const root = state.workspaceRoot;
  const file = state.files.find((candidate) => candidate.path === path);
  if (!root || !file || dirty(path) || (!force && file.loadState === "loaded")) return Promise.resolve();
  const key = `${root}\0${path}`;
  const existing = requests.get(key);
  if (existing) return existing;
  const revision = file.revision ?? 0;
  // Keep a loaded buffer on screen while refreshing. Initial loads have no editable document yet.
  if (file.loadState !== "loaded") {
    useAqvenor.setState((s) => ({ files: s.files.map((f) => f.path === path ? { ...f, loadState: "loading", loadError: undefined } : f) }));
  }
  const request = readCompleteDocument(path, root).then((document) => {
    const current = useAqvenor.getState();
    if (current.workspaceRoot !== root || dirty(path)) return;
    useAqvenor.setState((s) => ({
      files: s.files.map((f) => f.path === path && (f.revision ?? 0) === revision
        ? { ...f, content: document.content, loadState: "loaded", loadError: undefined, modified: false }
        : f),
    }));
  }).catch((error: unknown) => {
    if (useAqvenor.getState().workspaceRoot !== root) return;
    useAqvenor.setState((s) => ({ files: s.files.map((f) => f.path === path && (f.revision ?? 0) === revision
      ? { ...f, loadState: f.loadState === "loaded" ? "loaded" : "error", loadError: error instanceof Error ? error.message : String(error) }
      : f) }));
  }).finally(() => requests.delete(key));
  requests.set(key, request);
  return request;
}
