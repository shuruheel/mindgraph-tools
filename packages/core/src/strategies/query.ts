import type { MindGraph } from "mindgraph";
import { failOpen, type ResolvedOptions } from "../client.js";
import { renderContext, type RenderedContext } from "../render.js";

/** The minimal message shape every host has (AI SDK, OpenAI, eve). */
export interface HostMessage {
  role: string;
  content: unknown;
}

export const QUERY_MAX_CHARS = 500;

/** Plain text of a message, including Chat/AI SDK and Responses text parts. */
export function messageText(message: HostMessage): string {
  const { content } = message;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const p = part as { type?: string; text?: string };
        return p && (p.type === "text" || p.type === "input_text" || p.type === "output_text")
          && typeof p.text === "string" ? p.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** The most user messages a recall query is built from. */
export const USER_MESSAGES_MAX = 8;

/**
 * The recall query for a conversation: the latest user message, with up to
 * `count - 1` user messages before it placed ahead of it, oldest first, capped
 * at `QUERY_MAX_CHARS`.
 *
 * A follow-up that does not name its subject ("what caused it?") finds little
 * on its own; searched together with the turn before it, it finds the subject
 * that turn named. Measured on CogMemBench sessions that move between
 * subjects, 2026-11-23: with `count` 2, answer accuracy 0.68 against 0.41 for
 * the latest message alone, and no loss on the turns that name a new subject.
 * With `count` 4 those turns fell from 0.78 to 0.65, because the subject the
 * conversation has left is still in the search. Prefer 2.
 *
 * The latest message is never cut to make room: it takes what it needs of the
 * cap, and the earlier ones share what is left, nearest first. `ignore` leaves
 * out user-role messages that are not the user's words (an injected memory
 * block). An empty latest message gives an empty query.
 */
export function recentUserText(
  messages: readonly HostMessage[],
  count = 1,
  ignore?: (message: HostMessage) => boolean,
): string {
  const wanted = Math.min(Math.max(1, Math.floor(count) || 1), USER_MESSAGES_MAX);
  const texts = messages
    .filter((m) => m.role === "user" && !ignore?.(m))
    .slice(-wanted)
    .map((m) => messageText(m).trim());
  const latest = (texts.pop() ?? "").slice(0, QUERY_MAX_CHARS);
  if (!latest) return "";
  const kept = [latest];
  let room = QUERY_MAX_CHARS - latest.length;
  for (const earlier of texts.reverse()) {
    // One character of the room goes to the line break.
    if (!earlier || room < 2) continue;
    const piece = earlier.slice(0, room - 1).trim();
    if (!piece) continue;
    kept.unshift(piece);
    room -= piece.length + 1;
  }
  return kept.join("\n");
}

export interface QueryRecall extends RenderedContext {
  query: string;
  raw: unknown;
}

/**
 * The topic recall shape shared with the MCP server's `mindgraph_memory`
 * topic mode: a bounded node set, graph edges, a little cheapest-first graph
 * expansion, no raw chunks. `project_uid` narrows to a corpus boundary.
 */
export function buildQueryRequest(query: string, resolved: ResolvedOptions, nodeLimit = 12) {
  return {
    query,
    ...(resolved.projectUid ? { project_uid: resolved.projectUid } : {}),
    node_limit: nodeLimit,
    chunk_limit: 0,
    article_limit: 0,
    include_graph: true,
    graph_expansion_limit: 3,
    graph_max_depth: 2,
  };
}

/** Recall by query, fail-open. `null` means "proceed without memory". */
export async function recallByQuery(
  client: MindGraph,
  resolved: ResolvedOptions,
  query: string,
  options: { nodeLimit?: number; maxChars?: number } = {},
): Promise<QueryRecall | null> {
  const trimmed = query.trim().slice(0, QUERY_MAX_CHARS);
  if (!trimmed) return null;
  const raw = await failOpen("recall", resolved.onError, () => {
    if (resolved.spaceUid) {
      const sdk = client as MindGraph & { memory?: (scope: { space_uid: string }) => { context(options: object): Promise<unknown> } };
      if (!sdk.memory) throw new Error("Scoped recall requires a memory.v1-capable SDK");
      const { include_graph: _includeGraph, ...request } = buildQueryRequest(trimmed, resolved, options.nodeLimit);
      return sdk.memory({ space_uid: resolved.spaceUid }).context({ ...request, include_org_space: resolved.includeOrgSpace });
    }
    return client.retrieveContext(buildQueryRequest(trimmed, resolved, options.nodeLimit));
  });
  if (raw === null) return null;
  const rendered = renderContext(raw, { maxChars: options.maxChars });
  if (!rendered.text.trim()) return null;
  return { ...rendered, query: trimmed, raw };
}
