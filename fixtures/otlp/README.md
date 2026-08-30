# otlp fixtures — Claude Code native traces (beta)

The OTLP cell of the fixture matrix (`docs/04-SAMPLE-LOGS.md §4`): OTLP/JSON
exported from **Claude Code's own beta tracing**, which the `otlp` adapter
(task 2.8) imports by mapping `resourceSpans → spans`. You do **not** install
anything — tracing is built into Claude Code; you enable it with env vars and
capture the export locally.

Target layout (raw is git-ignored via `fixtures/**/raw/`; commit only scrubbed):

```
fixtures/otlp/claude-traces-beta/
  raw/simple.json        # git-ignored raw capture (real email/prompts)
  simple.json            # committed, scrubbed
  raw/subagents.json
  subagents.json
```

## 1. Start the sink (terminal 1)

No collector needed — `scripts/otlp-sink.mjs` persists the OTLP/JSON POSTed by
Claude Code (loopback only). **One capture = one sink run = one file:** the sink
starts empty and overwrites its output on the first batch, so give each variant
its own filename and restart the sink between variants.

```powershell
node scripts/otlp-sink.mjs "$env:USERPROFILE\otlp-simple.json"   # restart with otlp-subagents.json for variant 2
```

## 2. Enable tracing and run Claude Code (terminal 2)

Env is per-process, so set it in the **same** shell that runs `claude`:

```powershell
$env:CLAUDE_CODE_ENABLE_TELEMETRY        = '1'
$env:CLAUDE_CODE_ENHANCED_TELEMETRY_BETA = '1'   # REQUIRED — without it: no resourceSpans, only metrics/logs
$env:OTEL_TRACES_EXPORTER   = 'otlp'
$env:OTEL_METRICS_EXPORTER  = 'none'             # keep the capture traces-only
$env:OTEL_LOGS_EXPORTER     = 'none'
$env:OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json'   # readable OTLP/JSON straight to the sink
$env:OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318'
$env:OTEL_TRACES_EXPORT_INTERVAL = '1000'        # flush fast so a short run exports before exit
```

Then run ONE variant, `Ctrl+C` the sink, restart it with the other filename,
and run the other — in any directory that has a `package.json`:

```powershell
claude -p "list the files in this directory and read package.json"   # -> otlp-simple.json
claude -p "use a subagent to review README.md"                        # -> otlp-subagents.json (nests under claude_code.tool)
```

POSIX shells: use `export VAR=value` for the same vars.

Span names are Claude-specific and **beta** (`claude_code.interaction` root →
`claude_code.llm_request` / `claude_code.tool` / `claude_code.tool.execution`),
so pin the CLI version you captured with — names/attributes may change between
releases. Attributes are structural by default (durations, model, token
counts); prompt text only appears with `OTEL_LOG_USER_PROMPTS=1` (and Claude
Code emits a `user_prompt` attribute regardless) — the scrubber handles it.

## 3. Scrub before committing (non-negotiable)

A raw capture carries your **real email, account/org ids, and prompt text**.
The OTLP-aware scrub path keeps structural fields byte-identical (hex
trace/span ids, `*UnixNano` timestamps, `gen_ai.*` attribute keys, token
counts), anonymizes identity attributes, and lorem's free-text values:

```powershell
pnpm scrub "$env:USERPROFILE\otlp-simple.json" `
  -o fixtures/otlp/claude-traces-beta/simple.json --source otlp
pnpm scrub "$env:USERPROFILE\otlp-subagents.json" `
  -o fixtures/otlp/claude-traces-beta/subagents.json --source otlp
```

`--source otlp` is auto-detected from the `resourceSpans` envelope, but pass it
to be explicit. Verify (`docs/04-SAMPLE-LOGS.md §5`): the `SCRUBBED` marker is
present, the file parses, and `grep -ri "<your-username>"` / your email return
nothing.
