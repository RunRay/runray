import type { Span } from '@runray/schema';
import {
  ERROR_CLASS_META,
  type ErrorClassId,
  type ErrorOwner,
} from './meta.js';

/**
 * Error classification (error-triage capability): a pure function of the
 * span — its kind, tool name, exit code and failure text — to a class id
 * and the owner who has a lever. Patterns are an ORDERED list of regular
 * expressions over the preview (the adapters already start it where the
 * failure is named); the first match wins, so the result is deterministic
 * and wrong in the same way every time. Verified against the user's own
 * 592 failures on 2026-09-03.
 *
 * Without text (redacted sessions, adapters that carry none) the class
 * falls back to what the span shape still tells: an MCP call is the
 * server's problem, a shell wrapper's exit code is a non-zero exit,
 * anything else is unclassified.
 */

export interface ErrorClassification {
  classId: ErrorClassId;
  owner: ErrorOwner;
}

interface Pattern {
  id: ErrorClassId;
  re: RegExp;
}

const MODEL_PATTERNS: readonly Pattern[] = [
  {
    id: 'model-limit',
    re: /hit your (?:session |weekly |daily )?limit|reached your .{0,40}limit|usage limit|rate[ _-]?limit|\b429\b|quota/i,
  },
  {
    id: 'model-auth',
    re: /not logged in|\/login\b|unauthorized|\b401\b|invalid (?:api )?key|authentication/i,
  },
  {
    id: 'model-server',
    re: /\b(?:500|502|503|504|529)\b|internal server error|overloaded|server-side|timed out|timeout|econnreset|socket hang up|network error/i,
  },
  {
    id: 'model-content',
    re: /safeguards|flagged|could not be processed|content filter|usage policy|aup\b/i,
  },
];

const TOOL_PATTERNS: readonly Pattern[] = [
  {
    id: 'edit-anchor-miss',
    re: /String to replace not found|Could not find oldString|Failed to find expected lines|matches of the string to replace|apply_patch verification failed|old_string.*not found|has been modified since read/i,
  },
  { id: 'read-before-write', re: /has not been read yet/i },
  {
    id: 'input-validation',
    re: /InputValidationError|Input validation error|could not be parsed as JSON|Invalid arguments for tool|Invalid workflow script|control characters|-32602|required parameter .* is missing|No changes to make|at most \d+ actions/i,
  },
  {
    id: 'tool-misuse',
    re: /requires a prior computer|No site is open|No preview is open|exceeds maximum allowed tokens|Cannot read binary file|no screenshot dimensions|Unknown action|not a valid action|Use offset and limit|No task found|No-op:|no read_page tree|outside the coordinate frame|takes a process id|^(?:Server|Preview) not found/i,
  },
  {
    id: 'tool-unavailable',
    re: /No such tool available|not enabled in this context|Skill "?[^"]*"? not found|No \.claude\/launch\.json|not found in \.claude\/launch|Unknown server name|No such configuration|Available skills: none|<tool_use_error>Blocked:|blocked by (?:a )?hook|dev server exited|can't be moved/i,
  },
  {
    id: 'port-in-use',
    re: /Port \d+ is required|EADDRINUSE|is in use by|address already in use/i,
  },
  {
    id: 'pane-timeout',
    re: /timed out after|did not finish rendering|may be stuck|unresponsive renderer|Screenshot timed out|navigated or closed/i,
  },
  {
    id: 'pane-navigation',
    re: /was denied or failed|couldn't open file:|scheme is not allowed|cannot navigate|is pinned to|blocked by policy|Failed to fetch|net::ERR_|ERR_CONNECTION/i,
  },
  {
    id: 'missing-binary',
    re: /nie znaleziono Python|command not found|is not recognized as|not recognized as the name|ERR_MODULE_NOT_FOUND|Cannot find module|ERR_PACKAGE_PATH_NOT_EXPORTED|Permission denied|EACCES|EPERM|No module named|npm ERR!|not found: |Could not find a working python|is not installed/i,
  },
  {
    id: 'shell-syntax',
    re: /unexpected EOF while looking|token '&&'|not a valid statement separator|syntax error near|ParserError|Missing closing|cannot be parsed|unexpected token|The term '.*' is not recognized/i,
  },
  {
    id: 'path-not-found',
    re: /File does not exist|Path does not exist|File not found|ENOENT|No such file or directory|cd: .*: No such|does not exist|can't read/i,
  },
  {
    id: 'http-error',
    re: /status code:? \d{3}|Request failed|ECONNREFUSED|ENOTFOUND|fetch failed|\b429\b|timeout of \d+ms|HTTP \d{3}/i,
  },
  {
    id: 'check-failed',
    re: /Failing tests|EXCEPTION CAUGHT|assertion was thrown|When the exception was thrown|Analyzing \w+\.\.\.|\blint\/|typecheck|error TS\d+|\bFAIL\b|✗|✖|Test failed|tests? failed|Some tests failed|\.test\.[tj]sx?|test\/[\w_-]+\.\w+|expected .* (?:received|but got)|AssertionError|error\[E\d+\]|Build failed|Compilation failed/i,
  },
  {
    id: 'script-error',
    re: /TypeError|ReferenceError|RangeError|SyntaxError|Unhandled|Uncaught|\[eval\]|<anonymous_script>|Traceback \(most recent call last\)|ERR_UNSUPPORTED_ESM_URL_SCHEME|ERR_REQUIRE_ESM|^\s*Error: /i,
  },
  { id: 'mcp-error', re: /MCP error -?\d+|MCP server|JSON-RPC/i },
];

function textOf(span: Span): string | undefined {
  const t = span.content?.outputPreview;
  return typeof t === 'string' && t.trim() !== '' ? t : undefined;
}

function withOwner(classId: ErrorClassId): ErrorClassification {
  return { classId, owner: ERROR_CLASS_META[classId].owner };
}

/**
 * Class and owner of a failed span. Callers pass spans with status
 * `error`; a span of any other status still gets a classification (the
 * function does not look at status), so the caller decides what counts.
 */
export function classifyError(span: Span): ErrorClassification {
  const text = textOf(span);
  if (span.kind === 'llm_call') {
    if (text !== undefined) {
      for (const p of MODEL_PATTERNS)
        if (p.re.test(text)) return withOwner(p.id);
    }
    return withOwner('model-error');
  }
  if (text !== undefined) {
    for (const p of TOOL_PATTERNS) if (p.re.test(text)) return withOwner(p.id);
  }
  if (span.kind === 'mcp_call') return withOwner('mcp-error');
  if (span.tool?.exitCode !== undefined && span.tool.exitCode !== 0) {
    return withOwner('exit-nonzero');
  }
  return withOwner('unclassified');
}
