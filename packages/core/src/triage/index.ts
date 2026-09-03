/**
 * Error triage (error-triage capability): classes, owners, playbooks,
 * clusters. Browser-safe subpath `@runray/core/triage` — the visualizer
 * renders the Errors tab and the Inspector's error sections from these
 * functions, never from a copy.
 */
export { classifyError, type ErrorClassification } from './classify.js';
export {
  type ClusterOutcome,
  type ErrorCluster,
  type ErrorOccurrence,
  type RecoveryKind,
  type RunTriage,
  type TriageTone,
  triageRun,
  triageTone,
} from './cluster.js';
export {
  ERROR_CLASSES_END,
  ERROR_CLASSES_START,
  renderErrorClassesMarkdown,
} from './markdown.js';
export {
  ERROR_CLASS_IDS,
  ERROR_CLASS_META,
  ERROR_OWNER_META,
  ERROR_OWNER_ORDER,
  type ErrorClassId,
  type ErrorClassMeta,
  type ErrorOwner,
  type ErrorOwnerMeta,
  errorClassOwner,
} from './meta.js';
