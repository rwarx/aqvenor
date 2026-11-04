import type { Checkpoint } from "./types";

/** Older snapshots may have been truncated by the agent excerpt reader. */
export function canApplyCheckpoint(cp: Checkpoint, root: string | null, serverMode: boolean): boolean {
  return !serverMode || ((cp.formatVersion ?? 0) >= 2 && !!root && cp.workspaceRoot?.toLowerCase() === root.toLowerCase());
}
