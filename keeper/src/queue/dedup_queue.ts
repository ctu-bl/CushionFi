export class DedupQueue<T> {
  private readonly items: Array<{ key: string; payload: T }> = [];
  private readonly dedupeKeys = new Set<string>();
  private readonly waiters: Array<(value: { key: string; payload: T }) => void> = [];

  enqueue(key: string, payload: T): boolean {
    if (this.dedupeKeys.has(key)) {
      return false;
    }

    this.dedupeKeys.add(key);

    const next = { key, payload };
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(next);
      return true;
    }

    this.items.push(next);
    return true;
  }

  async dequeue(): Promise<{ key: string; payload: T }> {
    const immediate = this.items.shift();
    if (immediate) {
      this.dedupeKeys.delete(immediate.key);
      return immediate;
    }

    return new Promise((resolve) => {
      this.waiters.push((value) => {
        this.dedupeKeys.delete(value.key);
        resolve(value);
      });
    });
  }

  get size(): number {
    return this.items.length;
  }
}
