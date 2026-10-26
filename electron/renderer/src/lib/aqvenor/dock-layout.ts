/* ============================================================
   Dock layout: sizes, persistence envelope and the split guard.

   Kept out of DockWorkspace so the rules can be verified in a unit test
   without mounting dockview.
   ============================================================ */

/* Minimum readable size of a docked panel.
   dockview derives a group's constraints from its ACTIVE panel, so putting the
   floor on every panel keeps any group from being squeezed to the 2px that ate
   the Install button (AQV-002). */
export const PANEL_MIN_WIDTH = 260;
export const PANEL_MIN_HEIGHT = 200;
export const CONTEXT_MIN_WIDTH = 220;

/* Saved-layout schema version.
   v1 was the tiling era, when every sidebar click split the workspace to the
   right; restoring one of those layouts would reproduce the wall of 2px columns
   on the first start after this change. A layout without the current version is
   dropped once and rebuilt from the mode default — a single tab group. */
export const DOCK_LAYOUT_VERSION = 2;

/* A saved layout stripped of floating / popout / edge groups. Floating panels
   must NOT persist: a stray float restored on load sits on top of the dock and
   makes it look like surfaces "won't open" (they actually open behind it).
   Native drag-to-float still works within a session; it just never survives a
   reload. */
export function stripFloats(json: Record<string, unknown>): Record<string, unknown> {
  return { grid: json.grid, panels: json.panels, activeGroup: json.activeGroup };
}

/** The dockview layout inside a persisted envelope, or null when the saved
 *  layout predates the tabbed dock (or is corrupt). */
export function readSavedLayout(saved: unknown): Record<string, unknown> | null {
  if (!saved || typeof saved !== "object") return null;
  const box = saved as { v?: unknown; layout?: unknown };
  if (box.v !== DOCK_LAYOUT_VERSION) return null;
  const layout = box.layout;
  if (!layout || typeof layout !== "object") return null;
  return layout as Record<string, unknown>;
}

/** Would one more panel beside the active one still leave every group at least
 *  PANEL_MIN_* across? A split that cannot fit falls back to a tab. */
export function splitFits(
  dock: { width: number; height: number; groups: unknown[] },
  dir: "left" | "right" | "above" | "below",
): boolean {
  const horizontal = dir === "left" || dir === "right";
  const total = horizontal ? dock.width : dock.height;
  const need = horizontal ? PANEL_MIN_WIDTH : PANEL_MIN_HEIGHT;
  const groups = Math.max(dock.groups.length, 1);
  if (!Number.isFinite(total) || total <= 0) return true; // not measured yet: let dockview decide
  return total / (groups + 1) >= need;
}
