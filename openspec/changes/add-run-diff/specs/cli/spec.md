# Delta for cli

## ADDED Requirements

### Requirement: Diff command
The system SHALL expose `runray diff <runA> <runB> [--json]` comparing
two discovered runs. Run references SHALL resolve exactly as the export
command's run selection (exact id, then unique prefix); an ambiguous or
missing reference SHALL exit 3 with the `runray list` hint on stderr.
The human summary SHALL print delta chips as text (absolute and percent,
percent omitted on a zero base) with the worst cost regressions first.
The command SHALL parse with redaction: prompt/output text is never
required to compute or print a diff.

#### Scenario: Ambiguous reference
- GIVEN two discovered runs whose ids share the prefix `run_a`
- WHEN `runray diff run_a run_b` runs
- THEN the process exits with code 3 and stderr suggests `runray list`

### Requirement: Diff scripting contract
`runray diff --json` SHALL print the core `RunDiff` structure verbatim
on stdout, with stderr reserved for warnings. This shape is the CI-gate
input (the planned add-ci-gate change consumes it) and SHALL evolve
additively only: existing fields keep their names, types, and meaning;
new fields may be added.

#### Scenario: CI consumes the diff
- GIVEN any two discovered runs
- WHEN `runray diff <a> <b> --json` runs
- THEN stdout parses as a single JSON document with `a`, `b`, `header`
  (cost, tokens by class, tool errors, llm calls, max depth, wall clock —
  each with absolute values, delta, and percent-or-null), and `alignment`
  (matched pairs, added ids, removed ids, subagent subtree deltas)
