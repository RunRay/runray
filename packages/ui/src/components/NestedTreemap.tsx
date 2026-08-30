import type { Run } from '@runray/schema';
import { useMemo, useState } from 'react';
import {
  type AgentTreeNode,
  agentSubtreeTree,
  heatForShare,
  type SubtreeMapMode,
  treemapLayout,
} from '../lib/cost-breakdown';
import { formatTokens, formatUSD } from '../lib/format';
import { useAppStore } from '../store';

/**
 * Hierarchical agent-subtree map (D3): delegated subagents nest INSIDE
 * their delegating subagent — nested delegation is visible instead of
 * flattened to innermost-only. Node own-values follow the core attribution
 * cells (pinned by test), so this map can never disagree with the what-if
 * panel. Cost and token modes; cells too small to recurse render a flat
 * "+n nested" instead; every cell clicks through to the timeline.
 */

const HEAT_TEXT = [
  'text-text-dim',
  'text-heat-1',
  'text-heat-2',
  'text-heat-3',
];
const HEAT_CELL = [
  'bg-surface-container-high border-border-slate',
  'bg-heat-1/15 border-heat-1/40',
  'bg-heat-2/15 border-heat-2/40',
  'bg-heat-3/15 border-heat-3/40',
];

/** Percent-of-panel area below which nesting stops rendering. */
const RECURSE_FLOOR = 6;

function descendants(node: AgentTreeNode): number {
  return node.children.reduce((n, c) => n + 1 + descendants(c), 0);
}

export function NestedTreemap({ run }: { run: Run }) {
  const [mode, setMode] = useState<SubtreeMapMode>('cost');
  const tree = useMemo(
    () => agentSubtreeTree(run.spans, mode),
    [run.spans, mode],
  );
  const format = mode === 'cost' ? formatUSD : formatTokens;

  if (tree.total <= 0) {
    return (
      <p className="py-6 text-center text-label text-text-faint">
        No {mode === 'cost' ? 'priced' : ''} llm calls in this run.
      </p>
    );
  }

  // top level: main-session own value + top-level subagents side by side
  const topItems = cellItems(tree);
  const maxValue = Math.max(...topItems.map((i) => i.value), 1);

  return (
    <div>
      <fieldset className="mb-2 flex gap-1" aria-label="Subtree map value mode">
        {(['cost', 'tokens'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            className={`rounded-control border px-2 py-0.5 text-label transition-colors duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass ${
              mode === m
                ? 'border-border-slate bg-surface-variant text-text'
                : 'border-border-slate bg-surface text-text-dim hover:bg-surface-variant/40 hover:text-text active:bg-bg-deep-gray'
            }`}
          >
            {m}
          </button>
        ))}
      </fieldset>
      <div className="relative h-56 w-full overflow-hidden">
        <CellLayer
          items={topItems}
          runId={run.id}
          maxValue={maxValue}
          areaPct={100}
          format={format}
        />
      </div>
    </div>
  );
}

interface CellItem {
  node: AgentTreeNode | null; // null = the parent's own-value filler
  name: string;
  rootId: string | null;
  value: number;
}

/** A node's layout items: its own value as a filler leaf + its children. */
function cellItems(node: AgentTreeNode): CellItem[] {
  const items: CellItem[] = node.children.map((child) => ({
    node: child,
    name: child.name,
    rootId: child.rootId,
    value: child.total,
  }));
  if (node.own > 0) {
    items.push({
      node: null,
      name: node.name,
      rootId: node.rootId,
      value: node.own,
    });
  }
  return items.sort((a, b) => b.value - a.value);
}

function CellLayer({
  items,
  runId,
  maxValue,
  areaPct,
  format,
}: {
  items: CellItem[];
  runId: string;
  maxValue: number;
  /** Approximate share of the whole panel this layer covers. */
  areaPct: number;
  format: (v: number) => string;
}) {
  const layout = treemapLayout(items, (i) => i.value, 100, 100);
  const total = items.reduce((s, i) => s + i.value, 0);
  return (
    <>
      {layout.map(({ item, x, y, w, h }) => {
        const heat = heatForShare(item.value, maxValue);
        const cellArea = total > 0 ? areaPct * (item.value / total) : 0;
        const nested = item.node !== null && item.node.children.length > 0;
        const canRecurse = nested && cellArea >= RECURSE_FLOOR && h > 22;
        const open = () => {
          if (item.rootId !== null) {
            useAppStore.getState().selectSpan(item.rootId);
          }
          useAppStore.getState().navigateTo({ view: 'timeline', runId });
        };
        const label = `${item.name} — ${format(item.value)}`;

        if (canRecurse && item.node !== null) {
          return (
            <div
              key={item.rootId ?? '·own'}
              className={`absolute flex flex-col overflow-hidden border ${HEAT_CELL[heat]}`}
              style={{
                left: `${x}%`,
                top: `${y}%`,
                width: `${w}%`,
                height: `${h}%`,
              }}
            >
              <button
                type="button"
                onClick={open}
                title={`${label}. Open in timeline.`}
                className="flex shrink-0 items-baseline gap-2 px-1 py-0.5 text-left transition-colors duration-150 ease-out hover:brightness-125 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brass active:brightness-90"
              >
                <span className="truncate text-label text-text">
                  {item.name}
                </span>
                <span
                  className={`shrink-0 font-mono text-label ${HEAT_TEXT[heat]}`}
                >
                  {format(item.node.total)}
                </span>
              </button>
              <div className="relative min-h-0 flex-1">
                <CellLayer
                  items={cellItems(item.node)}
                  runId={runId}
                  maxValue={maxValue}
                  areaPct={cellArea}
                  format={format}
                />
              </div>
            </div>
          );
        }

        const hiddenNested = item.node !== null ? descendants(item.node) : 0;
        const big = w > 18 && h > 12;
        return (
          <button
            key={item.rootId ?? '·own'}
            type="button"
            onClick={open}
            title={`${label}. Open in timeline.`}
            aria-label={`${label}. Open in timeline.`}
            className={`absolute overflow-hidden border p-1 text-left transition-colors duration-150 ease-out hover:brightness-125 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brass active:brightness-90 ${HEAT_CELL[heat]}`}
            style={{
              left: `${x}%`,
              top: `${y}%`,
              width: `${w}%`,
              height: `${h}%`,
            }}
          >
            {big && (
              <>
                <p className="truncate text-label text-text">{item.name}</p>
                <p className={`font-mono text-label ${HEAT_TEXT[heat]}`}>
                  {format(item.value)}
                  {hiddenNested > 0 && (
                    <span className="ml-1 text-text-faint">
                      +{hiddenNested} nested
                    </span>
                  )}
                </p>
              </>
            )}
          </button>
        );
      })}
    </>
  );
}
