/** Query-free profile recall, bound to an explicitly configured Space. */
import type { MindGraph } from "mindgraph";
import { failOpen, type ResolvedOptions } from "../client.js";

export const PROFILE_UNAVAILABLE = "profile_unavailable";
export const PROFILE_INCOMPLETE = "profile_incomplete";
export interface ProfileRecall {
  /** Scope-bound identity prevents one Project's profile superseding another's. */
  id: string;
  text: string;
  complete: boolean;
  omitted: { item_limit: number; text_budget: number; unsafe_summary: number };
  unavailable: { section: string; reason: string }[];
}
// Optional SDK surface keeps older SDK consumers functional. No transport or
// legacy endpoint is emulated when the installed SDK lacks this capability.
interface ProfileSdk {
  contracts(): Promise<{ contracts: string[] }>;
  memory(scope: { space_uid: string }): {
    profile(options: { project_uid?: string; include_org_space: boolean; format: "text"; max_tokens: number }): Promise<{
      contract: string; scope: { space_uid: string }; project_uid?: string;
      include_org_space: boolean; context_text?: string; complete: boolean;
      omitted: ProfileRecall["omitted"]; unavailable: ProfileRecall["unavailable"];
    }>;
  };
}
export async function recallProfile(client: MindGraph, resolved: ResolvedOptions): Promise<ProfileRecall | null> {
  const sdk = client as MindGraph & Partial<ProfileSdk>;
  if (!resolved.spaceUid || !sdk.memory || !sdk.contracts) {
    resolved.onError?.(new Error("Profile recall requires an explicit spaceUid and a memory.v1-capable SDK"), PROFILE_UNAVAILABLE);
    return null;
  }
  return failOpen("profile", resolved.onError, async () => {
    const capability = await sdk.contracts!();
    if (!capability.contracts.includes("memory.v1")) {
      resolved.onError?.(new Error("Server does not advertise memory.v1"), PROFILE_UNAVAILABLE);
      return null;
    }
    const result = await sdk.memory!({ space_uid: resolved.spaceUid! }).profile({
      project_uid: resolved.projectUid,
      include_org_space: resolved.includeOrgSpace,
      format: "text",
      max_tokens: 4000,
    });
    if (result.contract !== "memory.v1" || result.scope.space_uid !== resolved.spaceUid ||
        result.project_uid !== resolved.projectUid || result.include_org_space !== resolved.includeOrgSpace) {
      throw new Error("Profile response scope does not match the configured scope");
    }
    if (!result.complete) {
      resolved.onError?.(new Error(`Profile is incomplete: ${JSON.stringify({ omitted: result.omitted, unavailable: result.unavailable })}`), PROFILE_INCOMPLETE);
    }
    if (!result.context_text?.trim()) return null;
    return {
      id: `mindgraph:profile:${JSON.stringify([resolved.orgId ?? null, resolved.spaceUid, resolved.projectUid ?? null, resolved.includeOrgSpace])}`,
      text: result.context_text,
      complete: result.complete, omitted: result.omitted, unavailable: result.unavailable,
    };
  });
}
