import type { MindGraph } from "mindgraph";
import { failOpen, type ResolvedOptions } from "./client.js";
import { stableId } from "./hash.js";

/** Server cap on the fast path; longer exchanges are trimmed, never split. */
export const REMEMBER_MAX_BYTES = 8 * 1024;
/** Exchanges whose user + assistant text is shorter than this are not worth a memory (greetings, acks). */
export const DEFAULT_MIN_CHARS = 32;

export interface Exchange {
  user: string;
  assistant: string;
}

export interface CaptureOptions {
  /** Partition key mixed into the deterministic custom_id (eve scope.key, principal, …). */
  scopeKey?: string;
  /** Overrides the derived custom_id (eve passes its operationId). */
  customId?: string;
  minChars?: number;
}

export interface CaptureReceipt {
  uid: string;
  action: string;
  customId: string;
  /** False when the server lacks `remember` and `capture` was used instead. */
  idempotent: boolean;
}

/** One exchange as memory text, bounded to the server cap. */
export function exchangeText(exchange: Exchange): string {
  const text = `User: ${exchange.user.trim()}\nAssistant: ${exchange.assistant.trim()}`;
  if (Buffer.byteLength(text, "utf8") <= REMEMBER_MAX_BYTES) return text;
  // Trim the assistant side first; the user turn carries the intent.
  let out = text;
  while (Buffer.byteLength(out, "utf8") > REMEMBER_MAX_BYTES - 1) {
    out = out.slice(0, -64);
  }
  return `${out}…`;
}

export function exchangeCustomId(exchange: Exchange, scopeKey = ""): string {
  return stableId("mgt", scopeKey, exchange.user.trim(), exchange.assistant.trim());
}

/**
 * Store one exchange as a memory. Uses the server's `remember` fast path
 * when the SDK exposes it (0.16+), where `custom_id` makes a replay a no-op;
 * otherwise falls back to `capture({ action: "observation" })`, which is
 * flagged non-idempotent in the receipt. Fail-open: returns `null` on error.
 */
export async function captureExchange(
  client: MindGraph,
  resolved: ResolvedOptions,
  exchange: Exchange,
  options: CaptureOptions = {},
): Promise<CaptureReceipt | null> {
  const minChars = options.minChars ?? DEFAULT_MIN_CHARS;
  if (exchange.assistant.trim().length + exchange.user.trim().length < minChars) {
    return null;
  }
  const customId = options.customId ?? exchangeCustomId(exchange, options.scopeKey);
  const text = exchangeText(exchange);
  const label = exchange.user.trim().split("\n")[0]?.slice(0, 80) || "Conversation memory";
  const props = {
    source: "mindgraph-tools",
    ...(resolved.principalId ? { principal_id: resolved.principalId } : {}),
    ...(options.scopeKey ? { scope_key: options.scopeKey } : {}),
  };

  const remember = (client as unknown as { remember?: unknown }).remember;
  if (typeof remember === "function") {
    const receipt = await failOpen("capture", resolved.onError, () =>
      client.remember(text, {
        custom_id: customId,
        label,
        props,
        agent_id: resolved.agentId,
        ...(resolved.spaceUid ? { space_uid: resolved.spaceUid } : {}),
      }),
    );
    if (!receipt) return null;
    return { uid: receipt.uid, action: receipt.action, customId, idempotent: true };
  }

  const fallback = await failOpen("capture", resolved.onError, () =>
    client.capture({
      action: "observation",
      label,
      summary: text,
      props: { ...props, custom_id: customId, observation_type: "memory" },
      agent_id: resolved.agentId,
    }),
  );
  if (!fallback) return null;
  const uid = (fallback as { uid?: string }).uid ?? "";
  return { uid, action: "inserted", customId, idempotent: false };
}
