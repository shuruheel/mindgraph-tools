import { jsonSchema, tool, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware, type Tool } from "ai";
import {
  messageText,
  NAVIGATE_DESCRIPTION,
  NAVIGATE_INPUT_SCHEMA,
  NAVIGATE_TOOL_NAME,
  type HostMessage,
  type NavigateInput,
  type NavigateOutput,
} from "mindgraph-agent-core";
import { MindGraphMemory, injectMemory, removeProfileMemory, type MindGraphToolsOptions } from "./memory.js";

type PromptMessage = HostMessage & { role: "system" | "user" | "assistant" | "tool" };

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const p = part as { type?: string; text?: string };
      return p && p.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .filter(Boolean)
    .join("");
}

/**
 * Vercel AI SDK middleware: recall before the model sees the prompt, capture
 * after it answers, never throw. Works with `generateText`, `streamText`,
 * agents and tool loops (a loop's repeated steps reuse the first recall).
 */
export function mindGraphMiddleware(
  options: MindGraphToolsOptions | MindGraphMemory = {},
): LanguageModelMiddleware {
  const memory = options instanceof MindGraphMemory ? options : new MindGraphMemory(options);
  const inject = memory.options.inject ?? "user";

  function lastUser(prompt: readonly PromptMessage[]): string {
    const idx = MindGraphMemory.lastUserIndex(prompt);
    return idx >= 0 ? messageText(prompt[idx]!) : "";
  }

  return {
    specificationVersion: "v3",
    transformParams: async ({ params }) => {
      const prompt = removeProfileMemory((params.prompt ?? []) as unknown as PromptMessage[]);
      const block = await memory.recall(memory.queryFor(prompt));
      if (!block) return { ...params, prompt: prompt as unknown as typeof params.prompt };
      const next = injectMemory<PromptMessage>(
        prompt,
        block,
        inject,
        (text) => ({ role: "user", content: [{ type: "text", text }] }),
        (message, text) => ({
          role: "system",
          content: `${typeof message.content === "string" ? message.content : messageText(message)}\n\n${text}`,
        }),
        (text) => ({ role: "system", content: text }),
      );
      return { ...params, prompt: next as unknown as typeof params.prompt };
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();
      const assistant = textFromContent((result as { content?: unknown }).content);
      const user = lastUser((params.prompt ?? []) as unknown as PromptMessage[]);
      if (assistant && user) memory.capture({ user, assistant });
      return result;
    },
    wrapStream: async ({ doStream, params }) => {
      const result = await doStream();
      const user = lastUser((params.prompt ?? []) as unknown as PromptMessage[]);
      let assistant = "";
      let captured = false;
      const finish = () => {
        if (captured) return;
        captured = true;
        if (assistant && user) memory.capture({ user, assistant });
      };
      const transform = new TransformStream<unknown, unknown>({
        transform(part, controller) {
          const p = part as { type?: string; delta?: string };
          if (p.type === "text-delta" && typeof p.delta === "string") assistant += p.delta;
          if (p.type === "finish") finish();
          controller.enqueue(part);
        },
        flush() {
          finish();
        },
      });
      const stream = (result as { stream: ReadableStream<unknown> }).stream.pipeThrough(transform);
      return { ...result, stream } as typeof result;
    },
  };
}

/**
 * `withMindGraph(model, options)` — the one-liner. Returns a model that
 * recalls MindGraph memory before every call and captures each exchange
 * after it. For serverless hosts that need to flush captures before
 * freezing, build a `MindGraphMemory` first and pass it in, then
 * `waitUntil(memory.flush())`.
 */
export function withMindGraph(
  model: LanguageModel,
  options: MindGraphToolsOptions | MindGraphMemory = {},
): LanguageModel {
  return wrapLanguageModel({
    model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
    middleware: mindGraphMiddleware(options),
  }) as LanguageModel;
}

export interface MindGraphToolsetOptions {
  /**
   * The conversation these tools serve. The working-set and continuation
   * tokens are held per session, so build the tools per conversation or pass
   * its id. Default `"default"`: one session for every call.
   */
  sessionId?: string;
}

/**
 * `mindGraphTools(memory)` — MindGraph tools for an AI SDK `tools` map:
 * `mindgraph_navigate`, one move of `POST /navigate` per call. The model
 * reads the rendered text; the tool result also carries the server's JSON.
 *
 * ```ts
 * const memory = new MindGraphMemory({ agentId: "support-bot" });
 * await generateText({ model, tools: mindGraphTools(memory, { sessionId: chatId }), prompt });
 * ```
 */
export function mindGraphTools(
  options: MindGraphToolsOptions | MindGraphMemory = {},
  toolset: MindGraphToolsetOptions = {},
): Record<typeof NAVIGATE_TOOL_NAME, Tool<NavigateInput, NavigateOutput>> {
  const memory = options instanceof MindGraphMemory ? options : new MindGraphMemory(options);
  const session = toolset.sessionId ?? "default";
  return {
    [NAVIGATE_TOOL_NAME]: tool<NavigateInput, NavigateOutput>({
      description: NAVIGATE_DESCRIPTION,
      inputSchema: jsonSchema<NavigateInput>(NAVIGATE_INPUT_SCHEMA as unknown as Parameters<typeof jsonSchema>[0]),
      execute: (input) => memory.navigator.run(input, session),
      toModelOutput: ({ output }) => ({ type: "text", value: output.text }),
    }),
  };
}

export { MindGraphMemory, type MindGraphToolsOptions } from "./memory.js";
