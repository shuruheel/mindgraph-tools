import type { MindGraph } from "mindgraph";
import { failOpen, type ResolvedOptions } from "../client.js";
import { renderContext, type RenderedContext } from "../render.js";

/** The minimal message shape every host has (AI SDK, OpenAI, eve). */
export interface HostMessage {
  role: string;
  content: unknown;
}

export const QUERY_MAX_CHARS = 500;

/** Plain text of a message: string content, or the joined `text` parts. */
export function messageText(message: HostMessage): string {
  const { content } = message;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const p = part as { type?: string; text?: string };
        return p && p.type === "text" && typeof p.text === "string" ? p.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** The last `count` user messages joined, capped for a retrieval query. */
export function recentUserText(messages: readonly HostMessage[], count = 1): string {
  const users = messages.filter((m) => m.role === "user").slice(-count);
  return users.map(messageText).join("\n").trim().slice(0, QUERY_MAX_CHARS);
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
  const raw = await failOpen("recall", resolved.onError, () =>
    client.retrieveContext(buildQueryRequest(trimmed, resolved, options.nodeLimit)),
  );
  if (raw === null) return null;
  const rendered = renderContext(raw, { maxChars: options.maxChars });
  if (!rendered.text.trim()) return null;
  return { ...rendered, query: trimmed, raw };
}
