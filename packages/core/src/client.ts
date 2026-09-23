import { MindGraph } from "mindgraph";

/** Options shared by every door. Environment fallbacks are explicit. */
export interface CoreOptions {
  /** Default: `MINDGRAPH_URL` or `https://api.mindgraph.cloud`. */
  baseUrl?: string;
  /** Default: `MINDGRAPH_API_KEY`. */
  apiKey?: string;
  orgId?: string;
  /** Per-request deadline; the door fails open when it passes. Default 5000. */
  timeoutMs?: number;
  /** Logical attribution for writes (authority comes from the credential). */
  agentId?: string;
  /** Corpus boundary for recall (Project uid). */
  projectUid?: string;
  /** Explicit Space for writes (for example an agent's private space). */
  spaceUid?: string;
  /** Recorded in capture props for per-user provenance. */
  principalId?: string;
  /** Called on every swallowed error; the door never throws into the host. */
  onError?: (error: unknown, operation: string) => void;
}

export interface ResolvedOptions {
  baseUrl: string;
  apiKey: string | undefined;
  orgId: string | undefined;
  timeoutMs: number;
  agentId: string;
  projectUid: string | undefined;
  spaceUid: string | undefined;
  principalId: string | undefined;
  onError: ((error: unknown, operation: string) => void) | undefined;
}

export const DEFAULT_BASE_URL = "https://api.mindgraph.cloud";
export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_AGENT_ID = "mindgraph-tools";

export function resolveOptions(options: CoreOptions = {}): ResolvedOptions {
  const env = typeof process !== "undefined" ? process.env : {};
  return {
    baseUrl: (options.baseUrl ?? env.MINDGRAPH_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
    apiKey: options.apiKey ?? env.MINDGRAPH_API_KEY,
    orgId: options.orgId,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    agentId: options.agentId ?? DEFAULT_AGENT_ID,
    projectUid: options.projectUid,
    spaceUid: options.spaceUid,
    principalId: options.principalId,
    onError: options.onError,
  };
}

/**
 * The SDK client a door uses: no automatic retries (a memory call must not
 * stretch a model turn) and a hard per-request deadline.
 */
export function createClient(resolved: ResolvedOptions): MindGraph {
  return new MindGraph({
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    orgId: resolved.orgId,
    timeoutMs: resolved.timeoutMs,
    maxRetries: 0,
  });
}

/**
 * Run a memory operation fail-open: any error (timeout, network, 4xx/5xx)
 * is reported through `onError` and the caller gets `null`, so the model
 * turn proceeds without memory rather than failing because of it.
 */
export async function failOpen<T>(
  operation: string,
  onError: ResolvedOptions["onError"],
  run: () => Promise<T>,
): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    onError?.(error, operation);
    return null;
  }
}
