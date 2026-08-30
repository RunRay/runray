/**
 * Rule presentation metadata (add-profiler-depth B1/X1). The single source
 * of truth for how a rule is shown (label, one-line explanation) and how it
 * is classified: 'waste' = money already burned, rolled into
 * `totals.costUSD.wastedEstimate`; 'opportunity' = hypothetical saving that
 * carries `estimatedWasteUSD` for ranking but never inflates the rollup.
 * The engine derives its waste-class membership from this registry and the
 * UI renders from it, so classification cannot drift between core and UI.
 *
 * Browser-safe: exported as `@runray/core/insights-meta`, zero imports —
 * the import-graph purity test enforces that. Every rule registered in
 * V0_RULES MUST have an entry here (test-enforced); unknown ids in the UI
 * fall back to the literal slug with class 'opportunity'.
 */

export type RuleClass = 'waste' | 'opportunity';

export interface RuleMeta {
  /** Human-readable label shown instead of the rule-id slug. */
  label: string;
  /** One-line explanation of what the finding means for the user. */
  explain: string;
  class: RuleClass;
}

export const RULE_META: Readonly<Record<string, RuleMeta>> = {
  'retry-loop': {
    label: 'Repeated failing tool calls',
    explain:
      'The same tool failed several times in a row — every retry re-billed the full context.',
    class: 'waste',
  },
  'low-cache-hit': {
    label: 'Low cache hit-rate',
    explain:
      'Most input tokens were paid at the full rate instead of being served from the prompt cache.',
    class: 'opportunity',
  },
  'context-bloat': {
    label: 'Growing context',
    explain:
      'Input tokens grew steadily across the session, so every later call re-paid an ever-larger context.',
    class: 'opportunity',
  },
  'expensive-subagent': {
    label: 'Expensive subagent',
    explain: "One delegated subtree dominated the run's spend.",
    class: 'opportunity',
  },
  'dead-end-run': {
    label: 'Run ended in an error',
    explain:
      'The session terminated on a failure — spend after the last productive step bought nothing.',
    class: 'waste',
  },
  'model-mismatch': {
    label: 'Wrong model tier',
    explain:
      'These calls would cost less on a cheaper same-family model; risky subtrees are excluded from the estimate.',
    class: 'opportunity',
  },
  'cache-prefix-break': {
    label: 'Cache prefix broken mid-session',
    explain:
      'The cached prompt prefix was invalidated mid-session, so already-cached content was re-written at the premium rate.',
    class: 'waste',
  },
  'idle-cache-expiry': {
    label: 'Cache expired while idle',
    explain:
      'A long pause let the prompt cache expire — the next call re-wrote the whole prefix at the premium rate.',
    class: 'waste',
  },
  'fixed-context-overhead': {
    label: 'Heavy fixed context',
    explain:
      'The session starts with a large fixed context (tool definitions, project instructions) that every later call re-reads.',
    class: 'opportunity',
  },
  'duplicate-read': {
    label: 'Same file re-read unchanged',
    explain:
      'The same file was read repeatedly with no edit in between; each redundant read re-enters the context as fresh input.',
    class: 'waste',
  },
  'scattered-tool-failures': {
    label: 'Scattered tool failures',
    explain:
      'Many isolated tool failures forced extra model calls to react and recover.',
    class: 'waste',
  },
  'oversized-output': {
    label: 'Oversized tool output',
    explain:
      'Very large tool outputs entered the context; their usefulness is unknowable, so this never counts as burned waste.',
    class: 'opportunity',
  },
};

/** Classification for a rule id; unknown ids are treated as 'opportunity'. */
export function ruleClass(ruleId: string): RuleClass {
  return RULE_META[ruleId]?.class ?? 'opportunity';
}
