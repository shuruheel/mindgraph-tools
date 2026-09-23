/**
 * Compact, model-facing rendering of a `/retrieve/context` response.
 *
 * Whole items only: when the character budget is reached the remaining items
 * are dropped and an explicit `[N item(s) omitted]` line is appended, so the
 * model is never shown a sentence cut in half and never left unaware that
 * more existed.
 */

type Rec = Record<string, unknown>;

const HIDDEN_NODE_TYPES = new Set(["Chunk", "Document", "Session", "Trace", "Execution", "Journal"]);
const HIDDEN_EDGE_TYPES = new Set(["ExtractedFrom", "PossibleDuplicate", "MemberOf", "DerivedFrom"]);

function obj(value: unknown): Rec | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function nodeType(node: Rec): string {
  return text(node.node_type) ?? text(obj(node.node_type)?.Custom) ?? "Node";
}

function firstLine(value: string, max = 240): string {
  const line = value.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export interface RenderedContext {
  text: string;
  items: number;
  omitted: number;
  warnings: string[];
}

export interface RenderOptions {
  /** Hard cap on rendered characters (default 4000). */
  maxChars?: number;
}

/** Render the response into lines; returns an empty text when nothing is retrievable. */
export function renderContext(raw: unknown, options: RenderOptions = {}): RenderedContext {
  const maxChars = options.maxChars ?? 4_000;
  const payload = obj(raw) ?? {};
  const graph = obj(payload.graph) ?? {};
  const lines: string[] = [];
  const warnings: string[] = [];
  const labels = new Map<string, string>();

  for (const article of Array.isArray(payload.articles) ? payload.articles : []) {
    const a = obj(article);
    const label = text(a?.label);
    if (!a || !label) continue;
    const content = text(a.content);
    lines.push(`[Article] ${label}${content ? ` — ${firstLine(content, 400)}` : ""}`);
  }

  for (const rawNode of Array.isArray(graph.nodes) ? graph.nodes : []) {
    const node = obj(rawNode);
    const uid = text(node?.uid);
    const label = text(node?.label);
    if (!node || !uid || !label) continue;
    const type = nodeType(node);
    if (HIDDEN_NODE_TYPES.has(type)) continue;
    labels.set(uid, label);
    const flags: string[] = [];
    if (node.superseded === true) flags.push("superseded");
    if (node.currently_valid === false || node.valid_at_time === false) flags.push("out of validity window");
    const status = text(node.truth_status) ?? text(obj(node.props)?.truth_status);
    if (status && status !== "asserted") flags.push(status);
    const summary = text(node.summary);
    lines.push(
      `[${type}] ${label}${summary && summary !== label ? ` — ${firstLine(summary)}` : ""}${
        flags.length ? ` (${flags.join(", ")})` : ""
      }`,
    );
    if (node.superseded === true) warnings.push("superseded_items_present");
  }

  for (const rawEdge of Array.isArray(graph.edges) ? graph.edges : []) {
    const edge = obj(rawEdge);
    const from = text(edge?.from_uid);
    const to = text(edge?.to_uid);
    const type = text(edge?.edge_type) ?? text(obj(edge?.edge_type)?.Custom);
    if (!from || !to || !type || HIDDEN_EDGE_TYPES.has(type)) continue;
    const fl = labels.get(from);
    const tl = labels.get(to);
    if (!fl || !tl) continue;
    lines.push(`  ${fl} —${type}→ ${tl}`);
  }

  for (const rawChunk of Array.isArray(payload.chunks) ? payload.chunks : []) {
    const chunk = obj(rawChunk);
    const content = text(chunk?.content);
    if (!content) continue;
    const title = text(chunk?.document_title);
    lines.push(`[Source${title ? ` ${title}` : ""}] ${firstLine(content, 400)}`);
  }

  const instructions = text(payload.remember_instructions);

  let used = 0;
  const kept: string[] = [];
  let omitted = 0;
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) {
      omitted += 1;
      continue;
    }
    kept.push(line);
    used += line.length + 1;
  }
  if (omitted > 0) {
    kept.push(`[${omitted} item(s) omitted — narrow the query for more]`);
    warnings.push("context_bounded");
  }
  return {
    text: kept.join("\n") + (instructions ? `\n\nRemember instructions: ${instructions}` : ""),
    items: kept.length - (omitted > 0 ? 1 : 0),
    omitted,
    warnings: Array.from(new Set(warnings)),
  };
}
