/**
 * Rule presentation metadata (add-profiler-depth B1/X1). The single source
 * of truth for how a rule is shown (label, one-line explanation) and how it
 * is classified: 'waste' = money already burned, rolled into
 * `totals.costUSD.wastedEstimate`; 'opportunity' = hypothetical saving that
 * carries `estimatedWasteUSD` for ranking but never inflates the rollup.
 * The engine derives its waste-class membership from this registry and the
 * UI renders from it, so classification cannot drift between core and UI.
 *
 * Browser-safe: exported as `@runray/core/insights-meta`, zero imports —
 * the import-graph purity test enforces that. Every rule registered in
 * V0_RULES MUST have an entry here (test-enforced); unknown ids in the UI
 * fall back to the literal slug with class 'opportunity'.
 */

export type RuleClass = 'waste' | 'opportunity';

/**
 * Sources a playbook addresses. Mirrors the schema's SourceTool enum,
 * spelled out here so this module stays import-free; `otlp` speaks to the
 * author of a custom agent.
 */
export type PlaybookSource = 'claude-code' | 'opencode' | 'otlp';

export const PLAYBOOK_SOURCES: readonly PlaybookSource[] = [
  'claude-code',
  'opencode',
  'otlp',
];

/** Display name of a playbook source, for headings. */
export const PLAYBOOK_SOURCE_LABEL: Readonly<Record<PlaybookSource, string>> = {
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  otlp: 'Custom agent (OTLP)',
};

/**
 * The static "how to fix" behind a rule: what produces the finding, the
 * levers the person has in each source, and what is out of their hands.
 * The per-finding `suggestion` is the one-sentence pointer; this is the
 * page behind it, rendered in the Inspector and in docs/08-FINDINGS.md
 * (generated — `pnpm docs:playbooks`). Backticks mark commands, keys and
 * file names; every lever named here is verified against the source's
 * current documentation before it is added.
 */
export interface Playbook {
  /** What produces this finding, in the person's terms. */
  causes: readonly string[];
  /** Concrete levers per source, most effective first. */
  actions: Readonly<Record<PlaybookSource, readonly string[]>>;
  /** What the person cannot change, so the finding is read honestly. */
  limits: readonly string[];
}

export interface RuleMeta {
  /** Human-readable label shown instead of the rule-id slug. */
  label: string;
  /** One-line explanation of what the finding means for the user. */
  explain: string;
  class: RuleClass;
  playbook: Playbook;
}

export const RULE_META: Readonly<Record<string, RuleMeta>> = {
  'retry-loop': {
    label: 'Repeated failing tool calls',
    explain:
      'The same tool failed several times in a row — every retry re-billed the full context.',
    class: 'waste',
    playbook: {
      causes: [
        'The agent does not know a fact about your environment: the shell version, a binary that is not installed, a sandbox that blocks the call.',
        'The file changed under the agent (a formatter on save, a concurrent edit), so an edit no longer finds its anchor text.',
        'An MCP server is down, slow, or rejects the arguments the agent sends.',
      ],
      actions: {
        'claude-code': [
          'Interrupt the loop (Esc) as soon as the same call fails twice; every further attempt re-bills the whole context.',
          'Write the missing fact into `CLAUDE.md`, for example `Shell is PowerShell 5.1: no && chaining`, so the next session starts with it.',
          'For a known-bad command pattern, a `PreToolUse` hook that exits with code 2 blocks the call before it is billed.',
          'For an MCP server that keeps failing, check it with `claude mcp list` and remove it with `claude mcp remove <name>` until it is fixed.',
        ],
        opencode: [
          'Interrupt the loop as soon as the same call fails twice.',
          'Write the missing fact into `AGENTS.md` so the next session starts with it.',
          'For a failing MCP server, set `mcp.<name>.enabled: false` in `opencode.json` until it is fixed.',
        ],
        otlp: [
          'Stop retrying the same call after two failures and surface the error to the person instead.',
          'Put the environment facts the agent keeps rediscovering into its system prompt.',
        ],
      },
      limits: [
        'The finding names the tool and the count; the error text itself is not part of the trace.',
      ],
    },
  },
  'low-cache-hit': {
    label: 'Low cache hit-rate',
    explain:
      'Most input tokens were paid at the full rate instead of being served from the prompt cache.',
    class: 'opportunity',
    playbook: {
      causes: [
        'The provider or model does not cache prompts, or caching is not enabled for the requests.',
        'The prefix changes on every call, so nothing can be served from cache.',
      ],
      actions: {
        'claude-code': [
          'Caching is automatic; check the same run for `cache-prefix-break` findings, which say what kept re-writing the prefix.',
          'Resume a session with `claude --continue` or `claude --resume` instead of pasting its history into a new one.',
        ],
        opencode: [
          'Check that the provider you use supports prompt caching for the model; OpenCode adds no cache options of its own.',
        ],
        otlp: [
          'Mark a stable prefix for caching in every request: system prompt, tool definitions, then the conversation, in that order.',
          'Keep anything that changes per call (timestamps, request ids) out of the cached prefix.',
        ],
      },
      limits: [
        'The estimate assumes a 60% hit-rate was reachable; a session whose prompts genuinely share nothing cannot get there.',
      ],
    },
  },
  'context-bloat': {
    label: 'Growing context',
    explain:
      'Input tokens grew steadily across the session, so every later call re-paid an ever-larger context.',
    class: 'opportunity',
    playbook: {
      causes: [
        'Large tool outputs stay in the conversation after they were used: a whole file, a long log, an unfiltered search.',
        'One session carries several unrelated tasks, so the context of the first is still paid for during the last.',
      ],
      actions: {
        'claude-code': [
          'Run `/compact` at a natural checkpoint and say what to keep, for example `/compact keep the failing test output`.',
          'Start the next task with `/clear` or a new session instead of continuing in the same context.',
          'Ask for smaller outputs: `Read` with `offset` and `limit`, `Grep` with a head limit, commands piped through a filter.',
        ],
        opencode: [
          'Run `/compact` (alias `/summarize`) at a checkpoint; start a new task with `/new`.',
          'Set `compaction.prune: true` in `opencode.json` so old tool outputs are dropped automatically.',
        ],
        otlp: [
          'Summarize or drop tool results once the step that needed them is done; keep only the conclusion in the history.',
        ],
      },
      limits: [
        'Auto-compaction is decided by the agent, not by RunRay; the finding shows where the context grew and which outputs were largest.',
      ],
    },
  },
  'expensive-subagent': {
    label: 'Expensive subagent',
    explain: "One delegated subtree dominated the run's spend.",
    class: 'opportunity',
    playbook: {
      causes: [
        'A delegated task ran on the most capable model although it was mechanical: exploring files, running tests, formatting.',
        'The subagent was given a task so wide that it re-read most of the project.',
      ],
      actions: {
        'claude-code': [
          "Set `model: sonnet` or `model: haiku` in the agent's frontmatter under `.claude/agents/`; `inherit` follows the main conversation.",
          'Set `CLAUDE_CODE_SUBAGENT_MODEL` to change the default for every subagent in a session.',
          'Give the subagent a narrower task, or point it at the files it needs, so it does not explore the whole repository.',
        ],
        opencode: [
          "Set `agent.<name>.model` in `opencode.json`, or `model:` in the agent's markdown frontmatter.",
          'Use `small_model` for lightweight work such as titles and summaries.',
        ],
        otlp: [
          'Route delegated, low-risk work to a cheaper model and keep the strong model for planning and review.',
        ],
      },
      limits: [
        'The saving assumes the cheaper model uses the same tokens; a model that needs more attempts can cost more, and RunRay cannot predict that.',
      ],
    },
  },
  'dead-end-run': {
    label: 'Run ended in an error',
    explain:
      'The session terminated on a failure — spend after the last productive step bought nothing.',
    class: 'waste',
    playbook: {
      causes: [
        'The last thing the agent did failed and nothing recovered from it: a command that errored, a session closed right after.',
        'In headless runs (`claude -p`, CI) an error at the end means the whole run produced nothing.',
      ],
      actions: {
        'claude-code': [
          'Resume with `claude --continue` and deal with the failing step first; everything up to the last completed change is intact.',
          'In CI, surface the failing step in the job log and rerun the job after fixing it, not the whole pipeline of prompts.',
        ],
        opencode: [
          'Resume with `opencode -c` (or `--session <id>`) and deal with the failing step first.',
        ],
        otlp: [
          'Return the error to the caller instead of ending the run silently, and make the failed step the first thing the next run sees.',
        ],
      },
      limits: [
        'An interactive session that simply ends after an error looks the same as a real dead end; the estimate counts only model calls after the last completed change.',
      ],
    },
  },
  'model-mismatch': {
    label: 'Wrong model tier',
    explain:
      'These calls would cost less on a cheaper same-family model; risky subtrees are excluded from the estimate.',
    class: 'opportunity',
    playbook: {
      causes: [
        'The whole session ran on the top tier, including stretches with few tool calls and a modest context that a cheaper model handles.',
      ],
      actions: {
        'claude-code': [
          'Switch mid-session with `/model sonnet` (or `/model haiku`) for mechanical stretches, and back with `/model opus` for design and debugging.',
          'Start a session on a cheaper tier with `claude --model sonnet` when the task is known to be routine.',
        ],
        opencode: [
          'Switch with `/models` in the TUI, or set `model` in `opencode.json`; `opencode run --model <provider/model>` for one-off runs.',
        ],
        otlp: [
          'Route by task: a cheaper model for classification, extraction and formatting; the strong model where errors are costly.',
        ],
      },
      limits: [
        'RunRay marks subtrees with many tool calls, errors or a large context as risky and excludes them; the estimate covers only the rest.',
      ],
    },
  },
  'cache-prefix-break': {
    label: 'Cache prefix broken mid-session',
    explain:
      'The cached prompt prefix was invalidated mid-session, so already-cached content was re-written at the premium rate.',
    class: 'waste',
    playbook: {
      causes: [
        'Something in the cached prefix changed between two calls: an MCP server connected or disconnected (its tools are part of the prefix), the model or a setting switched, an early turn was edited.',
        'The context was compacted: the new, shorter history is a different prefix and is written once more.',
        'Very large contexts get re-written with no visible change between the calls; in the sessions RunRay has seen this starts well above 180k tokens, and the cause sits on the platform side.',
      ],
      actions: {
        'claude-code': [
          'Connect the MCP servers you need before the long part of the work; a server that joins mid-session re-writes the prefix.',
          'Keep sessions from growing past a few hundred thousand tokens: `/compact` at a checkpoint, or a new session per task.',
          'Avoid switching `/model` or settings in the middle of a large context; do it at a task boundary.',
        ],
        opencode: [
          'Enable the MCP servers you need before starting; toggling `mcp.<name>.enabled` re-writes the prefix.',
          '`/compact` at a checkpoint and `/new` per task; `compaction.prune: true` keeps the history small.',
        ],
        otlp: [
          'Order every request as system prompt, tools, history, and never change the earlier parts once the session runs.',
        ],
      },
      limits: [
        'RunRay sees the collapse and the re-write, not what changed; the shape of the finding hints at the cause but does not prove it.',
      ],
    },
  },
  'idle-cache-expiry': {
    label: 'Cache expired while idle',
    explain:
      'A long pause let the prompt cache expire — the next call re-wrote the whole prefix at the premium rate.',
    class: 'waste',
    playbook: {
      causes: [
        'The session was left alone longer than the cache lives (5 minutes on an API key, 1 hour on a subscription), then resumed.',
        'The next call wrote the whole context again at the write premium, and every later call re-reads all of it.',
      ],
      actions: {
        'claude-code': [
          'Before a long break, `/compact`: it reads the context from cache while that is still cheap, and the resumed session re-writes only the summary.',
          "Start the next day's task in a new session rather than `claude --continue` into a large context.",
          'On an API key, set `promptCacheTtl: "1h"` in settings (or `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`) so a coffee break does not expire the cache.',
        ],
        opencode: [
          'Before a long break, `/compact` (alias `/summarize`); start the next task with `/new` instead of resuming a large session.',
          "There is no cache TTL setting in OpenCode; the provider's default applies.",
        ],
        otlp: [
          'Use the 1-hour cache TTL for sessions that pause, and compact the history before an expected idle period.',
        ],
      },
      limits: [
        'The re-write on resume is unavoidable if you continue the same conversation; the choice is between compacting first, resuming as is, or starting fresh.',
      ],
    },
  },
  'fixed-context-overhead': {
    label: 'Heavy fixed context',
    explain:
      'The session starts with a large fixed context (tool definitions, project instructions) that every later call re-reads.',
    class: 'opportunity',
    playbook: {
      causes: [
        'Everything the first call already carries is paid on every call: the system prompt, `CLAUDE.md` and imported files, skill and memory listings, MCP tool definitions, attachments.',
      ],
      actions: {
        'claude-code': [
          'Keep `CLAUDE.md` short (the docs recommend under 200 lines) and check what each `@import` pulls in.',
          'Disable MCP servers a project does not need: `disabledMcpServers` in settings, `claude mcp remove <name>`, or keep them project-scoped in `.mcp.json` instead of user-wide.',
          'Tool search defers MCP tool schemas by default, but a server with many tools still adds its name and descriptions to every call.',
        ],
        opencode: [
          'Keep `AGENTS.md` and the files under `instructions` short.',
          'Set `mcp.<name>.enabled: false` for servers a project does not use, or restrict tools per agent with the `tools` map.',
        ],
        otlp: [
          'Trim the system prompt and tool definitions; move rarely used tools behind a lookup step.',
        ],
      },
      limits: [
        'RunRay sees the footprint size, not its composition; the finding lists which MCP servers were actually called, the one fact the trace holds.',
      ],
    },
  },
  'duplicate-read': {
    label: 'Same file re-read unchanged',
    explain:
      'The same file was read repeatedly with no edit in between; each redundant read re-enters the context as fresh input.',
    class: 'waste',
    playbook: {
      causes: [
        "The agent lost the file's content, usually after a compaction or a long stretch of other work, and read it again.",
      ],
      actions: {
        'claude-code': [
          'Nothing to configure; if the same file keeps coming back across sessions, make it shorter or split it so each read costs less.',
          'For a reference file the agent needs constantly, an `@import` in `CLAUDE.md` keeps it in the prefix once instead of re-reading it, at the price of a larger fixed context.',
        ],
        opencode: [
          'Nothing to configure; keep files the agent needs repeatedly short.',
        ],
        otlp: [
          'Cache tool results by file and content hash so an unchanged file is served from memory.',
        ],
      },
      limits: [
        "The estimate counts the re-entered bytes at the input rate; a read after a compaction is also the agent's only way to recover the content.",
      ],
    },
  },
  'scattered-tool-failures': {
    label: 'Scattered tool failures',
    explain:
      'Many isolated tool failures forced extra model calls to react and recover.',
    class: 'waste',
    playbook: {
      causes: [
        'Many different calls failed once: wrong paths, missing tools, permission denials, flaky commands. Each failure costs a model call to react.',
      ],
      actions: {
        'claude-code': [
          'Start with the tool that failed most and put the fix into `CLAUDE.md`: the right path, the right command, the tools that are not available.',
          'If the failures are permission denials, add the calls to `permissions.allow` or `permissions.deny` in settings so the agent stops probing.',
        ],
        opencode: [
          'Put the fixes into `AGENTS.md`; use the `permission` block per agent to deny calls that should never run.',
        ],
        otlp: [
          'Log the error text with each failure and feed the recurring ones back into the system prompt.',
        ],
      },
      limits: [
        'The finding counts failures outside retry loops; the error text itself is not part of the trace.',
      ],
    },
  },
  'oversized-output': {
    label: 'Oversized tool output',
    explain:
      'Very large tool outputs entered the context; their usefulness is unknowable, so this never counts as burned waste.',
    class: 'opportunity',
    playbook: {
      causes: [
        'A tool returned far more than the agent needed: a whole file, an unfiltered directory listing, a full log, an MCP response with everything in it.',
      ],
      actions: {
        'claude-code': [
          '`Read` with `offset` and `limit`, `Grep` with a head limit, commands piped through `head` or a filter.',
          '`BASH_MAX_OUTPUT_LENGTH` caps command output (default 30,000 characters); MCP responses are capped separately.',
          'Put a rule in `CLAUDE.md` for the tool that produced it, for example `never print whole files; use Read with limit`.',
        ],
        opencode: [
          'Keep outputs small at the source: filtered commands, targeted reads; `compaction.prune: true` drops old outputs later.',
        ],
        otlp: [
          'Truncate or paginate tool results before they enter the context and keep the full result on disk for the agent to page through.',
        ],
      },
      limits: [
        'RunRay cannot tell how much of the output was needed, so this is an opportunity, never burned waste.',
      ],
    },
  },
};

/** Classification for a rule id; unknown ids are treated as 'opportunity'. */
export function ruleClass(ruleId: string): RuleClass {
  return RULE_META[ruleId]?.class ?? 'opportunity';
}

/** The playbook actions for a rule in one source; unknown sources get the
 * custom-agent list, unknown rules an empty one. */
export function playbookActions(
  ruleId: string,
  source: string,
): readonly string[] {
  const playbook = RULE_META[ruleId]?.playbook;
  if (playbook === undefined) return [];
  const key = (PLAYBOOK_SOURCES as readonly string[]).includes(source)
    ? (source as PlaybookSource)
    : 'otlp';
  return playbook.actions[key];
}
