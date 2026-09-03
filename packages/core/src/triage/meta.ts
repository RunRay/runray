import type { Playbook } from '../insights/meta.js';

/**
 * Error-class registry (error-triage capability). A failed call is not one
 * thing: on the user's own sessions a third of the "errors" were the agent's
 * normal check-and-fix loop, a third the model's own slips corrected within
 * seconds, and under a tenth something the person could act on. The class
 * says what happened; the OWNER says who has a lever. Both are read from the
 * failure text (`content.outputPreview`) by `classify.ts`; this module is
 * the presentation and playbook side, import-free apart from the shared
 * `Playbook` type so it stays browser-safe (`@runray/core/triage`).
 *
 * Every lever named in a playbook is verified against the source's current
 * documentation before it is added, same rule as RULE_META.
 */

export type ErrorOwner =
  | 'you'
  | 'tooling'
  | 'agent'
  | 'model'
  | 'work'
  | 'unknown';

/** Triage order: the person's own levers first, noise last. */
export const ERROR_OWNER_ORDER: readonly ErrorOwner[] = [
  'you',
  'tooling',
  'agent',
  'model',
  'work',
  'unknown',
];

export interface ErrorOwnerMeta {
  /** Group heading. */
  label: string;
  /** One line under the heading: what membership means for the person. */
  meaning: string;
}

export const ERROR_OWNER_META: Readonly<Record<ErrorOwner, ErrorOwnerMeta>> = {
  you: {
    label: 'Needs you',
    meaning:
      'something in your environment or configuration; the agent cannot fix it alone',
  },
  tooling: {
    label: 'Tooling',
    meaning:
      'the Browser pane, a preview server or an MCP server; restart or reconfigure, not reprompt',
  },
  agent: {
    label: 'Agent slips',
    meaning:
      "the model's own mistake, usually corrected by the model; worth a note only when it repeats",
  },
  model: {
    label: 'Model calls',
    meaning:
      'the request to the model itself failed; not in the tool-error count',
  },
  work: {
    label: 'Expected feedback',
    meaning:
      'the agent ran a check and read the result; not a failure of the session and never counted as waste',
  },
  unknown: {
    label: 'Unclassified',
    meaning: 'RunRay could not read a cause from the text',
  },
};

export type ErrorClassId =
  | 'model-limit'
  | 'model-auth'
  | 'model-server'
  | 'model-content'
  | 'model-error'
  | 'edit-anchor-miss'
  | 'read-before-write'
  | 'input-validation'
  | 'tool-misuse'
  | 'path-not-found'
  | 'script-error'
  | 'shell-syntax'
  | 'missing-binary'
  | 'tool-unavailable'
  | 'port-in-use'
  | 'http-error'
  | 'pane-timeout'
  | 'pane-navigation'
  | 'mcp-error'
  | 'check-failed'
  | 'exit-nonzero'
  | 'unclassified';

export interface ErrorClassMeta {
  label: string;
  /** One line: what this class means for the person. */
  explain: string;
  owner: ErrorOwner;
  playbook: Playbook;
}

const NOTHING_TO_DO = 'Nothing to configure; the agent corrects this itself.';

export const ERROR_CLASS_META: Readonly<Record<ErrorClassId, ErrorClassMeta>> =
  {
    'model-limit': {
      label: 'Usage limit reached',
      explain:
        'The model call was refused because a plan or session limit was hit; the message names the reset time.',
      owner: 'you',
      playbook: {
        causes: [
          'A plan, session or model-specific usage limit was reached mid-session.',
        ],
        actions: {
          'claude-code': [
            'Wait for the reset the message names, or switch tiers with `/model` so the session can continue on a tier with its own budget.',
            'Resume where you were with `claude --continue`; the transcript is intact.',
          ],
          opencode: [
            'Switch models with `/models` (or the `model` key in `opencode.json`); provider limits are per model.',
          ],
          otlp: [
            'Surface provider limit responses to the person instead of retrying blindly.',
          ],
        },
        limits: [
          'RunRay reads the harness message; it cannot see the limit or how much of it is left.',
        ],
      },
    },
    'model-auth': {
      label: 'Not authenticated',
      explain:
        'The model call was refused because the session is not logged in or the credentials were rejected.',
      owner: 'you',
      playbook: {
        causes: ['The login expired or the API key was rejected.'],
        actions: {
          'claude-code': [
            'Run `/login`, then resume with `claude --continue`.',
          ],
          opencode: [
            'Re-authenticate the provider with `opencode auth login` and resume with `opencode -c`.',
          ],
          otlp: ['Return the authentication failure to the caller.'],
        },
        limits: ['Everything after the failure was lost time, not lost money.'],
      },
    },
    'model-server': {
      label: 'Provider error',
      explain:
        'The provider answered with a server-side error (500, 529, overloaded, timeout); the harness retried.',
      owner: 'model',
      playbook: {
        causes: ['A transient provider-side failure.'],
        actions: {
          'claude-code': [
            'Nothing on your side: Claude Code retries. A run of them is worth a look at status.claude.com before retrying by hand.',
          ],
          opencode: [
            'Nothing on your side beyond a retry; check the provider status page if it keeps happening.',
          ],
          otlp: ['Retry with backoff and log the status code.'],
        },
        limits: [
          'The retry re-bills the context; RunRay counts that in the next model call, not in this one.',
        ],
      },
    },
    'model-content': {
      label: 'Request rejected by the provider',
      explain:
        'The provider refused the request itself: a safeguard flag or an image it could not process.',
      owner: 'model',
      playbook: {
        causes: [
          'A safeguard flagged the message, or an image in the conversation could not be processed.',
        ],
        actions: {
          'claude-code': [
            'Rephrase or drop the flagged content; for an image, re-read the file another way or at a smaller size.',
          ],
          opencode: ['Rephrase or drop the content the provider refused.'],
          otlp: ['Log the refusal reason and return it to the caller.'],
        },
        limits: ['The provider does not say which part was flagged.'],
      },
    },
    'model-error': {
      label: 'Model call failed',
      explain: 'The model call failed for a reason RunRay does not recognize.',
      owner: 'model',
      playbook: {
        causes: ['An API error outside the recognized patterns.'],
        actions: {
          'claude-code': [
            'Read the message in the Inspector; the transcript keeps it.',
          ],
          opencode: ['Read the message in the Inspector.'],
          otlp: ['Record the error message on the span status.'],
        },
        limits: ['Without the text (redacted sessions) the class is a guess.'],
      },
    },
    'edit-anchor-miss': {
      label: 'Edit anchor not found',
      explain:
        'An edit could not find the text it meant to replace, so nothing was written.',
      owner: 'agent',
      playbook: {
        causes: [
          'The model misremembered the file, or the file changed under it: a formatter on save, a concurrent edit, CRLF line endings.',
        ],
        actions: {
          'claude-code': [
            'Once is the model; several times on one file is the file changing under it. Pause format-on-save or the watcher while the agent works.',
            'Line-ending churn: a `.gitattributes` with `* text=auto` keeps the working copy stable.',
          ],
          opencode: [
            'Pause format-on-save while the agent edits; keep line endings stable.',
          ],
          otlp: ['Re-read before editing when the previous edit missed.'],
        },
        limits: [NOTHING_TO_DO],
      },
    },
    'read-before-write': {
      label: 'Write before read',
      explain:
        'The harness refused a write because the agent had not read the file first.',
      owner: 'agent',
      playbook: {
        causes: ['A safety check of the harness, doing its job.'],
        actions: {
          'claude-code': [NOTHING_TO_DO],
          opencode: [NOTHING_TO_DO],
          otlp: ['Keep the read-before-write check; it is cheap.'],
        },
        limits: ['The retry costs one model call.'],
      },
    },
    'input-validation': {
      label: 'Invalid tool arguments',
      explain:
        'The tool rejected the arguments the model sent: a missing field, a wrong type, unparseable JSON.',
      owner: 'agent',
      playbook: {
        causes: [
          'The model produced arguments the tool schema does not accept.',
        ],
        actions: {
          'claude-code': [
            'Nothing per event. If one tool keeps rejecting, a line in `CLAUDE.md` showing its correct call shape saves the retry.',
          ],
          opencode: [
            'Nothing per event; a correct example in `AGENTS.md` if one tool keeps rejecting.',
          ],
          otlp: ['Return the validation message verbatim; the model uses it.'],
        },
        limits: ['Each rejection costs one model call to correct.'],
      },
    },
    'tool-misuse': {
      label: 'Tool used out of order',
      explain:
        'The tool refused because a precondition was missing: no page open, no screenshot taken, a file too large for one read.',
      owner: 'agent',
      playbook: {
        causes: ['The model skipped a step the tool requires.'],
        actions: {
          'claude-code': [NOTHING_TO_DO],
          opencode: [NOTHING_TO_DO],
          otlp: ['Make the precondition part of the error message.'],
        },
        limits: ['Each refusal costs one model call.'],
      },
    },
    'path-not-found': {
      label: 'Path not found',
      explain:
        'A file or directory the agent named does not exist: a guessed name, a drifted working directory, a stale path.',
      owner: 'agent',
      playbook: {
        causes: [
          'The model guessed a path, or the working directory drifted from an earlier `cd`.',
        ],
        actions: {
          'claude-code': [
            'Nothing per event. If the same path keeps failing across sessions, a short repo map in `CLAUDE.md` removes the guess.',
          ],
          opencode: [
            'Nothing per event; a repo map in `AGENTS.md` if the same path keeps failing.',
          ],
          otlp: ['Give the agent a file listing before it guesses.'],
        },
        limits: ['Corrected on the next call in most sessions.'],
      },
    },
    'script-error': {
      label: 'Agent script threw',
      explain: 'A script the agent wrote raised an exception when it ran it.',
      owner: 'agent',
      playbook: {
        causes: ['A bug in an ad-hoc script the model wrote to inspect data.'],
        actions: {
          'claude-code': [NOTHING_TO_DO],
          opencode: [NOTHING_TO_DO],
          otlp: ['Return the stack trace; the model fixes its own script.'],
        },
        limits: ['Each attempt costs one model call.'],
      },
    },
    'shell-syntax': {
      label: 'Shell syntax',
      explain:
        'The shell could not parse the command: a quoting mistake, a heredoc that never closed, an operator this shell does not have.',
      owner: 'you',
      playbook: {
        causes: [
          'The agent wrote for a different shell than the one it runs in (PowerShell 5.1 has no `&&`; Git Bash heredocs need care).',
        ],
        actions: {
          'claude-code': [
            'Put the shell fact into `CLAUDE.md`, for example `Shell is PowerShell 5.1: no && chaining` or `write multi-line scripts with the Write tool, not heredocs`.',
            'For a pattern you never want billed, a `PreToolUse` hook that exits with code 2 blocks the call before it runs.',
          ],
          opencode: [
            'Put the shell fact into `AGENTS.md`; the `permission` block can deny a command pattern outright.',
          ],
          otlp: ['State the shell and its limits in the system prompt.'],
        },
        limits: [
          'The agent usually recovers on its own; the lever prevents the next session from paying again.',
        ],
      },
    },
    'missing-binary': {
      label: 'Missing program, module or permission',
      explain:
        'A command or module the agent relied on is not installed, not on PATH, or not permitted.',
      owner: 'you',
      playbook: {
        causes: [
          'The tool is not installed, not on PATH for this shell, or the file is not executable.',
        ],
        actions: {
          'claude-code': [
            'Install it, or write into `CLAUDE.md` that it is not available and what to use instead.',
            'For a tool that must never be tried, `permissions.deny` in settings stops the probing.',
          ],
          opencode: [
            'Install it, or note in `AGENTS.md` what is not available.',
          ],
          otlp: ['List the available tools in the system prompt.'],
        },
        limits: ['RunRay cannot tell an uninstalled tool from a PATH problem.'],
      },
    },
    'tool-unavailable': {
      label: 'Tool or configuration unavailable',
      explain:
        'The agent reached for a tool, skill or launch configuration that does not exist in this session.',
      owner: 'you',
      playbook: {
        causes: [
          'A skill or plugin is not installed, a tool is disabled in this context, or `.claude/launch.json` is missing.',
        ],
        actions: {
          'claude-code': [
            'Add the configuration the agent looked for: a `.claude/launch.json` entry for a preview server, or the skill/plugin it named.',
            'Check the MCP servers with `claude mcp list` if the missing tool belongs to one.',
          ],
          opencode: [
            'Enable the tool in the `tools` map or the MCP server with `mcp.<name>.enabled` in `opencode.json`.',
          ],
          otlp: ['Advertise only the tools that exist.'],
        },
        limits: ['The message names what was missing; RunRay quotes it.'],
      },
    },
    'port-in-use': {
      label: 'Port in use',
      explain:
        'A preview or dev server could not start because its port is taken.',
      owner: 'you',
      playbook: {
        causes: ['Another process, often a previous server, holds the port.'],
        actions: {
          'claude-code': [
            'Stop the process the message names, or change the `port` in `.claude/launch.json`.',
          ],
          opencode: ['Free the port or change it in the project config.'],
          otlp: ['Pick a free port before starting the server.'],
        },
        limits: ['Nothing the agent can do without you.'],
      },
    },
    'http-error': {
      label: 'HTTP or network error',
      explain: 'A fetch failed: a 404, a refused connection, a DNS miss.',
      owner: 'you',
      playbook: {
        causes: ['A wrong URL, a service that is down, or no network.'],
        actions: {
          'claude-code': [
            'Check the address or the service; if the agent must not fetch it, `permissions.deny` for `WebFetch` stops the attempts.',
          ],
          opencode: ['Check the address or the service.'],
          otlp: ['Return the status code to the model.'],
        },
        limits: ['RunRay sees the status, not the response.'],
      },
    },
    'pane-timeout': {
      label: 'Browser pane timeout',
      explain:
        'A screenshot, click or navigation in the Browser or Preview pane timed out; the pane, not the page, is usually stuck.',
      owner: 'tooling',
      playbook: {
        causes: [
          'A stuck renderer, a modal dialog, or a page that never finished rendering.',
        ],
        actions: {
          'claude-code': [
            'Close the pane tab and open it again; a stuck renderer keeps timing out on every step.',
            'If the page is a dev server, read `preview_logs` before retrying.',
            'Interrupt (Esc) when the same step fails twice; each retry re-bills the context.',
          ],
          opencode: ['Restart the browser tool or the MCP server behind it.'],
          otlp: ['Cap retries on timeouts and surface them.'],
        },
        limits: [
          'The most common single error class on real sessions; a retry usually works, a restart always does.',
        ],
      },
    },
    'pane-navigation': {
      label: 'Navigation refused',
      explain:
        'The Browser pane refused to open the address: a `file://` page, a blocked origin, a server that is not up.',
      owner: 'tooling',
      playbook: {
        causes: [
          'The pane cannot open local files, the origin is not allowed, or nothing listens on the port yet.',
        ],
        actions: {
          'claude-code': [
            'Serve the file instead of opening it: an entry in `.claude/launch.json` lets the agent open it with `preview_start`.',
            'Tell the agent in `CLAUDE.md` to publish local HTML as an artifact rather than open it in the pane.',
          ],
          opencode: [
            'Serve local files; check the origin allowlist of the browser tool.',
          ],
          otlp: ['Validate the URL before navigating.'],
        },
        limits: ['The refusal is a policy of the pane, not a bug in the page.'],
      },
    },
    'mcp-error': {
      label: 'MCP server error',
      explain:
        'An MCP server returned an error RunRay does not recognize; the server, not the prompt, is the place to look.',
      owner: 'tooling',
      playbook: {
        causes: ['The server is down, misconfigured, or rejected the call.'],
        actions: {
          'claude-code': [
            'Check the server with `claude mcp list`; remove it with `claude mcp remove <name>` until it is fixed.',
          ],
          opencode: [
            'Set `mcp.<name>.enabled: false` in `opencode.json` until the server is fixed.',
          ],
          otlp: ['Log the server response with the span.'],
        },
        limits: ['Under `--redact` every MCP failure lands here.'],
      },
    },
    'check-failed': {
      label: 'Check did not pass',
      explain:
        'A test, lint, type or build run reported failures; the agent asked for exactly this feedback.',
      owner: 'work',
      playbook: {
        causes: [
          'The fix-and-check loop; the exit code is the answer the agent wanted.',
        ],
        actions: {
          'claude-code': ['Nothing. This is the agent working.'],
          opencode: ['Nothing. This is the agent working.'],
          otlp: ['Nothing; do not count it as a failure of the run.'],
        },
        limits: [
          'Never counted as waste; a long run of them is a hard task, not an error.',
        ],
      },
    },
    'exit-nonzero': {
      label: 'Command returned non-zero',
      explain:
        'A command exited with a non-zero code without naming a failure RunRay recognizes; usually a probe (grep with no match, a partial pipeline).',
      owner: 'work',
      playbook: {
        causes: [
          'A probe or a pipeline where a harmless step returned non-zero.',
        ],
        actions: {
          'claude-code': [
            'Nothing per event. Read the text if the same command keeps failing.',
          ],
          opencode: ['Nothing per event.'],
          otlp: ['Record the exit code on the span.'],
        },
        limits: [
          'Without the text RunRay cannot tell a probe from a real failure.',
        ],
      },
    },
    unclassified: {
      label: 'Unclassified',
      explain: 'The failure text did not match any known class.',
      owner: 'unknown',
      playbook: {
        causes: ['A message RunRay has no pattern for, or a redacted session.'],
        actions: {
          'claude-code': ['Read the text in the Inspector.'],
          opencode: ['Read the text in the Inspector.'],
          otlp: ['Put the error message on the span status so it can be read.'],
        },
        limits: ['Under `--redact` every non-MCP tool failure lands here.'],
      },
    },
  };

export const ERROR_CLASS_IDS = Object.keys(ERROR_CLASS_META) as ErrorClassId[];

/** Owner of a class; unknown ids fall back to `unknown`. */
export function errorClassOwner(id: string): ErrorOwner {
  return (
    (ERROR_CLASS_META as Record<string, ErrorClassMeta>)[id]?.owner ?? 'unknown'
  );
}
