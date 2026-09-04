import type { Insight, Run, Span } from '@runray/schema';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { isTypingTarget } from '../App';
import {
  formatDateTime,
  formatDuration,
  formatTokens,
  formatUSD,
} from '../lib/format';
import { KIND_BG } from '../lib/span-kind';
import { tourAttr } from '../lib/tour-attr';
import {
  collapsedAncestorsOf,
  computeTimeRange,
  flattenVisible,
  insightsBySpan,
  matchingSpanIds,
  type SubtreeRollup,
  spanEndMs,
  spanStartMs,
  subagentSpanIds,
  subtreeRollups,
  type WaterfallRow,
} from '../lib/waterfall';
import { useAppStore } from '../store';
import { SpendSpine } from './SpendSpine';

/**
 * Timeline waterfall (03-design.md §4.2): virtualized 28px rows, indent
 * 16px per depth, bars positioned purely from startedAt/durationMs on the
 * run's shared time scale. Square bars — data, not buttons.
 */

const ROW_PX = 32;
const INDENT_PX = 16;
/** Label flips to the left of the bar when it starts past this point. */
const LABEL_FLIP_PCT = 55;
/** How long the evidence rows stay lit after an insight lands the view. */
const FLASH_MS = 5000;

/**
 * Finding marker tints by worst severity (A). Never the only signal: the
 * row's accessible name and the tooltip carry the findings in words.
 */
const FINDING_NOTCH: Record<Insight['severity'], string> = {
  info: 'bg-outline',
  warning: 'bg-heat-2',
  critical: 'bg-heat-3',
};
const FINDING_CHIP: Record<Insight['severity'], string> = {
  info: 'bg-surface-2 text-text-dim hover:bg-surface-variant hover:text-text',
  warning: 'bg-heat-2/15 text-heat-2 hover:bg-heat-2/30',
  critical: 'bg-heat-3/15 text-heat-3 hover:bg-heat-3/30',
};
const FINDING_TEXT: Record<Insight['severity'], string> = {
  info: 'text-text-dim',
  warning: 'text-heat-2',
  critical: 'text-heat-3',
};

interface TooltipState {
  row: WaterfallRow;
  /** Findings the row is evidence of, worst first (undefined = none). */
  findings: Insight[] | undefined;
  x: number;
  y: number;
}

export function Waterfall({ run }: { run: Run }) {
  const collapsed = useAppStore((s) => s.ui.collapsed);
  const selectedId = useAppStore((s) => s.selection.spanId);
  const insightId = useAppStore((s) => s.selection.insightId);
  const highlighted = useAppStore((s) => s.ui.highlighted);
  const selectSpan = useAppStore((s) => s.selectSpan);
  const showInsight = useAppStore((s) => s.showInsight);
  const toggleCollapsed = useAppStore((s) => s.toggleCollapsed);
  const setCollapsed = useAppStore((s) => s.setCollapsed);

  const [query, setQuery] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);
  const visibleIds = useMemo(
    () => matchingSpanIds(run.spans, query),
    [run.spans, query],
  );
  const rows = useMemo(
    () => flattenVisible(run, collapsed, visibleIds ?? undefined),
    [run, collapsed, visibleIds],
  );
  const range = useMemo(() => computeTimeRange(run.spans), [run.spans]);
  const subagents = useMemo(() => subagentSpanIds(run.spans), [run.spans]);
  // subtree economics badges for container rows (D3) — a collapsed
  // subagent is no longer economically opaque
  const rollups = useMemo(() => subtreeRollups(run.spans), [run.spans]);
  // Which rows are evidence of a finding — the persistent marker (A), as
  // opposed to `highlighted`, which is only the ACTIVE finding's evidence.
  const findingsBySpan = useMemo(
    () => insightsBySpan(run.insights),
    [run.insights],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PX,
    overscan: 16,
  });

  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  // First-paint bar animation only: flag drops after the stagger window.
  const [animate, setAnimate] = useState(true);
  useEffect(() => {
    setAnimate(true);
    const t = window.setTimeout(() => setAnimate(false), 450);
    return () => window.clearTimeout(t);
  }, []);

  // Cross-view navigation (treemap cell, insight evidence) and j/k walking
  // both land here — keep the selection in view ('auto' = scroll only when
  // needed, so j/k doesn't re-center every step).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-scroll only on selection change; rows/virtualizer identity churn must not re-trigger
  useEffect(() => {
    if (selectedId === null) return;
    const index = rows.findIndex((r) => r.span.id === selectedId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' });
  }, [selectedId]);

  // An insight landing here — the dashboard's "Open in timeline" deep link
  // or a strip pill — must answer "where?" at once: reveal the evidence
  // (drop the `/` filter, expand any collapsed ancestor), owe a scroll to
  // its first span, and light the evidence rows for FLASH_MS so the eye
  // finds them before they settle into the resting wash.
  const scrollOwed = useRef(false);
  const [flashing, setFlashing] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: react to activation only — rows/collapsed/highlighted churn must not re-trigger the reveal
  useEffect(() => {
    if (insightId === null) return;
    setQuery('');
    const hidden = collapsedAncestorsOf(run.spans, highlighted, collapsed);
    if (hidden.size > 0) {
      const next = new Set(collapsed);
      for (const id of hidden) next.delete(id);
      setCollapsed(next);
    }
    scrollOwed.current = true;
    setFlashing(true);
    const t = window.setTimeout(() => setFlashing(false), FLASH_MS);
    return () => window.clearTimeout(t);
  }, [insightId]);

  // The owed scroll runs once the rows actually contain an evidence span:
  // immediately when nothing hid it, on the next render after the reveal
  // above. Deferred a frame so the virtualizer has measured a freshly
  // mounted scroll element (cross-run navigation mounts and scrolls in
  // the same commit).
  useEffect(() => {
    if (!scrollOwed.current) return;
    // A finding opened from a row (chip, Inspector switch) keeps that row
    // as the anchor and scrolls only if it left the view; a deep link has
    // no anchor and centers the first evidence span.
    const anchored = selectedId !== null && highlighted.has(selectedId);
    const index = rows.findIndex((r) =>
      anchored ? r.span.id === selectedId : highlighted.has(r.span.id),
    );
    if (index < 0) return;
    const frame = requestAnimationFrame(() => {
      scrollOwed.current = false;
      virtualizer.scrollToIndex(index, { align: anchored ? 'auto' : 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [rows, highlighted, selectedId, virtualizer]);

  // Row keys (03-design.md §3): j/k walk spans, ←/→ collapse/expand the
  // selected subtree, `/` jumps to the filter. Text fields keep their keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === '/') {
        e.preventDefault();
        filterRef.current?.focus();
        return;
      }
      const state = useAppStore.getState();
      const currentId = state.selection.spanId;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        const at = rows.findIndex((r) => r.span.id === currentId);
        const next =
          e.key === 'j'
            ? Math.min(at + 1, rows.length - 1)
            : Math.max(at - 1, 0);
        const row = rows[next];
        if (row !== undefined) state.selectSpan(row.span.id);
        return;
      }
      if (
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
        currentId !== null
      ) {
        const row = rows.find((r) => r.span.id === currentId);
        if (row === undefined || !row.hasChildren) return;
        e.preventDefault();
        const wantCollapsed = e.key === 'ArrowLeft';
        if (row.collapsed !== wantCollapsed) state.toggleCollapsed(currentId);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [rows]);

  const allSubagentsCollapsed =
    subagents.length > 0 && subagents.every((id) => collapsed.has(id));

  // Compute visible spans in the viewport for the spine marker & viewport band.
  const scrollOffset = virtualizer.scrollOffset ?? 0;
  const viewportHeight = scrollRef.current?.clientHeight ?? 0;
  const virtualItems = virtualizer.getVirtualItems();

  const visibleItems = virtualItems.filter(
    (item) =>
      item.end > scrollOffset &&
      (viewportHeight === 0 || item.start < scrollOffset + viewportHeight),
  );

  const topItem = visibleItems[0] ?? virtualItems[0];
  const firstVisible = topItem !== undefined ? rows[topItem.index] : undefined;
  const nextVisible =
    topItem !== undefined ? rows[topItem.index + 1] : undefined;

  let timeAtTop =
    firstVisible !== undefined ? spanStartMs(firstVisible.span) : range.start;
  if (firstVisible !== undefined && topItem !== undefined) {
    const itemScrollOffset = Math.max(0, scrollOffset - topItem.start);
    const rowProgress =
      topItem.size > 0 ? Math.min(1, itemScrollOffset / topItem.size) : 0;
    const t0 = spanStartMs(firstVisible.span);
    const t1 =
      nextVisible !== undefined
        ? spanStartMs(nextVisible.span)
        : spanEndMs(firstVisible.span);
    if (t1 >= t0) {
      timeAtTop = t0 + rowProgress * (t1 - t0);
    }
  }

  const totalTime = Math.max(1, range.end - range.start);
  const positionFraction = Math.max(
    0,
    Math.min(1, (timeAtTop - range.start) / totalTime),
  );

  let minVisibleMs = range.end;
  let maxVisibleMs = range.start;
  for (const item of visibleItems) {
    const row = rows[item.index];
    if (row !== undefined) {
      const s0 = spanStartMs(row.span);
      const s1 = spanEndMs(row.span);
      if (s0 < minVisibleMs) minVisibleMs = s0;
      if (s1 > maxVisibleMs) maxVisibleMs = s1;
    }
  }

  const viewportFraction = {
    f0:
      minVisibleMs <= maxVisibleMs
        ? Math.max(0, Math.min(1, (minVisibleMs - range.start) / totalTime))
        : positionFraction,
    f1:
      minVisibleMs <= maxVisibleMs
        ? Math.max(0, Math.min(1, (maxVisibleMs - range.start) / totalTime))
        : positionFraction,
  };

  // Spine click → the visible row whose start or duration is nearest that moment.
  const scrollToTime = (timeMs: number) => {
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    rows.forEach((row, i) => {
      const start = spanStartMs(row.span);
      const end = spanEndMs(row.span);
      const dist =
        timeMs >= start && timeMs <= end
          ? 0
          : Math.min(Math.abs(start - timeMs), Math.abs(end - timeMs));
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    virtualizer.scrollToIndex(best, { align: 'start' });
  };

  return (
    <div
      {...tourAttr('waterfall')}
      className="flex h-full min-h-0 flex-col gap-2"
    >
      <div className="flex shrink-0 items-center justify-between gap-3">
        <p className="shrink-0 font-mono text-label text-text-faint">
          {formatTokens(rows.length)} of {formatTokens(run.spans.length)} spans
          · {formatDuration(range.end - range.start)}
        </p>
        <input
          ref={filterRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setQuery('');
              e.currentTarget.blur();
            }
          }}
          placeholder="filter spans · /"
          aria-label="Filter spans by name"
          className="h-6 w-44 min-w-0 rounded border border-border-slate bg-surface px-2 text-label text-on-surface placeholder:text-outline transition-colors duration-150 ease-out hover:bg-surface-variant focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
        />
        <div className="flex shrink-0 gap-1.5">
          {subagents.length > 0 && (
            <ToolbarButton
              onClick={() =>
                setCollapsed(
                  allSubagentsCollapsed ? new Set() : new Set(subagents),
                )
              }
            >
              {allSubagentsCollapsed
                ? 'Expand subagents'
                : 'Collapse subagents'}
            </ToolbarButton>
          )}
          {collapsed.size > 0 && (
            <ToolbarButton onClick={() => setCollapsed(new Set())}>
              Expand all
            </ToolbarButton>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-1">
        <SpendSpine
          run={run}
          range={range}
          positionFraction={positionFraction}
          viewportFraction={viewportFraction}
          onNavigate={scrollToTime}
        />
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto rounded border border-border-slate bg-surface-container-low"
        >
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (row === undefined) return null;
              return (
                <SpanRow
                  key={row.span.id}
                  row={row}
                  rollup={
                    row.span.kind === 'subagent' || row.span.kind === 'session'
                      ? rollups.get(row.span.id)
                      : undefined
                  }
                  range={range}
                  selected={row.span.id === selectedId}
                  highlighted={highlighted.has(row.span.id)}
                  flash={flashing && highlighted.has(row.span.id)}
                  findings={findingsBySpan.get(row.span.id)}
                  onOpenFinding={(insight) => showInsight(insight, row.span.id)}
                  animate={animate}
                  animationDelayMs={Math.min(item.index * 8, 300)}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: item.size,
                    transform: `translateY(${item.start}px)`,
                  }}
                  onSelect={() => selectSpan(row.span.id)}
                  onToggle={() => toggleCollapsed(row.span.id)}
                  onHover={(state) => setTooltip(state)}
                />
              );
            })}
          </div>
        </div>
      </div>

      {tooltip !== null && <SpanTooltip tooltip={tooltip} />}
    </div>
  );
}

function ToolbarButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border border-border-slate bg-surface px-2.5 py-1 text-label text-on-surface-variant transition-colors duration-150 ease-out hover:bg-surface-variant hover:text-on-surface active:bg-bg-deep-gray"
    >
      {children}
    </button>
  );
}

function SpanRow({
  row,
  rollup,
  range,
  selected,
  highlighted,
  flash,
  findings,
  onOpenFinding,
  animate,
  animationDelayMs,
  style,
  onSelect,
  onToggle,
  onHover,
}: {
  row: WaterfallRow;
  /** Subtree economics for container rows (subagent, session). */
  rollup?: SubtreeRollup;
  range: { start: number; end: number };
  selected: boolean;
  /** Evidence of the active insight — amber wash under everything else. */
  highlighted: boolean;
  /** Just landed on this evidence: a saturated wash that settles (FLASH_MS). */
  flash: boolean;
  /** Findings this span is evidence of, worst first (undefined = none). */
  findings: Insight[] | undefined;
  /** The marker chip: open a finding with this row as the anchor. */
  onOpenFinding: (insight: Insight) => void;
  animate: boolean;
  animationDelayMs: number;
  style: CSSProperties;
  onSelect: () => void;
  onToggle: () => void;
  onHover: (state: TooltipState | null) => void;
}) {
  const { span } = row;
  const worst = findings?.[0];
  const indent = span.depth * INDENT_PX;
  const total = range.end - range.start;
  const leftPct = ((spanStartMs(span) - range.start) / total) * 100;
  const widthPct =
    span.durationMs !== undefined ? (span.durationMs / total) * 100 : 0;
  const isError = span.status === 'error';
  const labelOnLeft = leftPct > LABEL_FLIP_PCT;

  const label = (
    <>
      <span className={isError ? 'text-span-error' : 'text-text'}>
        {span.name}
      </span>
      {span.durationMs !== undefined && (
        <span className="font-mono text-text-dim">
          {' '}
          {formatDuration(span.durationMs)}
        </span>
      )}
      <CostBadge span={span} />
      {worst !== undefined && findings !== undefined && (
        // finding chip (A): worst severity tint, a count when the span sits
        // under several findings; click opens the finding anchored here (B).
        // Keyboard users reach the same finding through the Inspector switch.
        <button
          type="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onOpenFinding(worst);
          }}
          className={`ml-1.5 inline-block rounded-control px-1 py-px align-middle font-mono text-[10px] leading-[14px] transition-colors duration-150 ease-out active:bg-bg-deep-gray ${FINDING_CHIP[worst.severity]}`}
        >
          ⚠{findings.length > 1 ? ` ${findings.length}` : ''}
        </button>
      )}
      {rollup !== undefined && rollup.llmCalls > 0 && (
        // always visible, collapsed or not (D3); unpriced calls surface
        // separately so the dollar figure stays honest
        <span className="font-mono text-label text-text-faint">
          {' '}
          Σ {formatUSD(rollup.costUSD)} · {formatTokens(rollup.tokens)} tok ·{' '}
          {rollup.llmCalls} calls
          {rollup.unpricedCalls > 0 && ` · +${rollup.unpricedCalls} unpriced`}
        </span>
      )}
      {row.collapsed && (
        <span className="font-mono text-text-faint">
          {' '}
          +{row.hiddenDescendants}
        </span>
      )}
    </>
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: virtualized row needs a positioned div; button semantics are provided via role/tabIndex
    <div
      role="button"
      tabIndex={0}
      aria-label={`${span.kind} ${span.name}${
        findings === undefined
          ? ''
          : `, evidence of ${findings.length} ${
              findings.length === 1 ? 'finding' : 'findings'
            }: ${findings.map((f) => f.title).join('; ')}`
      }`}
      style={style}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      onMouseMove={(e) =>
        onHover({ row, findings, x: e.clientX, y: e.clientY })
      }
      onMouseLeave={() => onHover(null)}
      className={`group cursor-pointer border-b border-outline-variant/30 transition-colors duration-150 ease-out ${
        selected
          ? 'bg-surface-variant'
          : highlighted
            ? 'bg-heat-2/10 hover:bg-surface-variant/40 active:bg-bg-deep-gray'
            : 'hover:bg-surface-variant/40 active:bg-bg-deep-gray'
      }`}
    >
      {/* arrival flash: under the bar and label, opacity-only settle into
          the resting wash; a static wash for FLASH_MS under reduced motion */}
      {flash && (
        <span
          className="pointer-events-none absolute inset-0 bg-heat-2/35 motion-safe:animate-[evidence-flash_var(--ease-out)_both]"
          style={{ animationDuration: `${FLASH_MS}ms` }}
          aria-hidden
        />
      )}
      {/* finding notch (A): this row is evidence of a finding; the full
          rails (active evidence, selection) take over when present */}
      {worst !== undefined && !highlighted && !selected && (
        <span
          className={`absolute left-0 top-1/2 h-2.5 w-1 -translate-y-1/2 ${FINDING_NOTCH[worst.severity]}`}
          aria-hidden
        />
      )}
      {/* evidence rail (active insight) */}
      {highlighted && !selected && (
        <span
          className="absolute inset-y-0 left-0 w-0.5 bg-heat-2"
          aria-hidden
        />
      )}
      {/* selection rail */}
      {selected && (
        <span
          className="absolute inset-y-0 left-0 w-0.5 bg-brand"
          aria-hidden
        />
      )}

      {/* concurrency bracket (thin line grouping overlapping siblings) */}
      {row.lane !== null && (
        <span
          aria-hidden
          className={`absolute w-px bg-text-faint ${
            row.lane === 'start'
              ? 'top-1/2 bottom-0'
              : row.lane === 'end'
                ? 'top-0 bottom-1/2'
                : 'inset-y-0'
          }`}
          style={{ left: indent + 2 }}
        />
      )}

      {/* collapse caret */}
      {row.hasChildren && (
        <button
          type="button"
          aria-expanded={!row.collapsed}
          aria-label={row.collapsed ? 'Expand subtree' : 'Collapse subtree'}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="absolute top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center text-text-faint transition-colors duration-150 ease-out hover:text-text active:text-brand"
          style={{ left: indent + 2 }}
        >
          <span
            aria-hidden
            className={`inline-block transition-transform duration-150 ease-out ${
              row.collapsed ? '' : 'rotate-90'
            }`}
          >
            ▸
          </span>
        </button>
      )}

      {/* the bar: position = time, color = kind, square corners = data */}
      <span
        aria-hidden
        className={`absolute top-1/2 h-3.5 -translate-y-1/2 ${KIND_BG[span.kind]} ${
          isError ? 'border-l-2 border-span-error' : ''
        }`}
        style={{
          left: `${leftPct}%`,
          width: `max(${widthPct}%, 2px)`,
          transformOrigin: 'left center',
          ...(animate && {
            animation: `bar-in 150ms ${animationDelayMs}ms cubic-bezier(0,0,0.2,1) backwards`,
          }),
        }}
      >
        {isError && (
          <span className="absolute -top-0.5 left-0.5 text-[10px] leading-none text-span-error">
            ✕
          </span>
        )}
      </span>

      {/* label: name · duration · cost — flips sides near the right edge */}
      <span
        aria-hidden
        className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-label"
        style={
          labelOnLeft
            ? { right: `calc(${100 - leftPct}% + 6px)` }
            : {
                left: `calc(${Math.min(leftPct + widthPct, 100)}% + 6px)`,
              }
        }
      >
        {label}
      </span>
    </div>
  );
}

function CostBadge({ span }: { span: Span }) {
  const cost = span.llm?.costUSD;
  if (cost === undefined || span.llm?.costSource === 'unknown') return null;
  return (
    <span
      className={`font-mono ${cost < 0.01 ? 'text-text-faint' : 'text-text-dim'}`}
    >
      {' '}
      {formatUSD(cost)}
    </span>
  );
}

function SpanTooltip({ tooltip }: { tooltip: TooltipState }) {
  const { span } = tooltip.row;
  const { findings } = tooltip;
  const x = Math.min(tooltip.x + 12, window.innerWidth - 300);
  const y = Math.min(tooltip.y + 14, window.innerHeight - 180);
  return (
    <div
      className="pointer-events-none fixed z-50 w-72 rounded-panel border border-border bg-surface-2 p-3 shadow-popover"
      style={{ left: x, top: y }}
    >
      <p className="truncate text-body font-medium text-text">{span.name}</p>
      <p className="mt-0.5 text-label text-text-dim">
        {span.kind}
        {' · '}
        <span
          className={span.status === 'error' ? 'text-span-error' : undefined}
        >
          {span.status}
        </span>
        {span.llm !== undefined && <> · {span.llm.model}</>}
      </p>
      {findings !== undefined && (
        // the marker in words (A): which findings this row is evidence of
        <ul className="mt-2 space-y-0.5 border-t border-border pt-2 text-label">
          {findings.slice(0, 3).map((f) => (
            <li key={f.id} className="flex items-baseline gap-1.5">
              <span
                aria-hidden
                className={`shrink-0 ${FINDING_TEXT[f.severity]}`}
              >
                ⚠
              </span>
              <span className="min-w-0 truncate text-text">{f.title}</span>
              {f.estimatedWasteUSD !== undefined && (
                <span className="ml-auto shrink-0 font-mono text-heat-2">
                  {formatUSD(f.estimatedWasteUSD)}
                </span>
              )}
            </li>
          ))}
          {findings.length > 3 && (
            <li className="text-text-faint">+{findings.length - 3} more</li>
          )}
        </ul>
      )}
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-label">
        <dt className="text-text-faint">started</dt>
        <dd className="text-right font-mono text-text-dim">
          {formatDateTime(span.startedAt)}
        </dd>
        <dt className="text-text-faint">duration</dt>
        <dd className="text-right font-mono text-text-dim">
          {span.durationMs !== undefined
            ? formatDuration(span.durationMs)
            : '—'}
        </dd>
        {span.llm !== undefined && (
          <>
            <dt className="text-text-faint">tokens in / out</dt>
            <dd className="text-right font-mono text-text-dim">
              {formatTokens(span.llm.tokens.input)} /{' '}
              {formatTokens(span.llm.tokens.output)}
            </dd>
            <dt className="text-text-faint">cache r / w</dt>
            <dd className="text-right font-mono text-text-dim">
              {formatTokens(span.llm.tokens.cacheRead)} /{' '}
              {formatTokens(span.llm.tokens.cacheWrite)}
            </dd>
            {span.llm.costUSD !== undefined && (
              <>
                <dt className="text-text-faint">
                  cost ({span.llm.costSource})
                </dt>
                <dd className="text-right font-mono text-text">
                  {formatUSD(span.llm.costUSD)}
                </dd>
              </>
            )}
          </>
        )}
        {span.tool?.isError === true && (
          <>
            <dt className="text-text-faint">tool</dt>
            <dd className="text-right font-mono text-span-error">error</dd>
          </>
        )}
      </dl>
    </div>
  );
}
