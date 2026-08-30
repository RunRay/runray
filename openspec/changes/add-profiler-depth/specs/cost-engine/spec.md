# Delta for cost-engine

## MODIFIED Requirements

### Requirement: Insight rule engine
The system SHALL evaluate configurable rules over each run and emit findings
with severity, evidence span ids, an estimated waste in USD where computable,
and one actionable suggestion. Rules SHALL be evaluated against the same
effective pricing table used to price the run's spans — never
unconditionally against the bundled snapshot. Each rule SHALL be classified
via the rule-metadata registry as waste-class (money already burned) or
opportunity-class (hypothetical saving); `totals.costUSD.wastedEstimate`
SHALL sum only waste-class findings and SHALL never exceed
`totals.costUSD.total`. The rule set SHALL comprise, in fixed registration
order: retry-loop, low-cache-hit, context-bloat, expensive-subagent,
dead-end-run, model-mismatch, cache-prefix-break, idle-cache-expiry,
fixed-context-overhead, duplicate-read, scattered-tool-failures,
oversized-output. Evaluation SHALL be deterministic: fixed registration
order, findings in first-evidence chronological order, byte-stable output
for identical input.

#### Scenario: Refreshed pricing reaches insight dollars
- GIVEN a user pricing override written by `pricing --refresh` with rates
  differing from the bundled snapshot
- WHEN rules are evaluated during discovery
- THEN waste estimates (e.g. low-cache-hit) are computed from the override's
  rates, not the bundled snapshot's

#### Scenario: Windowed retry detection
- GIVEN four failing tool_call spans with the same name and target identity,
  interleaved with at most three other same-scope tool calls between
  consecutive failures
- WHEN rules are evaluated
- THEN a single retry-loop finding references all four failures with an
  estimated waste amount

#### Scenario: Retry attribution respects parallel subtrees
- GIVEN a retry loop inside one subagent while a sibling subagent runs
  llm_calls in the same time window
- WHEN retry-loop waste is estimated
- THEN only llm_calls in the failing subagent's scope (or direct parents of
  the failures) are counted

#### Scenario: Expensive model with a cheap alternative
- GIVEN a run spending $40 on a top-tier model where the risk-free portion
  would cost $12 at the suggested lower tier
- WHEN rules are evaluated
- THEN a model-mismatch finding reports the −$28 estimate with the excluded
  risky subtrees counted, and the run's wastedEstimate is unchanged

#### Scenario: No double counting with the delegation finding
- GIVEN a subagent subtree that qualifies for an expensive-subagent finding
- WHEN model-mismatch is evaluated
- THEN that subtree's spans are excluded from the model-mismatch estimate and
  its detail counts the subtrees covered by the delegation finding

#### Scenario: Threshold override
- GIVEN a `runray.config.json` raising the low-cache-hit threshold
- WHEN rules are evaluated
- THEN the configured threshold is applied instead of the default

#### Scenario: Wasted estimate never exceeds spend
- GIVEN a run where multiple waste-class findings overlap in attribution
- WHEN totals are recomputed by the insight engine
- THEN `totals.costUSD.wastedEstimate` is at most `totals.costUSD.total`

## ADDED Requirements

### Requirement: Insight rule metadata
Every registered insight rule SHALL carry presentation metadata — a
human-readable label, a one-line explanation, and a class of `waste` (money
already burned) or `opportunity` (achievable saving) — in a single
core-owned registry consumable by the UI without importing runtime adapters;
the engine's wasted-estimate rollup SHALL derive its waste-class membership
from this metadata so classification cannot drift between core and UI; and
every registered rule SHALL have a metadata entry (test-enforced).

#### Scenario: Single source of classification
- GIVEN the registry classifies `dead-end-run` as waste and `low-cache-hit`
  as opportunity
- WHEN `totals.costUSD.wastedEstimate` is computed and the UI splits the
  savings panel
- THEN both derive from the same metadata and agree

#### Scenario: Metadata is presentation-only
- GIVEN the metadata module is added
- WHEN normalized goldens are regenerated
- THEN they are byte-identical to before (metadata never enters the
  TraceFile)

### Requirement: Failed-tail waste attribution
The dead-end-run rule SHALL attribute waste to the failed tail: the cost of
llm_call spans after the last successful tool span carrying code-change
counts, minus any llm cost already claimed by retry-loop findings within
that tail. Only when the run contains no successful code-changing span SHALL
the full run cost be claimed.

#### Scenario: Productive run that dies at the end
- GIVEN a run with successful Edit spans followed by a failing terminal span
- WHEN dead-end-run is evaluated
- THEN estimated waste covers only llm_calls after the last successful Edit,
  not the full run cost

#### Scenario: Run that produced nothing
- GIVEN a failing run containing no successful code-changing tool span
- WHEN dead-end-run is evaluated
- THEN estimated waste equals the run's total cost

### Requirement: Subagent repricing quantification
The expensive-subagent rule SHALL estimate the saving of delegating the
qualifying subtree to the suggested cheaper tier by re-pricing each
llm_call's exact token counts at the cheaper tier's rates via the repricing
primitive, and SHALL state the target model and delta in the suggestion.
When no cheaper tier or pricing match exists, the finding SHALL be emitted
without an estimate and SHALL say why.

#### Scenario: Opus subtree repriced at Sonnet
- GIVEN a subagent subtree on an Opus-class model consuming over half the
  run's cost
- WHEN the rule is evaluated
- THEN the finding carries estimatedWasteUSD equal to the subtree cost minus
  the same tokens priced at the Sonnet-class rates

#### Scenario: No cheaper tier
- GIVEN a qualifying subtree whose dominant model has no cheaper same-family
  entry in the effective pricing table
- WHEN the rule is evaluated
- THEN the finding is emitted without estimatedWasteUSD and the detail
  states the estimate is unavailable

### Requirement: Cache lifecycle insights
The system SHALL detect mid-session cache prefix invalidation (cacheRead
collapse with a cacheWrite spike between consecutive same-model llm_calls)
and idle-gap cache expiry (an idle gap of at least the live cache's TTL —
60 minutes when the live prefix in that scope/model stream was last
written with a majority 1h share, else the configured provider-default
TTL — followed by a cacheWrite spike), pricing each event as the re-write
premium — re-written tokens times the difference between the EFFECTIVE
cache-write rate (the 5m/1h blend of the re-writing span, per the
TTL-aware pricing requirement) and the cache-read rate — with the breaking
call as evidence. When an event satisfies both predicates it SHALL be
attributed to idle-cache-expiry only. The low-cache-hit savings target
SHALL be configurable, defaulting to 0.6, never below the firing
threshold.

#### Scenario: Mid-session prefix break
- GIVEN call N−1 with 80k cacheRead and call N with 2k cacheRead and 75k
  cacheWrite, with no qualifying idle gap
- WHEN rules are evaluated
- THEN a cache-prefix-break finding cites calls N−1 and N and prices
  min(75k, 80k) tokens at the effective-write-minus-read rate delta

#### Scenario: Idle gap claims the break
- GIVEN the same collapse pattern on a 5m-TTL cache (no 1h share recorded
  on the live prefix) with a 12-minute gap between the two calls
- WHEN rules are evaluated
- THEN an idle-cache-expiry finding is emitted for the pair and no
  cache-prefix-break finding duplicates it

### Requirement: Context overhead insights
The system SHALL detect sessions whose first llm_call context footprint
(input + cacheRead + cacheWrite) exceeds a configurable floor, pricing the
overhead as one cache write plus a cache read per subsequent call; and the
context-bloat estimate SHALL be the cumulative excess input tokens across
all calls beyond the baseline median, not a trailing-window approximation.

#### Scenario: Session born bloated
- GIVEN a session whose first llm_call carries a 95k-token context footprint
  and 20 llm_calls total, with flat growth thereafter
- WHEN rules are evaluated
- THEN a fixed-context-overhead finding fires (context-bloat stays silent)
  pricing the overhead above the floor as one write plus nineteen reads

#### Scenario: Cumulative bloat pricing
- GIVEN a run where median input grows from 20k to 60k across 30 calls
- WHEN context-bloat is evaluated
- THEN the estimate sums each call's excess over the 20k baseline rather
  than three times the final delta

### Requirement: Tool-usage insights
The system SHALL detect repeated reads of an unchanged target (same tool
identity, no intervening write to that target) priced by the re-read
output's approximate token cost; a scattered tool-failure share (failures
not claimed by retry-loop findings exceeding a configurable share) priced by
the distinct llm_calls reacting to those failures; and oversized tool
outputs reported as an opportunity-class finding listing the top offenders,
never entering the waste rollup.

#### Scenario: Duplicate read of an unchanged file
- GIVEN three successful reads of the same target key with no write to that
  key between them
- WHEN rules are evaluated
- THEN a duplicate-read finding cites the reads and prices the two redundant
  reads' output bytes as input tokens

#### Scenario: Legitimate re-read after an edit
- GIVEN read → edit → read of the same target key
- WHEN rules are evaluated
- THEN no duplicate-read finding is emitted

#### Scenario: Scattered failures excluding retry loops
- GIVEN a run with 30% tool errors of which one cluster is claimed by
  retry-loop
- WHEN rules are evaluated
- THEN scattered-tool-failures counts only the unclaimed failures against
  its share threshold and prices only their reaction llm_calls

### Requirement: What-if repricing primitive
The system SHALL provide a pure, deterministic repricing function over a
normalized run, a pricing table, and a source→target model mapping,
producing per-span and per-subtree cost deltas (subtrees = innermost
subagent subtrees plus the main session, computed once in core as the
canonical attribution cells), rollup totals, and a risk-free ("safe") delta;
output ordering SHALL be stable (spans in run order, subtrees by absolute
delta descending then root id ascending), all sums rounded to micro-dollars,
and the function SHALL be importable without any Node-only or native
dependency so the visualizer can execute it in-browser and in offline
exports.

#### Scenario: Downgrade delta for a priced run
- GIVEN a run whose llm_call spans ran on an expensive model present in the
  pricing table
- WHEN the run is repriced with a mapping to a cheaper model in the same
  table
- THEN each span carries current cost, repriced cost (same token quad at the
  target's input/output/cacheRead/cacheWrite rates, with any adapter-recorded
  1h cache-write share priced at the TARGET's 1h rate per the TTL-aware
  pricing requirement), and their delta, and the rollup equals the rounded
  sum of span deltas

#### Scenario: Unknown-cost spans never fabricate a delta
- GIVEN a run containing an llm_call with `costSource: unknown`
- WHEN the run is repriced
- THEN that span reports no delta, its enclosing subtree is flagged
  `unpriced`, and the safe delta excludes that subtree

### Requirement: Downgrade risk annotation
The system SHALL annotate each repriced subtree with deterministic risk
flags — `errors` (any error-status span inside), `tool-fanout` (tool/mcp
call count at or above a configurable threshold), `long-context` (any llm
call whose input plus cacheRead tokens meet a configurable threshold), and
`unpriced` — and SHALL expose the thresholds through the existing
insight-threshold configuration.

#### Scenario: Risky subtree excluded from the safe figure
- GIVEN a subagent subtree containing a failing tool call
- WHEN the run is repriced
- THEN the subtree is flagged `errors` and its delta is reported but
  excluded from the safe delta

### Requirement: Cheaper-tier suggestion
The system SHALL maintain a versioned, hardcoded model-tier ladder (per
model family, ordered from most to least capable) and SHALL resolve a
suggested downgrade for a model as the next ladder step that exists in the
effective pricing table with nonzero base rates; resolution SHALL be
deterministic and require no network access, and models without a resolvable
downgrade SHALL yield no suggestion.

#### Scenario: Ladder resolves against the effective table
- GIVEN a model at the top tier of its family and an effective pricing table
  containing the next tier down
- WHEN a downgrade suggestion is requested
- THEN the next-tier model is returned, and if the table lacked every lower
  tier no suggestion would be returned

### Requirement: TTL-aware cache-write pricing
Cache-write tokens SHALL be priced by TTL tier: the share recorded by an
adapter as 1-hour-TTL (span attribute `tracepulse.cacheWrite1hTokens`,
clamped to the span's cacheWrite total) SHALL bill at the entry's published
1h rate (`cacheWrite1hPerMTok`, stored only when the source publishes a
positive value within a sanity band of the 5m write rate — [1×, 4×] — so
upstream zero-fills and copy-paste garbage never become authority); when
no 1h rate is published, entries whose canonical pattern contains `claude`
SHALL derive Anthropic's documented 2×-input premium and every other entry
SHALL bill the 1h share at its plain cache-write rate — the engine SHALL
never invent a premium a provider does not charge. Every consumer that prices
cache-write tokens (span costs, what-if repricing, insight waste estimates)
SHALL use the same effective-rate computation, and the idle-cache-expiry
rule SHALL treat a pair as expirable only after 60 minutes when the LIVE
cached prefix in that scope/model stream — the most recent writing span,
not necessarily the pre-gap span itself — was written with a majority 1h
share.

#### Scenario: 1h share billed at the 1h rate
- GIVEN an llm_call whose cacheWrite is 300k tokens of which the adapter
  recorded 200k as 1h-TTL
- WHEN the span is priced against a claude entry with no published 1h rate
- THEN 100k tokens bill at cacheWritePerMTok and 200k at 2× inputPerMTok

#### Scenario: No invented premium for other providers
- GIVEN the same span repriced onto a non-claude entry without a published
  1h rate
- WHEN the what-if delta is computed
- THEN the whole cacheWrite quad prices at that entry's cacheWritePerMTok

#### Scenario: Insight waste reconciles with span cost
- GIVEN a cache-prefix-break pair whose re-writing span is 100% 1h-TTL
- WHEN the finding's estimatedWasteUSD is computed
- THEN the re-written tokens price at the same effective (1h) write rate the
  span's own costUSD used

#### Scenario: A short gap cannot expire a 1h cache
- GIVEN a collapse pair with a 12-minute gap where the live prefix was
  written with a majority 1h share — by the pre-gap span or by an earlier
  span in the same scope/model stream (a read-only pre-gap turn does not
  forget the TTL)
- WHEN rules are evaluated
- THEN no idle-cache-expiry finding is emitted and cache-prefix-break may
  claim the pair instead

### Requirement: Unpriced-cost coverage
The system SHALL compute, per run, an unpriced-coverage statistic — total
llm calls, unpriced llm calls (`costSource: unknown`), unpriced token count,
and the sorted list of offending model names — derived purely from spans and
recomputed on demand, never persisted into the frozen TraceFile schema.

#### Scenario: Coverage names the offending models
- GIVEN a run where 3 of 40 llm calls used a model absent from the pricing
  table
- WHEN coverage is computed
- THEN it reports 3 unpriced calls, their summed tokens, and the model names
  in stable order, and `complete` is false
