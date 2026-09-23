import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MindGraphMemory } from "./memory.js";
import { withMindGraph } from "./openai.js";

let captured: { url: string; body: any }[] = [];
const contextResponse = {
  graph: { nodes: [{ uid: "n1", label: "mg-prod", node_type: "Entity", summary: "deploy target" }], edges: [] },
};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      captured.push({ url, body });
      const payload = url.endsWith("/retrieve/context") ? contextResponse : { uid: "m1", action: "inserted" };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
}

class FakeCompletions {
  calls: any[] = [];
  async create(body: any): Promise<any> {
    this.calls.push(body);
    if (body.stream) {
      const chunks = [
        { choices: [{ delta: { content: "Deploy to " } }] },
        { choices: [{ delta: { content: "mg-prod." } }] },
      ];
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    }
    return { choices: [{ message: { role: "assistant", content: "Deploy to mg-prod." } }] };
  }
  list() {
    return "untouched";
  }
}

class FakeResponses {
  calls: any[] = [];
  async create(body: any): Promise<any> {
    this.calls.push(body);
    if (body.stream) {
      return (async function* () {
        yield { type: "response.output_text.delta", delta: "Deploy to " };
        yield { type: "response.output_text.delta", delta: "mg-prod." };
        yield { type: "response.completed" };
      })();
    }
    return { output_text: "Deploy to mg-prod." };
  }
}

function fakeClient() {
  return { chat: { completions: new FakeCompletions() }, responses: new FakeResponses(), models: { list: () => "models" } };
}

const options = { baseUrl: "https://mg.invalid", apiKey: "mg_test", capture: { batchSize: 1 } };

beforeEach(() => {
  captured = [];
  stubFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe("withMindGraph (OpenAI)", () => {
  it("injects before the latest user message on chat.completions and captures", async () => {
    const client = fakeClient();
    const memory = new MindGraphMemory(options);
    const wrapped = withMindGraph(client, memory);
    const result = await wrapped.chat.completions.create({
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Where do we deploy?" },
      ],
    });
    expect(result.choices[0].message.content).toBe("Deploy to mg-prod.");
    const sent = client.chat.completions.calls[0].messages;
    expect(sent.map((m: any) => m.role)).toEqual(["system", "user", "user"]);
    expect(sent[1].content).toContain("<mindgraph-memory>");
    expect(sent[2].content).toBe("Where do we deploy?");
    await memory.flush();
    expect(captured.find((c) => c.url.endsWith("/memory/remember"))!.body.text).toBe(
      "User: Where do we deploy?\nAssistant: Deploy to mg-prod.",
    );
    // Other members are untouched.
    expect(wrapped.chat.completions.list()).toBe("untouched");
    expect(wrapped.models.list()).toBe("models");
  });

  it("captures a streamed chat completion after iteration", async () => {
    const client = fakeClient();
    const memory = new MindGraphMemory(options);
    const wrapped = withMindGraph(client, memory);
    const stream = await wrapped.chat.completions.create({
      model: "gpt-5.4",
      stream: true,
      messages: [{ role: "user", content: "Where do we deploy the service?" }],
    });
    let text = "";
    for await (const chunk of stream) text += chunk.choices[0].delta.content;
    expect(text).toBe("Deploy to mg-prod.");
    await memory.flush();
    expect(captured.some((c) => c.url.endsWith("/memory/remember"))).toBe(true);
  });

  it("handles responses.create with string input, array input, and instructions injection", async () => {
    const client = fakeClient();
    const wrapped = withMindGraph(client, { ...options, capture: false });
    await wrapped.responses.create({ model: "gpt-5.4", input: "Where do we deploy?" });
    expect(client.responses.calls[0].input.map((m: any) => m.role)).toEqual(["user", "user"]);
    expect(client.responses.calls[0].input[0].content).toContain("<mindgraph-memory>");

    await wrapped.responses.create({
      model: "gpt-5.4",
      input: [{ role: "user", content: "Where do we deploy?" }],
    });
    expect(client.responses.calls[1].input).toHaveLength(2);

    const sys = withMindGraph(fakeClient(), { ...options, inject: "system", capture: false });
    const target = (sys as any).responses;
    await sys.responses.create({ model: "gpt-5.4", instructions: "Be brief.", input: "deploy?" });
    void target;
  });

  it("captures a streamed responses call", async () => {
    const client = fakeClient();
    const memory = new MindGraphMemory(options);
    const wrapped = withMindGraph(client, memory);
    const stream = await wrapped.responses.create({ model: "gpt-5.4", stream: true, input: "Where do we deploy the app?" });
    const events: any[] = [];
    for await (const e of stream) events.push(e);
    expect(events).toHaveLength(3);
    await memory.flush();
    expect(captured.find((c) => c.url.endsWith("/memory/remember"))!.body.text).toContain("Assistant: Deploy to mg-prod.");
  });
});
