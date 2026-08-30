# RunRay — User Personas

Status: working personas — updated July 2026 to include the Enterprise Solutions Architect.

## How to use this doc

1. **Feature/insight decisions.** Before adding or cutting a feature or insight rule, check it against these five — does at least one persona clearly need it? If none do, question whether it belongs in scope (see `01-FEATURES.md` scope legend).
2. **Testing lens.** When dogfooding (`runray view` on your own sessions) or reviewing a beta user's feedback, run it through a persona's eyes: what would make *this specific person* say "wow" vs. shrug and go back to `ccusage`. Each persona ends with a testing lens for exactly this.

**Explicitly out of scope:** none of these personas cares about model/prompt *quality* benchmarking (which model/prompt produces better output). That's intentional, not a gap — RunRay is a cost/efficiency observability tool with no scoring or golden-answer evaluation; that need belongs to Langfuse/LangSmith-style eval platforms, which `00_Index_RunRay.md` explicitly treats as adjacent, not a target to replicate.

---

## A. Marcus Chen — the indie builder

**Role & context:** 32, solo founder bootstrapping a niche B2B SaaS. Ex-corporate engineer, now the only developer on the payroll — his own runway pays the API bill.

**Setup:** Claude Code via the Anthropic API (pay-as-you-go), mostly Sonnet with Opus for the hard problems. Delegates aggressively — spins up 3-4 subagents in parallel for research, implementation, and test-writing on any non-trivial feature. MacBook, works solo, no team infra.

**A day in his agent usage:** Kicks off a feature build and forks subagents to parallelize a refactor, a test suite, and docs. One subagent gets stuck retrying against a flaky API mock and quietly burns $6 before he notices. By evening he has a $38 bill for one feature and no idea which part of it was necessary.

**Goals (JTBD):** "When I finish a session, I want to see exactly which tool calls and subagents cost me money, so I can decide if my delegation pattern is worth repeating."

**Frustrations with status quo:** `ccusage` gives him a daily/monthly total with no attribution to a specific run or task. Raw JSONL is unreadable. The Anthropic console lags and reports at the account level, not the session level — he can't tie a dollar figure back to a decision he made.

**Quote:** *"I don't mind spending $40 on a feature that ships. I mind spending $40 and not knowing why."*

**MVP features that matter most:** M7 Cost Breakdown (stacked cost by model, treemap by tool/agent, explicit wasted-spend callouts), M9 Insights (`retry-loop`, `expensive-subagent`, `dead-end-run`), M6 Timeline Waterfall (to see the actual subagent tree that produced the bill), M11 privacy defaults (his code is his product — nothing leaves the machine).

**Testing lens:** Run `runray view` on one of his own $30+ sessions. **Wow:** he immediately points at one bar or insight and says "there it is." **Meh:** he has to manually dig through the waterfall to find something `ccusage`'s total already implied.

---

## B. Priya Iyer — the day-job subscriber

**Role & context:** 28, mid-level backend engineer at a ~200-person company, working in a large legacy monorepo. Given a Claude Max seat by her employer.

**Setup:** Claude Code only, company-sanctioned. Flat monthly subscription — she has no visibility into (and no interest in) dollar cost. Subject to a weekly message/usage limit enforced by Claude Code's own UI. Mostly single-agent sessions; her org hasn't encouraged heavy subagent delegation yet.

**A day in her agent usage:** Assigned a refactor across a service she doesn't know well. Claude Code keeps re-reading the same 2,000-line file every turn because context isn't being reused. Midway through the day she gets an "approaching weekly limit" warning with no explanation of what consumed it, and has to decide whether to ration her remaining prompts through the rest of the week.

**Goals (JTBD):** "When I'm mid-task, I want to see whether the agent is being efficient with my weekly limit, so I know whether to keep going, restructure the task, or start fresh."

**Frustrations with status quo:** Claude Code's own limit indicator is a vague progress bar with no per-session breakdown. She's never billed directly, so a tool that only speaks in dollars feels irrelevant to her day-to-day decision, which is entirely about *quota*, not *cost*.

**Quote:** *"I don't care what it costs the company. I care whether I'll still have prompts left on Thursday."*

**MVP features that matter most:** M6 Timeline Waterfall (see what's happening turn to turn), M9 Insights especially `low-cache-hit-rate` and `context-bloat` (explains *why* quota is disappearing fast) — critically, this only lands if usage is framed in tokens/% of limit, not USD, per the subscription-cost framing risk (usage limits, not dollars, are what plan users watch).

**Testing lens:** **Wow:** the tool explains, in tokens/plain language, why her session is expensive without ever needing to show a dollar figure. **Meh:** the UI defaults to USD everywhere and she bounces because it doesn't map to the thing she actually manages — her weekly limit.

---

## C. Alex Okafor — the cross-tool tinkerer

**Role & context:** 35, senior freelance engineer running several client engagements in parallel, each with different tooling. Active in OSS/self-hosted and r/LocalLLaMA-adjacent communities.

**Setup:** Runs both OpenCode and Claude Code depending on the client. Picks models per task on cost/capability tradeoffs (cheap model for boilerplate, Sonnet/Opus for hard problems). Distrusts vendor lock-in and default-on cloud dashboards, especially with client code involved.

**A day in his agent usage:** In one week he touches three client repos — one on Claude Code, one on OpenCode's legacy file storage, one recently migrated to OpenCode's SQLite backend. He wants one place to compare token burn and delegation patterns across all three without learning three log formats or trusting three separate vendor dashboards.

**Goals (JTBD):** "When I look back at a week across clients, I want one normalized view of agent cost/behavior regardless of which tool or storage format produced it, so I can compare apples to apples and feed the data into my own scripts."

**Frustrations with status quo:** Every vendor ships its own ad hoc export format. OpenCode is mid-migration, so even OpenCode's own tooling doesn't have a stable answer yet. He won't hand client code to a cloud dashboard by default.

**Quote:** *"If I have to learn a new log format every time a vendor ships an update, that's not a moat, that's a chore."*

**MVP features that matter most:** M2/M3 adapters (Claude Code + both OpenCode storage eras), M4 normalization to a single schema, M8 session list spanning all discovered runs, S1 `--json` output (feeds his own scripts), M11 local-only/zero network calls (non-negotiable for client work).

**Testing lens:** **Wow:** an OpenCode SQLite session and a Claude Code JSONL session sit side by side in the same session list, comparably, with no visible seams. **Meh:** the tool visibly treats one adapter as second-class — missing fields, thinner insight coverage.

---

## D. Sam Whitfield — the platform engineer (forward-looking, v1)

**Role & context:** 41, platform engineer / EM at a ~150-person company where ~15 developers use Claude Code day to day. **Not an MVP power-user** — included because this persona's emergence is itself a signal worth watching for (see testing lens below).

**Setup:** Doesn't run `runray` personally. Encounters it secondhand — a `report.html` shows up in a PR or Slack thread, or he's the one approving next quarter's Anthropic API budget line.

**A day in his agent usage:** End of month, he's looking at an aggregate API invoice with no per-repo or per-dev breakdown. Separately, he suspects at least one team's agent sessions are "going in circles" — long sessions, little shipped code — but has no tooling to confirm it, let alone gate it before merge.

**Goals (JTBD):** "When I approve next quarter's agent budget, I want evidence of where the money and time actually go across the team, so I can set guardrails instead of guessing."

**Frustrations with status quo:** No visibility beyond the raw vendor invoice. No way to say "this workflow costs 3x what it should" with evidence attached. Nothing stops an over-eager agent from blowing budget in CI.

**Quote:** *"I don't need everyone's tool. I need one report I can point at in a budget meeting."*

**MVP features that matter most:** M10 export (`report.html`) — the artifact that reaches him secondhand. Indirectly, M9 Insights, since "did this session look wasteful" is exactly the `retry-loop`/`dead-end-run` signal. **Not yet served by MVP:** C1-C5 (`runray ci`, budget gate, team dashboard) — this persona is the one whose appearance validates the "≥1 user asks unprompted about a team/CI version" validation metric.

**Testing lens:** He shouldn't be tested by handing him `runray view` during MVP. The real test: is an exported `report.html`, seen secondhand, self-explanatory enough that he asks *"can I get this for my whole team?"* unprompted.

---

## E. Elena Rostova — the enterprise solutions architect

**Role & context:** 38, Principal Solutions Architect / AI Lead at a 300-person software house. Responsible for defining internal AI SDLC standards, evaluating developer agent tooling, and guiding architecture for 50+ engineers.

**Setup:** Orchestrates complex multi-agent pipelines (Claude Code, OpenCode, custom OTel scripts) across diverse OS environments (Windows/Mac/Linux) and installation methods (`npm install -g`, `winget`, binary downloads).

**A day in her agent usage:** Tries to roll out an internal agent tracing script to a team of Solutions Architects and PMs. The script fails on half the machines because it assumes a specific `winget` installation path, and breaks on another because a recent Claude CLI release subtly changed a log property name. She spends her afternoon debugging telemetry setup rather than agent performance.

**Goals (JTBD):** "When I evaluate or recommend an agent observability tool to my team, I want zero-config auto-discovery and schema-drift resilience so anyone can run it instantly without breaking or setting up Docker/Grafana sidecars."

**Frustrations with status quo:** Traditional APM setups (Grafana/Jaeger sidecars) require heavy configuration and break whenever vendor CLI log formats drift. Custom setup scripts fail when team members install tools via npm instead of system package managers.

**Quote:** *"If my team has to debug the observability tool before they can debug their agents, nobody is going to use it."*

**MVP features that matter most:** M1 log auto-discovery (robust across `npm`, `winget`, and global installation paths), M2 resilient/best-effort log parsing (handles schema drift gracefully without crashing), M11 zero-config local setup (no DBs, API keys, or sidecars), M10 `report.html` export (easy sharing with project leads).

**Testing lens:** **Wow:** She installs `runray` via npm, runs `runray view`, and it instantly auto-detects session logs regardless of how Claude Code was installed, rendering traces reliably despite minor log schema changes. **Meh:** The tool relies on hardcoded path assumptions or breaks when a vendor updates their CLI log schema.

---

## Persona-to-feature quick reference

| Feature / Insight | A. Marcus | B. Priya | C. Alex | D. Sam | E. Elena |
|---|---|---|---|---|---|
| M1 Log Auto-Discovery (robust across npm/winget/global) | — | — | — | — | ✅ |
| M6 Timeline Waterfall | ✅ | ✅ | — | — | ✅ |
| M7 Cost Breakdown / wasted spend | ✅ | — | — | (via M10) | ✅ |
| M8 Session list (cross-source) | — | — | ✅ | — | — |
| M9 `retry-loop` / `expensive-subagent` / `dead-end-run` | ✅ | — | — | ✅ | ✅ |
| M9 `low-cache-hit-rate` / `context-bloat` | — | ✅ | — | — | — |
| M2/M3 Adapters (multi-format / schema drift resilient) | — | — | ✅ | — | ✅ |
| M10 `export` (report.html) | — | — | — | ✅ | ✅ |
| S1 `--json` output | — | — | ✅ | — | — |
| M11 Local-only / privacy / zero-config | ✅ | — | ✅ | — | ✅ |
| C1-C5 `runray ci` / budget / team dashboard (v1, not built) | — | — | — | ✅ (aspirational) | ✅ (aspirational) |
