import { generateText, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MindGraphMemory, withMindGraph } from "./ai-sdk.js";

type Captured = { url: string; body: any };
let captured: Captured[] = [];

function stubFetch(handler: (url: string, body: any) => unknown | Promise<unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      captured.push({ url, body });
      const payload = await handler(url, body);
      if (payload instanceof Response) return payload;
      return new Response(JSON.stringify(payload ?? {}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

const contextResponse = {
  graph: {
    nodes: [{ uid: "n1", label: "mg-prod", node_type: "Entity", summary: "the fly deploy target" }],
    edges: [],
  },
};

function mockModel(text = "Deploy to mg-prod.") {
  // Result shapes are cast: the mock only needs `content` / `text-delta`
  // parts for these tests, and the usage shape differs across ai 6.x minors.
  return new MockLanguageModelV3({
    doGenerate: (async () => ({
      content: [{ type: "text", text }],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    })) as any,
    doStream: (async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t" });
          controller.enqueue({ type: "text-delta", id: "t", delta: "Deploy to " });
          controller.enqueue({ type: "text-delta", id: "t", delta: "mg-prod." });
          controller.enqueue({ type: "text-end", id: "t" });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          });
          controller.close();
        },
      }),
    })) as any,
  });
}

const options = { baseUrl: "https://mg.invalid", apiKey: "mg_test", capture: { batchSize: 1 } };

beforeEach(() => {
  captured = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("withMindGraph (AI SDK)", () => {
  it("injects a user-role memory block before the latest user message and captures the exchange", async () => {
    stubFetch((url) => (url.endsWith("/retrieve/context") ? contextResponse : { uid: "m1", action: "inserted" }));
    const model = mockModel();
    const memory = new MindGraphMemory(options);
    const wrapped = withMindGraph(model, memory);

    const result = await generateText({
      model: wrapped,
      system: "You are terse.",
      messages: [{ role: "user", content: "Where do we deploy?" }],
    });
    expect(result.text).toBe("Deploy to mg-prod.");

    // The model saw: system, injected memory (user role), the real user message.
    const prompt = model.doGenerateCalls[0]!.prompt;
    expect(prompt.map((m) => m.role)).toEqual(["system", "user", "user"]);
    const injected = prompt[1] as { content: Array<{ type: string; text: string }> };
    expect(injected.content[0]!.text).toContain("<mindgraph-memory>");
    expect(injected.content[0]!.text).toContain("[Entity] mg-prod — the fly deploy target");

    // Recall request shape, then a remember with a deterministic custom_id.
    await memory.flush();
    const recall = captured.find((c) => c.url.endsWith("/retrieve/context"))!;
    expect(recall.body).toMatchObject({ query: "Where do we deploy?", chunk_limit: 0, include_graph: true });
    const remember = captured.find((c) => c.url.endsWith("/memory/remember"))!;
    expect(remember.body.text).toBe("User: Where do we deploy?\nAssistant: Deploy to mg-prod.");
    expect(remember.body.custom_id).toMatch(/^mgt:[0-9a-f]{32}$/);
    expect(remember.body).not.toHaveProperty("idempotency_key");
  });

  it("does not inject when recall is empty", async () => {
    stubFetch(() => ({ graph: { nodes: [], edges: [] } }));
    const model = mockModel();
    await generateText({ model: withMindGraph(model, options), messages: [{ role: "user", content: "hi" }] });
    expect(model.doGenerateCalls[0]!.prompt.map((m) => m.role)).toEqual(["user"]);
  });

  it("fails open within the deadline when MindGraph hangs", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })),
    );
    const model = mockModel();
    const pending = generateText({
      model: withMindGraph(model, { ...options, timeoutMs: 50, onError, capture: false }),
      messages: [{ role: "user", content: "slow?" }],
    });
    await vi.advanceTimersByTimeAsync(80);
    const result = await pending;
    expect(result.text).toBe("Deploy to mg-prod.");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "timeout" }), "recall");
    expect(model.doGenerateCalls[0]!.prompt.map((m) => m.role)).toEqual(["user"]);
  });

  it("passes through on HTTP errors", async () => {
    const onError = vi.fn();
    stubFetch(() => new Response("boom", { status: 500 }));
    const model = mockModel();
    const r = await generateText({
      model: withMindGraph(model, { ...options, onError, capture: false }),
      messages: [{ role: "user", content: "anything" }],
    });
    expect(r.text).toBe("Deploy to mg-prod.");
    expect(onError).toHaveBeenCalledWith(expect.anything(), "recall");
  });

  it("recalls once per distinct last user message (tool loops reuse it)", async () => {
    stubFetch((url) => (url.endsWith("/retrieve/context") ? contextResponse : { uid: "m1", action: "inserted" }));
    const memory = new MindGraphMemory({ ...options, capture: false });
    const model = mockModel();
    const wrapped = withMindGraph(model, memory);
    await generateText({ model: wrapped, messages: [{ role: "user", content: "same question" }] });
    await generateText({ model: wrapped, messages: [{ role: "user", content: "same question" }] });
    expect(captured.filter((c) => c.url.endsWith("/retrieve/context"))).toHaveLength(1);
    await generateText({ model: wrapped, messages: [{ role: "user", content: "different question" }] });
    expect(captured.filter((c) => c.url.endsWith("/retrieve/context"))).toHaveLength(2);
  });

  it("captures streamed text after the stream finishes", async () => {
    stubFetch((url) => (url.endsWith("/retrieve/context") ? { graph: { nodes: [], edges: [] } } : { uid: "m1", action: "inserted" }));
    const memory = new MindGraphMemory(options);
    const result = streamText({
      model: withMindGraph(mockModel(), memory),
      messages: [{ role: "user", content: "Where do we deploy the service?" }],
    });
    let text = "";
    for await (const delta of result.textStream) text += delta;
    expect(text).toBe("Deploy to mg-prod.");
    await memory.flush();
    const remember = captured.find((c) => c.url.endsWith("/memory/remember"))!;
    expect(remember.body.text).toBe("User: Where do we deploy the service?\nAssistant: Deploy to mg-prod.");
  });

  it("profile mode degrades to query mode with one warning until M1 ships", async () => {
    stubFetch(() => contextResponse);
    const onError = vi.fn();
    const model = mockModel();
    await generateText({
      model: withMindGraph(model, { ...options, mode: "profile", onError, capture: false }),
      messages: [{ role: "user", content: "who am I?" }],
    });
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "profile_unavailable");
    expect(model.doGenerateCalls[0]!.prompt.map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("inject: system appends to the system prompt instead", async () => {
    stubFetch(() => contextResponse);
    const model = mockModel();
    await generateText({
      model: withMindGraph(model, { ...options, inject: "system", capture: false }),
      system: "Be brief.",
      messages: [{ role: "user", content: "deploy?" }],
    });
    const prompt = model.doGenerateCalls[0]!.prompt;
    expect(prompt.map((m) => m.role)).toEqual(["system", "user"]);
    expect(prompt[0]!.content).toContain("Be brief.");
    expect(prompt[0]!.content).toContain("<mindgraph-memory>");
  });
});
