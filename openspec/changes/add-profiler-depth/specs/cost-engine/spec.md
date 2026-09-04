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
attributed to idle-cache-expiry only. Each cache-prefix-break finding
SHALL classify the break by what survived, from the two calls' token
shapes: *compaction* when the breaking call's context (input + cacheRead
+ cacheWrite) is below the configured shrink ratio of the previous call's,
*front* when fewer than the configured base tokens stayed cached (the tool
list, system prompt or a setting changed), else *history* (the fixed front
stayed cached and the conversation was written again). The detail and the
suggestion SHALL follow the shape; the estimate SHALL NOT depend on it.
The low-cache-hit savings target SHALL be configurable, defaulting to 0.6,
never below the firing threshold.

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

#### Scenario: Shape follows what survived
- GIVEN three breaks after a 200k-token cached call: one where 38k tokens
  stay cached and 190k are written again, one where 1k stays cached and
  200k are written again, and one where the breaking call's whole context
  is 60k tokens
- WHEN rules are evaluated
- THEN the findings read as a history re-write, a front change and a
  compaction respectively, with different suggestions and the same
  re-write-premium estimate formula

### Requirement: Context overhead insights
The system SHALL detect sessions whose first llm_call context footprint
(input + cacheRead + cacheWrite) exceeds a configurable floor, pricing the
overhead as one cache write plus a cache read per subsequent call; and the
context-bloat rule SHALL measure each call's full input-class context
(input + cacheRead + cacheWrite) of the main session (subagent calls
excluded, as for the footprint), fire when the median of the last three
calls exceeds the configured multiple of the first three and the floor,
and estimate the cumulative excess over the baseline median across all
later calls, each call's excess priced at what that call actually paid per
input-class token (its input, cache-read and effective cache-write legs) —
never a trailing-window approximation, and never the input rate for tokens
that were served from cache. The finding SHALL state that this estimate is
an upper bound which assumes the work could have continued from a
compacted context.

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

#### Scenario: Cached growth is visible and priced as cache reads
- GIVEN a run whose calls read 10k tokens from cache at the start and
  150k tokens from cache at the end, with a few thousand fresh input
  tokens per call throughout
- WHEN context-bloat is evaluated
- THEN it fires on the cached growth and prices the excess at the
  cache-read rate, not the input rate

#### Scenario: Subagent calls do not drag the medians
- GIVEN a main session whose context is flat at 80k tokens and a subagent
  whose calls run at 5k tokens
- WHEN context-bloat is evaluated
- THEN it stays silent

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

### Requirement: Severity grading
The system SHALL assign each finding's severity centrally in the engine,
after rule evaluation, from the finding's estimated waste as a share of the
run's total cost: `critical` when the share is at least the critical share
AND the amount is at least the critical floor; `warning` when the share is
at least the warning share AND the amount is at least the warning floor;
`info` otherwise. Findings without an estimate, and findings on runs with
zero priced cost, SHALL be `info`. The shares and floors SHALL be
configurable under `insights.thresholds.severity` (defaults: warning 2% /
$0.05, critical 10% / $1). Rules SHALL NOT set severity themselves, and
severity SHALL be independent of the rule's waste/opportunity class.

#### Scenario: Same rule, different runs
- GIVEN two runs with a retry-loop finding worth $0.60, one run costing
  $0.65 and the other $600
- WHEN rules are evaluated
- THEN the first finding is `warning` and the second is `info`

#### Scenario: Critical needs both share and amount
- GIVEN a $0.50 finding on a $0.50 run and a $20 finding on a $100 run
- WHEN severity is graded
- THEN the first is `warning` (below the $1 floor) and the second is
  `critical`

#### Scenario: No estimate means info
- GIVEN a finding whose waste could not be priced
- WHEN severity is graded
- THEN it is `info` regardless of its rule

### Requirement: Suggestions address the person running the agent
Every finding's `suggestion` SHALL be one sentence addressed to the person
running the agent, naming a lever that person has (a command, a
configuration key, an instructions file, a model switch), never an
instruction the model would have to follow. Where the finding's own numbers
change the decision (the cost of one loop, the per-call cache-read cost of a
large context, the tokens re-written) the sentence SHALL carry them, and
where the lever differs by source the sentence SHALL pick it by
`run.source.tool` (Claude Code, OpenCode, or a custom agent for OTLP and
unknown sources). Each rule SHALL register a playbook in the rule metadata
registry — causes, actions per source, limits — which is the single source
for the generated docs section "How to fix, rule by rule" and for the
Inspector.

#### Scenario: A retry loop on a shell tool points at the instructions file
- GIVEN a Claude Code run with a retry-loop finding on `Bash`
- WHEN the finding is emitted
- THEN its suggestion names `CLAUDE.md` as the place to record the missing
  environment fact, and the same finding on an OpenCode run names
  `AGENTS.md`

#### Scenario: An idle expiry states the running cost
- GIVEN an idle-cache-expiry finding after a two-hour gap that re-wrote 50k
  tokens
- WHEN the finding is emitted
- THEN its suggestion says to compact before a long break or start a new
  session, and states the cache-read cost every further call in that
  context pays

#### Scenario: Playbook coverage
- GIVEN the registered rule set
- WHEN the metadata registry is checked
- THEN every rule has a playbook with at least one cause, at least one
  action for each of Claude Code, OpenCode and custom agents, and at least
  one limit, and the committed docs block equals the rendered registry

### Requirement: Findings quote the failure
Where a failed tool span carries an error preview, retry-loop SHALL quote
the last failure's first line (whitespace collapsed, at most 120
characters) in its detail, dead-end-run SHALL name the failing step's
reason, and scattered-tool-failures SHALL quote the dominant tool's most
recent error. Without a preview (redacted, or not captured by the source)
the findings SHALL read exactly as before, with no placeholder.

#### Scenario: Retry loop names the error
- GIVEN three consecutive Bash failures whose last error reads "The token
  '&&' is not a valid statement separator."
- WHEN the finding is emitted
- THEN its detail quotes that sentence as the last error

#### Scenario: Redaction leaves no trace of the text
- GIVEN the same session parsed with `--redact`
- WHEN the findings are emitted
- THEN no finding text contains any part of the error, and no placeholder
  stands in for it

### Requirement: Context ceiling estimates
The system SHALL expose, under a browser-safe subpath, the context-excess
formula the `context-bloat` rule prices with — from the fourth main-scope
call on, each call's input-class tokens above a floor, priced at what that
call actually paid per input-class token — and a function that, for a run,
reports the rule's own figure (the floor being the median context of the
first three main-scope calls) alongside the same formula evaluated with a
ceiling in place of the baseline for 100k, 200k and 400k tokens. The rule
SHALL compute its estimate through that same function, so the two cannot
diverge; without a pricing table the token figures SHALL stand and the
amounts SHALL be undefined; a run with fewer than six main-scope calls
SHALL yield nothing, as the rule never fires there.

#### Scenario: The rule and the ceilings agree
- GIVEN a run on which context-bloat fires
- WHEN the ceiling estimates are computed with the same pricing table
- THEN the figure against the baseline equals the finding's
  `estimatedWasteUSD`, and the amounts decrease as the ceiling rises

#### Scenario: Unpriced stays honest
- GIVEN the same run and no pricing table
- WHEN the ceiling estimates are computed
- THEN the token figures are present and every amount is undefined
