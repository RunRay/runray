/**
 * Waste grouping (waste-grouping capability): a session's findings by
 * rule and class, graded as groups, with the burned ones on the session's
 * clock. Browser-safe subpath `@runray/core/waste` — the visualizer
 * renders the Waste tab from these functions, never from a copy.
 */
export {
  type BreakShape,
  type BreakShapeThresholds,
  breakShape,
  contextTokens,
  DEFAULT_BREAK_SHAPE,
} from '../insights/cache-shape.js';
export {
  type ContextCapEstimate,
  type ContextCapEstimates,
  type ContextExcess,
  contextCapEstimates,
  DEFAULT_CONTEXT_CAPS,
} from '../insights/context-excess.js';
export {
  DEFAULT_SEVERITY_THRESHOLDS,
  gradeSeverity,
  type SeverityThresholds,
} from '../insights/severity.js';
export {
  type ContextPoint,
  type LeakEvent,
  type LeakKind,
  type RunWaste,
  type WasteGroup,
  type WasteOccurrence,
  type WasteOptions,
  wasteRun,
} from './group.js';
