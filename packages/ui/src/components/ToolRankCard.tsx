import type { Run } from '@runray/schema';
import { useMemo } from 'react';
import { formatDuration, formatUSD } from '../lib/format';
import { mcpShare, topTools } from '../lib/overview';
import { tourAttr } from '../lib/tour-attr';
import { useAppStore } from '../store';

/**
 * Cross-run "By tool" ranking (E5): tools and MCP servers by ATTRIBUTED
 * llm cost — the equal-split turn attribution is a heuristic and the hint
 * copy says so; the orchestration remainder is excluded. The MCP-share
 * callout answers "are my MCP servers eating my limit"; rows filter the
 * visible runs (clearable Tool chip in the top bar).
 */
export function ToolRankCard({
  runs,
  activeTool,
}: {
  runs: Run[];
  activeTool: string | null;
}) {
  const tools = useMemo(() => topTools(runs), [runs]);
  // share is computed over the full leaderboard, not the displayed top-N
  const share = useMemo(() => mcpShare(runs), [runs]);
  const setFilter = useAppStore((s) => s.setFilter);
  if (tools.length === 0) return null;
  const maxCost = tools[0]?.costUSD ?? 0;

  return (
    <section
      {...tourAttr('tool-rank')}
      aria-label="Cross-run tool ranking"
      className="rounded border border-border-slate bg-surface-container-low p-4 shadow-card motion-safe:animate-[rise_500ms_var(--ease-out)_both]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-detail font-medium text-text">By tool</h3>
        <p className="micro-label text-text-faint">
          attributed llm cost — equal split per turn, orchestration excluded
        </p>
      </div>
      <ul className="mt-2">
        {tools.map((tool) => {
          const active = activeTool === tool.name;
          return (
            <li key={tool.name}>
              <button
                type="button"
                onClick={() => setFilter({ tool: active ? null : tool.name })}
                aria-pressed={active}
                title={`Filter to sessions using ${tool.name}`}
                className={`grid w-full grid-cols-[minmax(0,1fr)_auto_auto_auto] items-baseline gap-3 rounded px-1 py-1 text-left transition-colors duration-150 ease-out hover:bg-surface-variant active:bg-bg-deep-gray ${
                  active ? 'bg-surface-variant' : ''
                }`}
              >
                <span className="relative min-w-0">
                  <span
                    aria-hidden
                    className="absolute inset-y-0.5 left-0 rounded-sm bg-brass/15"
                    style={{
                      width: `${maxCost > 0 ? (tool.costUSD / maxCost) * 100 : 0}%`,
                    }}
                  />
                  <span className="relative flex min-w-0 items-baseline gap-2 px-1">
                    <span className="truncate font-mono text-label text-text">
                      {tool.name}
                    </span>
                    {tool.mcpServer !== undefined && (
                      <span className="micro-label shrink-0 rounded-control bg-surface-2 px-1.5 py-px text-text-dim">
                        mcp:{tool.mcpServer}
                      </span>
                    )}
                  </span>
                </span>
                <span className="whitespace-nowrap font-mono text-label text-text-dim">
                  {tool.calls}×
                </span>
                <span className="whitespace-nowrap font-mono text-label text-text-faint">
                  p95 {formatDuration(tool.p95Ms)}
                </span>
                <span className="whitespace-nowrap font-mono text-label text-text">
                  {formatUSD(tool.costUSD)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {share.costUSD > 0 && (
        <p className="mt-2 border-t border-border-slate pt-2 text-label text-text-dim">
          MCP servers:{' '}
          <span className="font-mono text-text">
            {formatUSD(share.costUSD)}
          </span>{' '}
          · {(share.share * 100).toFixed(0)}% of attributed spend
          {share.topServer !== null && (
            <>
              {' '}
              — top: <span className="font-mono">{share.topServer}</span>
            </>
          )}
        </p>
      )}
    </section>
  );
}
