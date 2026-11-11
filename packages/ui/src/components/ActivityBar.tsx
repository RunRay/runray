import type { ToolUsage } from '@runray/core/tools';
import { formatDuration } from '../lib/format';
import { type ActivityPart, formatShare } from '../lib/tool-usage';

/**
 * Summed tool time by activity (visualizer "Tool time by activity"): one
 * stacked bar and a legend that carries every value as text. The figure is
 * a sum of call durations, so its heading says so: parallel calls overlap
 * and the sum can exceed the clock. Selecting a part narrows the tool table
 * below; the legend entries are the keyboard path, the bar parts a pointer
 * shortcut to the same action.
 */

function describe(part: ActivityPart): string {
  const members =
    part.members.length > 0 ? ` (${part.members.join(', ')})` : '';
  return `${part.label}${members} ${formatDuration(part.totalMs)}, ${formatShare(part.share)}`;
}

export function ActivityBar({
  usage,
  parts,
  selected,
  onSelect,
}: {
  usage: ToolUsage;
  parts: readonly ActivityPart[];
  /** Id of the selected part, or null. */
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const toggle = (id: string) => onSelect(selected === id ? null : id);
  const current = parts.find((p) => p.id === selected);

  return (
    <section
      className="rounded border border-border-slate bg-surface-container-low p-4 shadow-card"
      aria-label="Tool time by activity"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="micro-label text-text-faint">
          summed tool time · {formatDuration(usage.summedMs)}
        </p>
        <p className="text-label text-text-faint">
          A sum of call durations. Parallel calls overlap, so it can exceed the
          clock.
        </p>
      </div>

      <div
        className="mt-2 flex h-6 w-full gap-px overflow-hidden rounded-control border border-border-slate"
        role="img"
        aria-label={parts.map(describe).join('; ')}
      >
        {parts.map((part) => (
          <button
            key={part.id}
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => toggle(part.id)}
            title={`${part.label} · ${formatDuration(part.totalMs)} · ${formatShare(part.share)}`}
            style={{ flexGrow: part.totalMs }}
            className={`h-full min-w-[3px] basis-0 cursor-pointer transition-opacity duration-150 ease-out hover:opacity-80 active:opacity-70 ${part.fill} ${
              selected !== null && selected !== part.id ? 'opacity-30' : ''
            }`}
          />
        ))}
      </div>

      <ul className="mt-3 gap-x-6 sm:columns-2" data-testid="activity-legend">
        {parts.map((part) => (
          <li key={part.id} className="break-inside-avoid">
            <button
              type="button"
              aria-pressed={selected === part.id}
              onClick={() => toggle(part.id)}
              title={
                part.kind === 'unresolved'
                  ? 'Commands whose program could not be named: a variable in its place, or a name outside the tool list.'
                  : part.members.length > 0
                    ? part.members.join(', ')
                    : undefined
              }
              className="flex w-full items-center gap-2 rounded-control px-1.5 py-1 text-left text-label text-text-dim transition-colors duration-150 ease-out hover:bg-surface-variant/40 hover:text-text active:bg-surface-variant aria-pressed:bg-surface-variant aria-pressed:text-text"
            >
              <i
                aria-hidden
                className={`inline-block h-2.5 w-2.5 shrink-0 rounded-[2px] ${part.fill}`}
              />
              <span className="min-w-0 flex-1 truncate">
                {part.label}
                {part.members.length > 0 && (
                  <span className="text-text-faint">
                    {' '}
                    {part.members.join(', ')}
                  </span>
                )}
              </span>
              <span className="font-mono text-text">
                {formatDuration(part.totalMs)}
              </span>
              <span className="w-10 text-right font-mono text-text-faint">
                {formatShare(part.share)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {current !== undefined && (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-label text-text-dim">
          <span>
            The tool table shows{' '}
            <span className="text-text">{current.label.toLowerCase()}</span>{' '}
            only.
          </span>
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="rounded border border-border-slate bg-surface px-2 py-0.5 text-label text-on-surface-variant transition-colors duration-150 ease-out hover:bg-surface-variant hover:text-on-surface active:bg-bg-deep-gray"
          >
            Show all activities
          </button>
        </p>
      )}
    </section>
  );
}
