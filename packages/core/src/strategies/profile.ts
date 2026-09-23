/**
 * Profile recall (mode `profile` / `full`).
 *
 * The server-side `/memory/profile` endpoint is slice M1 of the 2026-09-22
 * tranche and does not exist yet. Until it ships, this strategy returns
 * `null` with a one-time warning so `profile` and `full` degrade to `query`
 * mode rather than failing. The drop-in point is this file only.
 */
import type { MindGraph } from "mindgraph";
import type { ResolvedOptions } from "../client.js";

export const PROFILE_UNAVAILABLE = "profile_unavailable";

let warned = false;

export interface ProfileRecall {
  /** Stable id so hosts that support supersession replace rather than append. */
  id: string;
  text: string;
}

export async function recallProfile(
  _client: MindGraph,
  resolved: ResolvedOptions,
): Promise<ProfileRecall | null> {
  if (!warned) {
    warned = true;
    resolved.onError?.(
      new Error("MindGraph profile mode requires /memory/profile (slice M1); using query mode"),
      PROFILE_UNAVAILABLE,
    );
  }
  return null;
}
