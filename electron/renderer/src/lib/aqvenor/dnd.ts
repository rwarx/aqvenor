"use client";

/* ============================================================
   AQVENOR CODE — drag-and-drop payloads between surfaces.
   HTML5 DnD MIME types shared by drag sources (canvas cards,
   sidebar session rows) and drop targets (chat composer, dock).
   Lowercase by convention — browsers lowercase dataTransfer types.
   ============================================================ */

/** Canvas nodes dragged toward the chat (carries a JSON array of node ids). */
export const NODE_MIME = "application/x-aq-canvas-node";

/** A chat session row dragged toward the dock (carries the session id). */
export const SESSION_MIME = "application/x-aq-session";

function transfer(e: { dataTransfer?: DataTransfer | null }): DataTransfer | null {
  return e.dataTransfer ?? null;
}

/** Drag source: stash the dragged canvas node ids on the dataTransfer. */
export function setNodeDrag(e: React.DragEvent, nodeIds: string | string[]): void {
  const dt = transfer(e);
  if (!dt) return;
  const ids = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
  dt.setData(NODE_MIME, JSON.stringify(ids));
  dt.effectAllowed = "copy";
}

/** Drop target: does this drag carry canvas nodes? */
export function hasNodeDrag(e: { dataTransfer?: DataTransfer | null }): boolean {
  const types = Array.from(transfer(e)?.types ?? []);
  return types.includes(NODE_MIME);
}

/** Drop target: read the dragged canvas node ids (empty when absent). */
export function getNodeDragIds(e: { dataTransfer?: DataTransfer | null }): string[] {
  const raw = transfer(e)?.getData(NODE_MIME);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
    if (typeof parsed === "string") return [parsed];
  } catch {
    // Very old payload shape: a bare node id.
    return [raw];
  }
  return [];
}

/** Drag source: stash the dragged chat session id on the dataTransfer. */
export function setSessionDrag(e: React.DragEvent, sessionId: string): void {
  const dt = transfer(e);
  if (!dt) return;
  dt.setData(SESSION_MIME, sessionId);
  dt.effectAllowed = "copy";
}

/** Drop target: does this drag carry a chat session? */
export function hasSessionDrag(e: { dataTransfer?: DataTransfer | null }): boolean {
  const types = Array.from(transfer(e)?.types ?? []);
  return types.includes(SESSION_MIME);
}

/** Drop target: read the dragged chat session id (null when absent). */
export function getSessionDragId(e: { dataTransfer?: DataTransfer | null }): string | null {
  return transfer(e)?.getData(SESSION_MIME) || null;
}
