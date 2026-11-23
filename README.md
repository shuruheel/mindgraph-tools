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

Options: `mode` (`query` by default; `profile` / `full` require an explicit `spaceUid` and a memory.v1-capable SDK/server), `inject` (`user` default, or `system`), `capture` (`false`, or `{ minChars, batchSize, batchDelayMs }`), `maxChars`, `nodeLimit`, `userMessages`, `timeoutMs`, `projectUid`, `spaceUid`, `includeOrgSpace` (default false), `principalId`, `onError`, `onRecall`.

### Follow-up questions: `userMessages`

By default the recall query is the latest user message. A follow-up that does not name its subject ("what caused it?") then searches for words that match many subjects. `userMessages: 4` builds the query from the latest user message and the three before it, so the search carries the subject the conversation named.

```ts
const model = withMindGraph(openai("gpt-5.4"), { userMessages: 4 });
```

- The latest message is always kept whole; earlier ones share what is left of the 500-character query, nearest first. The most is 8.
- Only the query widens. The exchange that is captured is still the latest one.
- Measured on synthetic ten-turn sessions (CogMemBench, 2026-11-23, two runs): answer accuracy 0.44 and 0.42 with the setting against 0.31 and 0.33 without. The gain was on follow-ups; turns that name their subject were unchanged. It has not been measured on real conversations, where a change of topic would carry the old one into the search for a few turns, so it is off by default.

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

Recall searches with the latest user message and the two before it (`recall: { userMessages }`, default 3; see "Follow-up questions" above).

Copy `node_modules/mindgraph-eve/skill/SKILL.md` to `agent/skills/mindgraph/SKILL.md` so the model knows when to use the tools. Isolation: `scope: "shared"` (default) keeps one org graph and namespaces `custom_id`s by eve's scope key; `scope: "agent-space"` writes to the agent's private Space, which is isolated for reads only when Space enforcement is on and the API key is bound to that agent.

## Development

```bash
npm install
npm run check        # tsc, vitest, tsup for all packages
MINDGRAPH_E2E=1 MINDGRAPH_API_KEY=mg_... npm run test:e2e   # eve restart acceptance against a live org
```

Node 20+. `eve` itself needs Node 24 at runtime; this repo types the provider structurally so it builds without it.

Profile recall checks `GET /memory/v1`, preserves `projectUid` alongside `spaceUid`, and requests bounded Markdown. Missing capability or a failed scoped read continues without that memory; it never falls back to a wider legacy read. `onError` receives `profile_incomplete` with omission/unavailable details for partial profiles. Shared typed knowledge normally lives in `space:org`; opt in with `includeOrgSpace: true`. Existing SDKs remain usable for unscoped query mode; profile/scoped recall requires the SDK exposing `memory()` and `contracts()`.
