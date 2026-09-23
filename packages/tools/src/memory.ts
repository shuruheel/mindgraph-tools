import type { MindGraph } from "mindgraph";
import {
  CaptureQueue,
  captureExchange,
  captureRecap,
  createClient,
  messageText,
  recallByQuery,
  recallProfile,
  resolveOptions,
  sha256Hex,
  type CoreOptions,
  type Exchange,
  type HostMessage,
  type MemoryMode,
  type QueryRecall,
  type ResolvedOptions,
} from "mindgraph-agent-core";

export const MEMORY_OPEN = "<mindgraph-memory>";
export const MEMORY_CLOSE = "</mindgraph-memory>";

export interface MindGraphToolsOptions extends CoreOptions {
  /** `query` (default) recalls by the latest user message; `profile`/`full` degrade to it until M1 ships. */
  mode?: MemoryMode;
  /** Where the recalled block goes: a `user`-role message before the latest user turn (default) or appended to the system prompt. */
  inject?: "user" | "system";
  /** Disable recall entirely. */
  recall?: boolean;
  /** Capture exchanges after each response (default true); an object tunes it. */
  capture?: boolean | { minChars?: number; batchSize?: number; batchDelayMs?: number };
  /** Cap on recalled characters (default 4000). */
  maxChars?: number;
  /** Graph nodes to ask for (default 12). */
  nodeLimit?: number;
  /** Observe every recall (including misses as null). */
  onRecall?: (recall: QueryRecall | null, query: string) => void;
}

/**
 * The shared engine behind both adapters: one client, one recall cache
 * (so a tool loop's repeated calls with the same last user message hit the
 * server once), one capture queue, and the recap seam.
 */
export class MindGraphMemory {
  readonly client: MindGraph;
  readonly resolved: ResolvedOptions;
  readonly options: MindGraphToolsOptions;
  private lastRecall: { hash: string; text: string | null } = { hash: "", text: null };
  private readonly queue: CaptureQueue<Exchange>;

  constructor(options: MindGraphToolsOptions = {}) {
    this.options = options;
    this.resolved = resolveOptions(options);
    this.client = createClient(this.resolved);
    const capture = typeof options.capture === "object" ? options.capture : {};
    this.queue = new CaptureQueue<Exchange>(
      async (items) => {
        for (const exchange of items) {
          await captureExchange(this.client, this.resolved, exchange, {
            scopeKey: this.resolved.principalId,
            minChars: capture.minChars,
          });
        }
      },
      { size: capture.batchSize, delayMs: capture.batchDelayMs },
    );
  }

  /** Is this message one we injected? */
  static isInjected(message: HostMessage): boolean {
    return messageText(message).trimStart().startsWith(MEMORY_OPEN);
  }

  /** Index of the latest real (non-injected) user message, or -1. */
  static lastUserIndex(messages: readonly HostMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      if (m.role === "user" && !MindGraphMemory.isInjected(m)) return i;
    }
    return -1;
  }

  /** Recall for a user text, cached by content hash. Returns the rendered block or null. */
  async recall(userText: string): Promise<string | null> {
    if (this.options.recall === false) return null;
    const query = userText.trim();
    if (!query) return null;
    const hash = sha256Hex(query);
    if (this.lastRecall.hash === hash) return this.lastRecall.text;
    let text: string | null = null;
    if (this.options.mode === "profile" || this.options.mode === "full") {
      const profile = await recallProfile(this.client, this.resolved);
      if (profile) text = profile.text;
    }
    if (this.options.mode !== "profile" || text === null) {
      const recall = await recallByQuery(this.client, this.resolved, query, {
        nodeLimit: this.options.nodeLimit,
        maxChars: this.options.maxChars,
      });
      this.options.onRecall?.(recall, query);
      if (recall) text = text ? `${text}\n\n${recall.text}` : recall.text;
    }
    const block = text ? `${MEMORY_OPEN}\n${text}\n${MEMORY_CLOSE}` : null;
    this.lastRecall = { hash, text: block };
    return block;
  }

  /** Queue an exchange for capture (no-op when capture is off). */
  capture(exchange: Exchange): void {
    if (this.options.capture === false) return;
    if (!exchange.assistant.trim()) return;
    this.queue.push(exchange);
  }

  /** Flush queued captures; call from `waitUntil` on serverless hosts. */
  flush(): Promise<void> {
    return this.queue.flush();
  }

  /** Persist a host's compaction recap as a Session trace keyed by the host's operation id. */
  captureRecap(recap: string, input: { operationId: string; sessionId: string }) {
    return captureRecap(this.client, this.resolved, { recap, ...input });
  }
}

/** Where to put the memory block, and the message that carries it. */
export function injectMemory<M extends HostMessage>(
  messages: readonly M[],
  block: string,
  inject: "user" | "system" = "user",
  makeUser: (text: string) => M,
  appendSystem: (message: M, text: string) => M,
  makeSystem: (text: string) => M,
): M[] {
  const out = [...messages];
  if (inject === "system") {
    const sys = out.findIndex((m) => m.role === "system");
    if (sys >= 0) out[sys] = appendSystem(out[sys]!, block);
    else out.unshift(makeSystem(block));
    return out;
  }
  const idx = MindGraphMemory.lastUserIndex(out);
  if (idx < 0) return out;
  out.splice(idx, 0, makeUser(block));
  return out;
}
