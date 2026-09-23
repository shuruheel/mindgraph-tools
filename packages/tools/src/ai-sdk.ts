import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import { messageText, type HostMessage } from "mindgraph-agent-core";
import { MindGraphMemory, injectMemory, type MindGraphToolsOptions } from "./memory.js";

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
      const prompt = (params.prompt ?? []) as unknown as PromptMessage[];
      const userText = lastUser(prompt);
      const block = await memory.recall(userText);
      if (!block) return params;
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

export { MindGraphMemory, type MindGraphToolsOptions } from "./memory.js";
