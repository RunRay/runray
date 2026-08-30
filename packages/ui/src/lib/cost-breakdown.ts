/**
 * Cost Breakdown data (03-design.md §4.3), pure and testable. Cost accrues
 * at each priced llm span's end (same convention as the Spend Spine);
 * `costSource: unknown` spans are excluded, matching the core rollups.
 */

import type { Span } from '@runray/schema';
import type { TimeRange } from './waterfall';
import { spanEndMs } from './waterfall';

export interface CostBucket {
  /** Time fractions of the run (0..1). */
  f0: number;
  f1: number;
  /** Cost per model in this bucket. */
  byModel: Map<string, number>;
  total: number;
}

function pricedCost(span: Span): number | undefined {
  const cost = span.llm?.costUSD;
  if (cost === undefined || span.llm?.costSource === 'unknown') {
    return undefined;
  }
  return cost;
}

/** Bucket llm cost over the session timeline, keyed by model. */
export function bucketCostByModel(
  spans: readonly Span[],
  range: TimeRange,
  bucketCount = 48,
): CostBucket[] {
  const buckets: CostBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    f0: i / bucketCount,
    f1: (i + 1) / bucketCount,
    byModel: new Map(),
    total: 0,
  }));
  const duration = range.end - range.start;
  for (const span of spans) {
    const cost = pricedCost(span);
    const model = span.llm?.model;
    if (cost === undefined || model === undefined) continue;
    const f = (spanEndMs(span) - range.start) / duration;
    const index = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor(f * bucketCount)),
    );
    const bucket = buckets[index];
    if (bucket === undefined) continue;
    bucket.byModel.set(model, (bucket.byModel.get(model) ?? 0) + cost);
    bucket.total += cost;
  }
  return buckets;
}

export interface SubtreeCost {
  /** Root span of the subtree ('' = the main session outside any subagent). */
  rootId: string;
  name: string;
  cost: number;
}

/**
 * Treemap input: llm cost attributed to the INNERMOST enclosing subagent
 * subtree; everything outside any subagent lands in "main session".
 */
export function agentSubtreeCosts(spans: readonly Span[]): SubtreeCost[] {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const owned = new Map<string, number>();
  let main = 0;

  for (const span of spans) {
    const cost = pricedCost(span);
    if (cost === undefined) continue;
    let owner: Span | undefined;
    let cursor = span.parentId === null ? undefined : byId.get(span.parentId);
    while (cursor !== undefined) {
      if (cursor.kind === 'subagent') {
        owner = cursor;
        break;
      }
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
    if (owner === undefined) main += cost;
    else owned.set(owner.id, (owned.get(owner.id) ?? 0) + cost);
  }

  const cells: SubtreeCost[] = [];
  if (main > 0) cells.push({ rootId: '', name: 'main session', cost: main });
  for (const [rootId, cost] of owned) {
    cells.push({ rootId, name: byId.get(rootId)?.name ?? rootId, cost });
  }
  cells.sort((a, b) => b.cost - a.cost || (a.rootId < b.rootId ? -1 : 1));
  return cells;
}

export interface TreemapCell<T> {
  item: T;
  /** Percent coordinates within the treemap container. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Squarified treemap over a width×height box (any unit; percentages here).
 * Items must be sorted descending by value; zero/negative values dropped.
 */
export function treemapLayout<T>(
  items: readonly T[],
  value: (item: T) => number,
  width: number,
  height: number,
): TreemapCell<T>[] {
  const positive = items.filter((i) => value(i) > 0);
  const total = positive.reduce((sum, i) => sum + value(i), 0);
  if (total === 0) return [];
  const scale = (width * height) / total;
  const areas = positive.map((item) => ({ item, area: value(item) * scale }));

  const cells: TreemapCell<T>[] = [];
  let x = 0;
  let y = 0;
  let w = width;
  let h = height;
  let row: { item: T; area: number }[] = [];

  const worst = (rowArr: { area: number }[], side: number): number => {
    const sum = rowArr.reduce((s, r) => s + r.area, 0);
    const max = Math.max(...rowArr.map((r) => r.area));
    const min = Math.min(...rowArr.map((r) => r.area));
    const sideSq = side * side;
    const sumSq = sum * sum;
    return Math.max((sideSq * max) / sumSq, sumSq / (sideSq * min));
  };

  const layoutRow = (rowArr: { item: T; area: number }[]) => {
    const sum = rowArr.reduce((s, r) => s + r.area, 0);
    const horizontal = w < h; // lay the row along the shorter side
    const thickness = sum / (horizontal ? w : h);
    let offset = 0;
    for (const r of rowArr) {
      const length = r.area / thickness;
      cells.push(
        horizontal
          ? { item: r.item, x: x + offset, y, w: length, h: thickness }
          : { item: r.item, x, y: y + offset, w: thickness, h: length },
      );
      offset += length;
    }
    if (horizontal) {
      y += thickness;
      h -= thickness;
    } else {
      x += thickness;
      w -= thickness;
    }
  };

  for (const entry of areas) {
    const side = Math.min(w, h);
    if (row.length > 0 && worst([...row, entry], side) > worst(row, side)) {
      layoutRow(row);
      row = [];
    }
    row.push(entry);
  }
  if (row.length > 0) layoutRow(row);
  return cells;
}

/** Heat bucket relative to the most expensive cell (thirds of max). */
export function heatForShare(cost: number, maxCost: number): 0 | 1 | 2 | 3 {
  if (cost <= 0 || maxCost <= 0) return 0;
  const rel = cost / maxCost;
  return rel > 2 / 3 ? 3 : rel > 1 / 3 ? 2 : 1;
}

export interface ToolCost {
  name: string;
  costUSD: number;
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  calls: number;
  /** MCP server the tool belongs to (E5); absent for built-in tools. */
  mcpServer?: string;
  /** The un-attributed remainder pseudo-row — aggregators exclude it. */
  orchestration?: true;
}

/**
 * Aggregates LLM cost and tokens by tool name based on span ancestry and associations.
 */
export function toolSpendLeaderboard(spans: readonly Span[]): ToolCost[] {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const llmCalls = spans.filter((s) => s.kind === 'llm_call');
  const toolCalls = spans.filter(
    (s) => s.kind === 'tool_call' || s.kind === 'mcp_call',
  );

  // Map each llm_call ID to the list of tool_call spans associated with it
  const llmToTools = new Map<string, Span[]>();
  for (const llm of llmCalls) {
    llmToTools.set(llm.id, []);
  }

  // To support turn-level association (like in OTLP)
  const turnToLlm = new Map<string, Span[]>();
  for (const llm of llmCalls) {
    if (llm.parentId) {
      const parent = byId.get(llm.parentId);
      if (parent && (parent.kind === 'turn' || parent.kind === 'subagent')) {
        const list = turnToLlm.get(parent.id) ?? [];
        list.push(llm);
        turnToLlm.set(parent.id, list);
      }
    }
  }

  for (const tool of toolCalls) {
    // 1. Direct LLM ancestor check
    let cursor = tool.parentId ? byId.get(tool.parentId) : undefined;
    let foundLlm: Span | undefined;
    while (cursor) {
      if (cursor.kind === 'llm_call') {
        foundLlm = cursor;
        break;
      }
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }

    if (foundLlm) {
      llmToTools.get(foundLlm.id)?.push(tool);
    } else if (tool.parentId) {
      // 2. Turn/subagent sibling check (for formats like OTLP where tool_call and llm_call are siblings under a turn)
      const parent = byId.get(tool.parentId);
      if (parent && (parent.kind === 'turn' || parent.kind === 'subagent')) {
        const siblingLlms = turnToLlm.get(parent.id) ?? [];
        for (const llm of siblingLlms) {
          llmToTools.get(llm.id)?.push(tool);
        }
      }
    }
  }

  // Now, aggregate stats by tool name
  const toolStats = new Map<
    string,
    {
      costUSD: number;
      input: number;
      output: number;
      calls: number;
    }
  >();

  let orchestrationCost = 0;
  let orchestrationInput = 0;
  let orchestrationOutput = 0;
  let orchestrationCalls = 0;

  for (const llm of llmCalls) {
    const cost = llm.llm?.costUSD ?? 0;
    const input = llm.llm?.tokens?.input ?? 0;
    const output = llm.llm?.tokens?.output ?? 0;
    const associatedTools = llmToTools.get(llm.id) ?? [];

    if (associatedTools.length === 0) {
      orchestrationCost += cost;
      orchestrationInput += input;
      orchestrationOutput += output;
      orchestrationCalls += 1;
      continue;
    }

    // Unique tool names in this associated list (in case a tool is called multiple times in one LLM turn)
    const uniqueToolNames = [
      ...new Set(associatedTools.map((t) => t.tool?.name ?? t.name)),
    ];

    // Distribute LLM cost/tokens equally among all unique tools active in this turn
    const distCost = cost / uniqueToolNames.length;
    const distInput = input / uniqueToolNames.length;
    const distOutput = output / uniqueToolNames.length;

    for (const toolName of uniqueToolNames) {
      const stats = toolStats.get(toolName) ?? {
        costUSD: 0,
        input: 0,
        output: 0,
        calls: 0,
      };
      stats.costUSD += distCost;
      stats.input += distInput;
      stats.output += distOutput;
      toolStats.set(toolName, stats);
    }
  }

  // Count the total invocations of each tool name; remember MCP servers
  const serverByName = new Map<string, string>();
  for (const tool of toolCalls) {
    const name = tool.tool?.name ?? tool.name;
    if (tool.kind === 'mcp_call' && tool.tool?.mcpServer !== undefined) {
      serverByName.set(name, tool.tool.mcpServer);
    }
    const stats = toolStats.get(name) ?? {
      costUSD: 0,
      input: 0,
      output: 0,
      calls: 0,
    };
    stats.calls += 1;
    toolStats.set(name, stats);
  }

  const result: ToolCost[] = [];
  for (const [name, stats] of toolStats.entries()) {
    const mcpServer = serverByName.get(name);
    result.push({
      name,
      costUSD: stats.costUSD,
      tokens: {
        input: Math.round(stats.input),
        output: Math.round(stats.output),
        total: Math.round(stats.input + stats.output),
      },
      calls: stats.calls,
      ...(mcpServer === undefined ? {} : { mcpServer }),
    });
  }

  if (
    orchestrationCalls > 0 ||
    orchestrationCost > 0 ||
    orchestrationInput + orchestrationOutput > 0
  ) {
    result.push({
      orchestration: true,
      name: 'Orchestration / Interface',
      costUSD: orchestrationCost,
      tokens: {
        input: Math.round(orchestrationInput),
        output: Math.round(orchestrationOutput),
        total: Math.round(orchestrationInput + orchestrationOutput),
      },
      calls: orchestrationCalls,
    });
  }

  // Sort by cost descending, then total tokens, then name
  result.sort(
    (a, b) =>
      b.costUSD - a.costUSD ||
      b.tokens.total - a.tokens.total ||
      a.name.localeCompare(b.name),
  );
  return result;
}

/**
 * Hierarchical agent tree for the treemap (D3): nodes are the main session
 * plus every subagent, nested by NEAREST subagent ancestor — nested
 * delegation is visible instead of flattened away. Each node's `own` value
 * follows the same innermost-owner attribution as the core repricing cells
 * (test-pinned: Σ own === Σ core cells), so the treemap and the what-if
 * panel can never disagree; `total` = own + Σ children, so a parent cell
 * contains its delegates. Cost mode counts priced llm spans only; token
 * mode counts the full quad of every llm span.
 */
export type SubtreeMapMode = 'cost' | 'tokens';

export interface AgentTreeNode {
  /** Subagent span id; null for the virtual "main session" root. */
  rootId: string | null;
  name: string;
  own: number;
  total: number;
  children: AgentTreeNode[];
}

function spanValue(span: Span, mode: SubtreeMapMode): number | undefined {
  if (mode === 'cost') return pricedCost(span);
  if (span.kind !== 'llm_call' || span.llm === undefined) return undefined;
  const t = span.llm.tokens;
  return t.input + t.output + t.cacheRead + t.cacheWrite + (t.reasoning ?? 0);
}

export function agentSubtreeTree(
  spans: readonly Span[],
  mode: SubtreeMapMode,
): AgentTreeNode {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const ownerOf = (span: Span): string | null => {
    let cursor = span.parentId === null ? undefined : byId.get(span.parentId);
    while (cursor !== undefined) {
      if (cursor.kind === 'subagent') return cursor.id;
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
    return null;
  };

  const nodes = new Map<string | null, AgentTreeNode>();
  const root: AgentTreeNode = {
    rootId: null,
    name: 'main session',
    own: 0,
    total: 0,
    children: [],
  };
  nodes.set(null, root);
  for (const span of spans) {
    if (span.kind !== 'subagent') continue;
    nodes.set(span.id, {
      rootId: span.id,
      name: span.agent?.name ?? span.name,
      own: 0,
      total: 0,
      children: [],
    });
  }

  for (const span of spans) {
    const value = spanValue(span, mode);
    if (value === undefined) continue;
    const node = nodes.get(ownerOf(span));
    if (node !== undefined) node.own += value;
  }

  // wire children (a subagent nests under its nearest subagent ancestor)
  for (const span of spans) {
    if (span.kind !== 'subagent') continue;
    const node = nodes.get(span.id);
    const parent = nodes.get(ownerOf(span)) ?? root;
    if (node !== undefined) parent.children.push(node);
  }

  // totals bottom-up; children ordered by total desc, rootId asc
  const finalize = (node: AgentTreeNode): number => {
    let total = node.own;
    for (const child of node.children) total += finalize(child);
    node.total = total;
    node.children.sort(
      (a, b) =>
        b.total - a.total || ((a.rootId ?? '') < (b.rootId ?? '') ? -1 : 1),
    );
    return total;
  };
  finalize(root);
  return root;
}
