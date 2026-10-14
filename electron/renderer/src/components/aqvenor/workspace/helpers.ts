import type { DemoFile, RunnerState } from "@/lib/aqvenor/types";
import type { Locale } from "@/lib/aqvenor/types";
import { fmtCompact, fmtDuration as fmtDur, fmtKb, intlLocale } from "@/lib/aqvenor/format";

/* ============================================================
   Workspace surfaces — shared pure helpers.
   (Trajectory / Tasks / Files / Code views)
   ============================================================ */

/* TFn mirrors useT()'s return: callable plus the ambient locale (and the
   plural lookup). Helpers read t.locale so dates and numbers follow the
   UI language instead of the OS default. */
export type TFn = ((key: string, ...args: (string | number)[]) => string) & {
  locale?: Locale;
  p?: (key: string, n: number) => string;
};

/** "just now" / "4m ago" / "3h ago" / "yesterday" / locale date */
export function relativeTime(ts: number, t: TFn): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return t("time.minutesAgo", minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", hours);
  if (hours < 48) return t("time.yesterday");
  return new Date(ts).toLocaleDateString(intlLocale(t.locale ?? "en"));
}

/** HH:mm:ss for the timeline rail, in the locale's clock convention */
export function formatClock(ts: number, locale: Locale = "en"): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(intlLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** 640ms / 3.2s with locale decimals */
export function formatDuration(ms?: number, locale: Locale = "en"): string {
  if (ms == null) return "";
  return fmtDur(ms, locale);
}

/** content length as "1.8 KB" with locale decimals */
export function formatSize(content: string, locale: Locale = "en"): string {
  return fmtKb(content.length, locale);
}

/** token count as "1.8k" with locale decimals */
export function formatCompact(n: number, locale: Locale): string {
  return fmtCompact(n, locale);
}

/** Human label for the runner state — falls back to a mapped status word. */
export function runnerStatusText(t: TFn, status: RunnerState["status"], label?: string): string {
  if (label) return label;
  switch (status) {
    case "running":
      return t("tasks.status.running");
    case "awaiting-approval":
      return t("tasks.waitingForYou");
    case "done":
      return t("tasks.status.done");
    case "stopped":
      return t("tasks.status.stopped");
    case "paused":
      return t("tasks.status.paused");
    default:
      return t("tasks.status.idle");
  }
}

/* ---------- file tree (Files view) ---------- */

export interface FileTreeNode {
  name: string;
  path: string;
  dir: boolean;
  children: FileTreeNode[];
  file?: DemoFile;
}

function sortNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  nodes.forEach((n) => sortNodes(n.children));
  return nodes;
}

/** Builds a folder/file tree from flat workspace paths. Folders first, then alphabetical. */
export function buildFileTree(files: DemoFile[]): FileTreeNode[] {
  const root: FileTreeNode = { name: "", path: "", dir: true, children: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === part && c.dir === !isFile);
      if (!child) {
        child = { name: part, path, dir: !isFile, children: [], file: isFile ? file : undefined };
        node.children.push(child);
      }
      node = child;
    });
  }
  return sortNodes(root.children);
}
