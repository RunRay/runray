import type { Run } from '@runray/schema';
import { useMemo } from 'react';
import {
  type CoverageAggregate,
  coverageOf,
  unpricedAdvice,
} from '../lib/coverage';
import { ContextualHint } from './ContextualHint';

/**
 * Unpriced-coverage honesty surfaces (C7): a banner where money is
 * aggregated, a caveat mark beside every waste/savings figure derived from
 * incomplete runs. Ember-tinted like other warnings; the count is always
 * spelled out — honesty is never color-alone. The banner advises a price
 * refresh only for models a newer list could hold (lib/coverage,
 * `unpricedAdvice`).
 */

export function useCoverage(runs: readonly Run[]): CoverageAggregate {
  return useMemo(() => coverageOf(runs), [runs]);
}

/** Banner over a run or the dashboard: named models, spelled-out counts. */
export function CoverageBanner({ runs }: { runs: readonly Run[] }) {
  const c = useCoverage(runs);
  if (c.complete) return null;
  const runsNote =
    c.runsAffected > 1 ? ` across ${c.runsAffected} sessions` : '';
  const advice = unpricedAdvice(c.models);
  const refreshCommand = (
    <code className="font-mono text-text">runray pricing --refresh</code>
  );
  return (
    <div className="flex flex-col gap-2">
      <ContextualHint hintKey="coverage" />
      <div
        role="status"
        className="flex items-baseline gap-2 rounded-control border border-heat-2/30 bg-heat-2/10 px-3 py-1.5"
      >
        <span className="micro-label shrink-0 text-heat-2">unpriced</span>
        <span className="text-label text-text-dim">
          {c.unpricedLlmCalls} llm call{c.unpricedLlmCalls === 1 ? '' : 's'}
          {runsNote} carry no price ({advice.listed}), so totals are
          understated.{' '}
          {advice.refresh === 'refresh' && <>Try {refreshCommand}.</>}
          {advice.refresh === 'refresh-others' && (
            <>Try {refreshCommand} for the others.</>
          )}
          {advice.refresh === 'none' &&
            (advice.what !== undefined
              ? `This is ${advice.what}; no price is published for it, so refreshing prices changes nothing.`
              : `No price is published for ${c.models.length === 1 ? 'this model' : 'these models'}, so refreshing prices changes nothing.`)}
        </span>
      </div>
    </div>
  );
}

/**
 * Caveat mark for one money figure: renders a `≥` with the explanation in
 * the accessible name when coverage is incomplete, nothing otherwise.
 * Compose directly before the dollar amount: `≥ $12.40`.
 */
export function CoverageCaveat({ runs }: { runs: readonly Run[] }) {
  const c = useCoverage(runs);
  if (c.complete) return null;
  return (
    <span
      className="cursor-help text-text-faint"
      title={`${c.unpricedLlmCalls} llm call(s) unpriced; this figure is understated`}
    >
      ≥
      <span className="sr-only">
        {` at least: ${c.unpricedLlmCalls} llm calls unpriced, figure understated`}
      </span>
    </span>
  );
}
