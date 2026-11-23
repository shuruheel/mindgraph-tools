import type { MindGraph } from "mindgraph";
import type { ResolvedOptions } from "./client.js";

/**
 * `mindgraph_navigate`: an agent's read of the graph one move at a time, by
 * handles, over the server's `POST /navigate` (recursive-navigation spec D8,
 * D10, D14). The same tool as the MCP server's, for the doors here.
 *
 * Two tokens are held per session so the model carries neither: the
 * working-set token of `context` (sent on the session's next `context` call)
 * and the continuation of the last listing move (`more` without a token
 * continues it).
 */
export const NAVIGATE_TOOL_NAME = "mindgraph_navigate";

export const NAVIGATE_MOVES = [
  "search",
  "open",
  "around",
  "follow",
  "walk",
  "lookup",
  "context",
  "more",
  "check",
] as const;
export type NavigateMove = (typeof NAVIGATE_MOVES)[number];

export const NAVIGATE_DESCRIPTION =
  "Navigate MindGraph memory one move at a time, by handles. Every result lists items as [handle] title, a line of text, how the item was reached and whether it still stands (current, superseded by [handle], withdrawn), then a `next:` line of moves valid from there. A handle is a type letter and the full uid (n: item, c: source text, e: entity, d: document); copy it exactly. " +
  "Moves: `search` (query; source items|text|both) finds a starting point. `walk` (handles you chose; rounds 1-4) spreads from those items and returns what is most strongly connected. `follow` (handles; relations, direction out|in|both, depth 1-3) lists linked items. `around` (a c: handle; window 1-3) reads the passages before and after a passage. `open` (handles; range [start,end]) reads items in full. `lookup` (name) finds the item a name or identifier denotes. `more` continues the last move past its budget. `check` (handles) says whether a conclusion still stands, where the server has it. " +
  "`context` (text: what was just said; focus, pin, drop: handles) reads the conversation's working set: what entered, stayed and left since the last call; new_session starts over. " +
  "Typical flow: search with a few keywords, walk or follow from the hits that matter, around or open to read the source, then answer or say the record does not answer.";

const HANDLES = { type: "array", items: { type: "string" }, maxItems: 32 } as const;

/** JSON schema of the tool's input. */
export const NAVIGATE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    move: { type: "string", enum: [...NAVIGATE_MOVES], description: "The move to make" },
    query: { type: "string", description: "search: a few discriminating keywords" },
    source: { type: "string", enum: ["items", "text", "both"], description: "search: items, source text, or both (default)" },
    node_types: { type: "array", items: { type: "string" }, description: "search: limit items to these node types" },
    handles: { ...HANDLES, description: "open, around, follow, walk, check: the handles to start from" },
    relations: { type: "array", items: { type: "string" }, description: "follow, walk, context: limit to these link types" },
    direction: { type: "string", enum: ["out", "in", "both"], description: "follow: link direction (default both)" },
    depth: { type: "integer", minimum: 1, maximum: 3, description: "follow: hops (default 1)" },
    window: { type: "integer", minimum: 1, maximum: 3, description: "around: passages on each side (default 1)" },
    rounds: { type: "integer", minimum: 1, maximum: 4, description: "walk (default 3), context: rounds of the walk" },
    range: {
      type: "array",
      items: { type: "integer", minimum: 0 },
      minItems: 2,
      maxItems: 2,
      description: "open: a character range [start, end) of each item's text",
    },
    name: { type: "string", description: "lookup: the identifier or name" },
    token: { type: "string", description: "more: the continuation of an earlier move (omit to continue the last one)" },
    text: { type: "string", description: "context: what the user or you just said; omit to re-read this turn" },
    focus: { ...HANDLES, description: "context: items you judge relevant" },
    pin: { ...HANDLES, description: "context: items to keep in the working set" },
    drop: { ...HANDLES, description: "context: items to remove from the working set" },
    new_session: { type: "boolean", description: "context: start a new working set" },
    valid_at: { type: "string", description: "context: the world-time point of the read (ISO-8601)" },
    budget_tokens: { type: "integer", maximum: 8000, description: "Token budget of the result (default 4000; context 2000)" },
    limit: { type: "integer", minimum: 1, maximum: 50, description: "Items to show (default 20)" },
  },
  required: ["move"],
  additionalProperties: false,
} as const;

export interface NavigateInput {
  move: NavigateMove;
  query?: string;
  source?: "items" | "text" | "both";
  node_types?: string[];
  handles?: string[];
  relations?: string[];
  direction?: "out" | "in" | "both";
  depth?: number;
  window?: number;
  rounds?: number;
  range?: [number, number];
  name?: string;
  token?: string;
  text?: string;
  focus?: string[];
  pin?: string[];
  drop?: string[];
  new_session?: boolean;
  valid_at?: string;
  budget_tokens?: number;
  limit?: number;
}

export interface NavigateOutput {
  /** The result written for the model to read. */
  text: string;
  /** The server's JSON (absent on an error). */
  result?: Record<string, unknown>;
  error?: string;
  code?: string;
  status?: number;
}

const FORWARDED = [
  "query", "source", "node_types", "handles", "relations", "direction", "depth", "window",
  "rounds", "range", "name", "token", "text", "focus", "pin", "drop", "valid_at",
  "budget_tokens", "limit",
] as const;

const CONTEXT_DEFAULT_BUDGET = 2_000;
const KEPT_SHOWN = 8;
const MAX_SESSIONS = 64;

type Rec = Record<string, unknown>;

interface Held {
  workingSet?: string;
  more?: string;
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function changeLine(item: unknown, mark?: string): string {
  const rec = (item && typeof item === "object" ? item : {}) as Rec;
  const label = str(rec.label);
  const line = `[${str(rec.uid) ?? "?"}]${label ? ` ${label}` : ""}`;
  return mark ? `${line}    ${mark}` : line;
}

/** The working-set change list above the server's rendered context. */
export function renderWorkingSet(response: Rec, budget: number): string {
  const set = (response.working_set ?? {}) as Rec;
  const entered = list(set.entered);
  const kept = list(set.kept);
  const left = list(set.left);
  const changed = list(set.changed);
  const used = typeof response.used_tokens === "number" ? response.used_tokens : undefined;
  const lines = [
    [
      "working set",
      `turn ${typeof set.turn === "number" ? set.turn : "?"}${set.reread === true ? " (re-read)" : ""}`,
      `${entered.length} entered, ${kept.length} kept, ${left.length} left`,
      ...(used !== undefined ? [`${used} of ${budget} tokens`] : []),
    ].join("  ·  "),
  ];
  if ((set.strength as Rec | undefined)?.nothing_strong === true) {
    lines.push("", "Nothing in memory is strongly related to this.");
  }
  if (entered.length) lines.push("", "entered", ...entered.map((item) => changeLine(item)));
  if (kept.length) {
    lines.push("", "kept", ...kept.slice(0, KEPT_SHOWN).map((item) => changeLine(item)));
    if (kept.length > KEPT_SHOWN) lines.push(`… ${kept.length - KEPT_SHOWN} more`);
  }
  if (left.length) {
    lines.push("", "left", ...left.map((item) => changeLine(item, str((item as Rec)?.reason) ?? "faded")));
  }
  if (changed.length) {
    lines.push("", "changed", ...changed.map((item) => changeLine(item, str((item as Rec)?.standing))));
  }
  const pins = list(set.pins_not_shown);
  if (pins.length) lines.push("", `${pins.length} pinned item(s) not shown`);
  const body = str(response.context_text);
  if (body) lines.push("", body.trimEnd());
  lines.push("", "steer: focus [handle] · pin [handle] · drop [handle] · widen (rounds)");
  return lines.join("\n");
}

function errorBody(error: unknown): Rec {
  const body = (error as { body?: unknown })?.body;
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Rec) : {};
}

/**
 * Makes navigation moves for one door and holds each session's tokens. Never
 * throws: a failed move comes back as `{ text, error, code, status }`, and the
 * error is also reported through `onError`.
 */
export class Navigator {
  private readonly sessions = new Map<string, Held>();

  constructor(
    private readonly client: MindGraph,
    private readonly resolved: Pick<ResolvedOptions, "projectUid" | "onError">,
  ) {}

  private held(session: string): Held {
    let held = this.sessions.get(session);
    if (held) this.sessions.delete(session);
    else held = {};
    this.sessions.set(session, held);
    while (this.sessions.size > MAX_SESSIONS) {
      this.sessions.delete(this.sessions.keys().next().value as string);
    }
    return held;
  }

  private async send(body: Rec): Promise<Rec> {
    const c = this.client as unknown as {
      navigate?: (body: Rec) => Promise<unknown>;
      post?: (path: string, body: unknown) => Promise<unknown>;
    };
    let response: unknown;
    if (typeof c.navigate === "function") response = await c.navigate.call(this.client, body);
    else if (typeof c.post === "function") response = await c.post.call(this.client, "/navigate", body);
    else throw new Error("This version of the MindGraph SDK cannot send navigation requests.");
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("The server returned no navigation result.");
    }
    return response as Rec;
  }

  /** Make one move for a session (one conversation). */
  async run(input: NavigateInput, session = "default"): Promise<NavigateOutput> {
    const move = (input as Partial<NavigateInput> & { action?: string }).move ??
      ((input as { action?: string }).action as NavigateMove | undefined);
    if (!move || !(NAVIGATE_MOVES as readonly string[]).includes(move)) {
      const error = `move must be one of ${NAVIGATE_MOVES.join(", ")}`;
      return { text: error, error, code: "invalid_move" };
    }
    const body: Rec = { action: move };
    for (const key of FORWARDED) {
      const value = (input as unknown as Rec)[key];
      if (value !== undefined && value !== null) body[key] = value;
    }
    if (this.resolved.projectUid) body.project_uid = this.resolved.projectUid;
    const held = this.held(session);
    try {
      if (move === "context") return await this.context(input, body, held);
      if (move === "more" && body.token === undefined) {
        if (!held.more) {
          const error =
            "There is no move to continue: the last move had nothing more, or none was made. Repeat a move, then call more.";
          return { text: error, error, code: "nothing_to_continue" };
        }
        body.token = held.more;
      }
      const result = await this.send(body);
      held.more = str(result.token);
      return { text: str(result.text) ?? JSON.stringify(result), result };
    } catch (error) {
      this.resolved.onError?.(error, "navigate");
      const fields = errorBody(error);
      const status = (error as { status?: unknown })?.status;
      const code = str(fields.code);
      const message =
        status === 501
          ? `The \`${move}\` move is not built on this server yet.`
          : str(fields.error) ?? (error instanceof Error ? error.message : String(error));
      return {
        text: `MindGraph navigation failed: ${message}`,
        error: message,
        ...(code ? { code } : {}),
        ...(typeof status === "number" ? { status } : {}),
      };
    }
  }

  private async context(input: NavigateInput, body: Rec, held: Held): Promise<NavigateOutput> {
    if (input.new_session === true) {
      held.workingSet = undefined;
      delete body.token;
    }
    const fromStore = body.token === undefined && held.workingSet !== undefined;
    if (fromStore) body.token = held.workingSet;
    let result: Rec;
    try {
      result = await this.send(body);
    } catch (error) {
      if (!fromStore || errorBody(error).code !== "working_set_token_unreadable") throw error;
      // The held token is ours: forget it and start the session over.
      held.workingSet = undefined;
      if (body.text === undefined) throw error;
      const fresh = { ...body };
      delete fresh.token;
      result = await this.send(fresh);
    }
    const set = result.working_set as Rec | undefined;
    const token = str(set?.token);
    if (token) held.workingSet = token;
    const budget = typeof input.budget_tokens === "number" ? input.budget_tokens : CONTEXT_DEFAULT_BUDGET;
    return { text: renderWorkingSet(result, budget), result };
  }
}
