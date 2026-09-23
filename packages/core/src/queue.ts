/**
 * A small batching queue for captures: flushes after `size` items or
 * `delayMs`, whichever comes first, and exposes `flush()` so serverless hosts
 * can `waitUntil(queue.flush())` before the function freezes.
 */
export interface QueueOptions {
  size?: number;
  delayMs?: number;
}

export class CaptureQueue<T> {
  private items: T[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inflight: Promise<void> | undefined;
  private readonly size: number;
  private readonly delayMs: number;

  constructor(
    private readonly handler: (items: T[]) => Promise<void>,
    options: QueueOptions = {},
  ) {
    this.size = options.size ?? 10;
    this.delayMs = options.delayMs ?? 2_000;
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length >= this.size) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.delayMs);
    }
  }

  get pending(): number {
    return this.items.length;
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.inflight) await this.inflight;
    if (this.items.length === 0) return;
    const batch = this.items;
    this.items = [];
    this.inflight = this.handler(batch).catch(() => undefined);
    try {
      await this.inflight;
    } finally {
      this.inflight = undefined;
    }
  }
}
