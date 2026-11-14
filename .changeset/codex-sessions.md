---
"runray": minor
---

RunRay now reads Codex sessions. With no setup, `runray view` finds the rollouts Codex keeps under `~/.codex/sessions` (or `$CODEX_HOME/sessions`) next to your Claude Code and OpenCode sessions, and `--source codex` limits a command to them.

- A Codex session shows its turns, each model response with its tokens, and what the harness ran. Commands are unwrapped from the shell Codex starts them in, so the Time & Tools tab names `git`, `pnpm` or `cargo`, not `bash` or `pwsh`.
- Codex records no cost. Every call is priced from its token counts, with cached input at the cache-read rate and reasoning at the output rate.
- When Codex asks its approval reviewer whether a command may run, that conversation is a thread of its own. It appears as a subagent under the turn that asked. The reviewer's model, `codex-auto-review`, has no published price: its tokens are counted and its cost is listed as unknown.
- Rollouts that Codex has compressed (`.jsonl.zst`) are read like plain ones. This needs Node 22.15 or newer; on an older Node 22 a compressed rollout is skipped with a message that says so, and plain ones still load.
- Findings on a Codex session name Codex's own levers: `AGENTS.md`, `/model` and `/compact`, and the keys of `config.toml`. The two findings about a re-written cache (`cache-prefix-break`, `idle-cache-expiry`) do not appear on Codex sessions, because Codex records no cache writes. The how-to-fix page behind every finding and every error class has a Codex section, shown for Codex sessions in the Inspector, the Waste tab and the Errors tab.
- A Codex request the provider refused, such as one stopped at the usage limit, appears in the Errors tab as a model error with its code. A session that ends there is not reported as a dead end.
- The Inspector shows the source record behind a Codex span: a command with its output, a file change, what you typed in a turn.
- `--redact` and sanitized exports remove prompts, outputs and command text from Codex sessions as they do for the other sources. Account ids, the repository URL and commit hashes that Codex writes into its session record are never read into a report.
