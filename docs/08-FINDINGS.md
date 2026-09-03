# Findings: what RunRay flags, and how it sizes it

A **finding** is one concrete thing RunRay noticed in a session that cost money it did not have to: a tool that failed three times in a row, a prompt cache that expired during a coffee break, a file read five times without changing. Every finding carries the same four things:

- the **rule** it came from (the kind of problem — the twelve rules are listed below),
- **evidence**: the exact spans in the timeline it is based on,
- an **estimate** in USD, where the data allows one,
- one **suggestion**: what to change.

Before you read the estimate, two questions decide how to treat it.

## Two questions every finding answers

### 1. Is the money gone? — the class

| class | meaning | where it shows up |
|---|---|---|
| **burned** | Spend that bought nothing: retries, cache re-writes, redundant reads, the tail after a fatal error. | Adds up to the run's **wasted** figure — the *Status / Waste* tile above the timeline and *already burned* on the dashboard. Capped at what the run actually cost. |
| **opportunity** | Spend that did buy something but could have been cheaper: a heavy fixed context, a model tier above the task, a cold cache. | Ranked and summed as *efficiency opportunities* on the dashboard. Never added to the wasted figure, so a hypothetical saving is never reported as a loss. |

The class is a property of the rule (see the table below): a retry loop is always burned money, a wrong model tier is always an opportunity.

### 2. How big is it here? — the severity

Severity is **not** a property of the rule. The engine grades every finding after all rules have run, from its estimate as a share of *that run's* total cost:

| severity | default rule | reads as |
|---|---|---|
| `critical` | at least **10 %** of the run's cost **and** at least **$1** | the biggest lever in this session |
| `warning` | at least **2 %** of the run's cost **and** at least **$0.05** | worth a look |
| `info` | everything else | noted, not urgent |

Two consequences worth knowing:

- **The same finding grades differently in different runs.** A $0.60 retry loop is a `warning` in a $0.65 session — it *was* the session — and `info` in a $600 one.
- **Unsized findings are `info`.** No estimate (for example a model missing from the price snapshot) or a run with no priced cost means the engine cannot size the finding, and it does not guess.

The absolute floors exist so that a few cents in a tiny session never read as critical. Shares and floors are configurable — see *Tuning thresholds*.

## The twelve rules

| rule | class | fires when | the estimate counts |
|---|---|---|---|
| `retry-loop` · Repeated failing tool calls | burned | the same tool call (same name and target) fails 3+ times in a row within one scope, tolerating up to 3 other calls in between | model calls in the same scope between the first and the last attempt — each retry re-bills the full context |
| `cache-prefix-break` · Cache prefix broken mid-session | burned | between two consecutive calls of the same model the cached prefix collapses (≥ 20k tokens read, then ≤ 20 % of that) and ≥ 10k tokens are written again | the re-written prefix at the cache-write premium over the cache-read rate |
| `idle-cache-expiry` · Cache expired while idle | burned | a pause longer than the live cache's TTL (5 min, or 60 min when the previous call wrote a 1-hour cache), followed by a ≥ 10k-token re-write | the re-written prefix at the cache-write premium |
| `duplicate-read` · Same file re-read unchanged | burned | the same file is read 3+ times with no write to it in between | the redundant reads' output (≈ bytes ÷ 4 tokens) at the input rate |
| `scattered-tool-failures` · Scattered tool failures | burned | 5+ isolated tool failures outside retry loops, making up ≥ 20 % of tool calls | the model calls that reacted to the failures |
| `dead-end-run` · Run ended in an error | burned | the session terminates on a failure | model calls after the last completed code change — nothing was produced after that point |
| `fixed-context-overhead` · Heavy fixed context | opportunity | the very first call already carries ≥ 20k tokens (tool definitions, project instructions) and the run has 5+ calls | the excess, written once and re-read on every later call |
| `model-mismatch` · Wrong model tier | opportunity | a cheaper same-family model would save ≥ $0.50 on calls that are not risky (few tool calls, modest context) | the risk-free repricing delta |
| `expensive-subagent` · Expensive subagent | opportunity | one delegated subtree costs > 50 % of the run and ≥ $0.25 | the subtree repriced one tier down; no cheaper tier means no figure |
| `context-bloat` · Growing context | opportunity | the last calls' input is 2× the first calls' and above 50k tokens | the cumulative excess over the starting context, at the input rate |
| `low-cache-hit` · Low cache hit-rate | opportunity | hit-rate below 40 % on a run costing more than $0.10 with 5+ calls | what a 60 % hit-rate would have saved |
| `oversized-output` · Oversized tool output | opportunity | tool outputs of 100 kB or more enter the context | ≈ bytes ÷ 4 tokens at the input rate — usefulness is unknowable, so never burned |

Estimates marked ≈ rely on the four-bytes-per-token heuristic and say so in the finding text.

## Where findings appear

- **Dashboard → Potential savings.** Burned and opportunity totals side by side, then the top three rules by amount with their worst findings expandable in place. *Open in timeline* jumps to the evidence and lights it up.
- **Timeline → findings strip.** One pill per finding, ranked by amount, tinted by severity. Click one to highlight its evidence rows and open it in the Inspector.
- **Timeline → rows.** Every row that is evidence of a finding carries a severity-coloured notch in the left gutter and a ⚠ chip, with a count when several findings share the row. Hover for the list; click the chip to open the finding.
- **Inspector.** With an evidence row selected, switch between *Activity* (the span) and *Finding* (why it was flagged, and what share of the run it represents). A row under several findings offers a chip per finding.
- **CLI.** `runray export --json <file>` writes the normalized trace with every finding, its `severity`, `estimatedWasteUSD` and `spanIds`.

## Tuning thresholds

Detection gates and the severity tiers live under `insights.thresholds` in `runray.config.json`, looked up in the current directory and then in `~/.config/runray/`. Set only the keys you want to change. The defaults:

```json
{
  "insights": {
    "thresholds": {
      "severity": { "warningShare": 0.02, "warningFloorUSD": 0.05, "criticalShare": 0.1, "criticalFloorUSD": 1 },
      "retryLoop": { "minFailures": 3, "maxGapToolCalls": 3 },
      "lowCacheHit": { "maxHitRate": 0.4, "minCostUSD": 0.1, "minLlmCalls": 5, "targetHitRate": 0.6 },
      "contextBloat": { "multiplier": 2, "minMedianInputTokens": 50000, "topCulprits": 3 },
      "expensiveSubagent": { "minShareOfRunCost": 0.5, "minCostUSD": 0.25 },
      "modelMismatch": { "minSavingsUSD": 0.5, "riskToolCalls": 25, "riskContextTokens": 150000 },
      "cachePrefixBreak": { "minPrefixTokens": 20000, "collapseRatio": 0.2, "rewriteFloorTokens": 10000 },
      "idleCacheExpiry": { "minIdleMinutes": 5, "rewriteFloorTokens": 10000 },
      "fixedContextOverhead": { "floorTokens": 20000, "minLlmCalls": 5 },
      "duplicateRead": { "minRepeats": 3 },
      "scatteredToolFailures": { "minFailures": 5, "minErrorShare": 0.2 },
      "oversizedOutput": { "minOutputBytes": 100000, "topOffenders": 5 }
    }
  }
}
```

Raising `severity.criticalShare` to `0.25`, for example, reserves `critical` for findings that eat a quarter of a session. Thresholds change what fires and how it is graded; the estimate formulas themselves are fixed.

## What the numbers do not claim

- **Wasted is capped at the run's cost.** Overlap between burned rules is only partly de-duplicated, so the cap keeps the headline honest.
- **Unpriced models have no dollar figure.** Their calls show tokens without USD, the totals are marked as understated, and their findings grade `info`. `runray pricing --refresh` fetches current prices — the only network call RunRay ever makes, and only when you ask for it.
- **Opportunities describe a counterfactual.** "Would have cost $X less on a cheaper model" assumes the cheaper model would have done the job; the risk flags exclude the subtrees where that is least likely.
- **Findings are a pure function of the log.** Same session, same prices, same thresholds — the same findings, byte for byte.

Normative details live in [02-DATA-MODEL.md](02-DATA-MODEL.md) (the `Insight` record) and [05-ARCHITECTURE.md](05-ARCHITECTURE.md) §2.4 (rule formulas and registration order).
