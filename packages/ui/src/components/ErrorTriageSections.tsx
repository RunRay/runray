import {
  PLAYBOOK_SOURCE_LABEL,
  resolvePlaybookSource,
} from '@runray/core/insights-meta';
import { ERROR_CLASS_META, ERROR_OWNER_META } from '@runray/core/triage';
import type { Run, Span } from '@runray/schema';
import type { ReactNode } from 'react';
import { formatDuration, formatUSD } from '../lib/format';
import { OWNER_FILL, OWNER_TEXT, runTriage } from '../lib/triage';
import { useAppStore } from '../store';
import { InlineCode, PlaybookList, PlaybookSteps } from './PlaybookSteps';

/**
 * The Inspector's error sections (visualizer "Inspector error sections"):
 * for a failed span, "What this is" — the class, its owner, what happened
 * to this occurrence (did the tool come back, what the reaction cost) —
 * and "What you can do" for the run's own source, from the same registry
 * the Errors tab renders. A declined call gets one sentence instead. The
 * sections read from the cached run triage, so the Inspector and the tab
 * never disagree about a span.
 */
export function ErrorTriageSections({ span, run }: { span: Span; run: Run }) {
  const navigateTo = useAppStore((s) => s.navigateTo);
  if (span.status === 'cancelled') {
    return (
      <Section title="What this is">
        <p className="text-label leading-[1.45] text-text-dim">
          You declined this call
          {span.statusReason === 'user-rejected'
            ? ''
            : ` (${span.statusReason ?? 'cancelled'})`}
          . It is not counted as an error and no finding reacts to it.
        </p>
      </Section>
    );
  }
  if (span.status !== 'error') return null;
  const triage = runTriage(run);
  const cluster = triage.clusters.find((c) =>
    c.occurrences.some((o) => o.spanId === span.id),
  );
  if (cluster === undefined) return null;
  const occurrence = cluster.occurrences.find((o) => o.spanId === span.id);
  const meta = ERROR_CLASS_META[cluster.classId];
  const owner = ERROR_OWNER_META[cluster.owner];
  const source = resolvePlaybookSource(run.source.tool);
  const showActions =
    cluster.owner === 'you' ||
    cluster.owner === 'tooling' ||
    cluster.owner === 'model' ||
    cluster.owner === 'unknown' ||
    (cluster.owner === 'agent' &&
      (cluster.count >= 2 || cluster.outcome !== 'recovered'));

  const outcome: string[] = [];
  if (occurrence !== undefined) {
    const r = occurrence.recovery;
    const what =
      span.kind === 'llm_call' ? 'model call' : `${cluster.tool} call`;
    if (r.kind === 'ok') {
      outcome.push(
        `The next ${what} succeeded${r.afterMs === undefined ? '' : ` ${formatDuration(r.afterMs)} later`}.`,
      );
    } else if (r.kind === 'error') {
      outcome.push(`The next ${what} failed too.`);
    } else {
      outcome.push(`No later ${what} in this scope.`);
    }
    if (occurrence.reactionUSD > 0) {
      outcome.push(
        `The model call reacting to it cost ${formatUSD(occurrence.reactionUSD)}.`,
      );
    }
  }

  return (
    <>
      <Section title="What this is">
        <p className="flex items-center gap-1.5 font-mono text-label text-text">
          <i
            aria-hidden
            className={`inline-block h-2 w-2 rounded-[2px] ${OWNER_FILL[cluster.owner]}`}
          />
          <span className={OWNER_TEXT[cluster.owner]}>{owner.label}</span>
          <span className="text-text-faint">·</span>
          <span>{meta.label}</span>
        </p>
        <p className="mt-1.5 text-label leading-[1.45] text-text-dim">
          <InlineCode line={meta.explain} />
        </p>
        {outcome.length > 0 && (
          <p className="mt-1.5 text-label leading-[1.45] text-text-dim">
            {outcome.join(' ')}
          </p>
        )}
      </Section>
      <Section
        title={
          showActions
            ? `What you can do · ${PLAYBOOK_SOURCE_LABEL[source]}`
            : 'Nothing to do'
        }
      >
        {showActions ? (
          <PlaybookSteps actions={meta.playbook.actions[source]} />
        ) : (
          <PlaybookList label="Why" lines={meta.playbook.limits} />
        )}
        <button
          type="button"
          onClick={() => navigateTo({ view: 'errors', runId: run.id })}
          className="mt-2 rounded-control px-1 py-0.5 text-label text-brand transition-colors duration-150 ease-out hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary active:bg-bg"
        >
          {cluster.count === 1
            ? 'The only one in this session → Errors'
            : `All ${cluster.count} in this session → Errors`}
        </button>
      </Section>
    </>
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
