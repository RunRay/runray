# Proposal: add-run-diff

## Why
Beta feedback path and CI prerequisite: users iterate on prompts/workflows and need to know whether a change made the agent cheaper or more reliable. Comparing two runs of the same task is also the technical foundation of the v1 regression gate.

## What Changes
- New capability **run-diff**: `runray diff <runA> <runB> [--json]` computing cost/token/error/depth deltas and a paired span alignment; new Diff view in the visualizer (`#/diff/:a/:b`).

## Impact
- Affected specs: run-diff (new); visualizer (extended with Diff view per `03-design.md §4.5`).
- Affected code: `core/diff` (pure, deterministic), `cli`, `ui`.
- Depends on: deterministic normalization from add-local-trace-viewer.
