# opencode fixtures

OpenCode session data for the `opencode` adapter (task 2.3). On this machine the
data dir is `~/.local/share/opencode` (Windows: `%USERPROFILE%\.local\share\opencode`;
some builds use `%APPDATA%\opencode`). OpenCode is mid-migration — SQLite
(`opencode.db`, v1.2.0+) and legacy file storage (`storage/session|message|part`)
coexist. `cost` is always `0` on disk; TraceLLM computes it from tokens.

## export-json — the stable single-file cell (done)

`opencode export <sessionID>` serializes one whole session to a self-contained
JSON `{ info, messages: [{ info, parts }] }`. It is the recommended fixture
source: a public CLI with import round-trip intent, stable across the storage
refactor (raw file storage scatters a session across three directory trees; the
SQLite schema is internal and moving).

```powershell
opencode session list --format json                               # find a session id
opencode export <sessionID> > "$env:USERPROFILE\oc-export.json"   # redirect — do NOT pipe (truncates large sessions, #14948)
pnpm scrub "$env:USERPROFILE\oc-export.json" `
  -o fixtures/opencode/export-json/simple.json --source opencode
```

`--source opencode` (auto-detected for `.json`) keeps `id` / `sessionID` /
`messageID` / `parentID` / `providerID` / `modelID` (+ v1.4 `model.{…,variant}`)
/ `callID` / tokens / cost / timestamps / tool names byte-identical,
canonicalizes `directory` and `path.{cwd,root}`, and lorem's the free text:
`parts[].text`, tool `state.input`/`state.output`, `title`, `system`, `summary`.
Verify (`docs/04-SAMPLE-LOGS.md §5`): `SCRUBBED` marker present, file parses,
your username/email absent.

Version gotchas ([anomalyco/opencode](https://github.com/anomalyco/opencode)):
[#12130](https://github.com/anomalyco/opencode/issues/12130) older builds
prepend an `Exporting session:` status line that must be stripped to yield valid
JSON; [#14948](https://github.com/anomalyco/opencode/issues/14948) piping export
truncates large sessions — redirect to a file; [#21941](https://github.com/anomalyco/opencode/issues/21941)
v1.4+ nests the model as `info.model.{providerID,modelID,variant}` vs the older
flat `info.providerID`/`info.modelID` (the scrub keeps both shapes). OpenCode's
own `--sanitize` flag redacts with `[redacted:kind:id]` markers — a privacy
pre-pass, not a substitute for the lorem scrub, so we scrub the raw export.

## storage (files) — the legacy-era cell (done)

`fixtures/opencode/storage/simple/` mirrors the native data-dir layout so the
adapter's `detect()` scans the fixture exactly like a real install:

```
storage/simple/
  raw/storage/…                     # git-ignored raw copy of the live session
  storage/session/global/ses_*.json
  storage/message/<sessionID>/msg_*.json
  storage/part/<messageID>/prt_*.json   # only parts of that session's messages
```

**It is the SAME session as `export-json/simple.json`** (session/message/part
ids match 1:1) — deliberately, so adapter 2.3 can test its spec requirement
"identical normalized structure across eras for equivalent sessions" directly.
Since lorem is seeded from content, even the scrubbed text matches across the
two formats.

To capture: copy one session's files from the live data dir into
`storage/<variant>/raw/storage/` (filter `part/` to that session's message
ids), then run the directory scrub — it mirrors the tree, gives every file its
own marker, and skips non-JSON files:

```powershell
pnpm scrub fixtures/opencode/storage/simple/raw --source opencode
```

## sqlite — the current-era cells (done)

`opencode.db` is a Drizzle DB (observed 1.1.56–1.2.14): flat-column `session`
rows plus `message`/`part` rows whose `data` JSON is the SAME shape as the
storage files minus the id/fk columns. **SQLite is the primary store well
before the v1.2.0 the migration notes suggest** — this machine's 1.1.x db held
27 sessions while file storage held 2 (dual-write), which is why the adapter's
`detect()` dedupes: a db session wins over the same id in file storage.

Fixtures are built by the sanctioned dump → scrub → rebuild path — the output
db contains only the three tables the adapter reads plus an
`x_tracellm_scrub` marker table (so `grep SCRUBBED` works on the binary too);
unread free-text columns (share_url, revert, permission, metadata,
summary_diffs) are nulled:

```powershell
# copy the live db (+ -wal) somewhere safe first; never scrub in place
pnpm scrub <copy-of-opencode.db> --session <ses_id> -o fixtures/opencode/sqlite/<variant>/opencode.db
```

`--session` names one ROOT session; descendant (subagent) sessions are
included automatically.

- `sqlite/simple/` — **the same session as `export-json` and `storage`**
  (three-era equivalence, tested in `opencode.test.ts`).
- `sqlite/subagents/` — a parent session whose `task` tool spawned a child
  session (`state.metadata.sessionId` is the join; child rows carry
  `parent_id`).
