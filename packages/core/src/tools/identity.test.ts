import type { Span } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { TOOL_ATTR } from './attributes.js';
import { toolUsageAttributes } from './classify.js';
import {
  identityContext,
  isToolSpan,
  OTHER_COMMAND_KEY,
  OTHER_COMMAND_LABEL,
  TOOL_FAMILIES,
  toolIdentity,
} from './identity.js';
import { TOOL_IDS } from './registry.js';

/**
 * Tool identity resolution (tool-usage spec: "Tool identity resolution",
 * "Harness tool classification"). Spans are built inline: committed
 * fixtures hold filler words where commands were, so they cannot exercise
 * a resolved identity.
 */

let seq = 0;

function span(over: Partial<Span> & { name: string }): Span {
  seq++;
  const kind = over.kind ?? 'tool_call';
  return {
    id: `s${seq}`,
    parentId: 'sess',
    kind,
    status: 'ok',
    startedAt: '2026-11-11T10:00:00.000Z',
    endedAt: '2026-11-11T10:00:01.000Z',
    durationMs: 1000,
    depth: 1,
    attributes: {},
    provenance: { file: 'inline.jsonl' },
    ...(kind === 'tool_call' || kind === 'mcp_call'
      ? { tool: { name: over.name, isError: false } }
      : {}),
    ...over,
  };
}

/** A shell span stamped the way the adapters stamp it. */
function shell(command: string, redact = false, name = 'Bash'): Span {
  return span({
    name,
    attributes: toolUsageAttributes(command, 'posix', redact),
  });
}

describe('toolIdentity — spec scenarios of "Tool identity resolution"', () => {
  it('resolves a shell span with identity', () => {
    const id = toolIdentity(
      span({
        name: 'Bash',
        attributes: {
          [TOOL_ATTR.activity]: 'infra',
          [TOOL_ATTR.tool]: 'docker',
          [TOOL_ATTR.sub]: 'exec',
        },
      }),
    );
    expect(id).toMatchObject({
      family: 'shell',
      key: 'docker',
      sub: 'exec',
      activity: 'infra',
      registry: true,
      classified: true,
      container: false,
    });
  });

  it('rolls an MCP span up to its server', () => {
    const id = toolIdentity(
      span({
        kind: 'mcp_call',
        name: 'mcp__playwright__browser_click',
        tool: {
          name: 'mcp__playwright__browser_click',
          mcpServer: 'playwright',
          isError: false,
        },
      }),
    );
    expect(id).toMatchObject({
      family: 'mcp',
      key: 'playwright',
      label: 'playwright',
      sub: 'browser_click',
      activity: 'integration',
    });
  });

  it('resolves a call that spawned a subagent to the agent type', () => {
    const call = span({ name: 'Agent' });
    const sub = span({
      kind: 'subagent',
      name: 'subagent:Explore',
      parentId: call.id,
      agent: { name: 'Explore', sessionId: 'a1' },
    });
    const id = toolIdentity(call, identityContext([call, sub]));
    expect(id).toMatchObject({
      family: 'agent',
      key: 'Explore',
      label: 'Explore',
      activity: 'agent',
      container: true,
    });
  });

  it('resolves a trace produced before this change to the harness tool', () => {
    const id = toolIdentity(span({ name: 'Bash' }));
    expect(id).toMatchObject({
      family: 'shell',
      key: 'Bash',
      label: 'Bash',
      registry: false,
      classified: false,
      activity: 'other',
    });
    expect(id?.sub).toBeUndefined();
  });
});

describe('toolIdentity — spec scenarios of "Harness tool classification"', () => {
  it('gives the same activity across harnesses', () => {
    const claude = toolIdentity(span({ name: 'Read' }));
    const opencode = toolIdentity(span({ name: 'read' }));
    expect(claude).toMatchObject({ family: 'harness', activity: 'explore' });
    expect(opencode).toMatchObject({ family: 'harness', activity: 'explore' });
  });

  it('classifies tools that block on the person as human', () => {
    for (const name of ['AskUserQuestion', 'question', 'ExitPlanMode']) {
      expect(toolIdentity(span({ name })), name).toMatchObject({
        family: 'harness',
        key: name,
        activity: 'human',
      });
    }
  });

  it('classifies an unknown tool of a custom agent as other', () => {
    // the shape the OTLP adapter emits: a generic span name, the tool's
    // own name in `tool.name`
    const id = toolIdentity(
      span({
        name: 'execute_tool',
        tool: { name: 'search_docs', isError: false },
      }),
    );
    expect(id).toMatchObject({
      family: 'harness',
      key: 'search_docs',
      label: 'search_docs',
      activity: 'other',
    });
  });

  it('does not read tool input: the name alone decides', () => {
    const table: Array<[string, string]> = [
      ['Edit', 'edit'],
      ['apply_patch', 'edit'],
      ['Grep', 'explore'],
      ['WebFetch', 'web'],
      ['websearch', 'web'],
      ['TodoWrite', 'agent'],
      ['ListMcpResourcesTool', 'integration'],
    ];
    for (const [name, activity] of table) {
      expect(toolIdentity(span({ name }))?.activity, name).toBe(activity);
    }
  });
});

describe('toolIdentity — shell family', () => {
  it('reads what the classifier stamped', () => {
    const id = toolIdentity(
      shell('cd apps/web && pnpm exec vitest run 2>&1 | tail -20'),
    );
    expect(id).toMatchObject({
      family: 'shell',
      key: 'vitest',
      activity: 'test',
      via: 'pnpm exec',
      registry: true,
      utility: false,
    });
  });

  it('lists the other tools of a shared command, never the tool itself', () => {
    expect(toolIdentity(shell('git add -A && pnpm build'))).toMatchObject({
      key: 'pnpm',
      sub: 'run',
      detail: 'build',
      activity: 'build',
      also: ['git'],
    });
    const crafted = span({
      name: 'Bash',
      attributes: {
        [TOOL_ATTR.activity]: 'build',
        [TOOL_ATTR.tool]: 'pnpm',
        [TOOL_ATTR.also]: ['pnpm', 'git'],
      },
    });
    expect(toolIdentity(crafted)?.also).toEqual(['git']);
  });

  it('keeps a script name as free-form detail, absent under redaction', () => {
    expect(toolIdentity(shell('npm run db:reset'))).toMatchObject({
      key: 'npm',
      sub: 'run',
      detail: 'db:reset',
      activity: 'data',
    });
    const redacted = toolIdentity(shell('npm run db:reset', true));
    expect(redacted).toMatchObject({ key: 'npm', sub: 'run' });
    expect(redacted?.detail).toBeUndefined();
  });

  it('files a program outside the registry under one fixed key', () => {
    const open = toolIdentity(shell('acme-deploy --prod'));
    expect(open).toMatchObject({
      family: 'shell',
      key: OTHER_COMMAND_KEY,
      label: OTHER_COMMAND_LABEL,
      detail: 'acme-deploy',
      activity: 'other',
      registry: false,
      classified: true,
    });
    const redacted = toolIdentity(shell('acme-deploy --prod', true));
    expect(redacted).toMatchObject({ key: OTHER_COMMAND_KEY });
    expect(redacted?.detail).toBeUndefined();
  });

  it('resolves an unresolved command to the fixed key in both modes', () => {
    for (const redact of [false, true]) {
      const id = toolIdentity(shell('"$BIN" --version', redact));
      expect(id).toMatchObject({ key: OTHER_COMMAND_KEY, activity: 'other' });
      expect(id?.detail).toBeUndefined();
    }
  });

  it('marks utilities and plumbing for the folded group', () => {
    expect(toolIdentity(shell('ls -la | grep config'))?.utility).toBe(true);
    expect(toolIdentity(shell('cd packages/ui'))?.utility).toBe(true);
    expect(toolIdentity(shell('docker ps'))?.utility).toBe(false);
  });

  it('the fixed key can never be a registry id', () => {
    expect(TOOL_IDS).not.toContain(OTHER_COMMAND_KEY);
  });

  it('is the same for PowerShell and for an OpenCode bash span', () => {
    const attributes = toolUsageAttributes(
      'docker compose up -d',
      'posix',
      false,
    );
    const keys = ['Bash', 'PowerShell', 'bash'].map((name) => {
      const id = toolIdentity(span({ name, attributes }));
      return `${id?.family}/${id?.key}/${id?.sub}`;
    });
    expect(new Set(keys)).toEqual(new Set(['shell/docker/compose up']));
  });

  it('reads the tool name of an imported span from tool.name', () => {
    const id = toolIdentity(
      span({
        name: 'claude_code.tool',
        tool: { name: 'Bash', isError: false },
      }),
    );
    expect(id).toMatchObject({
      family: 'shell',
      key: 'Bash',
      classified: false,
    });
  });

  it('treats a classified span of a custom tool as a shell call', () => {
    const id = toolIdentity(
      span({
        name: 'run_command',
        attributes: {
          [TOOL_ATTR.activity]: 'infra',
          [TOOL_ATTR.tool]: 'terraform',
        },
      }),
    );
    expect(id).toMatchObject({ family: 'shell', key: 'terraform' });
    // a known harness tool is never re-read as a shell
    const read = span({
      name: 'Read',
      attributes: { [TOOL_ATTR.activity]: 'infra', [TOOL_ATTR.tool]: 'docker' },
    });
    expect(toolIdentity(read)).toMatchObject({
      family: 'harness',
      key: 'Read',
    });
  });

  it('falls back to the registry activity when only the tool is stamped', () => {
    const id = toolIdentity(
      span({ name: 'Bash', attributes: { [TOOL_ATTR.tool]: 'docker' } }),
    );
    expect(id).toMatchObject({ key: 'docker', activity: 'infra' });
  });
});

describe('toolIdentity — values from outside are validated', () => {
  it('ignores a tool id outside the registry', () => {
    const id = toolIdentity(
      span({
        name: 'Bash',
        attributes: {
          [TOOL_ATTR.activity]: 'other',
          [TOOL_ATTR.tool]: '/Users/alex/bin/deploy',
        },
      }),
    );
    expect(id).toMatchObject({ key: OTHER_COMMAND_KEY, registry: false });
  });

  it('ignores a subcommand outside the tool table, a bad runner and bad flags', () => {
    const id = toolIdentity(
      span({
        name: 'Bash',
        attributes: {
          [TOOL_ATTR.activity]: 'vcs',
          [TOOL_ATTR.tool]: 'git',
          [TOOL_ATTR.sub]: './secret-plan',
          [TOOL_ATTR.via]: 'my-wrapper',
          [TOOL_ATTR.also]: ['acme-tool'],
          [TOOL_ATTR.flags]: ['exploded'],
        },
      }),
    );
    expect(id).toMatchObject({ key: 'git', also: [], flags: [] });
    expect(id?.sub).toBeUndefined();
    expect(id?.via).toBeUndefined();
  });

  it('ignores an activity outside the taxonomy', () => {
    const id = toolIdentity(
      span({ name: 'Bash', attributes: { [TOOL_ATTR.activity]: 'deploying' } }),
    );
    expect(id).toMatchObject({ key: 'Bash', classified: false });
  });

  it('drops free-form text that is not a short string', () => {
    for (const value of [42, '', '   ', 'x'.repeat(200), ['a'], null]) {
      const id = toolIdentity(
        span({
          name: 'Bash',
          attributes: {
            [TOOL_ATTR.activity]: 'other',
            [TOOL_ATTR.name]: value,
          },
        }),
      );
      expect(id?.detail, JSON.stringify(value)).toBeUndefined();
    }
  });

  it('returns flags in the fixed order', () => {
    const id = toolIdentity(
      span({
        name: 'Bash',
        attributes: {
          [TOOL_ATTR.activity]: 'run',
          [TOOL_ATTR.tool]: 'pnpm',
          [TOOL_ATTR.flags]: ['interrupted', 'background'],
        },
      }),
    );
    expect(id?.flags).toEqual(['background', 'interrupted']);
  });
});

describe('toolIdentity — other families', () => {
  it('names a skill call by its skill, and by the tool when redacted', () => {
    const named = toolIdentity(
      span({
        name: 'Skill',
        attributes: { [TOOL_ATTR.skill]: 'acme-runbook' },
      }),
    );
    expect(named).toMatchObject({
      family: 'skill',
      key: 'acme-runbook',
      activity: 'agent',
    });
    expect(toolIdentity(span({ name: 'Skill' }))).toMatchObject({
      family: 'skill',
      key: 'Skill',
    });
    expect(toolIdentity(span({ name: 'skill' }))).toMatchObject({
      family: 'skill',
      key: 'skill',
    });
  });

  it('keeps a delegation without a recorded subagent as a plain call', () => {
    expect(toolIdentity(span({ name: 'Agent' }))).toMatchObject({
      family: 'agent',
      key: 'Agent',
      container: false,
    });
  });

  it('names a forked skill by the subagent it contains', () => {
    const call = span({ name: 'Skill' });
    const sub = span({
      kind: 'subagent',
      name: 'subagent:code-review',
      parentId: call.id,
    });
    expect(toolIdentity(call, identityContext([sub, call]))).toMatchObject({
      family: 'agent',
      key: 'code-review',
      container: true,
    });
  });

  it('does not treat a subagent under a non-tool span as a container', () => {
    const call = span({ name: 'Agent' });
    const sub = span({
      kind: 'subagent',
      name: 'subagent:Explore',
      parentId: 'sess',
    });
    const context = identityContext([call, sub]);
    expect(context.subagents.size).toBe(0);
    expect(toolIdentity(call, context)?.container).toBe(false);
  });

  it('strips the server from an underscore-joined MCP tool name', () => {
    const id = toolIdentity(
      span({
        kind: 'mcp_call',
        name: 'github_create_issue',
        tool: {
          name: 'github_create_issue',
          mcpServer: 'github',
          isError: false,
        },
      }),
    );
    expect(id).toMatchObject({
      family: 'mcp',
      key: 'github',
      sub: 'create_issue',
    });
  });

  it('keeps an MCP call without a server under its own name', () => {
    const id = toolIdentity(span({ kind: 'mcp_call', name: 'lookup' }));
    expect(id).toMatchObject({ family: 'mcp', key: 'lookup' });
    expect(id?.sub).toBeUndefined();
  });

  it('resolves a hook span to the hook family', () => {
    const id = toolIdentity(
      span({
        kind: 'hook',
        name: 'PostToolUse:Edit',
        attributes: { [TOOL_ATTR.activity]: 'check' },
      }),
    );
    expect(id).toMatchObject({
      family: 'hook',
      key: 'PostToolUse:Edit',
      activity: 'check',
    });
    expect(toolIdentity(span({ kind: 'hook', name: 'Stop' }))?.activity).toBe(
      'other',
    );
  });

  it('resolves only tool, MCP and hook spans', () => {
    for (const kind of ['session', 'turn', 'llm_call', 'subagent', 'other']) {
      const s = span({ kind: kind as Span['kind'], name: 'x' });
      expect(isToolSpan(s), kind).toBe(false);
      expect(toolIdentity(s), kind).toBeUndefined();
    }
  });

  it('always resolves to a family of the closed set, deterministically', () => {
    const spans = [
      shell('docker ps'),
      span({ name: 'Read' }),
      span({ name: 'Skill' }),
      span({ kind: 'hook', name: 'Stop' }),
      span({ kind: 'mcp_call', name: 'lookup' }),
    ];
    const context = identityContext(spans);
    for (const s of spans) {
      const first = toolIdentity(s, context);
      expect(TOOL_FAMILIES).toContain(first?.family);
      expect(toolIdentity(s, context)).toEqual(first);
    }
  });
});
