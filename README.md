# mindgraph-tools

Doors into [MindGraph](https://mindgraph.cloud) memory for the frameworks agents are built on. Three packages, one version line:

| Package | What |
|---|---|
| `mindgraph-tools` | `withMindGraph(model)` for the **Vercel AI SDK** (middleware) and `withMindGraph(openai)` for the **OpenAI SDK** (client proxy): recall before the call, capture after it, fail-open in 5 s. |
| `mindgraph-eve` | `mindgraphMemory()` — a memory provider for **eve** (`defineMemory({ provider })`): recall on `turn.started`, capture on `turn.completed`, compaction recaps as Session traces, `search` / `remember` / `forget` / `resume` tools. |
| `mindgraph-agent-core` | The shared engine: bounded recall (`/retrieve/context`), idempotent capture (`/memory/remember` with a deterministic `custom_id`), rendering, batching, recap persistence. |

Memory written through any door lands in the same typed, versioned, cited graph the dashboard, SDKs and MCP server use — with provenance, history and Space/Project access control. Nothing here is a black box: every memory has a uid you can open.

## Vercel AI SDK

```ts
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { withMindGraph } from "mindgraph-tools";

const model = withMindGraph(openai("gpt-5.4-mini"), { agentId: "support-bot" });
const { text } = await generateText({ model, prompt: "Where do we deploy?" });
```

`MINDGRAPH_API_KEY` (and optionally `MINDGRAPH_URL`) come from the environment. On serverless hosts, build the memory first and flush before the function freezes:

```ts
import { MindGraphMemory, withMindGraph } from "mindgraph-tools";
const memory = new MindGraphMemory({ agentId: "support-bot" });
const model = withMindGraph(openai("gpt-5.4-mini"), memory);
// ... after the response:
waitUntil(memory.flush());
```

Options: `mode` (`query` now; `profile` / `full` degrade to `query` until `/memory/profile` ships), `inject` (`user` default, or `system`), `capture` (`false`, or `{ minChars, batchSize, batchDelayMs }`), `maxChars`, `nodeLimit`, `timeoutMs`, `projectUid`, `spaceUid`, `principalId`, `onError`, `onRecall`.

## OpenAI SDK

```ts
import OpenAI from "openai";
import { withMindGraph } from "mindgraph-tools/openai";

const openai = withMindGraph(new OpenAI(), { agentId: "support-bot" });
const r = await openai.responses.create({ model: "gpt-5.4", input: "Where do we deploy?" });
```

Wraps `chat.completions.create` and `responses.create` (streaming included); everything else on the client passes through.

## eve

```ts
// agent/memory.ts
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { mindgraphMemory } from "mindgraph-eve";

export default defineMemory({
  description: "Durable, typed memory in MindGraph",
  provider: mindgraphMemory({ agentId: "my-eve-agent" }),
  scope: byPrincipal,
});
```

Copy `node_modules/mindgraph-eve/skill/SKILL.md` to `agent/skills/mindgraph/SKILL.md` so the model knows when to use the tools. Isolation: `scope: "shared"` (default) keeps one org graph and namespaces `custom_id`s by eve's scope key; `scope: "agent-space"` writes to the agent's private Space, which is isolated for reads only when Space enforcement is on and the API key is bound to that agent.

## Development

```bash
npm install
npm run check        # tsc, vitest, tsup for all packages
MINDGRAPH_E2E=1 MINDGRAPH_API_KEY=mg_... npm run test:e2e   # eve restart acceptance against a live org
```

Node 20+. `eve` itself needs Node 24 at runtime; this repo types the provider structurally so it builds without it.
