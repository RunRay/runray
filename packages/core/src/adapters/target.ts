/**
 * Tool target identity capture (add-profiler-depth B7/X2, trace-ingestion
 * delta). For recognized file and command tools, adapters stamp a
 * redaction-safe identity into the existing free-form `span.attributes`:
 *
 * - `runray.targetKey`  — 16-hex doubled-FNV digest of the normalized
 *   target (POSIX path, or the command's executable token). Emitted in BOTH
 *   redact modes: a hash is the identity token, never content. Identical
 *   targets yield identical keys across spans, runs, adapters, and
 *   redaction modes — duplicate-read detection and retry identity depend
 *   on that.
 * - `runray.targetKind` — 'file-read' | 'file-write' | 'command'.
 * - `runray.target`     — short display token (basename / executable,
 *   ≤ 80 chars). Emitted ONLY when redaction is off, exactly like the
 *   `content` fields (ParseOptions.redact contract in adapter.ts).
 *
 * Unrecognized tools carry no target keys. Reserved adapter-emitted keys
 * use the `runray.` prefix (collision-proof against OTLP passthrough).
 */

export type TargetKind = 'file-read' | 'file-write' | 'command';

export interface ToolTarget {
  key: string;
  kind: TargetKind;
  display: string;
}

const DISPLAY_MAX = 80;

/** Same doubled-FNV-1a construction as the normalizer's deriveRunId. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hash16(key: string): string {
  const h1 = fnv1a(key).toString(16).padStart(8, '0');
  const h2 = fnv1a(key + h1)
    .toString(16)
    .padStart(8, '0');
  return `${h1}${h2}`;
}

function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

function basename(posixPath: string): string {
  const trimmed = posixPath.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function strField(input: unknown, field: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const v = (input as Record<string, unknown>)[field];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** kind + which input field carries the target, per source tool name. */
const TOOL_MAP: Record<
  'claude-code' | 'opencode',
  Record<string, { kind: TargetKind; fields: string[] }>
> = {
  'claude-code': {
    Read: { kind: 'file-read', fields: ['file_path'] },
    Edit: { kind: 'file-write', fields: ['file_path'] },
    MultiEdit: { kind: 'file-write', fields: ['file_path'] },
    Write: { kind: 'file-write', fields: ['file_path'] },
    NotebookEdit: { kind: 'file-write', fields: ['notebook_path'] },
    Bash: { kind: 'command', fields: ['command'] },
  },
  opencode: {
    read: { kind: 'file-read', fields: ['filePath'] },
    edit: { kind: 'file-write', fields: ['filePath'] },
    write: { kind: 'file-write', fields: ['filePath'] },
    bash: { kind: 'command', fields: ['command'] },
    // NOTE: OpenCode's `patch`/`apply_patch` write tools are intentionally
    // absent — their input carries only `patchText` (a unified diff), with no
    // discrete file-path field, so no redaction-safe target identity can be
    // derived without parsing diff bodies. Consequence: file writes made via
    // apply_patch carry no targetKey, so duplicate-read cannot see them as
    // intervening writes on OpenCode runs. Revisit if the tool schema gains a
    // path field.
  },
};

/** Extract the normalized target of one tool invocation, if recognized. */
export function extractToolTarget(
  source: 'claude-code' | 'opencode',
  toolName: string,
  input: unknown,
): ToolTarget | undefined {
  // Object.hasOwn, not a bare index: a tool named `constructor`, `toString`,
  // `__proto__` etc. in an untrusted transcript would otherwise resolve to an
  // inherited member and crash `spec.fields.map` (TypeError), failing the
  // whole session's parse.
  const table = TOOL_MAP[source];
  const spec = Object.hasOwn(table, toolName) ? table[toolName] : undefined;
  if (spec === undefined) return undefined;
  const raw = spec.fields
    .map((f) => strField(input, f))
    .find((v) => v !== undefined);
  if (raw === undefined) return undefined;

  if (spec.kind === 'command') {
    // executable token only — arguments never enter the identity or display
    const token = toPosix(raw.trim()).split(/\s+/)[0] ?? '';
    if (token === '') return undefined;
    return {
      key: hash16(token),
      kind: spec.kind,
      display: basename(token).slice(0, DISPLAY_MAX),
    };
  }
  const posix = toPosix(raw);
  return {
    key: hash16(posix),
    kind: spec.kind,
    display: basename(posix).slice(0, DISPLAY_MAX),
  };
}

/**
 * The `attributes` payload for one tool span: identity in both redact
 * modes, display token only unredacted; `{}` for unrecognized tools.
 */
export function toolTargetAttributes(
  source: 'claude-code' | 'opencode',
  toolName: string,
  input: unknown,
  redact: boolean,
): Record<string, unknown> {
  const target = extractToolTarget(source, toolName, input);
  if (target === undefined) return {};
  return {
    'runray.targetKey': target.key,
    'runray.targetKind': target.kind,
    ...(redact ? {} : { 'runray.target': target.display }),
  };
}
