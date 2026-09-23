import { messageText, type HostMessage } from "mindgraph-agent-core";
import { MindGraphMemory, injectMemory, type MindGraphToolsOptions } from "./memory.js";

/**
 * Structural view of the OpenAI SDK client: only the two entry points we
 * wrap. No dependency on the `openai` package (typed loosely on purpose so
 * any 4.x–7.x client works and the engines constraint stays the host's).
 */
export interface OpenAILikeClient {
  chat?: { completions: { create: (...args: any[]) => any } };
  responses?: { create: (...args: any[]) => any };
}

type ChatMessage = HostMessage & { role: string };

function lastUserText(messages: readonly HostMessage[]): string {
  const idx = MindGraphMemory.lastUserIndex(messages);
  return idx >= 0 ? messageText(messages[idx]!) : "";
}

function wrapMethod<T extends object>(target: T, name: string, replacement: unknown): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === name) return replacement;
      const value = Reflect.get(t, prop, receiver);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}

async function* captureChatStream(
  stream: AsyncIterable<any>,
  onDone: (assistant: string) => void,
): AsyncGenerator<any> {
  let assistant = "";
  try {
    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (typeof delta === "string") assistant += delta;
      yield chunk;
    }
  } finally {
    onDone(assistant);
  }
}

async function* captureResponsesStream(
  stream: AsyncIterable<any>,
  onDone: (assistant: string) => void,
): AsyncGenerator<any> {
  let assistant = "";
  try {
    for await (const event of stream) {
      if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
        assistant += event.delta;
      }
      yield event;
    }
  } finally {
    onDone(assistant);
  }
}

function responseInputToMessages(input: unknown): ChatMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  return input
    .filter((item) => item && typeof item === "object" && "role" in item)
    .map((item) => item as ChatMessage);
}

/**
 * `withMindGraph(openai, options)` — wraps `chat.completions.create` and
 * `responses.create`: recall is injected as a user message before the latest
 * user turn (or appended to the system/instructions with `inject: "system"`),
 * and the exchange is captured after the response, streaming included.
 * Everything else on the client passes through untouched.
 */
export function withMindGraph<T extends OpenAILikeClient>(
  client: T,
  options: MindGraphToolsOptions | MindGraphMemory = {},
): T {
  const memory = options instanceof MindGraphMemory ? options : new MindGraphMemory(options);
  const inject = memory.options.inject ?? "user";

  const asUser = (text: string): ChatMessage => ({ role: "user", content: text });
  const appendSystem = (m: ChatMessage, text: string): ChatMessage => ({
    ...m,
    content: `${messageText(m)}\n\n${text}`,
  });
  const asSystem = (text: string): ChatMessage => ({ role: "system", content: text });

  async function chatCreate(this: unknown, body: any, ...rest: any[]) {
    const original = client.chat!.completions.create;
    const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];
    const user = lastUserText(messages);
    const block = await memory.recall(user);
    const nextBody = block
      ? { ...body, messages: injectMemory(messages, block, inject, asUser, appendSystem, asSystem) }
      : body;
    const result = await original.call(client.chat!.completions, nextBody, ...rest);
    if (body?.stream === true && result && typeof result[Symbol.asyncIterator] === "function") {
      return captureChatStream(result, (assistant) => {
        if (assistant && user) memory.capture({ user, assistant });
      });
    }
    const assistant = result?.choices?.[0]?.message?.content;
    if (typeof assistant === "string" && assistant && user) memory.capture({ user, assistant });
    return result;
  }

  async function responsesCreate(this: unknown, body: any, ...rest: any[]) {
    const original = client.responses!.create;
    const messages = responseInputToMessages(body?.input);
    const user = lastUserText(messages);
    const block = await memory.recall(user);
    let nextBody = body;
    if (block) {
      if (inject === "system") {
        const instructions = typeof body?.instructions === "string" ? `${body.instructions}\n\n${block}` : block;
        nextBody = { ...body, instructions };
      } else if (typeof body?.input === "string") {
        nextBody = { ...body, input: [asUser(block), asUser(body.input)] };
      } else if (Array.isArray(body?.input)) {
        nextBody = { ...body, input: injectMemory(body.input as ChatMessage[], block, "user", asUser, appendSystem, asSystem) };
      }
    }
    const result = await original.call(client.responses, nextBody, ...rest);
    if (body?.stream === true && result && typeof result[Symbol.asyncIterator] === "function") {
      return captureResponsesStream(result, (assistant) => {
        if (assistant && user) memory.capture({ user, assistant });
      });
    }
    const assistant = result?.output_text;
    if (typeof assistant === "string" && assistant && user) memory.capture({ user, assistant });
    return result;
  }

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "chat" && target.chat) {
        return wrapMethod(target.chat, "completions", wrapMethod(target.chat.completions, "create", chatCreate));
      }
      if (prop === "responses" && target.responses) {
        return wrapMethod(target.responses, "create", responsesCreate);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export { MindGraphMemory, type MindGraphToolsOptions } from "./memory.js";
