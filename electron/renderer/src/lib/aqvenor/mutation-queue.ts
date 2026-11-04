/** Ordered commands survive transport failures; retry uses the same request identity. */
export class MutationQueue<T> {
  private pending: T[] = [];
  private active: Promise<void> | null = null;
  constructor(private send: (command: T) => Promise<unknown>) {}
  enqueue(command: T): void { this.pending.push(command); }
  flush(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.drain().finally(() => { this.active = null; });
    return this.active;
  }
  private async drain(): Promise<void> {
    while (this.pending.length) {
      await this.send(this.pending[0]);
      this.pending.shift();
    }
  }
}
