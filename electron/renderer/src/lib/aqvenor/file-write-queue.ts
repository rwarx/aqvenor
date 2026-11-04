export interface PendingFileWrite { path: string; root: string | null; content: string; revision: number }

/** Retains failed payloads and serializes each document, including writes already sent. */
export class FileWriteQueue {
  private pending = new Map<string, PendingFileWrite>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private active = new Map<string, Promise<void>>();
  constructor(private write: (entry: PendingFileWrite) => Promise<unknown>, private report: (entry: PendingFileWrite, status: "saved" | "error") => void, private delay = 700) {}
  enqueue(entry: PendingFileWrite): void {
    const key = `${entry.root}\0${entry.path}`;
    this.pending.set(key, entry);
    this.clearTimer(key);
    this.timers.set(key, setTimeout(() => { void this.flush(key).catch(() => {}); }, this.delay));
  }
  paths(): string[] { return [...new Set([...this.pending.values()].map((entry) => entry.path))]; }
  discard(path: string, root: string | null): void {
    const key = `${root}\0${path}`;
    if (this.active.has(key)) throw new Error("Wait for the current save to finish before discarding edits.");
    this.clearTimer(key);
    this.pending.delete(key);
  }
  async flushAll(): Promise<void> {
    do {
      const results = await Promise.allSettled([...new Set([...this.pending.keys(), ...this.active.keys()])].map((key) => this.flush(key)));
      const failure = results.find((r) => r.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    } while (this.pending.size || this.active.size);
  }
  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(key);
  }
  private flush(key: string): Promise<void> {
    this.clearTimer(key);
    const active = this.active.get(key);
    if (active) return active;
    const draining = this.drain(key).finally(() => this.active.delete(key));
    this.active.set(key, draining);
    return draining;
  }
  private async drain(key: string): Promise<void> {
    let entry;
    while ((entry = this.pending.get(key))) {
      try { await this.write(entry); }
      catch (error) { this.report(entry, "error"); throw error; }
      if (this.pending.get(key) === entry) { this.pending.delete(key); this.clearTimer(key); }
      this.report(entry, "saved");
    }
  }
}
