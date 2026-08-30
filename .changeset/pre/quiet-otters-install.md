---
"runray": patch
---

Make better-sqlite3 an optional dependency. It is needed only to read the
OpenCode SQLite store, so when it is absent — `--omit=optional`, a failed
native build, an unsupported platform — that one source now degrades to an
actionable "unavailable" message instead of an unhandled MODULE_NOT_FOUND,
and Claude Code and OTLP keep working.

Note: this does not remove the `prebuild-install` deprecation warning from a
default `npx runray`; npm installs optional dependencies unless told not to.
