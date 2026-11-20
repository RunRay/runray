# large fixture — generated locally, not committed

The `large` Codex rollout drives the Codex row of the bench (`pnpm bench`,
"parse large Codex rollout") and its budget in `docs/05-ARCHITECTURE.md §5`:
100 MB of rollout text in under 5 s. Like the Claude Code one next door it
is **deliberately not committed**: tens of megabytes would stay in git
history for good. It is git-ignored via `fixtures/**/large/*.jsonl` and
`fixtures/**/large/*.jsonl.zst`.

The bench takes the first `rollout-*.jsonl` or `rollout-*.jsonl.zst` it finds
in this folder. Tests, goldens and the fixture checker never look here.
Never commit the result.

## Option A — scrub a real large rollout (preferred)

Codex rollouts grow large on their own: one long thread is a file of tens or
hundreds of megabytes, with single records of several megabytes (a tool
output, a compaction). That shape is what the budget is about, and a
synthetic file does not have it.

POSIX (bash/zsh):

```sh
# 1. locate your largest rollouts
find ~/.codex/sessions -name 'rollout-*' -size +20M -exec ls -lS {} +

# 2. scrub the biggest straight into place; keep the rollout-* name
pnpm scrub "<biggest-rollout>.jsonl.zst" \
  -o fixtures/codex/large/rollout-large.jsonl.zst
```

Windows (PowerShell):

```powershell
# 1. locate your largest rollouts
Get-ChildItem "$env:USERPROFILE\.codex\sessions" -Recurse -Filter 'rollout-*' |
  Sort-Object Length -Descending |
  Select-Object -First 5 @{n='MB';e={[math]::Round($_.Length/1MB,2)}}, FullName

# 2. scrub the biggest straight into place; keep the rollout-* name
pnpm scrub "<biggest-rollout>.jsonl.zst" -o fixtures\codex\large\rollout-large.jsonl.zst
```

A compressed input stays compressed when the output name ends in
`.jsonl.zst`, and the bench then measures decompression too, as a real
session costs it. The speed it prints is per megabyte of text, not of the
file on disk.

## Option B — synth-multiply a committed fixture

With no large rollout of your own, inflate a committed fixture to the target
size. Repeating a rollout as it is would start every turn and make every
call a second time under the same id, and the adapter reads an id once, so
the helper gives each copy its own ids, later times and later ordinals:

```sh
pnpm synth-large 32 codex   # ~32 MB from tool-errors; refuses to overwrite
```

`pnpm bench` does this by itself when the folder holds no rollout (that is
how CI gets its fixture). The result is one thread of several times the turns
of `tool-errors`, with no record over a megabyte.

## Verify (same rules as any fixture, `docs/04-SAMPLE-LOGS.md §5`)

A scrubbed rollout carries the `SCRUBBED` marker as its first line. Check a
real one before you keep it, with your user name filled in:

```sh
grep -ci "<your-username>" fixtures/codex/large/rollout-large.jsonl   # must be 0
```

For a compressed one, decompress to a pipe first (`zstd -dc <file> | grep …`).
