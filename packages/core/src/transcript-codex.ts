import { existsSync } from 'node:fs';
import { outputTextOf, personText } from './adapters/codex.js';
import { CODEX_REVIEWER_AGENT } from './adapters/codex-names.js';
import {
  isCompressedRollout,
  isZstdUnavailable,
  readRolloutLines,
} from './rollout-lines.js';
import type { TranscriptProvenance, TranscriptSegment } from './transcript.js';

/**
 * The source record behind a Codex span, as labelled segments
 * (add-codex-adapter 5.4). The caller has already refused under redaction
 * and caps what is returned here.
 *
 * A span's provenance line holds one record, and for most spans that record
 * is the whole answer: a command with its output, a file change, an MCP
 * call, what the model wrote. For two it is not, and the reader goes on to
 * the record that completes it:
 *
 * - a call the model made (`function_call`, `custom_tool_call`): what came
 *   back is in the `*_output` record with the same call id;
 * - a turn (`task_started`): what the person wrote is in the first user
 *   message of the turn that has text of theirs.
 *
 * What is shown is chosen per record type, never a dump of the record. A
 * `session_meta` record also holds account and user ids, the repository URL
 * and a commit; a token event holds the account's rate limits; a message
 * can hold an image as a data URL. None of that is a transcript, and the
 * parser keeps the same things out of a run (design T11).
 */

export type CodexSegments =
  | { segments: TranscriptSegment[] }
  | { unavailable: string };

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

const NOT_TEXT = '(not text)';

/**
 * A long run of base64 with nothing else in it, bare or as a data URL: a
 * generated image, a screenshot, a file. Shown, it would be a megabyte of
 * letters that crowds out everything a person can read.
 */
const BLOB = /^(?:data:[\w.+-]+\/[\w.+-]+;base64,)?[A-Za-z0-9+/=_-]{512,}$/;
const BASE64_LINE = /^[A-Za-z0-9+/=_-]+$/;
/** The same run inside a longer text: an image in the JSON a tool printed,
 * a data URL after the lines a command wrote. */
const BLOB_WITHIN =
  /(?:data:[\w.+-]+\/[\w.+-]+;base64,)?[A-Za-z0-9+/=_-]{512,}/g;

/** True for base64 in one piece, or wrapped the way mail and PEM wrap it:
 * lines of one length of at least 60, the last one shorter. */
function isBlob(text: string): boolean {
  if (text.length < 512) return false;
  const body = text.trim();
  if (BLOB.test(body)) return true;
  const lines = body.split(/\r?\n/);
  const width = lines[0]?.length ?? 0;
  if (lines.length < 2 || width < 60) return false;
  return lines.every(
    (line, i) =>
      BASE64_LINE.test(line) &&
      (i === lines.length - 1 ? line.length <= width : line.length === width),
  );
}

/** JSON for a reader. A value in it that is binary data is named, as a
 * segment that is nothing else would be (`shown`). */
function pretty(v: unknown): string {
  return JSON.stringify(
    v,
    (_key, value: unknown) =>
      typeof value === 'string' && isBlob(value) ? NOT_TEXT : value,
    2,
  );
}

/** Text as it is, anything else as JSON. */
function asText(v: unknown): string {
  return typeof v === 'string' ? v : pretty(v);
}

function parse(text: string): Json | undefined {
  try {
    const record: unknown = JSON.parse(text);
    return isObj(record) ? record : undefined;
  } catch {
    return undefined;
  }
}

/** A copy of the object with only the named keys that are present. */
function pick(source: Json, keys: readonly string[]): Json {
  const out: Json = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

/** A copy of the object without the named keys. */
function omit(source: Json, keys: readonly string[]): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(source))
    if (!keys.includes(key)) out[key] = value;
  return out;
}

const EMPTY = '(empty)';

/** A segment as it is shown: text stays, an empty text is named, and so is
 * binary data, whether it is all of the segment or a run inside it. */
function shown(segment: TranscriptSegment): TranscriptSegment {
  const text = segment.text.trim();
  if (text === '') return { label: segment.label, text: EMPTY };
  if (isBlob(text)) return { label: segment.label, text: NOT_TEXT };
  const named = segment.text.replace(BLOB_WITHIN, NOT_TEXT);
  return named === segment.text
    ? segment
    : { label: segment.label, text: named };
}

/** Keys of a session record that say what the session was, not whose. */
const SESSION_KEYS = [
  'id',
  'timestamp',
  'cwd',
  'originator',
  'cli_version',
  'source',
  'thread_source',
  'model_provider',
  'parent_thread_id',
  'context_window',
];

/** Fields of an item or a call that are bookkeeping or an opaque blob. */
const NOISE_KEYS = [
  'id',
  'type',
  'call_id',
  'status',
  'encrypted_content',
  'internal_chat_message_metadata_passthrough',
];

/** What the reader still has to find after the record of the span. */
type Follow =
  | { kind: 'output'; callId: string }
  | { kind: 'prompt'; turnId: string | undefined };

interface Read {
  segments: TranscriptSegment[];
  follow?: Follow;
}

function sessionSegments(payload: Json): TranscriptSegment[] {
  const base = payload.base_instructions;
  const instructions =
    str(payload.instructions) ?? (isObj(base) ? str(base.text) : str(base));
  return [
    { label: 'session', text: pretty(pick(payload, SESSION_KEYS)) },
    ...(instructions === undefined
      ? []
      : [{ label: 'instructions', text: instructions }]),
  ];
}

/** What a tool handed back, as text. The older shell tools wrap theirs in
 * `{"output": "...", "metadata": {...}}`; the text inside is the output.
 * Only that form is unwrapped, the one the adapter reads the same way: any
 * other JSON with an `output` key is shown whole, or what stands next to
 * the key (an error, say) would be lost. */
function outputText(output: unknown): string {
  const text = outputTextOf(output);
  if (text === undefined) return NOT_TEXT;
  if (typeof output === 'string' && output.startsWith('{')) {
    const wrapped = parse(output);
    if (isObj(wrapped?.metadata) && typeof wrapped.output === 'string')
      return wrapped.output;
  }
  return text;
}

/** An argv as one line that keeps where each argument ends: an argument
 * with a space, a quote or nothing in it is quoted. It is for reading, so
 * a backslash stays one backslash (a Windows path reads as written). */
function commandLine(argv: readonly unknown[]): string {
  return argv
    .map((arg) => {
      const text = asText(arg);
      return text !== '' && !/[\s"']/.test(text)
        ? text
        : `"${text.replace(/"/g, '\\"')}"`;
    })
    .join(' ');
}

/** An action the harness recorded: one record holds what was asked and what
 * came of it. */
function itemSegments(item: Json): TranscriptSegment[] {
  switch (item.type) {
    case 'CommandExecution': {
      const command = Array.isArray(item.command)
        ? commandLine(item.command)
        : asText(item.command ?? '');
      const output = str(item.aggregated_output) ?? str(item.formatted_output);
      return [
        { label: 'command', text: command },
        ...(output === undefined ? [] : [{ label: 'output', text: output }]),
      ];
    }
    case 'FileChange': {
      const segments: TranscriptSegment[] = [];
      if (isObj(item.changes)) {
        for (const [path, change] of Object.entries(item.changes)) {
          const text = isObj(change)
            ? (str(change.unified_diff) ?? str(change.content))
            : undefined;
          segments.push({
            label: `change ${path}`,
            text: text ?? asText(change),
          });
        }
      }
      const said = [str(item.stdout), str(item.stderr)]
        .filter((text) => text !== undefined && text.trim() !== '')
        .join('\n');
      if (said !== '') segments.push({ label: 'output', text: said });
      return segments.length > 0
        ? segments
        : [{ label: 'change', text: pretty(omit(item, NOISE_KEYS)) }];
    }
    case 'McpToolCall': {
      const name = [str(item.server), str(item.tool)]
        .filter((part) => part !== undefined)
        .join('.');
      const result = isObj(item.result) ? item.result : undefined;
      const text = outputTextOf(result?.content);
      const error = isObj(item.error) ? str(item.error.message) : item.error;
      const back =
        text ??
        (error === undefined || error === null ? undefined : asText(error)) ??
        (result === undefined ? undefined : NOT_TEXT);
      return [
        { label: `tool call ${name}`, text: asText(item.arguments ?? {}) },
        ...(back === undefined ? [] : [{ label: 'tool output', text: back }]),
      ];
    }
    case 'ImageView':
      return [{ label: 'image', text: asText(item.path ?? '') }];
    case 'Extension': {
      const back = item.results ?? item.result ?? item.failure;
      return [
        {
          label: `tool call ${str(item.kind) ?? 'extension'}`,
          text: pretty(
            omit(item, [...NOISE_KEYS, 'kind', 'results', 'result', 'failure']),
          ),
        },
        ...(back === undefined || back === null
          ? []
          : [{ label: 'tool output', text: asText(back) }]),
      ];
    }
    default:
      return [
        {
          label: str(item.type) ?? 'item',
          text: pretty(omit(item, NOISE_KEYS)),
        },
      ];
  }
}

/** The text parts of a message under its role. A part that is not text (an
 * image, as a data URL of any size) is named, not shown. */
function messageSegments(payload: Json): TranscriptSegment[] {
  const role = str(payload.role) ?? 'message';
  const segments: TranscriptSegment[] = [];
  if (Array.isArray(payload.content)) {
    for (const part of payload.content) {
      if (!isObj(part)) continue;
      const text = str(part.text);
      segments.push(
        text === undefined
          ? { label: `${role} ${str(part.type) ?? 'part'}`, text: NOT_TEXT }
          : { label: role, text },
      );
    }
  }
  return segments.length > 0 ? segments : [{ label: role, text: NOT_TEXT }];
}

/** A call the model made. Its arguments are JSON in a string for a function
 * call and free text for a custom tool; anything else is shown as recorded. */
function callSegment(payload: Json): TranscriptSegment {
  const kind = (str(payload.type) ?? 'call').replace(/_call$/, '');
  const label = `tool call ${str(payload.name) ?? kind}`;
  if (typeof payload.arguments === 'string') {
    const args = parse(payload.arguments);
    return {
      label,
      text: args === undefined ? payload.arguments : pretty(args),
    };
  }
  if (typeof payload.input === 'string') return { label, text: payload.input };
  return { label, text: pretty(omit(payload, [...NOISE_KEYS, 'name'])) };
}

function responseItemRead(payload: Json): Read {
  const type = str(payload.type) ?? '';
  if (type === 'message') return { segments: messageSegments(payload) };
  if (type.endsWith('_call')) {
    const callId = str(payload.call_id);
    return {
      segments: [callSegment(payload)],
      // a hosted tool's call has no id: nothing is handed back for it
      ...(callId === undefined ? {} : { follow: { kind: 'output', callId } }),
    };
  }
  if (type.endsWith('_output')) {
    return {
      segments: [{ label: 'tool output', text: outputText(payload.output) }],
    };
  }
  if (type === 'reasoning') {
    const summary = Array.isArray(payload.summary)
      ? payload.summary
          .map((part) => (isObj(part) ? str(part.text) : undefined))
          .filter((text) => text !== undefined)
          .join('\n\n')
      : '';
    return {
      segments: [
        {
          label: 'reasoning',
          text: summary === '' ? '(stored encrypted, not readable)' : summary,
        },
      ],
    };
  }
  return {
    segments: [
      { label: type || 'item', text: pretty(omit(payload, NOISE_KEYS)) },
    ],
  };
}

/** The segments of the record a span points at, or nothing when the record
 * is of a type no span is read from (the file is not what it was). */
function readRecord(record: Json): Read | undefined {
  const payload = isObj(record.payload) ? record.payload : undefined;
  if (payload === undefined) return undefined;
  switch (record.type) {
    case 'session_meta':
      return { segments: sessionSegments(payload) };
    case 'token_usage_record':
      return isObj(payload.usage)
        ? { segments: [{ label: 'usage', text: pretty(payload.usage) }] }
        : undefined;
    case 'response_item':
      return responseItemRead(payload);
    case 'event_msg': {
      if (payload.type === 'task_started') {
        return {
          segments: [{ label: 'turn', text: pretty(omit(payload, ['type'])) }],
          follow: { kind: 'prompt', turnId: str(payload.turn_id) },
        };
      }
      if (payload.type === 'item_completed' && isObj(payload.item)) {
        return { segments: itemSegments(payload.item) };
      }
      if (payload.type === 'token_count' && isObj(payload.info)) {
        const usage = payload.info.last_token_usage;
        return isObj(usage)
          ? { segments: [{ label: 'usage', text: pretty(usage) }] }
          : undefined;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** What the person wrote in a user message: their text of every part, the
 * harness's blocks left out as in the prompt preview. */
function personSegment(payload: Json): TranscriptSegment | undefined {
  if (!Array.isArray(payload.content)) return undefined;
  const written: string[] = [];
  for (const part of payload.content) {
    if (!isObj(part) || part.type !== 'input_text') continue;
    const text = str(part.text);
    const theirs = text === undefined ? undefined : personText(text);
    if (theirs !== undefined) written.push(theirs);
  }
  return written.length === 0
    ? undefined
    : { label: 'user', text: written.join('\n\n') };
}

/** The first record says the thread is the approval reviewer's, the way
 * the adapter reads it (`agentNameOf`). */
function isReviewerThread(payload: unknown): boolean {
  const source = isObj(payload) ? payload.source : undefined;
  const subagent = isObj(source) ? source.subagent : undefined;
  return isObj(subagent) && subagent.other === CODEX_REVIEWER_AGENT;
}

function reasonOf(err: unknown, file: string): string {
  if (isZstdUnavailable(err)) return err.message;
  const code = (err as { code?: unknown } | null)?.code;
  if (
    code === 'ENOENT' &&
    !isCompressedRollout(file) &&
    existsSync(`${file}.zst`)
  ) {
    return 'the rollout was compressed after this view was built; rebuild the view to read it';
  }
  // the code, not the message: the message carries the path
  return `source log unavailable: ${
    typeof code === 'string' ? code : 'it could not be read'
  }`;
}

export async function readCodexSegments(
  provenance: TranscriptProvenance,
): Promise<CodexSegments> {
  const target = provenance.line;
  if (target === undefined) {
    return { unavailable: 'provenance carries no line number' };
  }
  let read: Read | undefined;
  // The thread is the approval reviewer's: what opens its turns is the
  // harness asking for a review, which no person wrote.
  let reviewer = false;
  let headRead = false;
  try {
    for await (const { line, text } of readRolloutLines(provenance.file)) {
      if (!headRead && text.includes('session_meta')) {
        const head = parse(text);
        if (head?.type === 'session_meta') {
          headRead = true;
          reviewer = isReviewerThread(head.payload);
        }
      }
      if (line < target) continue;
      if (line === target) {
        const record = parse(text);
        if (record === undefined) {
          return { unavailable: `line ${target} is not valid JSON` };
        }
        read = readRecord(record);
        if (read === undefined) {
          return {
            unavailable: `line ${target} is not a record a span is read from`,
          };
        }
        if (read.follow === undefined) break;
        continue;
      }
      const follow = read?.follow;
      if (read === undefined || follow === undefined) break;
      if (follow.kind === 'output') {
        // every line after a call is looked at, so only one that names the
        // call is parsed
        if (!text.includes(follow.callId)) continue;
        const payload = parse(text)?.payload;
        if (
          isObj(payload) &&
          str(payload.type)?.endsWith('_output') === true &&
          payload.call_id === follow.callId
        ) {
          read.segments.push({
            label: 'tool output',
            text: outputText(payload.output),
          });
          break;
        }
        continue;
      }
      const record = parse(text);
      const payload = isObj(record?.payload) ? record.payload : undefined;
      if (record === undefined || payload === undefined) continue;
      if (record.type === 'event_msg') {
        // another turn began, or this one is over: it had no prompt of its
        // own. The end of some other turn does not end this one: a rollout
        // can write a late completion for an earlier turn right here.
        if (payload.type === 'task_started') break;
        if (
          (payload.type === 'task_complete' ||
            payload.type === 'turn_aborted') &&
          (follow.turnId === undefined ||
            payload.turn_id === undefined ||
            payload.turn_id === follow.turnId)
        )
          break;
      } else if (
        record.type === 'response_item' &&
        payload.type === 'message' &&
        payload.role === 'user'
      ) {
        const prompt = personSegment(payload);
        if (prompt !== undefined) {
          read.segments = [
            reviewer ? { label: 'review request', text: prompt.text } : prompt,
          ];
          break;
        }
      }
    }
  } catch (err) {
    return { unavailable: reasonOf(err, provenance.file) };
  }
  return read === undefined
    ? { unavailable: `line ${target} is beyond the end of the file` }
    : { segments: read.segments.map(shown) };
}
