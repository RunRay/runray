/**
 * Names the Codex adapter writes into spans and other modules read back.
 * Kept apart from the adapter, which is Node-only, so an insight rule can
 * share the constant without importing a parser. Import-free.
 */

/** `agent.name` of the approval reviewer's `subagent` span: the thread
 * Codex opens when `approvals_reviewer = "auto_review"` hands an approval
 * prompt to a model. It is the word the rollout itself uses for it. */
export const CODEX_REVIEWER_AGENT = 'guardian';
