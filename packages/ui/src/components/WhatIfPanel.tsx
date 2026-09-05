import {
  DEFAULT_REPRICE_RISK,
  MODEL_TIERS,
  matchModel,
  repriceRun,
  suggestedDowngrade,
} from '@runray/core/pricing';
import type { Run } from '@runray/schema';
import { useMemo, useState } from 'react';
import { formatUSD } from '../lib/format';
import { useAppStore } from '../store';
import { ContextualHint } from './ContextualHint';
import { CoverageCaveat } from './CoverageNotices';
import { PricingProvenance } from './PricingProvenance';

/**
 * What-if repricing panel (C5/C8): the same token quads at the selected
 * tier's rates — per-subtree deltas with risk badges, a full and a
 * risk-free total, always worded as an ESTIMATE. The math is the
 * cost-engine primitive imported from `@runray/core/pricing`, never a UI
 * reimplementation, so these dollars can never disagree with insight
 * dollars. Without a delivered pricing payload (old export, older CLI)
 * the panel explains itself instead of fabricating rates.
 */
export function WhatIfPanel({ run }: { run: Run }) {
  const pricing = useAppStore((s) => s.pricing);

  const dominantModel = useMemo(() => {
    const entries = Object.entries(run.totals.costUSD.byModel);
    entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    return entries[0]?.[0];
  }, [run.totals.costUSD.byModel]);

  // Spec: any model from the delivered pricing table is selectable. The
  // canonical tier targets are promoted to the top (the common downgrades),
  // then every other priced model in the table, alphabetically.
  const candidates = useMemo(() => {
    if (pricing === undefined) return [];
    const preferred: string[] = [];
    for (const stages of MODEL_TIERS) {
      for (const stage of stages) {
        const entry = matchModel(pricing.table, stage.target);
        if (
          entry !== undefined &&
          entry.inputPerMTok > 0 &&
          entry.outputPerMTok > 0 &&
          !preferred.includes(stage.target)
        ) {
          preferred.push(stage.target);
        }
      }
    }
    const rest = pricing.table.entries
      .filter((e) => e.inputPerMTok > 0 && e.outputPerMTok > 0)
      .map((e) => e.modelPattern)
      .filter((m) => !preferred.includes(m))
      .sort();
    return [...preferred, ...new Set(rest)];
  }, [pricing]);

  const suggested = useMemo(
    () =>
      pricing === undefined || dominantModel === undefined
        ? undefined
        : suggestedDowngrade(dominantModel, pricing.table)?.target,
    [pricing, dominantModel],
  );
  const [target, setTarget] = useState<string | undefined>(undefined);
  // With no downgrade, default to the run's own dominant model (a self-map =
  // zero delta, an honest 'no cheaper tier' baseline) rather than candidates[0]
  // — which is the MOST expensive tier and would open on a cost increase.
  const domCandidate =
    dominantModel !== undefined && candidates.includes(dominantModel)
      ? dominantModel
      : undefined;
  const effectiveTarget = target ?? suggested ?? domCandidate ?? candidates[0];

  const result = useMemo(() => {
    if (pricing === undefined || effectiveTarget === undefined) {
      return undefined;
    }
    const targets = new Map<string, string>();
    for (const model of Object.keys(run.totals.costUSD.byModel)) {
      targets.set(model, effectiveTarget);
    }
    return repriceRun(run, pricing.table, targets, DEFAULT_REPRICE_RISK);
  }, [pricing, run, effectiveTarget]);

  if (pricing === undefined) {
    return (
      <p className="text-label text-text-dim">
        Repricing is unavailable because this page carries no pricing payload
        from an older export or CLI. Re-export with a current runray, or open
        the run in <code className="font-mono text-text">runray view</code>.
      </p>
    );
  }
  if (result === undefined || effectiveTarget === undefined) {
    return (
      <p className="text-label text-text-dim">
        No repriceable model tier resolves in the delivered pricing table.
      </p>
    );
  }

  const saving = -result.deltaUSD;
  const safeSaving = -result.safeDeltaUSD;

  return (
    <div className="space-y-3">
      <ContextualHint hintKey="what-if" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-label text-text-dim">
          run everything on
          <select
            value={effectiveTarget}
            onChange={(e) => setTarget(e.target.value)}
            className="rounded-control border border-border-slate bg-surface px-2 py-1 font-mono text-label text-text transition-colors duration-150 ease-out hover:bg-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass"
          >
            {candidates.map((c) => (
              <option key={c} value={c}>
                {c}
                {c === suggested
                  ? ' (suggested)'
                  : c === dominantModel
                    ? ' (current)'
                    : ''}
              </option>
            ))}
          </select>
        </label>
        <PricingProvenance />
      </div>

      <table className="mt-3 w-full border-collapse text-label">
        <thead>
          <tr className="micro-label text-text-faint">
            <th className="pb-1 text-left font-normal">subtree</th>
            <th className="pb-1 text-right font-normal">current</th>
            <th className="pb-1 text-right font-normal">repriced</th>
            <th className="pb-1 text-right font-normal">delta</th>
            <th className="pb-1 text-left font-normal pl-3">risk</th>
          </tr>
        </thead>
        <tbody>
          {result.subtrees
            .filter((c) => c.llmCalls > 0)
            .map((cell) => (
              <tr
                key={cell.rootId ?? 'main'}
                className="border-t border-border-slate"
              >
                <td className="max-w-[220px] truncate py-1.5 pr-3 text-text">
                  {cell.name}
                  <span className="ml-2 font-mono text-text-faint">
                    {cell.llmCalls} calls
                  </span>
                </td>
                <td className="py-1.5 text-right font-mono text-text">
                  {formatUSD(cell.currentUSD)}
                </td>
                <td className="py-1.5 text-right font-mono text-text-dim">
                  {formatUSD(cell.repricedUSD)}
                </td>
                <td
                  className={`py-1.5 text-right font-mono ${
                    cell.deltaUSD < 0 ? 'text-cache-savings' : 'text-text-dim'
                  }`}
                >
                  {cell.deltaUSD < 0 ? '−' : '+'}
                  {formatUSD(Math.abs(cell.deltaUSD))}
                </td>
                <td className="py-1.5 pl-3">
                  <span className="flex flex-wrap gap-1">
                    {cell.flags.map((flag) => (
                      <span
                        key={flag}
                        className={`micro-label rounded-control px-1.5 py-px ${
                          flag === 'errors'
                            ? 'bg-heat-3/15 text-heat-3'
                            : flag === 'unpriced'
                              ? 'bg-heat-2/15 text-heat-2'
                              : 'bg-surface-2 text-text-dim'
                        }`}
                      >
                        {flag}
                      </span>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
        </tbody>
      </table>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 border-t border-border-slate pt-2">
        <p className="text-body text-text">
          <CoverageCaveat runs={[run]} />
          <span
            className={`font-mono ${saving > 0 ? 'text-cache-savings' : 'text-text-dim'}`}
          >
            {saving > 0 ? '−' : '+'}
            {formatUSD(Math.abs(saving))}
          </span>{' '}
          <span className="text-label text-text-dim">full estimate</span>
        </p>
        <p className="text-body text-text">
          <CoverageCaveat runs={[run]} />
          <span
            className={`font-mono ${safeSaving > 0 ? 'text-cache-savings' : 'text-text-dim'}`}
          >
            {safeSaving > 0 ? '−' : '+'}
            {formatUSD(Math.abs(safeSaving))}
          </span>{' '}
          <span className="text-label text-text-dim">
            risk-free (flagged subtrees excluded)
          </span>
        </p>
        <p className="micro-label text-text-faint">
          estimated at {effectiveTarget} rates, assuming identical token usage
        </p>
      </div>
    </div>
  );
}
