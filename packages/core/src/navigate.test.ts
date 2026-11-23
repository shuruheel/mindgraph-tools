import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, Navigator, NAVIGATE_INPUT_SCHEMA, NAVIGATE_MOVES, resolveOptions } from "./index.js";

type Rec = Record<string, any>;
let captured: { url: string; body: Rec }[] = [];

/** Each request takes the next reply; a number is an HTTP error status. */
function stubFetch(...replies: Array<Rec | [number, Rec]>) {
  const queue = [...replies];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      captured.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const next = queue.shift() ?? {};
      const [status, payload] = Array.isArray(next) ? next : [200, next];
      return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

function listing(extra: Rec = {}): Rec {
  return {
    move: "search",
    state: "found",
    shown: 1,
    more_available: 2,
    items: [{ handle: "n:fix", uid: "fix", title: "Ship 2.4.1" }],
    next: [{ action: "more", token: "nv1.p2" }],
    token: "nv1.p2",
    text: 'search for "rollback"  ·  1 items shown\n\nnext: more {"token": …}',
    ...extra,
  };
}

function workingSet(token: string, extra: Rec = {}): Rec {
  return {
    graph: { nodes: [], edges: [] },
    context_text: "Decision: ship connector 2.4.1",
    used_tokens: 300,
    working_set: {
      token,
      turn: 1,
      reread: false,
      entered: [{ uid: "fix", label: "Ship 2.4.1" }],
      kept: [],
      left: [{ uid: "old", label: "Roll back", reason: "dropped" }],
      changed: [],
      strength: { nothing_strong: false },
      ...extra,
    },
  };
}

function navigator(options: Rec = {}) {
  const resolved = resolveOptions({ baseUrl: "https://mg.invalid", apiKey: "mg_test", ...options });
  return new Navigator(createClient(resolved), resolved);
}

beforeEach(() => {
  captured = [];
});
afterEach(() => vi.unstubAllGlobals());

describe("Navigator", () => {
  it("advertises every move", () => {
    expect(NAVIGATE_INPUT_SCHEMA.properties.move.enum).toEqual([...NAVIGATE_MOVES]);
  });

  it("sends a move with its arguments and the door's project, and returns the server text", async () => {
    stubFetch(listing());
    const out = await navigator({ projectUid: "proj-1" }).run({ move: "search", query: "rollback", source: "text" });
    expect(captured[0]).toEqual({
      url: "https://mg.invalid/navigate",
      body: { action: "search", query: "rollback", source: "text", project_uid: "proj-1" },
    });
    expect(out.text).toContain("1 items shown");
    expect(out.result?.state).toBe("found");
  });

  it("more continues the session's last move; sessions do not share it", async () => {
    stubFetch(listing(), listing({ token: null }));
    const nav = navigator();
    await nav.run({ move: "search", query: "rollback" }, "a");
    const other = await nav.run({ move: "more" }, "b");
    expect(other.code).toBe("nothing_to_continue");
    await nav.run({ move: "more" }, "a");
    expect(captured[1]!.body).toEqual({ action: "more", token: "nv1.p2" });
    expect((await nav.run({ move: "more" }, "a")).code).toBe("nothing_to_continue");
    expect(captured).toHaveLength(2);
  });

  it("context holds the working-set token and renders the change list", async () => {
    stubFetch(workingSet("ws1.a"), workingSet("ws1.b"), workingSet("ws1.c"));
    const nav = navigator();
    const first = await nav.run({ move: "context", text: "pool limit" }, "s");
    expect(captured[0]!.body).toEqual({ action: "context", text: "pool limit" });
    expect(first.text).toContain("working set  ·  turn 1  ·  1 entered, 0 kept, 1 left  ·  300 of 2000 tokens");
    expect(first.text).toContain("[old] Roll back    dropped");
    expect(first.text).toContain("Decision: ship connector 2.4.1");
    await nav.run({ move: "context", focus: ["n:fix"] }, "s");
    expect(captured[1]!.body).toEqual({ action: "context", focus: ["n:fix"], token: "ws1.a" });
    await nav.run({ move: "context", text: "new topic", new_session: true }, "s");
    expect(captured[2]!.body).toEqual({ action: "context", text: "new topic" });
  });

  it("an unreadable held token is dropped and the turn starts over", async () => {
    stubFetch(workingSet("ws1.a"), [400, { code: "working_set_token_unreadable" }], workingSet("ws1.b"));
    const nav = navigator();
    await nav.run({ move: "context", text: "one" });
    const out = await nav.run({ move: "context", text: "two" });
    expect(out.error).toBeUndefined();
    expect(captured.map((c) => c.body.token)).toEqual([undefined, "ws1.a", undefined]);
  });

  it("never throws: an unbuilt move and a refusal come back as text with their code", async () => {
    stubFetch([501, { error: "the `check` move is not built yet", code: "move_not_built" }], [400, { error: "bad", code: "bad_continuation" }]);
    const onError = vi.fn();
    const nav = navigator({ onError });
    const check = await nav.run({ move: "check", handles: ["n:fix"] });
    expect(check).toMatchObject({ code: "move_not_built", status: 501 });
    expect(check.text).toContain("not built on this server yet");
    const more = await nav.run({ move: "more", token: "nv1.bad" });
    expect(more).toMatchObject({ code: "bad_continuation", status: 400, error: "bad" });
    expect(onError).toHaveBeenCalledTimes(2);
    expect((await nav.run({ move: "jump" } as never)).code).toBe("invalid_move");
  });
});
