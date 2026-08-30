# runray

## 0.1.0-alpha.2

### Patch Changes

- 087d079: Make better-sqlite3 an optional dependency. It is needed only to read the
  OpenCode SQLite store, so when it is absent — `--omit=optional`, a failed
  native build, an unsupported platform — that one source now degrades to an
  actionable "unavailable" message instead of an unhandled MODULE_NOT_FOUND,
  and Claude Code and OTLP keep working.
  
  Note: this does not remove the `prebuild-install` deprecation warning from a
  default `npx runray`; npm installs optional dependencies unless told not to.
- Report a broken better-sqlite3 install as one clear message. The module loads
  its native addon lazily inside the constructor, so a missing or ABI-mismatched
  binary sailed past the load check and surfaced later as a raw `bindings` dump
  naming whichever OpenCode database happened to be scanned first — with the
  wrong remedy attached. The addon is now probed at load time, so every failure
  mode arrives as a single actionable error and the other sources keep working.
- Fix nine Windows path defects found by an audit of the path surface, plus the
  follow-ups from auditing that audit:
  
  - A UTF-8 BOM no longer hides a file. PowerShell's `>`, `Out-File` and
    `Set-Content -Encoding utf8` all write one, and the cheap content sniff does
    not notice it, so an OTLP capture or an `opencode export` bundle matched,
    failed to parse, and vanished — leaving the directory reported as "empty".
    `runray.config.json` and the pricing override hard-failed the same way.
  - The onboarding wizard printed a config snippet built by string
    interpolation, so every Windows path produced either invalid JSON (`\G` is
    not a legal escape) or a silently corrupted one (`\t` became a tab).
    Following our own instructions broke every later command.
  - The port scan aborted `view` on a port inside a Windows reserved block
    (Hyper-V, WSL2 and Docker Desktop reserve ranges of ordinary high ports and
    binding one returns EACCES, not EADDRINUSE) instead of stepping past it.
    A privileged-port refusal on POSIX still reports "permission denied".
  - Serving a directory path threw EISDIR out of the request handler and killed
    the viewer, its watcher and every connected client. It now 404s.
  - A session started at a filesystem root got an empty project name, which
    collided with the dashboard's "all projects" entry and dropped the run out
    of the filter. This affected `/` on Linux too.
  - Paths under the home directory are abbreviated to `~` regardless of case, so
    a pasted lowercase root no longer leaks the username into shared output.
