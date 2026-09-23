/**
 * Instinct's memory, in 60 lines, on MindGraph.
 *
 * Instinct keeps a git-tracked folder of Markdown memories and greps it before
 * every turn. This does the same job with one wrapper: recall before the
 * model call, capture after it — but the memories land in a typed, versioned,
 * cited graph you can open at https://mindgraph.cloud/dashboard/explorer.
 *
 *   MINDGRAPH_API_KEY=mg_... OPENAI_API_KEY=sk-... npx tsx examples/instinct-in-60-lines/index.ts
 */
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { MindGraphMemory, withMindGraph } from "mindgraph-tools";

const memory = new MindGraphMemory({
  // baseUrl and apiKey come from MINDGRAPH_URL / MINDGRAPH_API_KEY
  agentId: "instinct-demo",
  onError: (error: unknown, operation: string) =>
    console.warn(`[mindgraph:${operation}]`, error instanceof Error ? error.message : String(error)),
});

const openai = createOpenAI();
const model = withMindGraph(openai("gpt-5.4-mini"), memory);

async function turn(prompt: string): Promise<string> {
  const { text } = await generateText({
    model,
    system: "You are a terse engineering assistant. Use remembered context when it answers the question.",
    prompt,
  });
  console.log(`\n> ${prompt}\n${text}`);
  return text;
}

async function main() {
  // Turn 1: the user states two facts. They are captured as memories after the reply.
  await turn("For the record: we deploy the API to the fly app mg-prod, and I prefer dark mode everywhere.");
  await memory.flush(); // captures are batched; flush before the next call so recall can see them

  // Turn 2: a new conversation (no history passed) — the answer comes from recalled memory.
  await turn("Where do we deploy the API?");

  // Turn 3: paraphrase and misspelling — the vector leg still finds it (grep would not).
  await turn("Whats the prod deploymnet target for the backend service?");

  await memory.flush();
  console.log("\nOpen the graph: https://mindgraph.cloud/dashboard/explorer (search \"mg-prod\")");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
