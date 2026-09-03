import type { Insight, Run, Span } from '@runray/schema';
import { type ReactNode, useMemo, useState } from 'react';
import {
  formatDateTime,
  formatDuration,
  formatTokens,
  formatUSD,
} from '../lib/format';
import { KIND_BG } from '../lib/span-kind';
import { insightsBySpan } from '../lib/waterfall';
import { selectActiveRun, useAppStore } from '../store';
import { ContextualHint } from './ContextualHint';
import { ruleLabel } from './SavingsPanel';
import { TranscriptPane } from './TranscriptPane';

/**
 * Inspector (03-design.md §4.4): span header · timing · delegation reason ·
 * token table · cost + costSource badge · previews (8-line clamp, mono;
 * `null` preview = redacted in core, never filtered here) · provenance
 * footer with a Show raw toggle over the normalized span record.
 */
export function Inspector() {
  const spanId = useAppStore((s) => s.selection.spanId);
  const insightId = useAppStore((s) => s.selection.insightId);
  const focus = useAppStore((s) => s.selection.focus);
  const run = useAppStore(selectActiveRun);
  const toggleInspector = useAppStore((s) => s.toggleInspector);
  const showInsight = useAppStore((s) => s.showInsight);
  const focusInspector = useAppStore((s) => s.focusInspector);

  const span = useMemo(
    () => run?.spans.find((s) => s.id === spanId),
    [run, spanId],
  );
  const insight = useMemo(
    () => run?.insights.find((i) => i.id === insightId),
    [run, insightId],
  );
  // Findings this activity is evidence of, worst first: the Activity |
  // Finding switch and its per-finding chips are built from it.
  const spanFindings = useMemo(
    () =>
      span === undefined || run === undefined
        ? []
        : (insightsBySpan(run.insights).get(span.id) ?? []),
    [run, span],
  );
  // The switch flips `focus`; with no span selected the finding shows on
  // its own, with no finding active the activity does.
  const showingFinding =
    insight !== undefined && (span === undefined || focus === 'insight');
  const openFinding = () => {
    if (span === undefined) return;
    if (insight?.spanIds.includes(span.id)) {
      focusInspector('insight');
    } else if (spanFindings[0] !== undefined) {
      showInsight(spanFindings[0], span.id);
    }
  };

  return (
    <aside
      aria-label="Inspector"
      className="flex w-[360px] shrink-0 flex-col border-l border-border bg-surface"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <p className="micro-label text-text-faint">Inspector</p>
        <button
          type="button"
          onClick={toggleInspector}
          aria-label="Close inspector"
          className="flex h-6 w-6 items-center justify-center rounded-control text-text-faint transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text active:bg-bg"
        >
          ✕
        </button>
      </div>
      <div className="p-2 pb-0">
        <ContextualHint hintKey="redact" />
      </div>
      {span !== undefined && spanFindings.length > 0 && (
        <DetailSwitch
          mode={showingFinding ? 'finding' : 'activity'}
          findings={spanFindings}
          onActivity={() => focusInspector('span')}
          onFinding={openFinding}
        />
      )}
      {showingFinding &&
        span !== undefined &&
        insight !== undefined &&
        spanFindings.length > 1 && (
          <FindingChips
            findings={spanFindings}
            activeId={insight.id}
            onPick={(f) => showInsight(f, span.id)}
          />
        )}
      {showingFinding && insight !== undefined && run !== undefined ? (
        <InsightDetail insight={insight} run={run} />
      ) : span !== undefined ? (
        <SpanDetail span={span} />
      ) : run !== undefined ? (
        <RunSummary run={run} />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <p className="text-label text-text-faint">
            Select a span to inspect it.
          </p>
        </div>
      )}
    </aside>
  );
}

/**
 * Activity | Finding switch (B): offered when the selected span is evidence
 * of at least one finding. The finding side carries the worst severity's
 * glyph and a count when the span sits under several findings.
 */
function DetailSwitch({
  mode,
  findings,
  onActivity,
  onFinding,
}: {
  mode: 'activity' | 'finding';
  findings: Insight[];
  onActivity: () => void;
  onFinding: () => void;
}) {
  const worst = findings[0];
  const segment = (active: boolean) =>
    `flex-1 px-3 py-1 text-label transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary ${
      active
        ? 'bg-surface-variant font-semibold text-on-surface'
        : 'bg-surface text-on-surface-variant hover:bg-surface-variant/40 hover:text-on-surface active:bg-bg-deep-gray'
    }`;
  return (
    <div className="px-3 pt-2">
      <div className="flex overflow-hidden rounded border border-border-slate">
        <button
          type="button"
          aria-pressed={mode === 'activity'}
          onClick={onActivity}
          className={segment(mode === 'activity')}
        >
          Activity
        </button>
        <button
          type="button"
          aria-pressed={mode === 'finding'}
          onClick={onFinding}
          className={segment(mode === 'finding')}
        >
          {worst !== undefined && (
            <span aria-hidden className={SEVERITY_TEXT[worst.severity]}>
              ⚠{' '}
            </span>
          )}
          Finding{findings.length > 1 ? ` · ${findings.length}` : ''}
        </button>
      </div>
    </div>
  );
}

/** One chip per finding the selected span is evidence of, worst first. */
function FindingChips({
  findings,
  activeId,
  onPick,
}: {
  findings: Insight[];
  activeId: string;
  onPick: (insight: Insight) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 px-3 pt-2">
      {findings.map((f) => {
        const active = f.id === activeId;
        return (
          <button
            key={f.id}
            type="button"
            aria-pressed={active}
            onClick={() => onPick(f)}
            className={`rounded-control border px-2 py-0.5 text-label transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary active:bg-bg ${
              active
                ? 'border-border-slate bg-surface-2 text-text'
                : 'border-border bg-surface text-text-dim hover:bg-surface-2 hover:text-text'
            }`}
          >
            <span aria-hidden className={SEVERITY_TEXT[f.severity]}>
              ⚠{' '}
            </span>
            {ruleLabel(f.ruleId).label}
            {f.estimatedWasteUSD !== undefined && (
              <span className="ml-1 font-mono text-text-faint">
                {formatUSD(f.estimatedWasteUSD)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Default content: the run at a glance — nothing selected is not nothing. */
function RunSummary({ run }: { run: Run }) {
  const selectSpan = useAppStore((s) => s.selectSpan);
  const expensive = useMemo(
    () =>
      run.spans
        .filter(
          (s) => s.llm?.costUSD !== undefined && s.llm.costSource !== 'unknown',
        )
        .sort((a, b) => (b.llm?.costUSD ?? 0) - (a.llm?.costUSD ?? 0))
        .slice(0, 5),
    [run.spans],
  );
  const { counts, cache } = run.totals;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Section title="Run at a glance">
        <Field label="llm calls">
          <Mono>{formatTokens(counts.llmCalls)}</Mono>
        </Field>
        <Field label="tool calls">
          <Mono>{formatTokens(counts.toolCalls)}</Mono>
        </Field>
        <Field label="tool errors">
          <span
            className={`font-mono ${counts.toolErrors > 0 ? 'text-span-error' : ''}`}
          >
            {formatTokens(counts.toolErrors)}
          </span>
        </Field>
        <Field label="subagents">
          <Mono>{formatTokens(counts.subagents)}</Mono>
        </Field>
        <Field label="cache hit-rate">
          <Mono>{(cache.hitRate * 100).toFixed(1)}%</Mono>
        </Field>
      </Section>
      {expensive.length > 0 && (
        <Section title="Most expensive calls">
          <ul className="space-y-0.5">
            {expensive.map((span) => (
              <li key={span.id}>
                <button
                  type="button"
                  onClick={() => selectSpan(span.id)}
                  className="flex w-full items-baseline justify-between gap-2 rounded-control px-1.5 py-1 text-left text-label transition-colors duration-150 ease-out hover:bg-surface-2 active:bg-bg"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <i
                      aria-hidden
                      className={`inline-block h-2 w-2 shrink-0 ${KIND_BG[span.kind]}`}
                    />
                    <span className="truncate text-text">{span.name}</span>
                  </span>
                  <span className="shrink-0 font-mono text-text-dim">
                    {formatUSD(span.llm?.costUSD ?? 0)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <p className="px-3 py-3 text-label text-text-faint">
        Select a span in the waterfall for full detail.
      </p>
    </div>
  );
}

const SEVERITY_TEXT: Record<Insight['severity'], string> = {
  info: 'text-text-dim',
  warning: 'text-heat-2',
  critical: 'text-heat-3',
};

function InsightDetail({ insight, run }: { insight: Insight; run: Run }) {
  const selectSpan = useAppStore((s) => s.selectSpan);
  const evidence = useMemo(() => {
    const byId = new Map(run.spans.map((s) => [s.id, s]));
    return insight.spanIds
      .map((id) => byId.get(id))
      .filter((s): s is Span => s !== undefined);
  }, [insight.spanIds, run.spans]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b border-border px-3 py-3">
        <p className={`text-label ${SEVERITY_TEXT[insight.severity]}`}>
          ⚠ {insight.severity} · {ruleLabel(insight.ruleId).label}{' '}
          <span className="font-mono text-text-faint">{insight.ruleId}</span>
        </p>
        <h2 className="mt-1 text-detail font-medium text-text">
          {insight.title}
        </h2>
        {insight.estimatedWasteUSD !== undefined && (
          <p className="mt-1 font-mono text-body text-heat-2">
            {formatUSD(insight.estimatedWasteUSD)} wasted
          </p>
        )}
      </div>
      <Section title="What happened">
        <p className="text-label leading-[1.45] text-text-dim">
          {insight.detail}
        </p>
      </Section>
      {insight.suggestion !== undefined && (
        <Section title="Suggestion">
          <p className="text-label leading-[1.45] text-text">
            {insight.suggestion}
          </p>
        </Section>
      )}
      <Section title={`Evidence (${evidence.length})`}>
        <ul className="space-y-0.5">
          {evidence.map((span) => (
            <li key={span.id}>
              <button
                type="button"
                onClick={() => selectSpan(span.id)}
                className="flex w-full items-baseline justify-between gap-2 rounded-control px-1.5 py-1 text-left text-label transition-colors duration-150 ease-out hover:bg-surface-2 active:bg-bg"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <i
                    aria-hidden
                    className={`inline-block h-2 w-2 shrink-0 ${KIND_BG[span.kind]}`}
                  />
                  <span className="truncate text-text">{span.name}</span>
                </span>
                <span
                  className={`shrink-0 font-mono ${
                    span.status === 'error'
                      ? 'text-span-error'
                      : 'text-text-faint'
                  }`}
                >
                  {span.status}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function SpanDetail({ span }: { span: Span }) {
  const activeRunId = useAppStore((s) =>
    'runId' in s.route ? s.route.runId : null,
  );
  const [showRaw, setShowRaw] = useState(false);
  const isError = span.status === 'error';

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* header */}
      <div className="border-b border-border px-3 py-3">
        <div className="flex items-center gap-2">
          <i
            aria-hidden
            className={`inline-block h-2.5 w-2.5 shrink-0 ${KIND_BG[span.kind]}`}
          />
          <h2 className="min-w-0 truncate text-detail font-medium text-text">
            {span.name}
          </h2>
        </div>
        <p className="mt-1 text-label text-text-dim">
          {span.kind}
          {' · '}
          <span className={isError ? 'text-span-error' : undefined}>
            {span.status}
          </span>
          {span.llm !== undefined && <> · {span.llm.model}</>}
        </p>
        {span.statusReason !== undefined && (
          <p className="mt-1 text-label text-span-error">{span.statusReason}</p>
        )}
      </div>

      {/* timing */}
      <Section title="Timing">
        <Field label="started">
          <Mono>{formatDateTime(span.startedAt)}</Mono>
        </Field>
        <Field label="duration">
          <Mono>
            {span.durationMs !== undefined
              ? formatDuration(span.durationMs)
              : '—'}
          </Mono>
        </Field>
      </Section>

      {/* delegation reason (subagents) */}
      {span.content?.delegationReason !== undefined && (
        <Section title="Delegation reason">
          <PreviewText value={span.content.delegationReason} />
        </Section>
      )}

      {/* tokens + cost */}
      {span.llm !== undefined && (
        <Section title="Tokens">
          <table className="w-full text-label">
            <tbody>
              <TokenRow label="input" value={span.llm.tokens.input} />
              <TokenRow label="output" value={span.llm.tokens.output} />
              <TokenRow label="cache read" value={span.llm.tokens.cacheRead} />
              <TokenRow
                label="cache write"
                value={span.llm.tokens.cacheWrite}
              />
              {span.llm.tokens.reasoning !== undefined && (
                <TokenRow label="reasoning" value={span.llm.tokens.reasoning} />
              )}
            </tbody>
          </table>
          <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
            <span className="text-label text-text-faint">cost</span>
            <span className="flex items-center gap-1.5">
              <span className="font-mono text-body text-text">
                {span.llm.costUSD !== undefined
                  ? formatUSD(span.llm.costUSD)
                  : '—'}
              </span>
              <CostSourceBadge source={span.llm.costSource} />
            </span>
          </div>
          {span.llm.stopReason !== undefined && (
            <Field label="stop reason">
              <Mono>{span.llm.stopReason}</Mono>
            </Field>
          )}
        </Section>
      )}

      {/* tool detail */}
      {span.tool !== undefined && (
        <Section title="Tool">
          {span.tool.mcpServer !== undefined && (
            <Field label="mcp server">
              <Mono>{span.tool.mcpServer}</Mono>
            </Field>
          )}
          {span.tool.exitCode !== undefined && (
            <Field label="exit code">
              <Mono>{span.tool.exitCode}</Mono>
            </Field>
          )}
          {span.tool.outputBytes !== undefined && (
            <Field label="output">
              <Mono>{formatTokens(span.tool.outputBytes)} B</Mono>
            </Field>
          )}
          {(span.tool.linesAdded !== undefined ||
            span.tool.linesRemoved !== undefined) && (
            <Field label="code changes">
              <span className="font-mono">
                <span className="text-cache-savings">
                  +{formatTokens(span.tool.linesAdded ?? 0)}
                </span>{' '}
                <span className="text-span-error">
                  −{formatTokens(span.tool.linesRemoved ?? 0)}
                </span>
              </span>
            </Field>
          )}
        </Section>
      )}

      {/* previews */}
      {span.content?.promptPreview !== undefined && (
        <Section title="Prompt">
          <PreviewText value={span.content.promptPreview} />
        </Section>
      )}
      {span.content?.outputPreview !== undefined && (
        <Section title="Output">
          <PreviewText value={span.content.outputPreview} />
        </Section>
      )}

      {/* full source-log slice behind the preview (D4) */}
      {activeRunId !== null && (
        <Section title="Transcript">
          <TranscriptPane runId={activeRunId} spanId={span.id} />
        </Section>
      )}

      {/* provenance footer */}
      <div className="px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <p
            className="min-w-0 truncate font-mono text-label text-text-faint"
            title={span.provenance.file}
          >
            {span.provenance.file}
            {span.provenance.line !== undefined && `:${span.provenance.line}`}
          </p>
          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            aria-pressed={showRaw}
            className="shrink-0 rounded-control border border-border bg-surface px-2 py-0.5 text-label text-text-dim transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text active:bg-bg"
          >
            {showRaw ? 'Hide raw' : 'Show raw'}
          </button>
        </div>
        {showRaw && (
          <pre className="mt-2 max-h-80 overflow-auto rounded-control border border-border bg-bg p-2 text-label leading-[1.45] text-text-dim">
            {JSON.stringify(span, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border px-3 py-3">
      <h3 className="micro-label mb-2 text-text-faint">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="flex items-baseline justify-between gap-3 py-0.5 text-label">
      <span className="text-text-faint">{label}</span>
      <span className="min-w-0 truncate text-right text-text-dim">
        {children}
      </span>
    </p>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono">{children}</span>;
}

function TokenRow({ label, value }: { label: string; value: number }) {
  return (
    <tr>
      <td className="py-0.5 text-text-faint">{label}</td>
      <td className="py-0.5 text-right font-mono text-text-dim">
        {formatTokens(value)}
      </td>
    </tr>
  );
}

function CostSourceBadge({
  source,
}: {
  source: 'reported' | 'computed' | 'unknown';
}) {
  return (
    <span
      title={
        source === 'computed'
          ? 'Computed from the bundled pricing snapshot'
          : source === 'reported'
            ? 'Reported by the source tool'
            : 'No pricing match — excluded from rollups'
      }
      className={`rounded-control border px-1.5 py-px font-mono text-label ${
        source === 'unknown'
          ? 'border-heat-2/40 text-heat-2'
          : 'border-border text-text-faint'
      }`}
    >
      {source}
    </span>
  );
}

/** `null` = redacted in core (AGENTS.md privacy rule) — never a UI filter. */
function PreviewText({ value }: { value: string | null }) {
  if (value === null) {
    return <p className="text-label text-text-faint italic">redacted</p>;
  }
  return (
    <pre className="line-clamp-[8] overflow-hidden whitespace-pre-wrap break-words font-mono text-label leading-[1.45] text-text-dim">
      {value}
    </pre>
  );
}
