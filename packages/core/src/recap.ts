import type { MindGraph } from "mindgraph";
import { failOpen, type ResolvedOptions } from "./client.js";
import { REMEMBER_MAX_BYTES } from "./capture.js";
import type { HostMessage } from "./strategies/query.js";
import { messageText } from "./strategies/query.js";

export interface RecapInput {
  /** The recap text (a host's compaction summary, or one we build). */
  recap: string;
  /** Host operation id: makes the open + trace replay-identical. */
  operationId: string;
  /** Host session id: the Session node is upserted by (harness, id). */
  sessionId: string;
  harness?: "claude-code" | "codex" | "generic";
}

export interface RecapReceipt {
  sessionUid: string;
  traceUid: string;
}

/** Build a recap from the messages a host hands us at compaction: newest last, bounded. */
export function recapFromMessages(messages: readonly HostMessage[], maxBytes = REMEMBER_MAX_BYTES): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = messageText(message).trim();
    if (!text) continue;
    lines.push(`${message.role === "user" ? "User" : "Assistant"}: ${text}`);
  }
  // Keep the most recent lines that fit.
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + size > maxBytes) break;
    kept.unshift(line);
    bytes += size;
  }
  return kept.join("\n");
}

/**
 * Persist a compaction recap as a Session trace. `open` upserts the Session
 * by (harness, session id) and both writes carry the operation id as their
 * server-side idempotency key, so a replayed compaction produces the same
 * receipt and no second trace.
 */
export async function captureRecap(
  client: MindGraph,
  resolved: ResolvedOptions,
  input: RecapInput,
): Promise<RecapReceipt | null> {
  const recap = input.recap.trim();
  if (!recap) return null;
  const harness = input.harness ?? "generic";
  return failOpen("captureRecap", resolved.onError, async () => {
    const opened = (await client.session({
      action: "open",
      label: `Session ${input.sessionId}`,
      harness,
      harness_session_id: input.sessionId,
      agent_id: resolved.agentId,
      idempotency_key: `${input.operationId}:open`,
    })) as { uid: string };
    const trace = (await client.session({
      action: "trace",
      session_uid: opened.uid,
      label: "Compaction recap",
      summary: recap.slice(0, 2_000),
      props: {
        recap,
        operation_id: input.operationId,
        ...(resolved.principalId ? { principal_id: resolved.principalId } : {}),
      },
      agent_id: resolved.agentId,
      idempotency_key: input.operationId,
    })) as { uid: string };
    return { sessionUid: opened.uid, traceUid: trace.uid };
  });
}
