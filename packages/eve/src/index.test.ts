import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mindgraphMemory, RECAP_MESSAGE_ID, TOPIC_MESSAGE_ID } from "./index.js";
import type { MemoryOperationContext } from "./eve-types.js";

let captured: { url: string; body: any }[] = [];

function stubFetch(context: unknown = { graph: { nodes: [{ uid: "n1", label: "mg-prod", node_type: "Entity", summary: "deploy target" }], edges: [] } }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      captured.push({ url, body });
      let payload: unknown = { uid: "m1", action: "inserted" };
      if (url.endsWith("/retrieve/context")) payload = context;
      if (url.endsWith("/memory/session")) payload = { uid: body?.action === "open" ? "ses1" : "trace1" };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
}

function ctx(overrides: Partial<MemoryOperationContext> = {}): MemoryOperationContext {
  return {
    abortSignal: new AbortController().signal,
    messages: [
      { role: "user", content: "Where do we deploy?" },
      { role: "assistant", content: [{ type: "text", text: "To fly app mg-prod." }] },
    ],
    operationId: "op-1",
    memory: { scope: { key: "scope-abc", namespace: "ns", value: "user-1" }, slot: "memory" },
    session: { id: "sess-1" },
    turn: { id: "t1", sequence: 1 },
    ...overrides,
  };
}

const options = { baseUrl: "https://mg.invalid", apiKey: "mg_test", agentId: "eve-agent" };

beforeEach(() => {
  captured = [];
  stubFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe("mindgraphMemory", () => {
  it("recall on turn.started returns one stable-id topic message", async () => {
    const provider = mindgraphMemory(options);
    const result = await provider.recall["turn.started"](ctx());
    expect(result?.messages).toHaveLength(1);
    expect(result?.messages[0]).toMatchObject({ id: TOPIC_MESSAGE_ID });
    expect(result?.messages[0]!.content).toContain("[Entity] mg-prod");
    expect(captured[0]!.body).toMatchObject({ query: "Where do we deploy?", chunk_limit: 0, include_graph: true });
  });

  it("recall returns null when nothing is found or memory is down", async () => {
    stubFetch({ graph: { nodes: [], edges: [] } });
    expect(await mindgraphMemory(options).recall["turn.started"](ctx())).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const onError = vi.fn();
    expect(await mindgraphMemory({ ...options, onError }).recall["turn.started"](ctx())).toBeNull();
    expect(onError).toHaveBeenCalled();
  });

  it("capture on turn.completed uses the operation id as custom_id and is replay-identical", async () => {
    const provider = mindgraphMemory(options);
    await provider.capture!["turn.completed"]!(ctx());
    await provider.capture!["turn.completed"]!(ctx());
    const writes = captured.filter((c) => c.url.endsWith("/memory/remember"));
    expect(writes).toHaveLength(2);
    expect(writes[0]!.body).toEqual(writes[1]!.body);
    expect(writes[0]!.body.custom_id).toBe("eve:op-1");
    expect(writes[0]!.body.text).toBe("User: Where do we deploy?\nAssistant: To fly app mg-prod.");
    expect(writes[0]!.body.props).toMatchObject({ scope_key: "scope-abc" });
    expect(writes[0]!.body.agent_id).toBe("eve-agent");
  });

  it("agent-space scope writes into the agent's private Space", async () => {
    const provider = mindgraphMemory({ ...options, scope: "agent-space" });
    await provider.capture!["turn.completed"]!(ctx());
    expect(captured.find((c) => c.url.endsWith("/memory/remember"))!.body.space_uid).toBe("space:agent:eve-agent");
  });

  it("compaction.requested stores a recap trace keyed by the operation id; compaction.completed returns it first", async () => {
    const provider = mindgraphMemory(options);
    const requested = ctx({ operationId: "op-compact-1", turn: null, compaction: { modelId: "m" } });
    await provider.capture!["compaction.requested"]!(requested);
    const session = captured.filter((c) => c.url.endsWith("/memory/session"));
    expect(session).toHaveLength(2);
    expect(session[0]!.body).toMatchObject({
      action: "open",
      harness: "generic",
      harness_session_id: "sess-1",
      idempotency_key: "op-compact-1:open",
    });
    expect(session[1]!.body).toMatchObject({
      action: "trace",
      session_uid: "ses1",
      label: "Compaction recap",
      idempotency_key: "op-compact-1",
    });
    expect(session[1]!.body.props.recap).toContain("User: Where do we deploy?");

    const completed = await provider.recall["compaction.completed"]!(ctx({ operationId: "op-2", turn: null, compaction: { modelId: "m" } }));
    expect(completed?.messages.map((m) => m.id)).toEqual([RECAP_MESSAGE_ID, TOPIC_MESSAGE_ID]);
    expect(completed?.messages[0]!.content).toContain("Before compaction");
  });

  it("exposes search, remember, forget (dry-run by default) and resume tools", async () => {
    const provider = mindgraphMemory(options);
    const tools = (await provider.tools!({ memory: { scope: { key: "scope-abc", namespace: "ns", value: "u" }, slot: "memory" } }))!;
    expect(Object.keys(tools).sort()).toEqual(["forget", "remember", "resume", "search"]);

    const search = await (tools.search!.execute as any)({ query: "deploy" });
    expect(search.context).toContain("mg-prod");

    await (tools.remember!.execute as any)({ content: "Deploy target is mg-prod" });
    const remember = captured.find((c) => c.url.endsWith("/memory/remember"))!;
    expect(remember.body.custom_id).toMatch(/^eve:[0-9a-f]{32}$/);

    await (tools.forget!.execute as any)({ custom_id: "x" });
    const forget = captured.find((c) => c.url.endsWith("/memory/forget"))!;
    expect(forget.body).toMatchObject({ custom_id: "x", dry_run: true });
    await (tools.forget!.execute as any)({ uid: "n1", confirm: true });
    expect(captured.filter((c) => c.url.endsWith("/memory/forget"))[1]!.body).toEqual({ uid: "n1", agent_id: "eve-agent" });
  });

  it("can be switched off piecewise", async () => {
    const provider = mindgraphMemory({ ...options, recall: false, capture: false, tools: false });
    expect(await provider.recall["turn.started"](ctx())).toBeNull();
    await provider.capture!["turn.completed"]!(ctx());
    expect(captured).toHaveLength(0);
    expect(await provider.tools!({ memory: { scope: { key: "k", namespace: "n", value: "v" }, slot: "m" } })).toBeNull();
  });
});
