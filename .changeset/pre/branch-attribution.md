---
"runray": patch
---

See what each git branch cost. The dashboard ranks spend by branch in a new Top branches card, and clicking a branch filters every view to it. Each session shows the branch it started on, in its header and in the sessions table. `runray list --json` and the sessions CSV carry the branch too. Claude Code sessions record their branch already. OTLP imports now read it from OpenTelemetry's `vcs.ref.head.name` resource attribute (or `vcs.repository.ref.name`, or `git.branch`). OpenCode records no branch, so its sessions show none.
