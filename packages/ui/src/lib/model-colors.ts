/**
 * Stable model → color assignment (sessions-table dots, stacked-bar
 * segments, legends), sorted by name so the same model gets the same color
 * everywhere. Uses the dedicated model ramp (03-design.md §2) — NOT the
 * span-kind palette, which keeps its single meaning.
 */

const MODEL_CLASSES = [
  'bg-model-1',
  'bg-model-2',
  'bg-model-3',
  'bg-model-4',
] as const;

const MODEL_VARS = [
  'var(--color-model-1)',
  'var(--color-model-2)',
  'var(--color-model-3)',
  'var(--color-model-4)',
] as const;

export function assignModelColors(
  models: Iterable<string>,
): Map<string, string> {
  const map = new Map<string, string>();
  [...new Set(models)].sort().forEach((model, i) => {
    map.set(model, MODEL_CLASSES[i % MODEL_CLASSES.length] ?? 'bg-model-1');
  });
  return map;
}

/**
 * The same stable assignment as `assignModelColors`, but as `var(--color-…)`
 * strings for SVG `fill`/`stroke` (the stacked spend chart) — index-aligned
 * with the classes so a model's dot and its stacked segment match.
 */
export function assignModelColorVars(
  models: Iterable<string>,
): Map<string, string> {
  const map = new Map<string, string>();
  [...new Set(models)].sort().forEach((model, i) => {
    map.set(model, MODEL_VARS[i % MODEL_VARS.length] ?? MODEL_VARS[0]);
  });
  return map;
}

/**
 * Source-tool → chart color (the "By source" stacked segments + legend).
 * Borrows the muted span-kind hues purely as chart categories; always shown
 * with a labelled legend, never as a bare swatch.
 */
export const SOURCE_COLOR_VAR: Record<string, string> = {
  'claude-code': 'var(--color-span-llm)',
  opencode: 'var(--color-span-tool)',
  otlp: 'var(--color-span-mcp)',
  unknown: 'var(--color-span-hook)',
};

export function sourceColorVar(source: string): string {
  return SOURCE_COLOR_VAR[source] ?? 'var(--color-span-hook)';
}
