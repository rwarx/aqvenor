"use client";

/* ============================================================
   AQVENOR CODE — attach a canvas node to the chat draft.
   Drop target logic for dragging a node card onto the composer:
   resolves the node, reads its file (server first, demo files
   fallback), and stages it as a draft attachment — the same tray
   the paperclip fills, so sending pins the file to this turn.
   ============================================================ */

import { newId, useAqvenor } from "@/lib/aqvenor/store";
import { isServerMode, readServerFile } from "@/lib/aqvenor/sync";

/** Same cap as the paperclip path (Composer.onPickFiles). */
const MAX_CHARS = 200_000;

function mimeFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "md":
    case "markdown":
      return "text/markdown";
    case "json":
      return "application/json";
    case "html":
    case "htm":
      return "text/html";
    case "xml":
      return "application/xml";
    case "png":
      return "image/png";
    default:
      return "text/plain";
  }
}

function baseName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

/**
 * Stage a canvas node as a draft attachment. File nodes carry their
 * contents; note nodes carry their note text; anything else carries
 * a title/path reference so the turn still names the node.
 * Returns true when something was staged.
 */
export async function attachCanvasNodeToDraft(nodeId: string, sessionId?: string): Promise<boolean> {
  const st = useAqvenor.getState();
  const sid = sessionId ?? st.currentSessionId;
  const node = st.canvas.nodes.find((n) => n.id === nodeId);
  if (!node) return false;

  // Note node without a file: pin its text directly.
  if (!node.path) {
    const text = node.note?.trim() ? node.note : node.title;
    st.addDraftAttachment({
      id: newId("att"),
      name: node.title.endsWith(".md") ? node.title : `${node.title}.md`,
      sizeKb: Math.max(1, Math.round(text.length / 1024)),
      mimeType: "text/markdown",
      textContent: `# ${node.title}\n\n${text}`,
    }, sid);
    return true;
  }

  const name = baseName(node.path);
  let content: string | null = null;

  if (isServerMode()) {
    content = await readServerFile(node.path);
  }
  if (content == null) {
    content = st.files.find((f) => f.path === node.path)?.content ?? null;
  }
  if (content == null) {
    // Unreadable (binary, missing): pin the reference so the turn still
    // names the file instead of silently dropping the gesture.
    const ref = `File pinned from canvas: ${node.path}${node.note ? `\nNote: ${node.note}` : ""}`;
    st.addDraftAttachment({
      id: newId("att"),
      name: `${name}.ref.md`,
      sizeKb: 1,
      mimeType: "text/markdown",
      textContent: ref,
    }, sid);
    return true;
  }

  st.addDraftAttachment({
    id: newId("att"),
    name,
    sizeKb: Math.max(1, Math.round(content.length / 1024)),
    mimeType: mimeFor(name),
    textContent: content.length > MAX_CHARS ? content.slice(0, MAX_CHARS) : content,
  }, sid);
  return true;
}
