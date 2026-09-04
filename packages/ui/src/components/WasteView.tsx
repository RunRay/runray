import {
  PLAYBOOK_SOURCE_LABEL,
  RULE_META,
  resolvePlaybookSource,
} from '@runray/core/insights-meta';
import type { RunWaste, WasteGroup, WasteOccurrence } from '@runray/core/waste';
import type { Insight, Run } from '@runray/schema';
import { useMemo, useState } from 'react';
import { formatDuration, formatUSD } from '../lib/format';
import { toHash } from '../lib/router';
import { formatOffset } from '../lib/triage';
import { leadSentence, runWaste, tok } from '../lib/waste';
import { useAppStore } from '../store';
import { ContextualHint } from './ContextualHint';
import { LeakRail } from './LeakRail';
import { InlineCode, PlaybookList, PlaybookSteps } from './PlaybookSteps';
import { SeverityPill } from './SeverityPill';

/**
 * The Waste tab (waste-grouping capability, visualizer "Waste tab"): what
 * in this session bought nothing, and what one change would have kept.
 * Two figures kept apart — burned (the engine's capped estimate) and
 * opportunities (upper bounds that do not add up) — then one sentence on
 * the largest burn and its lever; then the groups by rule, burned first,
 * each graded as a group, opening to its occurrences (each a jump to the
 * finding on the timeline), its shape split and the playbook for the
 * session's own source. Cents fold into one line. Between the figures
 * and the groups, the leak rail places every burned finding on the
 * session's clock. Hue: heat for burned, savings green for
 * opportunities, severity only on the pill.
 */

const OCCURRENCES_SHOWN = 6;

export function WasteView({ run }: { run: Run }) {
  const waste = useMemo(() => runWaste(run), [run]);
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        [
          waste.burned.find((g) => !g.folded && g.usd > 0),
          waste.opportunities.find((g) => g.usd > 0),
        ]
          .filter((g): g is WasteGroup => g !== undefined)
          .map((g) => g.ruleId),
      ),
  );

  if (waste.findings === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pr-1 [&>*]:shrink-0">
        <section className="rounded border border-border-slate bg-surface-container-low p-4 shadow-card">
          <p className="text-body text-text">
            Nothing leaked that the rules can see.
          </p>
          <p className="mt-1 text-label text-text-dim">
            {Object.keys(RULE_META).length} rules checked: retries, cache
            breaks, idle gaps, context growth, fixed context, model tier,
            subagents, re-reads, oversized outputs, dead ends. Where the money
            went is on the{' '}
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

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pr-1 [&>*]:shrink-0">
      <ContextualHint hintKey="waste-view" />
      <Summary run={run} waste={waste} />
      {waste.burned.length > 0 && (
        <GroupSection
          kind="burned"
          groups={waste.burned}
          amount={waste.burnedUSD}
          run={run}
          open={open}
          onToggle={toggle}
        />
      )}
      {waste.opportunities.length > 0 && (
        <GroupSection
          kind="opportunities"
          groups={waste.opportunities}
          amount={waste.opportunityUSD}
          run={run}
          open={open}
          onToggle={toggle}
        />
      )}
      <p className="text-label text-text-faint">
        Burned is the engine's waste-class total, capped at the session's cost.
        Opportunities assume a different setup and overlap with each other and
        with the burn, so they are read one at a time.
        {waste.unpriced &&
          ' Some findings carry no estimate (unpriced model): the amounts are lower bounds.'}
      </p>
    </div>
  );
}

function Summary({ run, waste }: { run: Run; waste: RunWaste }) {
  const lead = leadSentence(waste, run.source.tool);
  const share = (waste.burnedShare * 100).toFixed(
    waste.burnedShare < 0.1 ? 1 : 0,
  );
  return (
    <section className="grid gap-x-7 gap-y-4 rounded border border-border-slate bg-surface-container-low p-4 shadow-card md:grid-cols-[auto_auto_minmax(0,1fr)]">
      <div>
        <p className="micro-label text-text-faint">Burned</p>
        <p
          className={`mt-0.5 font-display text-[30px] font-semibold leading-[1.05] ${waste.burnedUSD > 0 ? 'text-heat-2' : 'text-text-dim'}`}
        >
          {formatUSD(waste.burnedUSD)}
        </p>
        <p className="mt-1 text-label text-text-dim">
          {waste.burnedUSD > 0 ? (
            <>
              already spent on nothing ·{' '}
              <span className="font-mono text-text">{share}%</span> of this
              session ·{' '}
              <span className="font-mono text-text">{waste.burned.length}</span>{' '}
              {waste.burned.length === 1 ? 'rule' : 'rules'}
            </>
          ) : (
            'nothing burned that the rules can see'
          )}
        </p>
      </div>
      <div>
        <p className="micro-label text-text-faint">Opportunities</p>
        <p
          className={`mt-0.5 font-display text-[30px] font-semibold leading-[1.05] ${waste.opportunityUSD > 0 ? 'text-cache-savings' : 'text-text-dim'}`}
        >
          {waste.opportunityUSD > 0
            ? `up to ${formatUSD(waste.opportunityUSD)}`
            : formatUSD(0)}
        </p>
        <p className="mt-1 text-label text-text-dim">
          if you change the setup · upper bounds, not additive
        </p>
      </div>
      <p className="self-center text-body leading-[1.5] text-text-dim md:max-w-[58ch]">
        {lead === null ? (
          <>
            Nothing was burned.{' '}
            {waste.opportunityUSD > 0 &&
              'The opportunities below say what a different setup could have saved, each on its own.'}
          </>
        ) : (
          <>
            <span className="font-medium text-text">{lead.opening}</span>{' '}
            {lead.what} <InlineCode line={lead.lever} />
          </>
        )}
      </p>
      {(waste.events.length > 0 || waste.context.length > 0) && (
        <div className="md:col-span-3">
          <LeakRail run={run} waste={waste} />
        </div>
      )}
    </section>
  );
}

const SECTION: Record<
  'burned' | 'opportunities',
  { label: string; meaning: string; amount: string; ariaLabel: string }
> = {
  burned: {
    label: 'Burned',
    meaning: 'already spent on nothing · retries, cache breaks, idle gaps',
    amount: 'text-heat-2',
    ariaLabel: 'Burned',
  },
  opportunities: {
    label: 'Opportunities',
    meaning: 'if you change the setup · each an upper bound · not additive',
    amount: 'text-cache-savings',
    ariaLabel: 'Opportunities',
  },
};

function GroupSection({
  kind,
  groups,
  amount,
  run,
  open,
  onToggle,
}: {
  kind: 'burned' | 'opportunities';
  groups: WasteGroup[];
  amount: number;
  run: Run;
  open: ReadonlySet<string>;
  onToggle: (key: string) => void;
}) {
  const s = SECTION[kind];
  return (
    <section
      aria-label={s.ariaLabel}
      // shrink-0: inside the scrolling flex column an overflow-hidden item
      // would otherwise be squeezed to the viewport and clip its rows
      className="shrink-0 overflow-hidden rounded border border-border-slate bg-surface"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border bg-surface-container-low px-3 py-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className={`micro-label ${s.amount}`}>{s.label}</span>
          <span className="text-label text-text-dim">{s.meaning}</span>
        </div>
        <span className={`font-mono text-label ${s.amount}`}>
          {kind === 'opportunities' && amount > 0 ? 'up to ' : ''}
          {formatUSD(amount)}
        </span>
      </div>
      {groups.map((g) => (
        <GroupRow
          key={g.ruleId}
          run={run}
          group={g}
          open={open.has(g.ruleId)}
          onToggle={() => onToggle(g.ruleId)}
        />
      ))}
    </section>
  );
}

const SHAPE_LABEL = {
  history: (n: number) =>
    `${n} re-write${n === 1 ? '' : 's'} of the conversation, the front stayed cached`,
  front: (n: number) =>
    `${n} front change${n === 1 ? '' : 's'}: tools, model or a setting`,
  compaction: (n: number) => `${n} compaction${n === 1 ? '' : 's'}`,
} as const;

/** The occurrence's one-line "what": tokens for cache findings, the
 * finding's own title otherwise. */
function occurrenceText(g: WasteGroup, o: WasteOccurrence): string {
  if (g.ruleId === 'cache-prefix-break' && o.cache !== undefined) {
    const shape = o.shape === 'compaction' ? ' · compaction' : '';
    return `${tok(o.cache.readBefore)} → ${tok(o.cache.readAfter)} cached · ${tok(o.cache.rewritten)} re-written${shape}`;
  }
  if (g.ruleId === 'idle-cache-expiry' && o.cache !== undefined) {
    return `${o.gapMs === undefined ? 'idle' : `idle ${formatDuration(o.gapMs)}`} · ${tok(o.cache.rewritten)} re-written on resume`;
  }
  return o.title;
}

function GroupRow({
  run,
  group,
  open,
  onToggle,
}: {
  run: Run;
  group: WasteGroup;
  open: boolean;
  onToggle: () => void;
}) {
  const showInsight = useAppStore((s) => s.showInsight);
  const navigateTo = useAppStore((s) => s.navigateTo);
  const meta = RULE_META[group.ruleId];
  const source = resolvePlaybookSource(run.source.tool);
  const amountTone =
    group.class === 'waste' ? 'text-heat-2' : 'text-cache-savings';
  const share = group.share * 100;
  const bodyId = `waste-${group.ruleId}`;
  const shown = group.occurrences.slice(0, OCCURRENCES_SHOWN);
  const rest = group.occurrences.slice(OCCURRENCES_SHOWN);
  const restUSD = rest.reduce((acc, o) => acc + o.usd, 0);
  const byId = useMemo(
    () => new Map(run.insights.map((i) => [i.id, i])),
    [run.insights],
  );

  const openFinding = (o: WasteOccurrence) => {
    const insight: Insight | undefined = byId.get(o.insightId);
    if (insight === undefined) return;
    showInsight(insight, o.spanIds[0]);
    navigateTo({ view: 'timeline', runId: run.id });
  };

  return (
    <article
      className={`border-b border-border last:border-b-0 ${group.folded ? 'opacity-70' : ''}`}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className="grid w-full grid-cols-[20px_minmax(0,1fr)_auto_auto_84px] items-center gap-2.5 py-2 pr-3 pl-2 text-left transition-colors duration-150 ease-out hover:bg-brand/6 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary active:bg-brand/12 max-md:grid-cols-[20px_minmax(0,1fr)_auto]"
      >
        <span
          aria-hidden
          className={`inline-block text-center text-[11px] text-text-faint transition-transform duration-150 ease-out ${open ? 'rotate-90' : ''}`}
        >
          ▸
        </span>
        <span className="min-w-0">
          <span className="block truncate text-body text-text">
            {group.label}
            <span className="ml-2 font-mono text-label text-text-faint">
              {group.ruleId}
            </span>
            <span className="ml-2 text-label text-text-faint">
              {group.folded
                ? `· ${group.count} findings, each under $0.05`
                : group.count > 1
                  ? `· ${group.count}×`
                  : ''}
              {group.unpriced && ' · partly unpriced'}
            </span>
          </span>
          <span className="block truncate text-label text-text-dim">
            {group.explain}
          </span>
        </span>
        <span className="whitespace-nowrap font-mono text-label text-text-faint max-md:hidden">
          {group.share > 0 ? `${share.toFixed(share < 10 ? 1 : 0)}%` : ''}
        </span>
        <span className="max-md:hidden">
          <SeverityPill severity={group.severity} />
        </span>
        <span
          className={`text-right font-mono text-label ${group.usd > 0 ? amountTone : 'text-text-faint'}`}
        >
          {group.usd > 0 ? formatUSD(group.usd) : '—'}
        </span>
      </button>
      {open && (
        <div id={bodyId} className="grid gap-2.5 px-3 pb-3.5 pt-1 md:pl-10">
          {group.ruleId === 'cache-prefix-break' &&
            group.shapes !== undefined && (
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-label text-text-dim">
                {(['history', 'front', 'compaction'] as const)
                  .filter((k) => (group.shapes?.[k]?.count ?? 0) > 0)
                  .map((k) => {
                    const cell = group.shapes?.[k];
                    return (
                      <span key={k}>
                        {SHAPE_LABEL[k](cell?.count ?? 0)} ·{' '}
                        <span className="font-mono text-text">
                          {formatUSD(cell?.usd ?? 0)}
                        </span>
                      </span>
                    );
                  })}
              </p>
            )}
          {group.ruleId === 'context-bloat' && (
            <p className="text-label text-text-faint">
              Upper bound: assumes the work could have continued from a
              compacted context.
            </p>
          )}
          <ul className="grid gap-0.5">
            {shown.map((o) => (
              <li key={o.insightId}>
                <button
                  type="button"
                  onClick={() => openFinding(o)}
                  title="Open this finding in the Timeline Explorer with its evidence selected"
                  className="grid w-full grid-cols-[52px_minmax(0,1fr)_auto_auto] items-baseline gap-3 rounded-control px-1.5 py-1 text-left text-label transition-colors duration-150 ease-out hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary active:bg-bg max-md:grid-cols-[52px_minmax(0,1fr)_auto]"
                >
                  <span className="font-mono text-text-faint">
                    {o.atMs === undefined ? '—' : formatOffset(o.atMs)}
                  </span>
                  <span className="truncate text-text-dim">
                    {occurrenceText(group, o)}
                  </span>
                  <span className="font-mono text-text-faint max-md:hidden">
                    {o.model ?? o.tool ?? ''}
                  </span>
                  <span
                    className={`font-mono ${o.usd > 0 ? amountTone : 'text-text-faint'}`}
                  >
                    {o.priced ? formatUSD(o.usd) : 'unpriced'}
                  </span>
                </button>
              </li>
            ))}
            {rest.length > 0 && (
              <li className="px-1.5 py-1 text-label text-text-faint">
                {rest.length} more ·{' '}
                <span className="font-mono">{formatUSD(restUSD)}</span>
              </li>
            )}
          </ul>
          {meta !== undefined && (
            <div className="grid gap-1.5 border-t border-border pt-2">
              <p className="micro-label text-text-faint">
                What you can do · {PLAYBOOK_SOURCE_LABEL[source]}
              </p>
              <PlaybookSteps actions={meta.playbook.actions[source]} />
              <PlaybookList
                label="Out of your hands"
                lines={meta.playbook.limits}
              />
            </div>
          )}
        </div>
      )}
    </article>
  );
}
