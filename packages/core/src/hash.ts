import { createHash } from "node:crypto";

/** Hex SHA-256 of a string. Node runtimes only (Vercel functions, eve, servers). */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * A deterministic, bounded id from a prefix and parts. The same parts always
 * produce the same id, which is what makes captures idempotent on the server
 * (`custom_id` upsert) without any client-side state.
 */
export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${sha256Hex(parts.join("\u0000")).slice(0, 32)}`;
}
