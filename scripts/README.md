# scripts/

Maintenance scripts. Run from the repo root.

## scrub-fixture.ts — make a real agent log committable (task 1.3)

Fixtures are **sacred** (see `AGENTS.md`): they are collected and scrubbed by a
human, never fabricated by an agent, and **no real prompt text, path, or
username ever lands in git**. This script is the only sanctioned path from a
raw log to a committed fixture.

### What it does

- Replaces every string with deterministic lorem of the **same character
  length** — except structural keys (ids, timestamps, roles, models, flags),
  which stay byte-identical. Token/usage counts are numbers and are preserved.
- Canonicalizes paths to `/home/user/project/…`, length-preserved, no real
  names.
- Redacts your OS username/hostname and key-shaped strings (`sk-…`, `Bearer …`,
  32+ hex) everywhere.
- Writes a `SCRUBBED` marker (a leading meta record for JSONL, a top-level
  field for JSON). CI refuses fixtures without it.

Output is deterministic: the same raw input always scrubs to the same bytes, so
goldens stay stable.

### The workflow

1. **Pick sessions** that fill the matrix in `docs/04-SAMPLE-LOGS.md §4`:
   `simple`, `subagents`, `tool-errors`, `large` — per source. Generate missing
   variants deliberately (ask Claude Code to use a subagent; run a command that
   fails 3×).

2. **Drop the raw file** under a `raw/` directory (git-ignored, so raw data
   never leaves your machine):

   ```
   fixtures/claude-code/subagents/raw/<session>.jsonl
   ```

3. **Scrub it** (writes the sibling `fixtures/claude-code/subagents/<session>.jsonl`):

   ```sh
   pnpm scrub fixtures/claude-code/subagents/raw/<session>.jsonl
   ```

   Or choose the output path explicitly:

   ```sh
   pnpm scrub <raw-file> -o <out-file> --source claude-code
   ```

4. **Verify** (non-negotiable, `docs/04-SAMPLE-LOGS.md §5`) — the script prints
   these commands with your username filled in:

   - `grep -ri "<your-username>" <out-file>` returns nothing
   - no real repo/file names remain, the file still parses
   - the `SCRUBBED` marker is present

5. **Commit** the scrubbed file. Do **not** commit anything under `raw/`.

Goldens in `fixtures/normalized/` are **not** produced here — they are generated
from these fixtures once the adapters exist (task 2.6), in a dedicated commit.

### Layout

```
fixtures/
  claude-code/<variant>/raw/*.jsonl   # git-ignored raw input
  claude-code/<variant>/*.jsonl       # committed, scrubbed
  opencode/<variant>/…
  otlp/<variant>/…
  normalized/…                        # goldens, added at task 2.6
```

### Directory mode (multi-file stores)

Pass a directory instead of a file and every `.json`/`.jsonl` beneath it is
scrubbed into a mirrored output tree — for stores that scatter one session
across many files (OpenCode file storage; Claude Code session + subagents
trees). Each output file carries its own marker (the convention the committed
claude-code subagents fixture established), and **non-JSON files are skipped,
never copied** (same posture as default-scrub: unknown content never lands in
git). With the raw tree under `raw/`, output derivation works as usual:

```sh
pnpm scrub fixtures/opencode/storage/simple/raw --source opencode
```

### SQLite mode (OpenCode `opencode.db`)

A `.db` input dumps one root session (`--session <ses_id>`, descendant
subagent sessions included automatically), scrubs the row JSON with the
opencode key rules, and rebuilds a fresh db containing only the
session/message/part tables plus an `x_tracepulse_scrub` marker table. Copy the
live db before scrubbing — never point this at `~/.local/share/opencode`
directly:

```sh
pnpm scrub <copy-of-opencode.db> --session <ses_id> -o fixtures/opencode/sqlite/<variant>/opencode.db
```

### OTLP captures (`--source otlp`)

OTLP/JSON needs its own handling: it encodes ids, timestamps, attribute keys,
and int64 token counts as JSON **strings**, which the default-scrub would
corrupt. `pnpm scrub … --source otlp` (auto-detected from the `resourceSpans`
envelope) keeps `traceId`/`spanId`/`parentSpanId`, `*UnixNano`, `gen_ai.*`
attribute keys and numeric values byte-identical, anonymizes user/account/org
identity attributes, and lorem's only free-text values.

## otlp-sink.mjs — capture Claude Code beta OTLP traces (task 1.3)

A dev-only, loopback-only sink that persists the OTLP/JSON Claude Code exports
when its native tracing (beta) is enabled — no OTel Collector needed. Run it,
then run `claude -p …` with the telemetry env vars; spans stream to a file.

```sh
node scripts/otlp-sink.mjs "$HOME/otlp-capture.json"   # or: pnpm otlp-sink -- <outFile> [port]
```

Full capture recipe (env vars, the required `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`
flag, `simple`/`subagents` variants) lives in `fixtures/otlp/README.md`.
