import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readRolloutLines } from '../packages/core/src/rollout-lines.js';
import {
  BLOB_PLACEHOLDER,
  isScrubMarkerLine,
  newCodexStats,
  ROLLOUT_FILE,
  scrubCodexFile,
  scrubCodexLines,
  scrubCodexPath,
  scrubCodexRecord,
  scrubDiffText,
  scrubOutputText,
} from './scrub-codex.js';

// Everything below is invented for these tests: the person, the machine,
// the repository and the ids. None of it comes from a real session.
const secrets = { username: 'alice', host: 'ALICE-LAPTOP' };

const ACCOUNT_ID = '7f1c2a90-4b1e-4c3d-9a55-0d6e2b7c8f11';
const USER_ID = 'user-Zk3QpV8mT1xYbN4cRw7LhJ2s';
const REPO_URL = 'https://github.com/acme-corp/billing-portal.git';
const COMMIT = '9fceb02d0ae598e95dc970b74767f19372d61af8';
const THREAD = '0199f3a0-1111-7222-8333-444455556666';
const TURN = '0199f3a0-aaaa-7bbb-8ccc-ddddeeeeffff';
const CWD = 'C:\\Users\\alice\\work\\billing-portal';
const FILE_A = `${CWD}\\src\\Invoices\\InvoiceService.cs`;
const FILE_B = `${CWD}\\src\\Invoices\\TaxRules.cs`;

/** Substrings that must not survive scrubbing, anywhere in a record. */
const NEEDLES = [
  'alice',
  'ALICE-LAPTOP',
  'billing-portal',
  'acme-corp',
  'github.com',
  'Invoices',
  'InvoiceService',
  'TaxRules',
  ACCOUNT_ID,
  USER_ID,
  COMMIT,
  'feature/vat-rounding',
  'customer_email',
  'jan.kowalski',
  'secret-roadmap',
  'Zaokrąglij',
  'Get-ChildItem',
  'vat_rate',
  'Europe/Warsaw',
  'prolite',
  'iVBORw0KGgo',
  'acme-internal',
  'client-name',
];

const UNIFIED_DIFF = [
  '@@ -10,4 +10,5 @@ public class InvoiceService',
  ' var net = line.Net;',
  '-var vat = net * 0.23m;',
  '+var vat = Math.Round(net * vat_rate, 2);',
  '+++counter;',
  '--counter;',
  ' return net + vat;',
  '',
].join('\n');

const PATCH = [
  '*** Begin Patch',
  `*** Update File: ${FILE_A}`,
  '@@ public decimal Total(Line line)',
  ' var net = line.Net;',
  '-var vat = net * 0.23m;',
  '+var vat = Math.Round(net * vat_rate, 2);',
  '@@',
  '-// secret-roadmap',
  `*** Add File: ${FILE_B}`,
  '+namespace Invoices;',
  '+public record TaxRules(decimal vat_rate);',
  '*** Delete File: src/Invoices/Legacy.cs',
  '*** End Patch',
].join('\n');

/** Added and removed lines as the adapter counts them (design T9). */
function changeLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

const base = (type: string, ordinal: number, payload: unknown) => ({
  timestamp: '2026-10-13T09:00:00.000Z',
  ordinal,
  type,
  payload,
});

// biome-ignore lint/suspicious/noExplicitAny: a scrubbed record is read loosely in assertions
type Loose = any;

interface Case {
  name: string;
  record: Record<string, unknown>;
  /** Assertions on the scrubbed record, beyond "no needle survives". */
  check: (out: Loose) => void;
}

const CASES: Case[] = [
  {
    name: 'session_meta of a root thread',
    record: base('session_meta', 0, {
      id: THREAD,
      session_id: THREAD,
      timestamp: '2026-10-13T09:00:00.000Z',
      cwd: CWD,
      originator: 'Codex Desktop',
      cli_version: '0.158.0-alpha.2.1',
      source: 'vscode',
      thread_source: 'user',
      model_provider: 'openai',
      creator_account_id: ACCOUNT_ID,
      creator_user_id: USER_ID,
      git: {
        branch: 'feature/vat-rounding',
        commit_hash: COMMIT,
        repository_url: REPO_URL,
      },
      runtime_workspace_roots: [CWD, 'D:\\scratch\\secret-roadmap'],
      base_instructions: {
        text: 'You are Codex. '.repeat(400),
        provenance: 'x',
      },
      dynamic_tools: [
        {
          name: 'billing-portal-admin',
          description: 'Looks up a customer_email',
          input_schema: { properties: { customer_email: { type: 'string' } } },
        },
      ],
    }),
    check: (out) => {
      const p = out.payload;
      expect(p.id).toBe(THREAD);
      expect(p.session_id).toBe(THREAD);
      expect(p.originator).toBe('Codex Desktop');
      expect(p.cli_version).toBe('0.158.0-alpha.2.1');
      expect(p.source).toBe('vscode');
      expect(p.thread_source).toBe('user');
      expect(p.model_provider).toBe('openai');
      expect(p.cwd).toMatch(/^\/home\/user\/project\//);
      expect(p.runtime_workspace_roots).toHaveLength(2);
      expect(p.creator_account_id).toMatch(/^anon_[0-9a-f]{8}$/);
      expect(p.creator_user_id).toMatch(/^anon_[0-9a-f]{8}$/);
      expect(p.git.repository_url).toBe('https://example.com/user/project.git');
      expect(p.git.commit_hash).toBe('0'.repeat(40));
      expect(p.git.branch).toHaveLength('feature/vat-rounding'.length);
      expect(p.base_instructions.text).toBe(BLOB_PLACEHOLDER);
      // a tool definition is somebody's payload: no key of it survives
      expect(Object.keys(p.dynamic_tools[0])).not.toContain('name');
      expect(p.dynamic_tools).toHaveLength(1);
    },
  },
  {
    name: 'session_meta of a reviewer thread',
    record: base('session_meta', 0, {
      id: THREAD,
      parent_thread_id: '0199f3a0-9999-7222-8333-444455556666',
      cli_version: '0.160.0',
      originator: 'Codex Desktop',
      thread_source: 'guardian_review',
      source: {
        subagent: {
          other: 'guardian',
          thread_spawn: { agent_nickname: 'jan.kowalski', depth: 1 },
        },
      },
    }),
    check: (out) => {
      const p = out.payload;
      expect(p.parent_thread_id).toBe('0199f3a0-9999-7222-8333-444455556666');
      expect(p.thread_source).toBe('guardian_review');
      expect(p.source.subagent.other).toBe('guardian');
      expect(p.source.subagent.thread_spawn.depth).toBe(1);
      expect(p.source.subagent.thread_spawn.agent_nickname).toHaveLength(12);
    },
  },
  {
    name: 'turn_context',
    record: base('turn_context', 3, {
      turn_id: TURN,
      model: 'gpt-5.5',
      cwd: CWD,
      effort: 'high',
      timezone: 'Europe/Warsaw',
      current_date: '2026-10-13',
      sandbox_policy: { type: 'workspace-write', writable_roots: [CWD] },
      file_system_sandbox_policy: {
        kind: 'restricted',
        entries: [
          { access: 'write', path: { type: 'path', path: CWD } },
          {
            access: 'read',
            path: { type: 'special', value: { kind: 'root' } },
          },
        ],
      },
    }),
    check: (out) => {
      const p = out.payload;
      expect(p.turn_id).toBe(TURN);
      expect(p.model).toBe('gpt-5.5');
      expect(p.sandbox_policy.type).toBe('workspace-write');
      expect(p.sandbox_policy.writable_roots[0]).toMatch(/^\/home\/user\//);
      expect(p.file_system_sandbox_policy.entries[0].path.type).toBe('path');
      expect(p.file_system_sandbox_policy.entries[0].path.path).toMatch(
        /^\/home\/user\//,
      );
      expect(p.file_system_sandbox_policy.entries[1].path.value.kind).toBe(
        'root',
      );
    },
  },
  {
    name: 'token_usage_record',
    record: base('token_usage_record', 20, {
      response_id: 'resp_0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607182',
      turn_id: TURN,
      root_turn_id: TURN,
      thread_id: THREAD,
      session_id: THREAD,
      usage: {
        input_tokens: 10_000,
        cached_input_tokens: 8_000,
        cache_write_input_tokens: 0,
        output_tokens: 500,
        reasoning_output_tokens: 300,
        total_tokens: 10_500,
      },
    }),
    check: (out) => {
      // ids and every counter are untouched
      expect(out).toEqual(CASES[3]?.record);
    },
  },
  {
    name: 'token_count with rate limits',
    record: base('event_msg', 21, {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: 5, output_tokens: 7 } },
      rate_limits: {
        plan_type: 'prolite',
        limit_id: 'codex',
        primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1 },
      },
    }),
    check: (out) => {
      expect(out.payload.type).toBe('token_count');
      expect(out.payload.info.last_token_usage).toEqual({
        input_tokens: 5,
        output_tokens: 7,
      });
      expect(out.payload.rate_limits.primary.used_percent).toBe(12.5);
      expect(out.payload.rate_limits.plan_type).toHaveLength(7);
    },
  },
  {
    name: 'command behind a PowerShell wrapper',
    record: base('event_msg', 30, {
      type: 'item_completed',
      thread_id: THREAD,
      turn_id: TURN,
      started_at_ms: 1_000,
      completed_at_ms: 1_450,
      item: {
        type: 'CommandExecution',
        id: 'exec-0199f3a0-1234-7222-8333-444455556666',
        command: [
          'C:\\Users\\alice\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe',
          '-NoProfile',
          '-Command',
          `Get-ChildItem ${CWD}\\src -Recurse | Select-String vat_rate`,
        ],
        cwd: CWD,
        source: 'unified_exec_startup',
        status: 'failed',
        exit_code: 1,
        duration: { secs: 0, nanos: 450_000_000 },
        process_id: '48213',
        aggregated_output: `${FILE_A}:12: vat_rate`,
        formatted_output: `${FILE_A}:12: vat_rate`,
        stdout: `${FILE_A}:12: vat_rate`,
        stderr: '',
        parsed_cmd: [
          {
            type: 'read',
            cmd: 'cat InvoiceService.cs',
            name: 'InvoiceService.cs',
            path: FILE_A,
          },
        ],
      },
    }),
    check: (out) => {
      const item = out.payload.item;
      expect(item.type).toBe('CommandExecution');
      expect(item.id).toBe('exec-0199f3a0-1234-7222-8333-444455556666');
      expect(item.status).toBe('failed');
      expect(item.exit_code).toBe(1);
      expect(item.duration).toEqual({ secs: 0, nanos: 450_000_000 });
      // the wrapper survives: drive, program name and flags
      expect(item.command).toHaveLength(4);
      expect(item.command[0]).toMatch(/^C:\\.*\\pwsh\.exe$/);
      expect(item.command[0].split('\\')).toHaveLength(8);
      expect(item.command[1]).toBe('-NoProfile');
      expect(item.command[2]).toBe('-Command');
      // output keeps its length, which is what `outputBytes` is read from
      expect(item.formatted_output).toHaveLength(
        `${FILE_A}:12: vat_rate`.length,
      );
      expect(item.parsed_cmd).toHaveLength(1);
      expect(Object.keys(item.parsed_cmd[0])).not.toContain('name');
    },
  },
  {
    name: 'file change keyed by path',
    record: base('event_msg', 31, {
      type: 'item_completed',
      thread_id: THREAD,
      turn_id: TURN,
      item: {
        type: 'FileChange',
        id: 'exec-0199f3a0-5678-7222-8333-444455556666',
        status: 'completed',
        changes: {
          [FILE_A]: {
            type: 'update',
            unified_diff: UNIFIED_DIFF,
            move_path: null,
          },
          [FILE_B]: {
            type: 'add',
            content:
              'namespace Invoices;\npublic record TaxRules(decimal vat_rate);\n',
          },
        },
      },
    }),
    check: (out) => {
      const changes = out.payload.item.changes;
      const keys = Object.keys(changes);
      expect(keys).toHaveLength(2);
      for (const key of keys)
        expect(key).toMatch(/^\/home\/user\/project\/.*\.cs$/);
      const [update, add] = keys.map((k) => changes[k]);
      expect(update.type).toBe('update');
      expect(update.move_path).toBeNull();
      expect(changeLines(update.unified_diff)).toEqual(
        changeLines(UNIFIED_DIFF),
      );
      expect(update.unified_diff.split('\n')[0]).toMatch(
        /^@@ -10,4 \+10,5 @@ /,
      );
      expect(add.type).toBe('add');
      expect(add.content.split('\n')).toHaveLength(3);
    },
  },
  {
    name: 'MCP call with arbitrary arguments and result',
    record: base('event_msg', 32, {
      type: 'item_completed',
      thread_id: THREAD,
      turn_id: TURN,
      item: {
        type: 'McpToolCall',
        id: 'call_Zk3QpV8mT1xYbN4cRw7LhJ2s9',
        server: 'codex_apps',
        tool: 'github.search',
        status: 'completed',
        duration: { secs: 1, nanos: 0 },
        arguments: {
          query: 'repo:acme-corp/billing-portal vat_rate',
          name: 'jan.kowalski',
        },
        result: {
          content: [
            {
              type: 'text',
              text: 'customer_email: jan.kowalski@acme-corp.example',
            },
          ],
          structured_content: { id: 'acme-corp', status: 'secret-roadmap' },
        },
      },
    }),
    check: (out) => {
      const item = out.payload.item;
      expect(item.server).toBe('codex_apps');
      expect(item.tool).toBe('github.search');
      expect(item.status).toBe('completed');
      expect(item.id).toBe('call_Zk3QpV8mT1xYbN4cRw7LhJ2s9');
      // `name`, `id` and `status` are structure in Codex's schema and data
      // in a payload: nothing in here is kept by its key
      expect(Object.keys(item.arguments)).toHaveLength(2);
      expect(Object.keys(item.arguments)).not.toContain('name');
      expect(Object.keys(item.result)).toHaveLength(2);
      expect(JSON.stringify(item.result)).not.toContain('"id"');
    },
  },
  {
    name: 'exec call and its output',
    record: base('response_item', 40, {
      type: 'custom_tool_call',
      id: 'ctc_0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071',
      call_id: 'call_AbCdEfGhIjKlMnOpQrStUvWx',
      name: 'exec',
      status: 'completed',
      input: `text(await tools.exec_command({cmd:"Get-ChildItem ${CWD}"}));\n// Zaokrąglij VAT`,
    }),
    check: (out) => {
      expect(out.payload.name).toBe('exec');
      expect(out.payload.call_id).toBe('call_AbCdEfGhIjKlMnOpQrStUvWx');
      expect(out.payload.status).toBe('completed');
      expect(out.payload.input.split('\n')).toHaveLength(2);
    },
  },
  {
    name: 'apply_patch call',
    record: base('response_item', 41, {
      type: 'custom_tool_call',
      call_id: 'call_PatchPatchPatchPatchPatc',
      name: 'apply_patch',
      status: 'completed',
      input: PATCH,
    }),
    check: (out) => {
      const lines = (out.payload.input as string).split('\n');
      expect(lines[0]).toBe('*** Begin Patch');
      expect(lines.at(-1)).toBe('*** End Patch');
      expect(lines[1]).toMatch(
        /^\*\*\* Update File: \/home\/user\/project\/.*\.cs$/,
      );
      expect(lines[8]).toMatch(
        /^\*\*\* Add File: \/home\/user\/project\/.*\.cs$/,
      );
      expect(lines[11]).toMatch(
        /^\*\*\* Delete File: [a-z]+\/[a-z]+\/[a-z]+\.cs$/,
      );
      expect(lines[6]).toBe('@@');
      expect(lines[2]).toMatch(/^@@ /);
      expect(changeLines(out.payload.input)).toEqual(changeLines(PATCH));
      expect(lines.map((l) => l.length)).toEqual(
        PATCH.split('\n').map((l, i) =>
          [1, 8, 11].includes(i) ? lines[i]?.length : l.length,
        ),
      );
    },
  },
  {
    name: 'output of a failed script',
    record: base('response_item', 42, {
      type: 'custom_tool_call_output',
      call_id: 'call_AbCdEfGhIjKlMnOpQrStUvWx',
      output: [
        {
          type: 'input_text',
          text: 'Script failed\nWall time 1.4 seconds\nOutput:\n',
        },
        {
          type: 'input_text',
          text: `Error: cannot read ${FILE_A}\nExit code: 1`,
        },
        {
          type: 'input_image',
          image_url: `data:image/png;base64,iVBORw0KGgo${'A'.repeat(600)}`,
          detail: 'high',
        },
      ],
    }),
    check: (out) => {
      const [frame, body, image] = out.payload.output;
      expect(frame).toEqual({
        type: 'input_text',
        text: 'Script failed\nWall time 1.4 seconds\nOutput:\n',
      });
      expect(body.text.split('\n')[1]).toBe('Exit code: 1');
      expect(body.text).toHaveLength(
        `Error: cannot read ${FILE_A}\nExit code: 1`.length,
      );
      expect(image.type).toBe('input_image');
      expect(image.image_url).toBe(BLOB_PLACEHOLDER);
    },
  },
  {
    name: 'legacy shell call with a wrapped command',
    record: base('response_item', 50, {
      type: 'function_call',
      id: 'fc_0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e',
      call_id: 'call_LegacyLegacyLegacyLegacy',
      name: 'shell',
      arguments: JSON.stringify({
        command: ['powershell.exe', '-Command', `Get-ChildItem ${CWD}`],
        workdir: CWD,
        timeout_ms: 120_000,
        customer_email: 'jan.kowalski@acme-corp.example',
      }),
    }),
    check: (out) => {
      expect(out.payload.name).toBe('shell');
      const args = JSON.parse(out.payload.arguments);
      expect(args.command[0]).toBe('powershell.exe');
      expect(args.command[1]).toBe('-Command');
      expect(args.command).toHaveLength(3);
      expect(args.workdir).toMatch(/^\/home\/user\/project\//);
      expect(args.timeout_ms).toBe(120_000);
      expect(Object.keys(args)).toHaveLength(4);
    },
  },
  {
    name: 'legacy shell call that is a patch',
    record: base('response_item', 51, {
      type: 'function_call',
      call_id: 'call_LegacyPatchLegacyPatchLe',
      name: 'shell',
      arguments: JSON.stringify({ command: ['apply_patch', PATCH] }),
    }),
    check: (out) => {
      const args = JSON.parse(out.payload.arguments);
      expect(args.command[0]).toBe('apply_patch');
      expect(args.command[1].split('\n')[0]).toBe('*** Begin Patch');
      expect(changeLines(args.command[1])).toEqual(changeLines(PATCH));
    },
  },
  {
    name: 'legacy shell_command with the script as a string',
    record: base('response_item', 52, {
      type: 'function_call',
      call_id: 'call_LegacyStringLegacyString',
      name: 'shell_command',
      arguments: JSON.stringify({
        command: `Get-ChildItem ${CWD}`,
        workdir: CWD,
      }),
    }),
    check: (out) => {
      const args = JSON.parse(out.payload.arguments);
      expect(args.command).toHaveLength(`Get-ChildItem ${CWD}`.length);
      expect(args.workdir).toMatch(/^\/home\/user\/project\//);
    },
  },
  {
    name: 'legacy output with metadata',
    record: base('response_item', 53, {
      type: 'function_call_output',
      call_id: 'call_LegacyLegacyLegacyLegacy',
      output: JSON.stringify({
        output: `Exit code: 1\nWall time: 0.3 seconds\nOutput:\n${FILE_A} not found`,
        metadata: { exit_code: 1, duration_seconds: 0.3 },
      }),
    }),
    check: (out) => {
      const parsed = JSON.parse(out.payload.output);
      expect(parsed.metadata).toEqual({ exit_code: 1, duration_seconds: 0.3 });
      expect(parsed.output.split('\n').slice(0, 3)).toEqual([
        'Exit code: 1',
        'Wall time: 0.3 seconds',
        'Output:',
      ]);
    },
  },
  {
    name: 'message with text and an inline image',
    record: base('response_item', 60, {
      type: 'message',
      id: 'msg_0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'Zaokrąglij VAT w billing-portal, proszę.',
        },
        {
          type: 'input_image',
          image_url: `data:image/png;base64,iVBORw0KGgo${'B'.repeat(900)}`,
        },
      ],
    }),
    check: (out) => {
      expect(out.payload.role).toBe('user');
      expect(out.payload.content[0].type).toBe('input_text');
      expect(out.payload.content[0].text).toHaveLength(
        'Zaokrąglij VAT w billing-portal, proszę.'.length,
      );
      expect(out.payload.content[1].image_url).toBe(BLOB_PLACEHOLDER);
    },
  },
  {
    name: 'reasoning with encrypted content',
    record: base('response_item', 61, {
      type: 'reasoning',
      id: 'rs_0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718',
      encrypted_content: `gAAAAAB${'x'.repeat(2000)}`,
      summary: [
        { type: 'summary_text', text: 'Checking how vat_rate is rounded' },
      ],
    }),
    check: (out) => {
      expect(out.payload.encrypted_content).toBe(BLOB_PLACEHOLDER);
      expect(out.payload.summary[0].type).toBe('summary_text');
    },
  },
  {
    name: 'turn that was interrupted, and one that failed',
    record: base('event_msg', 70, {
      type: 'task_complete',
      turn_id: TURN,
      duration_ms: 4_200,
      reason: 'interrupted',
      last_agent_message: 'Zaokrąglij VAT: done in InvoiceService',
      error: {
        codex_error_info: 'usage_limit_exceeded',
        message: 'You have hit the prolite limit for acme-corp',
      },
    }),
    check: (out) => {
      expect(out.payload.turn_id).toBe(TURN);
      expect(out.payload.duration_ms).toBe(4_200);
      expect(out.payload.reason).toBe('interrupted');
      expect(out.payload.error.codex_error_info).toBe('usage_limit_exceeded');
    },
  },
  {
    name: 'world state and compaction history',
    record: base('compacted', 80, {
      window_id: THREAD,
      window_number: 2,
      message: '',
      latest_token_usage_record: {
        response_id: 'resp_abc',
        usage: { input_tokens: 9 },
      },
      replacement_history: [
        {
          type: 'message',
          role: 'user',
          id: 'msg_x',
          content: [
            { type: 'input_text', text: 'secret-roadmap for acme-corp' },
          ],
        },
      ],
    }),
    check: (out) => {
      expect(out.payload.window_id).toBe(THREAD);
      expect(out.payload.window_number).toBe(2);
      expect(out.payload.latest_token_usage_record).toEqual({
        response_id: 'resp_abc',
        usage: { input_tokens: 9 },
      });
      expect(out.payload.replacement_history).toHaveLength(1);
      expect(Object.keys(out.payload.replacement_history[0])).not.toContain(
        'role',
      );
    },
  },
];

describe('scrubCodexRecord', () => {
  it.each(CASES)('$name', ({ record, check }) => {
    const stats = newCodexStats();
    const out = scrubCodexRecord(record, secrets, stats);
    const text = JSON.stringify(out);
    for (const needle of NEEDLES) expect(text, needle).not.toContain(needle);

    // the envelope of every record is untouched
    expect((out as Loose).timestamp).toBe(record.timestamp);
    expect((out as Loose).ordinal).toBe(record.ordinal);
    expect((out as Loose).type).toBe(record.type);
    check(out);

    // nothing in the table is outside the known schema
    expect([...stats.unknownKeys.keys()]).toEqual([]);
    expect([...stats.guardedKeys.keys()]).toEqual([]);
    // same input, same bytes
    expect(
      JSON.stringify(scrubCodexRecord(record, secrets, newCodexStats())),
    ).toBe(text);
  });

  it('scrubs a key it does not know, with its subtree, and reports it', () => {
    const stats = newCodexStats();
    const out = scrubCodexRecord(
      base('event_msg', 1, {
        type: 'task_started',
        turn_id: TURN,
        workspace_owner: { name: 'jan.kowalski', id: ACCOUNT_ID, seats: 3 },
      }),
      secrets,
      stats,
    ) as Loose;
    const text = JSON.stringify(out);
    expect(text).not.toContain('workspace_owner');
    expect(text).not.toContain('jan.kowalski');
    expect(text).not.toContain(ACCOUNT_ID);
    expect(text).toContain(':3'); // numbers survive
    expect(out.payload.turn_id).toBe(TURN);
    expect([...stats.unknownKeys]).toEqual([['workspace_owner', 1]]);
  });

  it('scrubs a structural key whose value is not id-shaped, and reports it', () => {
    const stats = newCodexStats();
    const out = scrubCodexRecord(
      base('response_item', 2, {
        type: 'function_call',
        call_id: 'call_ok',
        name: `${CWD}\\tools\\deploy.ps1`,
        status: 'see https://acme-corp.example/secret-roadmap',
      }),
      secrets,
      stats,
    ) as Loose;
    const text = JSON.stringify(out);
    for (const needle of NEEDLES) expect(text, needle).not.toContain(needle);
    expect(out.payload.call_id).toBe('call_ok');
    expect([...stats.guardedKeys].sort()).toEqual([
      ['name', 1],
      ['status', 1],
    ]);
  });

  it('replaces the user and host names wherever they are kept', () => {
    const out = scrubCodexRecord(
      base('response_item', 3, {
        type: 'function_call',
        call_id: 'call_alice_ALICE-LAPTOP',
        name: 'shell',
        arguments: '{}',
      }),
      secrets,
      newCodexStats(),
    ) as Loose;
    expect(out.payload.call_id).toBe('call_user_host');
  });

  it('keeps a slash switch as a flag only behind cmd', () => {
    const argvOf = (command: string[]) =>
      (
        scrubCodexRecord(
          base('event_msg', 4, {
            type: 'item_completed',
            item: { type: 'CommandExecution', id: 'item-1', command },
          }),
          secrets,
          newCodexStats(),
        ) as Loose
      ).payload.item.command as string[];

    const cmd = argvOf(['C:\\Windows\\System32\\cmd.exe', '/d', '/c', 'dir']);
    expect(cmd.slice(1, 3)).toEqual(['/d', '/c']);
    // under cmd a longer word is not a switch either
    expect(argvOf(['cmd.exe', '/prolite', '/c', 'dir'])[1]).not.toBe(
      '/prolite',
    );

    for (const shell of ['bash', 'zsh', 'pwsh.exe', 'powershell.exe']) {
      const argv = argvOf([shell, '/prolite', '-NoProfile', '-c', 'ls']);
      expect(argv[1], shell).not.toBe('/prolite');
      expect(argv[1], shell).toHaveLength('/prolite'.length);
      expect(argv.slice(2, 4), shell).toEqual(['-NoProfile', '-c']);
    }
  });

  it('scrubs a tool input that is not a string as content, keys included', () => {
    const stats = newCodexStats();
    const out = scrubCodexRecord(
      base('response_item', 5, {
        type: 'custom_tool_call',
        call_id: 'call_obj',
        name: 'exec',
        input: {
          name: 'acme-internal',
          id: 'client-name',
          type: 'prolite',
          rows: [{ status: 'secret-roadmap', count: 2 }],
        },
      }),
      secrets,
      stats,
    ) as Loose;
    const text = JSON.stringify(out);
    for (const needle of NEEDLES) expect(text, needle).not.toContain(needle);
    expect(Object.keys(out.payload.input)).not.toContain('name');
    expect(text).toContain(':2'); // numbers survive
    expect(out.payload.call_id).toBe('call_obj');
    expect(out.payload.name).toBe('exec');
    // content, not an unknown key of Codex's schema: nothing to report
    expect([...stats.unknownKeys]).toEqual([]);
  });
});

describe('scrubCodexPath', () => {
  it('keeps a real file extension and nothing else that follows a dot', () => {
    const out = scrubCodexPath(
      'C:\\Users\\alice\\.acme-internal\\report.client-name\\notes.v2.md',
    );
    expect(out).toMatch(
      /^\/home\/user\/project\/[a-z]{5}\/[a-z]{5}\/[a-z]{14}\/[a-z]{18}\/[a-z]{8}\.md$/,
    );
    for (const needle of NEEDLES) expect(out, needle).not.toContain(needle);
    expect(scrubCodexPath('src/.env')).toMatch(/^[a-z]{3}\/[a-z]{4}$/);
    expect(scrubCodexPath('../x/./Program.cs')).toMatch(
      /^\.\.\/[a-z]\/\.\/[a-z]{7}\.cs$/,
    );
  });
});

describe('scrubDiffText', () => {
  it('keeps the count of added and removed lines, and every line length', () => {
    for (const diff of [UNIFIED_DIFF, UNIFIED_DIFF.replace(/\n/g, '\r\n')]) {
      const out = scrubDiffText(diff, secrets);
      expect(changeLines(out)).toEqual(changeLines(diff));
      expect(out.split('\n').map((l) => l.length)).toEqual(
        diff.split('\n').map((l) => l.length),
      );
      expect(out).not.toContain('vat_rate');
      expect(out).not.toContain('InvoiceService');
    }
  });

  it('keeps a change line that reads as a header reading as one', () => {
    const out = scrubDiffText('+++counter;\n--counter;\n---x', secrets).split(
      '\n',
    );
    expect(out[0]?.startsWith('+++')).toBe(true);
    // `--counter;` is the removed line `-counter;`: still one removed line
    expect(out[1]?.startsWith('-')).toBe(true);
    expect(out[1]?.startsWith('---')).toBe(false);
    expect(out[1]).toHaveLength('--counter;'.length);
    expect(out[2]?.startsWith('---')).toBe(true);
  });

  it('keeps the no-newline marker and scrubs any other line that starts with a backslash', () => {
    const marker = '\\ No newline at end of file';
    const out = scrubDiffText(
      [
        '+var vat = 0.23m;',
        marker,
        '\\ secret-roadmap for acme-corp',
        '\\ No newline at end of file, says jan.kowalski',
        `${marker}\r`,
      ].join('\n'),
      secrets,
    ).split('\n');
    expect(out[1]).toBe(marker);
    expect(out[4]).toBe(`${marker}\r`);
    for (const i of [2, 3]) {
      expect(out[i]?.startsWith('\\')).toBe(false);
      for (const needle of NEEDLES)
        expect(out[i], needle).not.toContain(needle);
    }
    expect(out[2]).toHaveLength('\\ secret-roadmap for acme-corp'.length);
  });
});

describe('scrubOutputText', () => {
  it('keeps harness frame lines and nothing else', () => {
    const input =
      'Script completed\nWall time 12 seconds\nOutput:\nvat_rate = 0.23\nTotal output lines: 4';
    const out = scrubOutputText(input, secrets).split('\n');
    expect(out[0]).toBe('Script completed');
    expect(out[1]).toBe('Wall time 12 seconds');
    expect(out[2]).toBe('Output:');
    expect(out[3]).not.toContain('vat_rate');
    expect(out[3]).toHaveLength('vat_rate = 0.23'.length);
    expect(out[4]).toBe('Total output lines: 4');
    expect(
      scrubOutputText('Script error:\nTypeError: vat_rate', secrets),
    ).toMatch(/^Script error:\n[a-z ]{19}$/);
    expect(scrubOutputText('Script terminated', secrets)).toBe(
      'Script terminated',
    );
  });
});

describe('scrubCodexLines and scrubCodexFile', () => {
  const lines = CASES.map((c, i) => ({
    line: i + 1,
    text: JSON.stringify(c.record),
  }));

  it('puts the SCRUBBED marker on line one and drops what is not JSON', () => {
    const cut = '{"timestamp":"2026-10-13T09:00:01.000Z","type":"event_m';
    const result = scrubCodexLines(
      [
        ...lines,
        { line: lines.length + 1, text: '' },
        { line: lines.length + 2, text: cut },
      ],
      secrets,
    );
    const out = result.output.split('\n');
    expect(isScrubMarkerLine(out[0] ?? '')).toBe(true);
    expect(JSON.parse(out[0] ?? '')).toMatchObject({
      marker: 'SCRUBBED',
      source: 'codex',
    });
    expect(out).toHaveLength(1 + CASES.length + 1); // marker, records, final newline
    expect(result.dropped).toEqual([lines.length + 2]);
    expect(result.stats.records).toBe(CASES.length);
    for (const needle of NEEDLES)
      expect(result.output, needle).not.toContain(needle);
  });

  it('keeps one marker, on line one, when a scrubbed rollout is scrubbed again', () => {
    const once = scrubCodexLines(lines, secrets);
    const again = scrubCodexLines(
      once.output.split('\n').map((text, i) => ({ line: i + 1, text })),
      secrets,
    );
    // the old marker is not carried along as a record: the same records
    // come out, in the same order, behind a single marker (their lorem is
    // drawn again, so the bytes differ)
    const typesOf = (output: string) =>
      output
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => (JSON.parse(l) as { type: string }).type);
    expect(typesOf(again.output)).toEqual(typesOf(once.output));
    expect(
      again.output.split('\n').filter((l) => isScrubMarkerLine(l)),
    ).toHaveLength(1);
    expect(isScrubMarkerLine(again.output.split('\n')[0] ?? '')).toBe(true);
    expect(again.stats.records).toBe(CASES.length);
    expect([...again.stats.unknownKeys]).toEqual([]);
    expect(again.dropped).toEqual([]);
  });

  it('writes the marker as the first line of a plain and of a compressed file, with the same content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runray-scrub-codex-'));
    try {
      const raw = `${lines.map((l) => l.text).join('\n')}\n`;
      const name = 'rollout-2026-10-13T09-00-00-0199f3a0.jsonl';
      expect(ROLLOUT_FILE.test(name)).toBe(true);
      expect(ROLLOUT_FILE.test(`${name}.zst`)).toBe(true);
      expect(ROLLOUT_FILE.test('session.jsonl')).toBe(false);

      const rawPlain = join(dir, 'raw', name);
      const rawPacked = join(dir, 'raw', `${name}.zst`);
      mkdirSync(join(dir, 'raw'));
      writeFileSync(rawPlain, raw);
      writeFileSync(rawPacked, zstdCompressSync(Buffer.from(raw, 'utf8')));

      const outPlain = join(dir, name);
      const outPacked = join(dir, `${name}.zst`);
      await scrubCodexFile(rawPlain, outPlain, secrets);
      await scrubCodexFile(rawPacked, outPacked, secrets);

      const read = async (file: string) => {
        const out: string[] = [];
        for await (const { text } of readRolloutLines(file)) out.push(text);
        return out;
      };
      const plain = await read(outPlain);
      const packed = await read(outPacked);
      expect(isScrubMarkerLine(plain[0] ?? '')).toBe(true);
      expect(isScrubMarkerLine(packed[0] ?? '')).toBe(true);
      expect(packed).toEqual(plain);
      expect(plain).toHaveLength(1 + CASES.length);
      // the plain file is text; the compressed one is not the same bytes
      expect(
        readFileSync(outPlain, 'utf8').startsWith(
          '{"type":"x-tracepulse-scrub"',
        ),
      ).toBe(true);
      expect(readFileSync(outPacked).subarray(0, 4)).toEqual(
        Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
      );

      // a compressed input can be written plain by naming the output so
      const crossed = join(dir, 'crossed.jsonl');
      await scrubCodexFile(rawPacked, crossed, secrets);
      expect(await read(crossed)).toEqual(plain);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
