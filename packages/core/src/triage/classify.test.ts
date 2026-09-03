import type { Span } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { classifyError } from './classify.js';

function span(over: Partial<Span> & { text?: string | null }): Span {
  const { text, ...rest } = over;
  return {
    id: 'e1',
    parentId: 'm1',
    kind: 'tool_call',
    name: 'Bash',
    status: 'error',
    startedAt: '2026-09-03T10:00:00Z',
    depth: 2,
    tool: { name: rest.name ?? 'Bash', isError: true },
    ...(text === undefined ? {} : { content: { outputPreview: text } }),
    attributes: {},
    provenance: { file: 'f' },
    ...rest,
  } as Span;
}

/** Real failure texts from the user's sessions (2026-09-03), one per class. */
const CASES: [string, Partial<Span> & { text?: string | null }, string][] = [
  [
    'edit-anchor-miss',
    {
      name: 'Edit',
      text: '<tool_use_error>String to replace not found in file. String: if (x) return false;</tool_use_error>',
    },
    'agent',
  ],
  [
    'read-before-write',
    {
      name: 'Write',
      text: '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>',
    },
    'agent',
  ],
  [
    'input-validation',
    {
      name: 'Monitor',
      text: '<tool_use_error>InputValidationError: Monitor failed due to the following issues: The required parameter `description` is missing</tool_use_error>',
    },
    'agent',
  ],
  [
    'input-validation',
    {
      name: 'mcp__Claude_Browser__computer',
      kind: 'mcp_call',
      text: 'MCP error -32602: Input validation error: Invalid arguments for tool computer',
    },
    'agent',
  ],
  [
    'tool-misuse',
    {
      name: 'mcp__Claude_Browser__computer',
      kind: 'mcp_call',
      text: 'No site is open in this tab. Use `navigate` first.',
    },
    'agent',
  ],
  [
    'tool-misuse',
    {
      name: 'Read',
      text: 'File content (67493 tokens) exceeds maximum allowed tokens (25000). Use offset and limit parameters to read specific portions of the file',
    },
    'agent',
  ],
  [
    'tool-unavailable',
    {
      name: 'mcp__Claude_Browser__preview_start',
      kind: 'mcp_call',
      text: 'No .claude/launch.json found. Create D:\\proj\\.claude\\launch.json with this format: {}',
    },
    'you',
  ],
  [
    'tool-unavailable',
    {
      name: 'skill',
      text: 'Error: Skill "frontend-design" not found. Available skills: none',
    },
    'you',
  ],
  [
    'port-in-use',
    {
      name: 'mcp__Claude_Preview__preview_start',
      kind: 'mcp_call',
      text: 'Port 3001 is required by this server but is in use by "node.exe" (PID 8152). Stop that process to free port 3001 and try again.',
    },
    'you',
  ],
  [
    'pane-timeout',
    {
      name: 'mcp__Claude_Browser__computer',
      kind: 'mcp_call',
      text: 'screenshot failed: Screenshot timed out after 5s: the page did not finish rendering in time. Retry; the pane does not need to be displayed.',
    },
    'tooling',
  ],
  [
    'pane-timeout',
    {
      name: 'mcp__Claude_Browser__browser_batch',
      kind: 'mcp_call',
      text: 'actions[2] (computer:screenshot) failed: screenshot failed: Screenshot timed out after 5s (2 completed, 0 remaining)',
    },
    'tooling',
  ],
  [
    'pane-navigation',
    {
      name: 'mcp__Claude_Browser__navigate',
      kind: 'mcp_call',
      text: 'navigation to http://localhost:3001 was denied or failed',
    },
    'tooling',
  ],
  [
    'pane-navigation',
    {
      name: 'mcp__Claude_Browser__navigate',
      kind: 'mcp_call',
      text: "couldn't open file:///C:/Users/x/report.html — the file scheme is not allowed",
    },
    'tooling',
  ],
  [
    'missing-binary',
    { text: 'nie znaleziono Python; uruchom bez argumentów, aby zainstalować' },
    'you',
  ],
  [
    'missing-binary',
    {
      text: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\\x\\smoke.mjs'",
    },
    'you',
  ],
  [
    'missing-binary',
    { text: '/usr/bin/bash: line 81: /smoke.mjs: Permission denied' },
    'you',
  ],
  [
    'shell-syntax',
    {
      text: "/usr/bin/bash: -c: line 126: unexpected EOF while looking for matching `''",
    },
    'you',
  ],
  [
    'shell-syntax',
    {
      name: 'PowerShell',
      text: "The token '&&' is not a valid statement separator in this version.",
    },
    'you',
  ],
  [
    'path-not-found',
    {
      text: '/usr/bin/bash: line 1: cd: packages/ui/src: No such file or directory',
    },
    'agent',
  ],
  [
    'path-not-found',
    {
      name: 'Read',
      text: 'File does not exist. Note: your current working directory is D:\\GIT\\pstryk.',
    },
    'agent',
  ],
  [
    'path-not-found',
    {
      name: 'Grep',
      text: '<tool_use_error>Path does not exist: D:\\GIT\\pstryk\\apps\\layout. Note: your current working directory is D:\\GIT\\pstryk.</tool_use_error>',
    },
    'agent',
  ],
  [
    'http-error',
    { name: 'webfetch', text: 'Error: Request failed with status code: 404' },
    'you',
  ],
  [
    'check-failed',
    {
      name: 'PowerShell',
      text: 'Failing tests: D:/GIT/app/test/make_icons_test.dart: loading D:/GIT/app/test/make_icons_test.dart',
    },
    'work',
  ],
  [
    'check-failed',
    {
      name: 'PowerShell',
      text: '══╡ EXCEPTION CAUGHT BY FLUTTER TEST FRAMEWORK ╞═══ When the exception was thrown, this was the stack',
    },
    'work',
  ],
  [
    'check-failed',
    {
      text: 'packages\\ui\\src\\lib\\load.test.ts:27:10 lint/correctness/noUnusedVariables FIXABLE',
    },
    'work',
  ],
  [
    'script-error',
    {
      text: "[eval]:4 console.log('X:', d.potwierdzone.length); ^ TypeError: Cannot read properties of undefined",
    },
    'agent',
  ],
  [
    'script-error',
    {
      name: 'mcp__Claude_Browser__javascript_tool',
      kind: 'mcp_call',
      text: 'javascript_tool failed: SyntaxError: await is only valid in async functions',
    },
    'agent',
  ],
  [
    'mcp-error',
    {
      name: 'mcp__ccd_directory__change_directory',
      kind: 'mcp_call',
      text: 'MCP error -32000: internal failure',
    },
    'tooling',
  ],
  [
    'exit-nonzero',
    {
      text: '=== cli config.ts threshold override handling === if (raw !== undefined) {',
      tool: { name: 'Bash', isError: true, exitCode: 2 },
    },
    'work',
  ],
  [
    'edit-anchor-miss',
    {
      name: 'Edit',
      text: '<tool_use_error>File has been modified since read, either by the user or by a linter. Read it again</tool_use_error>',
    },
    'agent',
  ],
  [
    'tool-misuse',
    {
      name: 'TaskOutput',
      text: '<tool_use_error>No task found with ID: status-check</tool_use_error>',
    },
    'agent',
  ],
  [
    'tool-misuse',
    {
      name: 'mcp__Claude_Preview__preview_eval',
      kind: 'mcp_call',
      text: 'Server not found. No running servers for this workspace.',
    },
    'agent',
  ],
  [
    'tool-unavailable',
    {
      text: '<tool_use_error>Blocked: sleep 45 followed by: gh pr checks 113. To wait for CI use Monitor</tool_use_error>',
    },
    'you',
  ],
  [
    'tool-unavailable',
    {
      name: 'mcp__Claude_Browser__preview_start',
      kind: 'mcp_call',
      text: 'The dev server exited during startup (code 1). Fix the error in the output below, then start the server again.',
    },
    'you',
  ],
  [
    'pane-navigation',
    {
      name: 'mcp__Claude_Browser__navigate',
      kind: 'mcp_call',
      text: 'https://claude.ai is blocked by policy and cannot be opened in the Browser pane.',
    },
    'tooling',
  ],
  [
    'pane-timeout',
    {
      name: 'mcp__Claude_Browser__javascript_tool',
      kind: 'mcp_call',
      text: 'javascript_tool failed: Inspected target navigated or closed',
    },
    'tooling',
  ],
  [
    'missing-binary',
    {
      name: 'Read',
      text: 'pdftoppm is not installed. Install poppler-utils (e.g. `brew install poppler`)',
    },
    'you',
  ],
  [
    'script-error',
    {
      text: 'Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in: file, data, and node are supported',
    },
    'agent',
  ],
  [
    'check-failed',
    {
      name: 'PowerShell',
      text: 'When the exception was thrown, this was the stack: #0 ConsumerStatefulElement._assertNotDisposed',
    },
    'work',
  ],
  [
    'input-validation',
    {
      name: 'Edit',
      text: '<tool_use_error>No changes to make: old_string and new_string are exactly the same.</tool_use_error>',
    },
    'agent',
  ],
  [
    'path-not-found',
    {
      name: 'read',
      text: 'Error: File not found: D:\\GIT\\ReplyAI\\apps\\planner\\lib\\spotlight.ts',
    },
    'agent',
  ],
  ['unclassified', { text: 'something nobody has seen before' }, 'unknown'],
];

describe('classifyError — tool failures', () => {
  for (const [expected, over, owner] of CASES) {
    it(`${expected}: ${(over.text ?? '').slice(0, 50)}`, () => {
      const c = classifyError(span(over));
      expect(c.classId).toBe(expected);
      expect(c.owner).toBe(owner);
    });
  }

  it('does not read `error` inside identifiers as a failure word', () => {
    // tool_use_error wraps the message; the class comes from the message
    const c = classifyError(
      span({
        name: 'Grep',
        text: '<tool_use_error>Path does not exist: /x</tool_use_error>',
      }),
    );
    expect(c.classId).toBe('path-not-found');
  });
});

describe('classifyError — the tool-misuse case that is also a Read limit', () => {
  it('prefers tool-misuse over path-not-found for the Read token cap', () => {
    const c = classifyError(
      span({
        name: 'Read',
        text: 'File content (26686 tokens) exceeds maximum allowed tokens (25000).',
      }),
    );
    expect(c.classId).toBe('tool-misuse');
  });
});

describe('classifyError — model-call failures', () => {
  const model = (text: string | null | undefined) =>
    span({
      kind: 'llm_call',
      name: 'llm',
      tool: undefined,
      llm: {
        provider: 'anthropic',
        model: '<synthetic>',
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costSource: 'unknown',
      },
      text,
    });
  it('maps limits, auth, server errors and refusals', () => {
    expect(
      classifyError(model("You've hit your session limit · resets 11:10pm"))
        .classId,
    ).toBe('model-limit');
    expect(
      classifyError(
        model("You've reached your Fable 5 limit. Switch to another model"),
      ).classId,
    ).toBe('model-limit');
    expect(
      classifyError(model('Not logged in · Please run /login')).classId,
    ).toBe('model-auth');
    expect(
      classifyError(
        model(
          'API Error: 500 Internal server error. This is a server-side issue',
        ),
      ).classId,
    ).toBe('model-server');
    expect(
      classifyError(
        model("API Error: Fable 5's safeguards flagged this message"),
      ).classId,
    ).toBe('model-content');
    expect(
      classifyError(
        model('API Error: an image in the conversation could not be processed'),
      ).classId,
    ).toBe('model-content');
    expect(classifyError(model('API Error: something new')).classId).toBe(
      'model-error',
    );
  });
  it('owner: limits and auth are the person, the rest is the model', () => {
    expect(classifyError(model('Not logged in')).owner).toBe('you');
    expect(classifyError(model('API Error: 529 overloaded')).owner).toBe(
      'model',
    );
  });
});

describe('classifyError — without text', () => {
  it('falls back to the span shape', () => {
    expect(classifyError(span({ text: null })).classId).toBe('unclassified');
    expect(classifyError(span({})).classId).toBe('unclassified');
    expect(
      classifyError(span({ name: 'mcp__x__y', kind: 'mcp_call', text: null }))
        .classId,
    ).toBe('mcp-error');
    expect(
      classifyError(
        span({
          text: null,
          tool: { name: 'Bash', isError: true, exitCode: 1 },
        }),
      ).classId,
    ).toBe('exit-nonzero');
    expect(
      classifyError(
        span({
          text: null,
          tool: { name: 'Bash', isError: true, exitCode: 0 },
        }),
      ).classId,
    ).toBe('unclassified');
    expect(
      classifyError(
        span({ kind: 'llm_call', name: 'llm', tool: undefined, text: null }),
      ).classId,
    ).toBe('model-error');
  });
});
