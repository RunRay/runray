# large fixture — generated locally, not committed

The `large` perf fixture (`large.jsonl`, target ≥ 30–50 MB) drives the bench
harness (task 2.7) and the performance budgets in `docs/05-ARCHITECTURE.md §5`
(e.g. "parse 100 MB JSONL < 5 s"). It is **deliberately not committed** — a
~46 MB blob would bloat git history permanently. It is git-ignored via
`fixtures/**/large/*.jsonl`.

Each contributor generates it once, locally, before running `pnpm bench`. Any
sufficiently large session works — the bench only needs volume and a valid,
scrubbed file. Never commit the result.

## Option A — scrub a real large session (preferred)

Find your biggest Claude Code session and scrub it into place.

POSIX (bash/zsh):

```sh
# 1. locate your largest sessions
ls -lS ~/.claude/projects/*/*.jsonl | head -5

# 2. copy the biggest into raw/ (git-ignored) and scrub
mkdir -p fixtures/claude-code/large/raw
cp "<biggest-session>.jsonl" fixtures/claude-code/large/raw/large.jsonl
pnpm scrub fixtures/claude-code/large/raw/large.jsonl
```

Windows (PowerShell):

```powershell
# 1. locate your largest sessions
Get-ChildItem "$env:USERPROFILE\.claude\projects\*\*.jsonl" |
  Sort-Object Length -Descending |
  Select-Object -First 5 @{n='MB';e={[math]::Round($_.Length/1MB,2)}}, FullName

# 2. copy the biggest into raw/ (git-ignored) and scrub
New-Item -ItemType Directory -Force fixtures\claude-code\large\raw
Copy-Item "<biggest-session>.jsonl" fixtures\claude-code\large\raw\large.jsonl
pnpm scrub fixtures\claude-code\large\raw\large.jsonl
```

The scrubbed `fixtures/claude-code/large/large.jsonl` appears next to this
README and stays local (git-ignored).

## Option B — synth-multiply a committed fixture

If you have no large session of your own, inflate a committed fixture to the
target size (naive concatenation duplicates record ids, which breaks tree
reconstruction and tool pairing — the helper rewrites them per copy):

```sh
pnpm synth-large        # ~32 MB from tool-errors; refuses to overwrite
pnpm synth-large 64     # custom target size in MB
```

`pnpm bench` runs this automatically when `large.jsonl` is absent (that is
how CI gets its fixture). A real scrubbed session (Option A) is still the
better benchmark — synthetic copies repeat the same shape.

## Verify (same rules as any fixture, `docs/04-SAMPLE-LOGS.md §5`)

The scrub script prints the checks with your username filled in:

```sh
grep -ri "<your-username>" fixtures/claude-code/large/large.jsonl   # must be empty
```

The file must parse, carry the `SCRUBBED` marker, and contain no real
repo/file names.
