---
"runray": minor
---

The Time tab is now called Time & Tools, and it shows which programs a session ran, not only which harness tools. Shell commands are read when the session is parsed: `cd web && pnpm exec vitest run | tail -20` counts as `vitest`, so `docker`, `git` and `cargo` get rows of their own instead of hiding inside `Bash`. The command text is never stored. What is kept is the program's id from a fixed list, its subcommand and the kind of work it was.

- A bar splits summed tool time by activity, such as test, build or search. Selecting a part narrows the tool table to it.
- The tool table ranks tools by total time and can be re-sorted by p95 or by calls. It filters by family, and a row with subcommands expands to them. MCP tools roll up to their server.
- The wall-clock strip has a fifth segment, "waiting on you", for questions and plan approvals that sat unanswered.
- When one command ran several tools, its time counts for one of them and is marked as shared on the others.
- Agent delegations are listed apart, with the time their subagent actually ran.
- Hooks from Claude Code sessions are listed apart too: each hook that failed or was cancelled, how long it ran and which tool its command started. A hook that succeeds leaves no record in the transcript, so only failed and cancelled runs are shown, and the view says so.

With `--redact` and in sanitized exports the tool ids stay, so a shared report keeps its rows. Names outside the fixed list, such as your own scripts, are removed and appear as one "other command" row. A redacted report therefore now shows which well-known tools a session used.
