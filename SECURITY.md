# Security policy

RunRay runs on your machine and reads logs that often contain prompts, file
paths and project names. Anything that lets that data leave the machine, or
reach a place it should not, is a security issue for this project.

## What counts

- An outbound network connection from any command other than
  `runray pricing --refresh`.
- The local server (`runray view`, `runray demo`) reachable from an address
  other than 127.0.0.1, or serving files outside the embedded UI and the
  loaded trace.
- Prompt text, output text, real paths or usernames surviving `--redact`,
  `--scrub-paths`, `--anonymize` or `--metadata-only` in an export.
- A crafted log file that makes RunRay execute code, read files it was not
  pointed at, or write outside its own config directory.
- A published `runray` tarball whose contents differ from the tagged source.

Wrong token counts, wrong prices and parser gaps are bugs, not security
issues. Open a normal issue for those.

## How to report

Use GitHub's private vulnerability reporting: open the **Security** tab of
this repository and choose **Report a vulnerability**. Only the maintainers
see the report. Please do not open a public issue or a pull request for
something you believe is exploitable.

Include:

- the output of `runray --version` and your operating system,
- the command you ran and what you expected to stay private,
- a log or trace that reproduces it. If the trace holds your own data, run
  `runray export --anonymize --json trace.json` first and attach that.

## What happens next

You get an acknowledgement within seven days. A confirmed issue is fixed in
the next release, with a GitHub security advisory that credits you unless
you ask otherwise. Only the latest published version receives fixes; the
project is in alpha and there are no maintenance branches.
