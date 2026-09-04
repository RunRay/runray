import { Fragment } from 'react';
import { splitInlineCode } from '../lib/inline-code';

/**
 * Playbook primitives shared by the Inspector (rule playbooks) and the
 * Errors tab (error-class playbooks): a numbered list of actions in the
 * registry's order, a labelled bullet list, and inline code runs set in
 * mono. One rendering for both registries, so a lever reads the same
 * wherever it appears.
 */

/** A playbook line with its backtick runs set in mono. */
export function InlineCode({ line }: { line: string }) {
  const seen = new Map<string, number>();
  return (
    <>
      {splitInlineCode(line).map((run) => {
        const n = (seen.get(run.text) ?? 0) + 1;
        seen.set(run.text, n);
        const key = `${run.code ? 'c' : 't'}${n}:${run.text}`;
        return run.code ? (
          <code
            key={key}
            className="rounded-control bg-surface-2 px-1 font-mono text-[0.92em] text-text"
          >
            {run.text}
          </code>
        ) : (
          <Fragment key={key}>{run.text}</Fragment>
        );
      })}
    </>
  );
}

/** Actions, numbered: the registry orders them most effective first. */
export function PlaybookSteps({ actions }: { actions: readonly string[] }) {
  return (
    <ol className="space-y-1.5">
      {actions.map((line, i) => (
        <li
          key={line}
          className="flex gap-2 text-label leading-[1.45] text-text"
        >
          <span
            aria-hidden
            className="w-3 shrink-0 text-right font-mono text-text-faint tabular-nums"
          >
            {i + 1}
          </span>
          <span className="min-w-0">
            <InlineCode line={line} />
          </span>
        </li>
      ))}
    </ol>
  );
}

export function PlaybookList({
  label,
  lines,
}: {
  label: string;
  lines: readonly string[];
}) {
  return (
    <div>
      <p className="micro-label mb-1 text-text-faint">{label}</p>
      <ul className="space-y-1">
        {lines.map((line) => (
          <li key={line} className="text-label leading-[1.45] text-text-dim">
            <InlineCode line={line} />
          </li>
        ))}
      </ul>
    </div>
  );
}
