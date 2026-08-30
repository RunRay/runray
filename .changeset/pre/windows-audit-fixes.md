---
"runray": patch
---

Fix nine Windows path defects found by an audit of the path surface, plus the
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
