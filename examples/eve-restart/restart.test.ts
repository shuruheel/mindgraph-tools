/**
 * Restart acceptance for the eve provider: what session A captured must be
 * recalled by session B for the same scope. Runs only against a live
 * MindGraph (MINDGRAPH_E2E=1 and MINDGRAPH_API_KEY); offline it is skipped.
 *
 * The eve wiring it exercises (agent/memory.ts):
 *
 *   import { defineMemory } from "eve/memory";
 *   import { byPrincipal } from "eve/memory/scope";
 *   import { mindgraphMemory } from "mindgraph-eve";
 *   export default defineMemory({
 *     description: "Durable, typed memory in MindGraph",
 *     provider: mindgraphMemory({ agentId: "my-eve-agent" }),
 *     scope: byPrincipal,
 *   });
 */
import { describe, expect, it } from "vitest";
import { mindgraphMemory } from "mindgraph-eve";

const enabled = process.env.MINDGRAPH_E2E === "1" && !!process.env.MINDGRAPH_API_KEY;

describe.skipIf(!enabled)("eve restart", () => {
  it("session B recalls what session A captured", async () => {
    const provider = mindgraphMemory({ agentId: "eve-restart-test" });
    const scope = { key: `restart-${Date.now()}`, namespace: "test", value: "principal-1" };
    const base = { abortSignal: new AbortController().signal, memory: { scope, slot: "memory" } };
    const marker = `mg-prod-${Date.now().toString(36)}`;

    await provider.capture!["turn.completed"]!({
      ...base,
      operationId: `a-${marker}`,
      session: { id: "session-a" },
      messages: [
        { role: "user", content: `Remember: the deploy target for the billing service is fly app ${marker}.` },
        { role: "assistant", content: `Noted — the billing service deploys to ${marker}.` },
      ],
    });

    const recalled = await provider.recall["turn.started"]({
      ...base,
      operationId: `b-${marker}`,
      session: { id: "session-b" },
      messages: [{ role: "user", content: "where does the billing service deploy?" }],
    });
    expect(recalled?.messages[0]!.content).toContain(marker);
  }, 30_000);
});
