# Delta for cost-engine

## ADDED Requirements

### Requirement: Offline token costing
The system SHALL compute USD cost per llm_call span from a bundled pricing snapshot, covering input, output, cache-read, and cache-write token classes, and SHALL function with no network access.

#### Scenario: Cache-aware pricing
- GIVEN an llm_call with cacheRead and cacheWrite tokens
- WHEN cost is computed
- THEN cache classes are priced at their distinct rates, not the base input rate

#### Scenario: Unknown model
- GIVEN a model absent from the pricing snapshot
- WHEN cost is computed
- THEN the span is marked `costSource: unknown`, excluded from cost rollups, and surfaced in the UI

### Requirement: Derived run totals
The system SHALL recompute run totals (tokens by class, cost by model, tool/error counts, delegation depth, cache hit-rate, code modification metrics) from spans, and SHALL NOT trust source-reported aggregate cost for rollups.

#### Scenario: OpenCode zero-cost records
- GIVEN OpenCode messages storing cost as zero
- WHEN totals are derived
- THEN cost reflects the pricing engine's computation from token counts

#### Scenario: Code modification totals
- GIVEN a run whose file-modifying tool_call spans carry `linesAdded`/`linesRemoved`
- WHEN totals are derived
- THEN `totals.codeChanges` sums those values across spans, and the field is omitted entirely when no span reports code changes

### Requirement: Insight rule engine
The system SHALL evaluate configurable rules over each run and emit findings with severity, evidence span ids, an estimated waste in USD where computable, and one actionable suggestion. The v0 rule set SHALL include: retry-loop, low-cache-hit, context-bloat, expensive-subagent, dead-end-run.

#### Scenario: Retry loop detection
- GIVEN three chronologically consecutive failing tool_call spans with the same tool name, each issued by a different llm_call
- WHEN rules are evaluated
- THEN a retry-loop finding references those spans with an estimated waste amount

#### Scenario: Threshold override
- GIVEN a `runray.config.json` raising the low-cache-hit threshold
- WHEN rules are evaluated
- THEN the configured threshold is applied instead of the default
