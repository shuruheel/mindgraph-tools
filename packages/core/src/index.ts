export {
  createClient,
  failOpen,
  resolveOptions,
  DEFAULT_AGENT_ID,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  type CoreOptions,
  type ResolvedOptions,
} from "./client.js";
export { sha256Hex, stableId } from "./hash.js";
export { renderContext, type RenderOptions, type RenderedContext } from "./render.js";
export {
  buildQueryRequest,
  messageText,
  recentUserText,
  recallByQuery,
  QUERY_MAX_CHARS,
  type HostMessage,
  type QueryRecall,
} from "./strategies/query.js";
export { recallProfile, PROFILE_UNAVAILABLE, type ProfileRecall } from "./strategies/profile.js";
export {
  captureExchange,
  exchangeCustomId,
  exchangeText,
  DEFAULT_MIN_CHARS,
  REMEMBER_MAX_BYTES,
  type CaptureOptions,
  type CaptureReceipt,
  type Exchange,
} from "./capture.js";
export { CaptureQueue, type QueueOptions } from "./queue.js";
export { captureRecap, recapFromMessages, type RecapInput, type RecapReceipt } from "./recap.js";

export type MemoryMode = "query" | "profile" | "full";
