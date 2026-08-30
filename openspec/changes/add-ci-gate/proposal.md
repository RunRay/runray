# Proposal: add-ci-gate

## Why
Monetization path: retrospective dashboards are commoditized free OSS; the unclaimed, buyer-backed value is **enforcement** — failing a PR when an agent run blows its budget, regresses in cost, or violates behavior policy. Buyer: platform engineering, where agents run on API rates in CI.

## What Changes
- New capability **ci-gate**: `runray ci` command (exit code 2 on gate failure) with budget, baseline-regression, and rule-based gates; baseline store with run-to-run variance handling; GitHub Action wrapping headless agent runs and posting a PR comment with the cost diff and embedded single-file report.
- Behavior policies (unauthorized tool / network egress / delegation depth) as gate rules — a shared policy engine.

## Impact
- Affected specs: ci-gate (new); cli (extended: `ci` command, exit code 2); run-diff (consumed as library).
- Affected code: `core/baseline`, `core/policies`, `cli`, new `action/` package (composite GitHub Action).
- Depends on: add-run-diff. Paid-tier boundary begins at org-level baseline store and policy packs.
