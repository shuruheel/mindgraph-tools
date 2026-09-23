import {
  captureExchange,
  captureRecap,
  createClient,
  failOpen,
  messageText,
  recallByQuery,
  recapFromMessages,
  recentUserText,
  resolveOptions,
  stableId,
  type CoreOptions,
  type HostMessage,
  type ResolvedOptions,
} from "mindgraph-agent-core";
import type {
  MemoryOperationContext,
  MemoryProvider,
  MemoryRecallMessage,
  MemoryRecallResult,
  MemoryToolSet,
  MemoryToolsContext,
} from "./eve-types.js";

export type { MemoryProvider, MemoryOperationContext, MemoryToolSet } from "./eve-types.js";

export const RECAP_MESSAGE_ID = "mindgraph:recap";
export const TOPIC_MESSAGE_ID = "mindgraph:topic";

export interface MindGraphEveOptions extends CoreOptions {
  /**
   * `shared` (default): every scope reads and writes the org graph; the
   * scope key still namespaces `custom_id`s so partitions never collide.
   * `agent-space`: writes go to this agent's private Space
   * (`space:agent:<agentId>`); under Space enforcement with an agent-bound
   * API key, reads are limited to the org space plus that Space.
   */
  scope?: "shared" | "agent-space";
  /** Graph nodes to recall per turn (default 12) and the character cap (default 4000). */
  recall?: { nodeLimit?: number; maxChars?: number; userMessages?: number } | false;
  /** Capture each completed turn as a memory (default true). */
  capture?: boolean;
  /** Persist the pre-compaction history as a Session trace (default true). */
  captureRecap?: boolean;
  /** Expose search / remember / forget / resume tools to the model (default true). */
  tools?: boolean;
}

function lastExchange(messages: readonly HostMessage[]): { user: string; assistant: string } | null {
  let assistant: string | null = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (assistant === null) {
      if (m.role === "assistant") assistant = messageText(m);
      continue;
    }
    if (m.role === "user") {
      const user = messageText(m);
      return user.trim() && assistant.trim() ? { user, assistant } : null;
    }
  }
  return null;
}

/** JSON-schema inputs; eve accepts AI SDK flexible schemas, which include plain JSON schema via `jsonSchema()` at the eve boundary. */
const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "1–3 discriminating keywords or a short question" },
    limit: { type: "integer", minimum: 1, maximum: 50, default: 12 },
  },
  required: ["query"],
  additionalProperties: false,
} as const;
const REMEMBER_SCHEMA = {
  type: "object",
  properties: {
    content: { type: "string", description: "One durable fact, preference or decision (not chit-chat)" },
    label: { type: "string" },
  },
  required: ["content"],
  additionalProperties: false,
} as const;
const FORGET_SCHEMA = {
  type: "object",
  properties: {
    uid: { type: "string" },
    custom_id: { type: "string" },
    confirm: { type: "boolean", description: "false (default) previews the edges; true tombstones" },
  },
  additionalProperties: false,
} as const;
const RESUME_SCHEMA = { type: "object", properties: {}, additionalProperties: false } as const;

/**
 * `mindgraphMemory(options)` — a provider for `defineMemory({ provider })`.
 *
 * - `turn.started` recalls MindGraph context for the last few user messages
 *   and returns it under the stable id `mindgraph:topic`, so each turn
 *   replaces the previous block instead of accumulating.
 * - `turn.completed` captures the last user/assistant exchange with
 *   `custom_id = eve:<operationId>`: a replay with the same operation id is
 *   an upsert on the same node, so results are identical.
 * - `compaction.requested` stores the pre-checkpoint history as a Session
 *   trace keyed by the operation id; `compaction.completed` returns that
 *   recap first (`mindgraph:recap`) so nothing is lost across compaction.
 * - `tools`: `search`, `remember`, `forget` (dry-run by default), `resume`.
 *
 * Every call is fail-open within `timeoutMs` (default 5 s).
 */
export function mindgraphMemory(options: MindGraphEveOptions = {}): MemoryProvider {
  const base = resolveOptions(options);
  const resolved: ResolvedOptions =
    options.scope === "agent-space" && !base.spaceUid
      ? { ...base, spaceUid: `space:agent:${base.agentId}` }
      : base;
  const client = createClient(resolved);
  const recallOpts = options.recall === false ? null : (options.recall ?? {});
  const recaps = new Map<string, string>();

  async function topic(context: MemoryOperationContext): Promise<MemoryRecallMessage | null> {
    if (!recallOpts) return null;
    const query = recentUserText(context.messages, recallOpts.userMessages ?? 3);
    const recall = await recallByQuery(client, { ...resolved }, query, {
      nodeLimit: recallOpts.nodeLimit,
      maxChars: recallOpts.maxChars,
    });
    return recall ? { id: TOPIC_MESSAGE_ID, content: recall.text } : null;
  }

  const provider: MemoryProvider = {
    recall: {
      "turn.started": async (context): Promise<MemoryRecallResult> => {
        const message = await topic(context);
        return message ? { messages: [message] } : null;
      },
      "compaction.completed": async (context): Promise<MemoryRecallResult> => {
        const messages: MemoryRecallMessage[] = [];
        const recap = recaps.get(context.session.id);
        if (recap) messages.push({ id: RECAP_MESSAGE_ID, content: `Before compaction, this session covered:\n${recap}` });
        const message = await topic(context);
        if (message) messages.push(message);
        return messages.length ? { messages } : null;
      },
    },
    capture: {
      "turn.completed": async (context) => {
        if (options.capture === false) return;
        const exchange = lastExchange(context.messages);
        if (!exchange) return;
        await captureExchange(client, resolved, exchange, {
          scopeKey: context.memory.scope.key,
          customId: `eve:${context.operationId}`,
        });
      },
      "compaction.requested": async (context) => {
        if (options.captureRecap === false) return;
        const recap = recapFromMessages(context.messages);
        if (!recap) return;
        recaps.set(context.session.id, recap);
        await captureRecap(client, resolved, {
          recap,
          operationId: context.operationId,
          sessionId: context.session.id,
        });
      },
    },
    tools: async (context: MemoryToolsContext): Promise<MemoryToolSet | null> => {
      if (options.tools === false) return null;
      const scopeKey = context.memory.scope.key;
      return {
        search: {
          description:
            "Search MindGraph memory for facts, decisions and preferences relevant to a query. Returns a compact list with uids.",
          inputSchema: SEARCH_SCHEMA,
          execute: async (input: { query: string; limit?: number }) => {
            const recall = await recallByQuery(client, resolved, input.query, { nodeLimit: input.limit });
            return recall ? { context: recall.text, items: recall.items, omitted: recall.omitted } : { context: "", items: 0, omitted: 0 };
          },
        },
        remember: {
          description:
            "Store one durable fact, preference or decision in MindGraph memory. Re-storing the same content is a no-op.",
          inputSchema: REMEMBER_SCHEMA,
          execute: async (input: { content: string; label?: string }) => {
            const receipt = await failOpen("remember", resolved.onError, () =>
              client.remember(input.content, {
                custom_id: stableId("eve", scopeKey, input.content.trim()),
                label: input.label,
                agent_id: resolved.agentId,
                props: { source: "mindgraph-eve", scope_key: scopeKey },
                ...(resolved.spaceUid ? { space_uid: resolved.spaceUid } : {}),
              }),
            );
            return receipt ? { uid: receipt.uid, action: receipt.action } : { error: "memory_unavailable" };
          },
        },
        forget: {
          description:
            "Forget a memory by uid or custom_id. Without confirm=true this only previews the connected edges that would be removed; the removal is reversible.",
          inputSchema: FORGET_SCHEMA,
          execute: async (input: { uid?: string; custom_id?: string; confirm?: boolean }) => {
            const target = input.uid ? { uid: input.uid } : input.custom_id ? { custom_id: input.custom_id } : null;
            if (!target) return { error: "uid or custom_id required" };
            const result = await failOpen("forget", resolved.onError, () =>
              client.forget(target, {
                ...(input.confirm === true ? {} : { dry_run: true }),
                agent_id: resolved.agentId,
              }),
            );
            return result ?? { error: "memory_unavailable" };
          },
        },
        resume: {
          description: "Recover what was in progress: the most recent compaction recap for this session, if any, plus open work.",
          inputSchema: RESUME_SCHEMA,
          execute: async () => {
            const work = await failOpen("resume", resolved.onError, () =>
              client.plan({ action: "resume_work", limit: 1, agent_id: resolved.agentId } as never),
            );
            return { work: work ?? null };
          },
        },
      } as unknown as MemoryToolSet;
    },
  };
  return provider;
}

export default mindgraphMemory;
