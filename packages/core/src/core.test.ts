import { describe, expect, it, vi } from "vitest";
import {
  CaptureQueue,
  captureExchange,
  exchangeCustomId,
  exchangeText,
  messageText,
  recallByQuery,
  recentUserText,
  renderContext,
  resolveOptions,
  stableId,
  REMEMBER_MAX_BYTES,
} from "./index.js";

describe("hash", () => {
  it("stableId is deterministic and bounded", () => {
    const a = stableId("mgt", "scope", "hello", "world");
    const b = stableId("mgt", "scope", "hello", "world");
    expect(a).toBe(b);
    expect(a).toMatch(/^mgt:[0-9a-f]{32}$/);
    expect(stableId("mgt", "other", "hello", "world")).not.toBe(a);
  });
});

describe("renderContext", () => {
  const response = {
    articles: [{ uid: "a1", label: "Deploys", content: "We deploy to fly.\nMore." }],
    graph: {
      nodes: [
        { uid: "n1", label: "mg-prod", node_type: "Entity", summary: "Fly app" },
        { uid: "n2", label: "Old target", node_type: "Claim", summary: "gone", superseded: true },
        { uid: "c1", label: "chunk", node_type: "Chunk" },
      ],
      edges: [
        { from_uid: "n2", to_uid: "n1", edge_type: "Supersedes" },
        { from_uid: "n1", to_uid: "c1", edge_type: "ExtractedFrom" },
      ],
    },
    remember_instructions: "Keep deploy targets.",
  };

  it("renders whole items, hides infrastructure, flags supersession, and appends instructions", () => {
    const out = renderContext(response);
    expect(out.text).toContain("[Article] Deploys — We deploy to fly.");
    expect(out.text).toContain("[Entity] mg-prod — Fly app");
    expect(out.text).toContain("[Claim] Old target — gone (superseded)");
    expect(out.text).toContain("Old target —Supersedes→ mg-prod");
    expect(out.text).not.toContain("chunk");
    expect(out.text).not.toContain("ExtractedFrom");
    expect(out.text).toContain("Remember instructions: Keep deploy targets.");
    expect(out.warnings).toContain("superseded_items_present");
    expect(out.omitted).toBe(0);
  });

  it("drops whole items past the budget and says how many", () => {
    const out = renderContext(response, { maxChars: 60 });
    expect(out.omitted).toBeGreaterThan(0);
    expect(out.text).toMatch(/\[\d+ item\(s\) omitted/);
    expect(out.warnings).toContain("context_bounded");
    // No line is cut in the middle.
    for (const line of out.text.split("\n")) expect(line.length).toBeLessThanOrEqual(60);
  });

  it("returns empty text for an empty response", () => {
    expect(renderContext({ graph: { nodes: [], edges: [] } }).text).toBe("");
  });
});

describe("messages", () => {
  it("reads Responses text without treating images or unknown parts as query text", () => {
    const input = { role: "user", content: [
      { type: "input_text", text: "  question\n" },
      { type: "input_image", image_url: "data:image/png;base64,AA==", text: "not input text" },
      { type: "unknown", text: "not input text either" },
    ] };
    expect(messageText(input)).toBe("  question\n");
    expect(recentUserText([input])).toBe("question");
    expect(messageText({ role: "assistant", content: [{ type: "output_text", text: "answer" }] })).toBe("answer");
  });
  it("extracts text from string and part-array content, last user only", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: [{ type: "text", text: "second " }, { type: "file", data: "x" }] },
    ];
    expect(messageText(messages[2]!)).toBe("reply");
    expect(recentUserText(messages)).toBe("second");
    expect(recentUserText(messages, 2)).toBe("first\nsecond");
  });
  it("builds a conversation query that never cuts the latest message", () => {
    const user = (content: string) => ({ role: "user", content });
    const turns = [user("who owns checkout?"), user("what is its pool size?"), user("what caused its last incident?")];
    expect(recentUserText(turns, 3)).toBe("who owns checkout?\nwhat is its pool size?\nwhat caused its last incident?");
    // More than there are, zero, a fraction and nonsense all mean a sane count.
    expect(recentUserText(turns, 99)).toBe(recentUserText(turns, 3));
    expect(recentUserText(turns, 0)).toBe("what caused its last incident?");
    expect(recentUserText(turns, 2.9)).toBe("what is its pool size?\nwhat caused its last incident?");
    expect(recentUserText(turns, Number.NaN)).toBe("what caused its last incident?");
    expect(recentUserText(Array.from({ length: 20 }, (_, i) => user(`m${i}`)), 99).split("\n")).toHaveLength(8);

    // Long earlier turns give way; the latest is whole and last.
    const long = [user("a".repeat(400)), user("b".repeat(400)), user("the question")];
    const query = recentUserText(long, 3);
    expect(query.length).toBeLessThanOrEqual(500);
    expect(query.endsWith("\nthe question")).toBe(true);
    // The nearer earlier turn is served first; the older one gets what is left.
    expect(query).toBe(`${"a".repeat(86)}\n${"b".repeat(400)}\nthe question`);
    expect(query).toHaveLength(500);
    // When the nearer one takes all of it, the older one is left out.
    expect(recentUserText([user("a".repeat(400)), user("b".repeat(600)), user("the question")], 3))
      .toBe(`${"b".repeat(487)}\nthe question`);
    // A latest message at the cap leaves no room, and is still not displaced.
    expect(recentUserText([user("earlier"), user("q".repeat(900))], 2)).toBe("q".repeat(500));

    // An empty latest message is no query, whatever came before it.
    expect(recentUserText([user("earlier"), { role: "user", content: [{ type: "file", data: "x" }] }], 3)).toBe("");
    // An empty earlier turn is skipped, and so is a user-role message that is not the user's words.
    expect(recentUserText([user("one"), user("  "), user("three")], 3)).toBe("one\nthree");
    const injected = (m: { content: unknown }) => String(m.content).startsWith("<memory>");
    expect(recentUserText([user("one"), user("<memory>recalled</memory>"), user("three")], 2, injected)).toBe("one\nthree");
  });
});

describe("captureExchange", () => {
  const resolved = resolveOptions({ apiKey: "mg_test", agentId: "tester", principalId: "u1" });

  it("uses remember with a deterministic custom_id when the SDK has it", async () => {
    const remember = vi.fn(async (_text: string, _options: Record<string, unknown>) => ({ uid: "n1", action: "inserted" }));
    const client = { remember } as never;
    const exchange = { user: "Where do we deploy the app?", assistant: "To fly app mg-prod, always." };
    const receipt = await captureExchange(client, resolved, exchange, { scopeKey: "s1" });
    expect(receipt).toEqual({
      uid: "n1",
      action: "inserted",
      customId: exchangeCustomId(exchange, "s1"),
      idempotent: true,
    });
    const [text, options] = remember.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(text).toBe("User: Where do we deploy the app?\nAssistant: To fly app mg-prod, always.");
    expect(options.custom_id).toBe(receipt!.customId);
    expect(options.agent_id).toBe("tester");
    expect(options.props).toMatchObject({ principal_id: "u1", scope_key: "s1" });
    // Replay: same input, same custom_id → the server upserts, nothing new.
    await captureExchange(client, resolved, exchange, { scopeKey: "s1" });
    expect(remember.mock.calls[1]![1]).toEqual(remember.mock.calls[0]![1]);
  });

  it("falls back to capture(observation) and reports non-idempotent", async () => {
    const capture = vi.fn(async () => ({ uid: "n2" }));
    const client = { capture } as never;
    const receipt = await captureExchange(client, resolved, {
      user: "Remember that the deploy target is mg-prod",
      assistant: "Noted: mg-prod is the deploy target.",
    });
    expect(receipt?.idempotent).toBe(false);
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ action: "observation", props: expect.objectContaining({ custom_id: receipt!.customId }) }),
    );
  });

  it("skips trivial exchanges and fails open on errors", async () => {
    const onError = vi.fn();
    const r = resolveOptions({ apiKey: "mg_test", onError });
    const client = { remember: vi.fn(async () => { throw new Error("boom"); }) } as never;
    expect(await captureExchange(client, r, { user: "hi", assistant: "hello" })).toBeNull();
    expect(await captureExchange(client, r, { user: "a".repeat(50), assistant: "b".repeat(50) })).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "capture");
  });

  it("bounds the text to the server cap", () => {
    const text = exchangeText({ user: "u", assistant: "x".repeat(20_000) });
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(REMEMBER_MAX_BYTES);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("recallByQuery", () => {
  it("builds the bounded request and renders, failing open on error", async () => {
    const onError = vi.fn();
    const resolved = resolveOptions({ apiKey: "mg_test", projectUid: "p1", onError });
    const retrieveContext = vi.fn(async () => ({
      graph: { nodes: [{ uid: "n1", label: "mg-prod", node_type: "Entity" }], edges: [] },
    }));
    const client = { retrieveContext } as never;
    const recall = await recallByQuery(client, resolved, "  where do we deploy?  ");
    expect(recall?.text).toContain("[Entity] mg-prod");
    expect(retrieveContext).toHaveBeenCalledWith({
      query: "where do we deploy?",
      project_uid: "p1",
      node_limit: 12,
      chunk_limit: 0,
      article_limit: 0,
      include_graph: true,
      graph_expansion_limit: 3,
      graph_max_depth: 2,
    });
    const broken = { retrieveContext: vi.fn(async () => { throw new Error("down"); }) } as never;
    expect(await recallByQuery(broken, resolved, "q")).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "recall");
    expect(await recallByQuery(client, resolved, "   ")).toBeNull();
  });
});

describe("CaptureQueue", () => {
  it("flushes at size and on demand", async () => {
    const handler = vi.fn(async (_items: number[]) => undefined);
    const queue = new CaptureQueue(handler, { size: 2, delayMs: 60_000 });
    queue.push(1);
    expect(handler).not.toHaveBeenCalled();
    queue.push(2);
    await queue.flush();
    expect(handler).toHaveBeenCalledWith([1, 2]);
    queue.push(3);
    await queue.flush();
    expect(handler).toHaveBeenLastCalledWith([3]);
    expect(queue.pending).toBe(0);
  });
});

describe("renderContext with server-side text (evidence plan R2)", () => {
  it("passes the server's context_text through and reports its omissions", () => {
    const raw = {
      context_text: "Legend: …\nAs of: 2024-06-01\n[2024-04-05] Claim — budget is $8,000 [current]",
      graph: { nodes: [{ uid: "a", label: "ignored", node_type: "Claim" }], edges: [] },
      omitted: { nodes: 2, chunks: 0, articles: 0, conflicts: 0 },
      truncated: true,
    };
    const out = renderContext(raw);
    expect(out.text).toBe(raw.context_text);
    expect(out.items).toBe(1);
    expect(out.omitted).toBe(2);
    expect(out.warnings).toContain("context_bounded");
  });

  it("guards the server text with the character budget", () => {
    const out = renderContext({ context_text: "x".repeat(1000), graph: { nodes: [], edges: [] } }, { maxChars: 600 });
    expect(out.text.startsWith("x".repeat(600))).toBe(true);
    expect(out.text).toContain("[truncated to 600 characters]");
  });
});
