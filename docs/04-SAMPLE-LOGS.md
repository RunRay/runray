# RunRay — Sample Log Acquisition (fixtures)

Goal: within ~30 minutes on your machines, assemble the fixture set that Track A tests against and Track B builds UI on. Fixtures are the shared ground truth for the whole project.

## 1. Claude Code (priority 1)

Location: `~/.claude/projects/<project-dir>/<session-uuid>.jsonl` (Windows: `%USERPROFILE%\.claude\projects\...`). One JSONL file per session; records per message. **Subagent transcripts are separate files** (CC ≥ 2.1): `<project-dir>/<session-uuid>/subagents/agent-<agentId>.jsonl`, workflow agents under `subagents/workflows/wf_*/` — a complete fixture must include this subtree.

```bash
ls -lhS ~/.claude/projects/*/ | head          # find candidates by size
wc -l ~/.claude/projects/<dir>/<id>.jsonl     # sanity check
```

Fields to expect per record (verify on your data — this drives the adapter):
`type` (user/assistant/system/attachment/queue-operation/…), `message.role`, `message.model`, `message.usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`), `message.content[]` (incl. `tool_use` / `tool_result` blocks), `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`, `toolUseResult` (for `Agent` calls: `{agentId, status, resolvedModel, outputFile, …}` — the subagent join), `isSidechain` (legacy subagent marker — always `false` on CC ≥ 2.1).

Generate missing variants deliberately:
- **subagents:** run a session that spawns a subagent via the `Agent` tool (`Task` in older versions) — e.g. ask Claude Code to "use a subagent to review this file". Copy the session `.jsonl` **and** its `<session-uuid>/subagents/` subtree; scrub every file (the scrub script works per file).
- **tool-errors:** ask for a command that fails 3× (e.g. run a test that doesn't exist, insist it retries).
- **duplicate-records:** a desktop-app session that was bridged (the transcript carries `bridge-session` records) and re-appended from the start afterwards — every record before the bridge appears a second time with the same `uuid`, later in the file. Slice a few original stretches plus their later copies (keep the `bridge-session` record between them) and scrub; the adapter must emit each span once.

## 2. OpenCode (priority 2)

Two storage eras — capture both:

**A. File storage (legacy, still common):**
```bash
ls ~/.local/share/opencode/storage/session/*/            # ses_*.json (metadata)
ls ~/.local/share/opencode/storage/message/<sessionID>/  # msg_*.json
ls ~/.local/share/opencode/storage/part/<messageID>/     # tool/text/reasoning parts
```

**B. SQLite (current migration target):**
```bash
opencode db path                       # locate opencode.db
sqlite3 "$(opencode db path)" ".tables"
```
Assistant messages carry token counts (input, output, reasoning, cache_read, cache_write); note that stored `cost` is `0` — cost is always ours to compute.

**C. Easiest single-session tap:**
```bash
opencode export <sessionID> > fixtures/opencode/export-json/simple.json
```

Custom dir override: `OPENCODE_DATA_DIR` (also comma-separated archive roots).

## 3. OTLP (priority 3 — power-user path)

Claude Code native traces (beta) with subagent nesting. Tracing is built in —
nothing to install — but it is gated behind an **extra beta flag** on top of
telemetry; without it you get only metrics/logs, no `resourceSpans`:
```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1   # REQUIRED for spans
export OTEL_TRACES_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=none              # keep the capture traces-only
export OTEL_LOGS_EXPORTER=none
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json   # readable OTLP/JSON, no collector needed
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_TRACES_EXPORT_INTERVAL=1000        # flush fast so short runs export
```
Run `scripts/otlp-sink.mjs` (loopback, no OTel Collector needed) in one shell,
then a non-interactive `claude -p "…"` in this one — spans POST straight to the
sink as OTLP/JSON. Copy the output into `fixtures/otlp/claude-traces-beta/` and
scrub with `--source otlp` (keeps trace/span ids, `*UnixNano`, `gen_ai.*` keys
and token counts byte-identical; anonymizes email/account/org identity). Span
names/attrs are beta (`claude_code.*`, not `gen_ai.*` span names) — treat this
adapter as best-effort, pin the CLI version, and pin what you observe in the
fixture. Full recipe: `fixtures/otlp/README.md`.

## 4. Fixture matrix (definition of done)

| Source | simple | subagents | tool-errors | large (perf) |
|---|---|---|---|---|
| claude-code (jsonl) | ☐ | ☐ | ☐ | ☐ ≥50 MB or synth-multiplied |
| opencode storage (files) | ☐ | ☐ | ☐ | — |
| opencode sqlite | ☐ | ☐ | — | — |
| opencode export json | ☐ | — | — | — |
| otlp json | ☐ | ☐ | — | — |

Plus `fixtures/normalized/` — golden outputs of the normalizer for every cell above (generated once adapters exist; snapshot-tested forever).

## 5. Anonymization (non-negotiable before commit)

Logs contain prompts, file paths, and code. Repo rule: **no real prompt/output text ever lands in git.**

`scripts/scrub-fixture.ts` must:
1. Replace all prompt/output/tool-result text with deterministic lorem of the **same character length** (token-ish counts preserved; usage numbers stay untouched — they're the point).
2. Rewrite paths → `/home/user/project/...`; strip usernames, hostnames, git remotes, env values.
3. Drop/blank any `apiKey`-shaped strings defensively (regex for `sk-`, `Bearer`, 32+ hex).
4. Keep every structural field byte-identical (ids, timestamps, usage, flags) so adapters exercise real shapes.
5. Emit a `SCRUBBED` marker field at file top-level; CI refuses fixtures without it.

Verification checklist per fixture: `grep -ri "$(whoami)"` clean · no real repo names · file parses · adapter golden test green.
