/**
 * The subset of eve's memory-provider contract this package implements,
 * restated structurally so the package builds without `eve` installed
 * (eve 0.64 requires Node 24; this package supports Node 20+). The shapes
 * mirror `eve/memory` (`MemoryProvider`, `MemoryOperationContext`,
 * `MemoryRecallResult`, `MemoryToolSet`) as published in eve 0.64.1; a
 * provider object built here is assignable to `defineMemoryProvider()`.
 */
import type { HostMessage } from "mindgraph-agent-core";

export interface MemoryScope {
  readonly key: string;
  readonly namespace: string;
  readonly value: string | readonly string[];
}

export interface MemoryRecallMessage {
  readonly content: string;
  /** Stable id: eve replaces an earlier message with the same id instead of appending. */
  readonly id?: string;
}

export type MemoryRecallResult = { readonly messages: readonly MemoryRecallMessage[] } | null | undefined;

export interface MemoryOperationContext {
  readonly abortSignal: AbortSignal;
  readonly messages: readonly HostMessage[];
  readonly operationId: string;
  readonly memory: { readonly scope: MemoryScope; readonly slot: string };
  readonly session: { readonly id: string; readonly auth?: unknown };
  readonly turn?: { readonly id: string; readonly sequence: number } | null;
  readonly compaction?: { readonly modelId: string; readonly usageInputTokens?: number | null };
}

export interface MemoryToolsContext {
  readonly memory: { readonly scope: MemoryScope; readonly slot: string };
  readonly turn?: { readonly id: string; readonly sequence: number };
}

export interface MemoryToolDefinition {
  readonly description: string;
  readonly inputSchema: unknown;
  execute(input: never, context: unknown): unknown | Promise<unknown>;
}

export type MemoryToolSet = Readonly<Record<string, MemoryToolDefinition>>;

export interface MemoryProvider {
  readonly recall: {
    readonly "turn.started": (context: MemoryOperationContext) => MemoryRecallResult | Promise<MemoryRecallResult>;
    readonly "compaction.completed"?: (context: MemoryOperationContext) => MemoryRecallResult | Promise<MemoryRecallResult>;
  };
  readonly capture?: {
    readonly "turn.completed"?: (context: MemoryOperationContext) => void | Promise<void>;
    readonly "compaction.requested"?: (context: MemoryOperationContext) => void | Promise<void>;
  };
  readonly tools?: (context: MemoryToolsContext) => Promise<MemoryToolSet | null>;
}
