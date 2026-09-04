import {
  PLAYBOOK_SOURCE_LABEL,
  resolvePlaybookSource,
} from '@runray/core/insights-meta';
import {
  ERROR_CLASS_META,
  ERROR_OWNER_META,
  ERROR_OWNER_ORDER,
  type ErrorCluster,
  type ErrorOwner,
  type RunTriage,
} from '@runray/core/triage';
import type { Run } from '@runray/schema';
import { useMemo, useState } from 'react';
import { formatDuration, formatUSD } from '../lib/format';
import { toHash } from '../lib/router';
import { formatOffset, OWNER_FILL, runTriage } from '../lib/triage';
import { useAppStore } from '../store';
import { ContextualHint } from './ContextualHint';
import { InlineCode, PlaybookList, PlaybookSteps } from './PlaybookSteps';

/**
 * The Errors tab (error-triage capability, visualizer "Errors tab"): a
 * session's failed calls grouped by who can act, most actionable first.
 * The summary says how many need the person and what the failures cost in
 * reaction; the rail places them on the session's clock; each cluster
 * (class × tool) opens to the failure text, its occurrences (each a jump
 * to the timeline), the findings that cite it, and the playbook for the
 * session's own source. Expected feedback — the agent's own checks — is
 * collapsed and dimmed: it is not a failure of the session. Hue encodes
 * the owner, never severity.
 */

type Filter = ErrorOwner | 'all';

export function ErrorsView({ run }: { run: Run }) {
  const triage = useMemo(() => runTriage(run), [run]);
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        triage.clusters
          .filter((c) => c.owner === 'you')
          .slice(0, 1)
          .map((c) => c.key),
      ),
  );
  const [showWork, setShowWork] = useState(false);

  const total = triage.toolErrors + triage.modelErrors;
  if (total === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pr-1">
        <section className="rounded border border-border-slate bg-surface-container-low p-4 shadow-card">
          <p className="text-body text-text">
            No failed calls in this session.
          </p>
          <p className="mt-1 text-label text-text-dim">
            {triage.cancelled > 0
              ? `${triage.cancelled} call${triage.cancelled === 1 ? '' : 's'} you declined ${triage.cancelled === 1 ? 'is' : 'are'} not counted as failures. `
              : ''}
            Where the money went is on the{' '}
            <a
              href={toHash({ view: 'cost', runId: run.id })}
              className="text-brand underline-offset-2 hover:underline"
            >
              Overview
            </a>
            .
          </p>
        </section>
      </div>
    );
  }

  const groups = ERROR_OWNER_ORDER.map((owner) => ({
    owner,
    clusters: triage.clusters.filter((c) => c.owner === owner),
  })).filter((g) => g.clusters.length > 0);

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pr-1">
      <ContextualHint hintKey="errors-view" />
      <Summary run={run} triage={triage} />

      <div
        className="flex flex-wrap items-center gap-1.5"
        role="toolbar"
        aria-label="Filter by who can act"
      >
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
          All {total}
        </FilterChip>
        {ERROR_OWNER_ORDER.filter((o) => triage.byOwner[o] > 0).map((owner) => (
          <FilterChip
            key={owner}
            active={filter === owner}
            onClick={() => {
              setFilter(owner);
              if (owner === 'work') setShowWork(true);
            }}
          >
            <i
              aria-hidden
              className={`inline-block h-1.5 w-1.5 rounded-[2px] ${OWNER_FILL[owner]}`}
            />
            {ERROR_OWNER_META[owner].label} {triage.byOwner[owner]}
          </FilterChip>
        ))}
        <span className="ml-auto text-label text-text-faint">
          Click a row for the error text and what to do
        </span>
      </div>

      {groups
        .filter((g) => filter === 'all' || g.owner === filter)
        .map((g) => {
          const dimmed = g.owner === 'work';
          const collapsed = dimmed && !showWork;
          const reacting = g.clusters.reduce((s, c) => s + c.reactionUSD, 0);
          const count = g.clusters.reduce((s, c) => s + c.count, 0);
          return (
            <section
              key={g.owner}
              aria-label={ERROR_OWNER_META[g.owner].label}
              className={`overflow-hidden rounded border border-border-slate bg-surface ${dimmed ? 'opacity-80' : ''}`}
            >
              <div className="grid grid-cols-[4px_1fr_auto] items-center gap-3 border-b border-border bg-surface-container-low py-2 pr-3">
                <span
                  aria-hidden
                  className={`h-full min-h-7 ${OWNER_FILL[g.owner]}`}
                />
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="micro-label text-text">
                    {ERROR_OWNER_META[g.owner].label}
                  </span>
                  <span className="text-label text-text-dim">
                    {ERROR_OWNER_META[g.owner].meaning}
                  </span>
                </div>
                <div className="flex items-center gap-3 font-mono text-label text-text-dim">
                  <span>
                    <span className="text-text">{count}</span> error
                    {count === 1 ? '' : 's'}
                  </span>
                  {reacting > 0 && (
                    <span>
                      <span className="text-text">{formatUSD(reacting)}</span>{' '}
                      reacting
                    </span>
                  )}
                  {dimmed && (
                    <button
                      type="button"
                      aria-expanded={showWork}
                      onClick={() => setShowWork((v) => !v)}
                      className="rounded-control border border-border-slate px-2 py-0.5 text-label text-text-dim transition-colors duration-150 ease-out hover:bg-surface-variant hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary active:bg-bg-deep-gray"
                    >
                      {showWork ? 'hide' : 'show'}
                    </button>
                  )}
                </div>
              </div>
              {!collapsed &&
                g.clusters.map((c) => (
                  <ClusterRow
                    key={c.key}
                    run={run}
                    cluster={c}
                    open={open.has(c.key)}
                    onToggle={() => toggle(c.key)}
                  />
                ))}
            </section>
          );
        })}

      <p className="text-label text-text-faint">
        {triage.redacted
          ? 'Some failures carry no text (redacted or absent): their class is read from the tool alone and may be wrong.'
          : 'Error text comes from the transcript and is kept only for failed calls; under --redact it is unavailable and classes fall back to the tool name and exit code.'}
      </p>
    </div>
  );
}

function Summary({ run, triage }: { run: Run; triage: RunTriage }) {
  const total = triage.toolErrors + triage.modelErrors;
  const start = Date.parse(run.startedAt);
  const duration =
    run.durationMs ??
    Math.max(
      1,
      ...run.spans.map((s) => Date.parse(s.endedAt ?? s.startedAt) - start),
    );
  const ticks = triage.clusters.flatMap((c) =>
    c.occurrences.map((o) => ({
      id: o.spanId,
      owner: c.owner,
      model: c.kind === 'llm_call',
      left: Number(
        Math.min(
          100,
          Math.max(0, ((Date.parse(o.startedAt) - start) / duration) * 100),
        ).toFixed(3),
      ),
      title: `${formatOffset(Date.parse(o.startedAt) - start)} · ${c.tool} · ${c.label}`,
    })),
  );
  const needsYou = triage.byOwner.you;
  return (
    <section className="grid gap-x-7 gap-y-4 rounded border border-border-slate bg-surface-container-low p-4 shadow-card md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <div>
        <p className="text-detail font-semibold text-text">
          <span className="font-mono">{triage.toolErrors}</span> tool error
          {triage.toolErrors === 1 ? '' : 's'}
          {triage.modelErrors > 0 && (
            <>
              {' · '}
              <span className="font-mono">{triage.modelErrors}</span> model-call
              error
              {triage.modelErrors === 1 ? '' : 's'}
            </>
          )}
        </p>
        <p className="mt-1 text-label text-text-dim">
          <span
            className={`font-mono ${needsYou > 0 ? 'text-heat-1' : 'text-text'}`}
          >
            {needsYou}
          </span>{' '}
          need{needsYou === 1 ? 's' : ''} you ·{' '}
          <span className="font-mono text-text">{triage.recovered}</span>{' '}
          recovered on the next call
          {triage.reactionUSD > 0 && (
            <>
              {' · '}
              <span className="font-mono text-text">
                {formatUSD(triage.reactionUSD)}
              </span>{' '}
              spent reacting
            </>
          )}
        </p>
        <p className="mt-1 text-label text-text-dim">
          Grouped by who can act. Expected feedback is not counted as waste.
          {triage.cancelled > 0 &&
            ` ${triage.cancelled} call${triage.cancelled === 1 ? '' : 's'} you declined ${triage.cancelled === 1 ? 'is' : 'are'} not in the count.`}
        </p>
      </div>
      <div>
        <p className="micro-label text-text-faint">Who can act</p>
        <div
          className="mt-1.5 flex h-3.5 overflow-hidden rounded-[3px] border border-border"
          role="img"
          aria-label={ERROR_OWNER_ORDER.filter((o) => triage.byOwner[o] > 0)
            .map((o) => `${ERROR_OWNER_META[o].label} ${triage.byOwner[o]}`)
            .join(', ')}
        >
          {ERROR_OWNER_ORDER.filter((o) => triage.byOwner[o] > 0).map((o) => (
            <span
              key={o}
              className={OWNER_FILL[o]}
              style={{ width: `${(triage.byOwner[o] / total) * 100}%` }}
            />
          ))}
        </div>
        <p className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-label text-text-dim">
          {ERROR_OWNER_ORDER.filter((o) => triage.byOwner[o] > 0).map((o) => (
            <span key={o} className="inline-flex items-center gap-1.5">
              <i
                aria-hidden
                className={`inline-block h-2 w-2 rounded-[2px] ${OWNER_FILL[o]}`}
              />
              {ERROR_OWNER_META[o].label}{' '}
              <span className="font-mono text-text">{triage.byOwner[o]}</span>
            </span>
          ))}
        </p>
      </div>
      <div className="md:col-span-2">
        <p className="flex justify-between micro-label text-text-faint">
          <span>When · {formatDuration(duration)}</span>
          <span>tick = one failure · dot = model call</span>
        </p>
        <div
          className="relative mt-1.5 h-6 border-y border-border-slate"
          role="img"
          aria-label={`${total} failures placed on the session's time axis`}
        >
          {ticks.map((t) => (
            <span
              key={t.id}
              title={t.title}
              className={`absolute ${OWNER_FILL[t.owner]} ${
                t.model
                  ? 'top-[7px] h-2.5 w-2.5 -translate-x-[5px] rounded-full'
                  : 'top-[3px] h-[18px] w-[3px] -translate-x-px rounded-[1px]'
              }`}
              style={{ left: `${t.left}%` }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-label transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary active:bg-bg-deep-gray ${
        active
          ? 'border-border-strong bg-surface-variant text-on-surface'
          : 'border-border-slate bg-surface text-text-dim hover:border-border-strong hover:text-text'
      }`}
    >
      {children}
    </button>
  );
}

const OUTCOME_PILL: Record<ErrorCluster['outcome'], string> = {
  recovered: 'bg-cache-savings/12 text-cache-savings',
  looping: 'bg-heat-2/12 text-heat-2',
  unrecovered: 'bg-heat-1/14 text-heat-1',
};

function outcomeLabel(c: ErrorCluster): string {
  const last = c.occurrences[c.occurrences.length - 1];
  const after = last?.recovery.afterMs;
  if (c.outcome === 'looping') {
    return `${c.count} in a row → ok${after === undefined ? '' : ` · ${formatDuration(after)}`}`;
  }
  if (c.outcome === 'recovered') {
    return `next call ok${after === undefined ? '' : ` · ${formatDuration(after)}`}`;
  }
  return last?.recovery.kind === 'error' ? 'next call failed' : 'no later call';
}

/** The row's one-line "what": the class label, then the first line of the
 * latest failure text when there is one. */
function firstLine(text: string | null | undefined): string | undefined {
  if (typeof text !== 'string') return undefined;
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  return line === undefined
    ? undefined
    : line.length > 140
      ? `${line.slice(0, 140)}…`
      : line;
}

function ClusterRow({
  run,
  cluster,
  open,
  onToggle,
}: {
  run: Run;
  cluster: ErrorCluster;
  open: boolean;
  onToggle: () => void;
}) {
  const selectSpan = useAppStore((s) => s.selectSpan);
  const showInsight = useAppStore((s) => s.showInsight);
  const navigateTo = useAppStore((s) => s.navigateTo);
  const meta = ERROR_CLASS_META[cluster.classId];
  const source = resolvePlaybookSource(run.source.tool);
  const start = Date.parse(run.startedAt);
  const latest = cluster.occurrences[cluster.occurrences.length - 1];
  const summary = firstLine(latest?.preview);
  const firstAt = formatOffset(Date.parse(cluster.firstAt) - start);
  const lastAt = formatOffset(Date.parse(cluster.lastAt) - start);
  const when = firstAt === lastAt ? firstAt : `${firstAt}–${lastAt}`;
  // `mcp__<server>__<tool>` reads as the tool with the server beside it
  const shortTool =
    cluster.mcpServer !== undefined &&
    cluster.tool.startsWith(`mcp__${cluster.mcpServer}__`)
      ? cluster.tool.slice(`mcp__${cluster.mcpServer}__`.length)
      : cluster.tool;
  // the lever shows when the person has one, or when an agent slip repeats
  // or was never recovered from; expected feedback only explains itself
  const showActions =
    cluster.owner === 'you' ||
    cluster.owner === 'tooling' ||
    cluster.owner === 'model' ||
    cluster.owner === 'unknown' ||
    (cluster.owner === 'agent' &&
      (cluster.count >= 2 || cluster.outcome !== 'recovered'));
  const findings = run.insights.filter((i) =>
    cluster.insightIds.includes(i.id),
  );
  const bodyId = `errors-${cluster.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  const jump = (spanId: string) => {
    selectSpan(spanId);
    navigateTo({ view: 'timeline', runId: run.id });
  };

  return (
    <article className="border-b border-border last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className="grid w-full grid-cols-[20px_minmax(120px,170px)_minmax(0,1fr)_auto_auto_64px] items-center gap-2.5 py-2 pr-3 pl-2 text-left transition-colors duration-150 ease-out hover:bg-brand/6 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary active:bg-brand/12 max-md:grid-cols-[20px_minmax(0,1fr)_auto]"
      >
        <span
          aria-hidden
          className={`inline-block text-center text-[11px] text-text-faint transition-transform duration-150 ease-out ${open ? 'rotate-90' : ''}`}
        >
          ▸
        </span>
        <span
          className="truncate font-mono text-label text-text"
          title={cluster.tool}
        >
          {shortTool}
          {cluster.mcpServer !== undefined && (
            <span className="text-text-faint"> · {cluster.mcpServer}</span>
          )}
        </span>
        <span className="truncate text-label text-text-dim max-md:col-span-3 max-md:col-start-2 max-md:whitespace-normal">
          <span className="text-text">{cluster.label}</span>
          {summary !== undefined && <> · {summary}</>}
        </span>
        <span className="whitespace-nowrap font-mono text-label text-text-dim">
          {cluster.count}× · {when}
        </span>
        <span
          className={`whitespace-nowrap rounded-full px-2 py-px font-mono text-[11px] ${OUTCOME_PILL[cluster.outcome]}`}
        >
          {outcomeLabel(cluster)}
        </span>
        <span className="text-right font-mono text-label text-text">
          {cluster.reactionUSD > 0 ? formatUSD(cluster.reactionUSD) : '—'}
        </span>
      </button>
      {open && (
        <div id={bodyId} className="grid gap-2.5 px-3 pb-3.5 pt-1 md:pl-10">
          {typeof latest?.preview === 'string' ? (
            <pre className="m-0 whitespace-pre-wrap break-words border-l-2 border-error-rose bg-error-rose/7 px-2.5 py-2 font-mono text-[11.5px] leading-[1.5] text-text">
              {latest.preview}
            </pre>
          ) : (
            <p className="text-label text-text-faint">
              {latest?.preview === null
                ? 'Error text redacted.'
                : 'No error text in the source.'}
            </p>
          )}
          <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1 text-label">
            <dt className="text-text-faint">occurrences</dt>
            <dd className="m-0 flex flex-wrap gap-1">
              {cluster.occurrences.map((o) => (
                <button
                  key={o.spanId}
                  type="button"
                  onClick={() => jump(o.spanId)}
                  title="Open in Timeline Explorer with this call selected"
                  className="rounded-control border border-border bg-surface-2 px-1.5 py-px font-mono text-[11px] text-text-dim transition-colors duration-150 ease-out hover:border-border-strong hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary active:bg-bg-deep-gray"
                >
                  {formatOffset(Date.parse(o.startedAt) - start)}
                  {o.durationMs !== undefined &&
                    ` · ${formatDuration(o.durationMs)}`}
                  {o.recovery.kind !== 'ok' && (
                    <span
                      className={
                        o.recovery.kind === 'error'
                          ? ' text-heat-2'
                          : ' text-heat-1'
                      }
                    >
                      {o.recovery.kind === 'error' ? ' ✕' : ' ∅'}
                    </span>
                  )}
                </button>
              ))}
            </dd>
            {findings.length > 0 && (
              <>
                <dt className="text-text-faint">
                  finding{findings.length === 1 ? '' : 's'}
                </dt>
                <dd className="m-0 flex flex-wrap gap-x-3 gap-y-1">
                  {findings.map((i) => (
                    <button
                      key={i.id}
                      type="button"
                      onClick={() => {
                        showInsight(i);
                        navigateTo({ view: 'timeline', runId: run.id });
                      }}
                      className="text-left text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                    >
                      {i.title}
                      {i.estimatedWasteUSD !== undefined && (
                        <span className="font-mono text-text-dim">
                          {' '}
                          · {formatUSD(i.estimatedWasteUSD)}
                        </span>
                      )}
                    </button>
                  ))}
                </dd>
              </>
            )}
            {cluster.reactionUSD > 0 && (
              <>
                <dt className="text-text-faint">what it cost</dt>
                <dd className="m-0 text-text-dim">
                  {cluster.count === 1
                    ? 'the model call'
                    : `${cluster.count} model calls`}{' '}
                  reacting to {cluster.count === 1 ? 'it' : 'them'}:{' '}
                  <span className="font-mono text-text">
                    {formatUSD(cluster.reactionUSD)}
                  </span>
                </dd>
              </>
            )}
          </dl>
          <div className="grid gap-1.5 border-t border-border pt-2">
            <p className="micro-label text-text-faint">
              {showActions
                ? `What you can do · ${PLAYBOOK_SOURCE_LABEL[source]}`
                : 'What this is'}
            </p>
            {showActions ? (
              <>
                <p className="text-label text-text-dim">
                  <InlineCode line={meta.explain} />
                </p>
                <PlaybookSteps actions={meta.playbook.actions[source]} />
                <PlaybookList
                  label="Out of your hands"
                  lines={meta.playbook.limits}
                />
              </>
            ) : (
              <p className="text-label text-text-dim">
                <InlineCode line={meta.explain} />{' '}
                <InlineCode line={meta.playbook.limits[0] ?? ''} />
              </p>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
