/**
 * The git-branch glyph that precedes every branch name (run header, sessions
 * table, Top branches, the filter chip), so a branch reads as one at a
 * glance next to a project name. Decorative: the name beside it carries the
 * meaning, and the surrounding label says "branch" where it matters.
 */
export function BranchMark({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`inline-block h-3 w-3 shrink-0 ${className}`}
    >
      <circle cx="6" cy="5" r="2.25" />
      <circle cx="6" cy="19" r="2.25" />
      <circle cx="18" cy="7" r="2.25" />
      <path d="M6 7.25v9.5" />
      <path d="M18 9.25c0 4.5-4 6.25-9.75 7.5" />
    </svg>
  );
}

/**
 * A branch name after its glyph, in mono, truncating from the end. The
 * wrapper clips, so when there is no room left the glyph disappears with
 * the name instead of spilling past it. `announce` adds a visually hidden
 * "branch" for screen readers; leave it off where a visible label already
 * says so.
 */
export function BranchName({
  name,
  announce = true,
  className = '',
  markClassName = '',
}: {
  name: string;
  announce?: boolean;
  className?: string;
  markClassName?: string;
}) {
  return (
    <span
      className={`flex min-w-0 items-center gap-1 overflow-hidden font-mono ${className}`}
      title={name}
    >
      <BranchMark className={markClassName} />
      {announce && <span className="sr-only">branch </span>}
      <span className="truncate">{name}</span>
    </span>
  );
}
