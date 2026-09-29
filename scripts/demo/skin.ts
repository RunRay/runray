/**
 * skin.ts — re-skin a scrubbed golden Run into a `runray demo` sample.
 *
 * The goldens in `fixtures/normalized/` carry real token counts, timings and
 * span trees, but every string went through the scrubber and reads as lorem.
 * That is right for tests and wrong for a showcase. A `DemoStory` supplies
 * a coherent storyline for one session (title, project, prompts, delegation
 * reasons, file paths, commands, error texts, narration), and `skinRun`
 * substitutes it into the golden. Structure and numbers are untouched; the
 * caller re-prices, re-normalizes and re-runs the insight engine on the
 * result so every derived figure and insight text is computed, never pasted.
 *
 * Deterministic by construction: every choice is keyed on span ids or
 * first-appearance order, never on randomness or wall-clock time.
 */

import { extractToolTarget } from '../../packages/core/src/adapters/target.js';
import type { RawRun } from '../../packages/core/src/index.js';
import type { Run, Span } from '../../packages/schema/src/index.js';

const PREVIEW_CHARS = 200;

export interface Narration {
  /**
   * Short noun phrase per segment: index 0 is the work before the first
   * captured prompt, index i the work after prompt i. An array cycles.
   */
  topics: Array<string | string[]>;
  /** Closing answer per segment, used for the first end_turn in it. */
  summaries: string[];
  /** What a shell command in this session is checking ("the unit tests"). */
  checks: string[];
  /** What a search in this session is looking for ("usages of fetchOrders"). */
  searches: string[];
  /** What a preview/browser step verifies. */
  previews?: string[];
  /** Questions the agent asks via AskUserQuestion. */
  asks?: string[];
  /** What a web search looks up; falls back to `searches`. */
  web?: string[];
  /** Noun phrase per subagent (what it works on), chronological order. */
  subagentTopics?: string[];
  /** Final report per subagent, in chronological subagent order. */
  subagentReports?: string[];
}

export interface DemoStory {
  /** Golden to skin, relative to fixtures/normalized, without `.json`. */
  golden: string;
  /** Output file, relative to demo/runs, without `.json`. */
  out: string;
  title: string;
  project: NonNullable<Run['project']>;
  /** Rewrites fixture-relative source paths (source.files, provenance). */
  source: { from: string; to: string; rename?: Record<string, string> };
  /** Model-name substitutions (spans and gen_ai.* attributes). */
  modelRenames?: Record<string, string>;
  /** Distinct user prompts, in chronological order of first appearance. */
  prompts: string[];
  /** Subagent delegation reasons, in chronological subagent order. */
  delegations: string[];
  /** Replacement file paths per original extension ('' = no extension). */
  files: Record<string, string[]>;
  /** Replacement executables, most-used command key first. */
  commands: string[];
  /** Error text per tool name (plus `<synthetic>`), in occurrence order. */
  errors: Record<string, string[]>;
  narration: Narration;
}

type Family =
  | 'read'
  | 'write'
  | 'shell'
  | 'search'
  | 'agent'
  | 'preview'
  | 'browser'
  | 'plan-enter'
  | 'plan-exit'
  | 'ask'
  | 'task-stop'
  | 'task-list'
  | 'todo'
  | 'web'
  | 'tool-search'
  | 'chapter'
  | 'spawn-task'
  | 'workflow'
  | 'skill'
  | 'other';

function familyOf(tool: string): Family {
  if (tool.startsWith('mcp__Claude_Preview__')) return 'preview';
  if (tool.startsWith('mcp__Claude_Browser__')) return 'browser';
  switch (tool) {
    case 'Read':
    case 'read':
      return 'read';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'edit':
    case 'write':
    case 'patch':
    case 'apply_patch':
      return 'write';
    case 'Bash':
    case 'PowerShell':
    case 'bash':
      return 'shell';
    case 'Grep':
    case 'Glob':
    case 'grep':
    case 'glob':
      return 'search';
    case 'Agent':
    case 'task':
      return 'agent';
    case 'EnterPlanMode':
      return 'plan-enter';
    case 'ExitPlanMode':
      return 'plan-exit';
    case 'AskUserQuestion':
      return 'ask';
    case 'TaskStop':
      return 'task-stop';
    case 'TaskList':
      return 'task-list';
    case 'todowrite':
      return 'todo';
    case 'WebSearch':
    case 'WebFetch':
      return 'web';
    case 'ToolSearch':
      return 'tool-search';
    case 'mcp__ccd_session__mark_chapter':
      return 'chapter';
    case 'mcp__ccd_session__spawn_task':
      return 'spawn-task';
    case 'Workflow':
      return 'workflow';
    case 'Skill':
      return 'skill';
    default:
      return 'other';
  }
}

/** Narration templates keyed by the first tool an llm call invokes. */
const SINGLE: Record<Family, string[]> = {
  read: [
    'Let me read {file} before changing anything.',
    'Checking how {file} handles {topic}.',
    'Reading {file} to confirm the current behaviour.',
    'Checking {file} for {topic}.',
    'Opening {file} to see what it touches.',
    'Looking at {file} for the existing pattern.',
    'Reading {file} to see what depends on it.',
  ],
  write: [
    'Updating {file} for {topic}.',
    'Applying the change to {file}.',
    'Editing {file}: {topic}.',
    'Now {file}, same change with a smaller surface.',
    'Fixing {file} so it matches the new API.',
    'Writing the change into {file}.',
  ],
  shell: [
    'Running {check}.',
    'Let me run {check} to verify.',
    'Verifying with {check}.',
    'Re-running {check} after the change.',
    'Checking the result with {check}.',
  ],
  search: [
    'Searching for {search}.',
    'Let me find {search}.',
    'Looking for {search} before editing.',
    'First, {search}.',
  ],
  agent: ['Starting an agent: “{delegation}”.'],
  preview: [
    'Checking {preview} in the preview.',
    'Reloading the preview to check {preview}.',
    'Taking a look at {preview} in the running app.',
  ],
  browser: ['Opening the app in the browser to reproduce it.'],
  'plan-enter': [
    'This touches several modules, so I will plan it before editing.',
  ],
  'plan-exit': ['The plan is ready for your review.'],
  ask: ['One decision before I continue: {ask}'],
  'task-stop': ['Stopping the background job before the next step.'],
  'task-list': ['Listing the background jobs that are still running.'],
  todo: ['Updating the todo list: {topic}.'],
  web: ['Searching the web for {web}.', 'Checking the docs on {web}.'],
  'tool-search': ['Loading the tools I need for this step.'],
  chapter: ['Starting a new chapter: {topic}.'],
  'spawn-task': ['That is out of scope here, so I will flag it as a task.'],
  workflow: ['Starting a workflow for {topic}.'],
  skill: ['Running the project skill for {topic}.'],
  other: ['Continuing with {topic}.'],
};

const MULTI: Partial<Record<Family, string[]>> = {
  read: [
    'Reading {file} and {more} in parallel.',
    'Pulling in {file} plus {more} for {topic}.',
  ],
  write: [
    'Editing {file} and {more} for {topic}.',
    'Applying the change to {file} and {more}.',
  ],
  search: ['Running {n1} searches in parallel, starting with {search}.'],
  shell: ['Running {check}, then {moreCmds}.'],
  agent: ['Starting {n1} agents in parallel. First one: “{delegation}”.'],
};

/** Read/write narration by file type, where the code templates read wrong. */
const BY_EXT: Record<string, Partial<Record<Family, string[]>>> = {
  md: {
    read: [
      'Reading {file} for context on {topic}.',
      'Checking what {file} says about {topic}.',
    ],
    write: ['Updating {file} with {topic}.', 'Writing up {topic} in {file}.'],
  },
  sql: {
    read: [
      'Reading {file} to see which tables it touches.',
      'Opening {file} to check its parameters.',
    ],
    write: ['Writing {file}.', 'Adding {file} for {topic}.'],
  },
  output: { read: ['Reading the background job output in {file}.'] },
};

/** Shell narration by executable, where `checks` would read wrong. */
const SEARCHY = new Set([
  'rg',
  'grep',
  'find',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'jq',
  'awk',
  'diff',
]);
const BY_EXE: Record<string, string[]> = {
  git: [
    'Checking the diff so far.',
    'Looking at git status before the next step.',
    'Checking what changed with git diff.',
  ],
  curl: ['Calling the endpoint to check {topic}.'],
  psql: ['Querying the local database to check {topic}.'],
  docker: ['Checking the local Postgres container.'],
  cd: ['Running {check} from the package directory.'],
};

const ACKS = [
  'Done with {topic}.',
  'That covers {topic}.',
  'Finished {topic}; nothing else is pending there.',
];

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pick<T>(items: readonly T[], seed: string): T {
  const item = items[fnv1a(seed) % items.length];
  if (item === undefined) throw new Error(`empty template list (${seed})`);
  return item;
}

function cap(text: string): string {
  return text.length <= PREVIEW_CHARS ? text : text.slice(0, PREVIEW_CHARS);
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]?.toLowerCase() + text.slice(1);
}

function extOf(display: string): string {
  const i = display.lastIndexOf('.');
  return i > 0 ? display.slice(i + 1) : '';
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = vars[key];
    if (v === undefined) throw new Error(`template var {${key}} unset`);
    return v;
  });
}

function chronological(spans: readonly Span[]): Span[] {
  return [...spans].sort(
    (a, b) =>
      Date.parse(a.startedAt) - Date.parse(b.startedAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

function need<T>(items: readonly T[], i: number, what: string): T {
  const item = items[i];
  if (item === undefined) {
    throw new Error(`story is short of ${what}: need index ${i}`);
  }
  return item;
}

/** Substitute the story into a golden Run; returns a RawRun to re-derive. */
export function skinRun(golden: Run, story: DemoStory): RawRun {
  const byId = new Map(golden.spans.map((s) => [s.id, s]));
  const ordered = chronological(golden.spans);

  // --- nearest enclosing subagent, per span -------------------------------
  const scopeOf = new Map<string, string | undefined>();
  const resolveScope = (s: Span): string | undefined => {
    if (scopeOf.has(s.id)) return scopeOf.get(s.id);
    const parent = s.parentId === null ? undefined : byId.get(s.parentId);
    const scope =
      s.kind === 'subagent'
        ? s.id
        : parent === undefined
          ? undefined
          : resolveScope(parent);
    scopeOf.set(s.id, scope);
    return scope;
  };
  for (const s of ordered) resolveScope(s);

  // --- prompts, delegations: by first appearance --------------------------
  const promptIndex = new Map<string, number>();
  for (const s of ordered) {
    const p = s.content?.promptPreview;
    if (typeof p === 'string' && !promptIndex.has(p)) {
      promptIndex.set(p, promptIndex.size);
    }
  }
  if (promptIndex.size !== story.prompts.length) {
    throw new Error(
      `${story.golden}: ${promptIndex.size} distinct prompts, story has ${story.prompts.length}`,
    );
  }
  const subagents = ordered.filter((s) => s.kind === 'subagent');
  if (subagents.length !== story.delegations.length) {
    throw new Error(
      `${story.golden}: ${subagents.length} subagents, story has ${story.delegations.length} delegations`,
    );
  }
  const subagentIndex = new Map(subagents.map((s, i) => [s.id, i]));

  // --- segment per span: which user turn the work answers -----------------
  // A new segment starts whenever the main-thread prompt changes. OpenCode
  // repeats the prompt on every call of a turn (same segment); Claude Code
  // users re-send short prompts like "continue" (a new segment each time).
  const segmentOf = new Map<string, number>();
  let segment = 0;
  let lastPrompt: string | undefined;
  for (const s of ordered) {
    const p = s.content?.promptPreview;
    if (
      typeof p === 'string' &&
      resolveScope(s) === undefined &&
      p !== lastPrompt
    ) {
      lastPrompt = p;
      segment += 1;
    }
    segmentOf.set(s.id, segment);
  }
  /** `A<i>` inside subagent i, `S<n>` in main-thread segment n. */
  const whereOf = (s: Span): string => {
    const scope = resolveScope(s);
    return scope === undefined
      ? `S${segmentOf.get(s.id) ?? 0}`
      : `A${subagentIndex.get(scope) ?? 0}`;
  };

  // --- targets: files by first appearance, commands by frequency ----------
  // A file draws from the pool `<ext>@<where>` of the scope that touches it
  // first (e.g. `ts@A4`), falling back to the story-wide `<ext>` pool.
  const fileKeys = new Map<string, { display: string; where: string }>();
  const commandUse = new Map<string, number>();
  for (const s of ordered) {
    const a = s.attributes as Record<string, unknown>;
    const key = a['runray.targetKey'];
    if (typeof key !== 'string') continue;
    if (a['runray.targetKind'] === 'command') {
      commandUse.set(key, (commandUse.get(key) ?? 0) + 1);
    } else if (!fileKeys.has(key)) {
      const display = String(a['runray.target'] ?? '');
      fileKeys.set(key, { display, where: whereOf(s) });
    }
  }
  const newTarget = new Map<string, { key: string; display: string }>();
  const poolCursor = new Map<string, number>();
  for (const [oldKey, { display, where }] of fileKeys) {
    const ext = extOf(display);
    const scoped = `${ext}@${where}`;
    const poolKey = story.files[scoped] === undefined ? ext : scoped;
    const at = poolCursor.get(poolKey) ?? 0;
    poolCursor.set(poolKey, at + 1);
    const path = need(story.files[poolKey] ?? [], at, `'${poolKey}' files`);
    const t = extractToolTarget('claude-code', 'Read', { file_path: path });
    if (t === undefined) throw new Error(`no target for ${path}`);
    newTarget.set(oldKey, { key: t.key, display: t.display });
  }
  for (const [poolKey, pool] of Object.entries(story.files)) {
    const used = poolCursor.get(poolKey) ?? 0;
    if (used !== pool.length) {
      throw new Error(
        `${story.golden}: pool '${poolKey}' has ${pool.length} paths, ${used} used`,
      );
    }
  }
  const commandsByUse = [...commandUse.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  );
  for (const [i, [oldKey]] of commandsByUse.entries()) {
    const exe = need(story.commands, i, 'commands');
    const t = extractToolTarget('claude-code', 'Bash', { command: exe });
    if (t === undefined) throw new Error(`no target for ${exe}`);
    newTarget.set(oldKey, { key: t.key, display: t.display });
  }
  const targetOf = (s: Span): string | undefined => {
    const key = (s.attributes as Record<string, unknown>)['runray.targetKey'];
    return typeof key === 'string' ? newTarget.get(key)?.display : undefined;
  };

  const children = new Map<string, Span[]>();
  for (const s of ordered) {
    if (s.parentId === null) continue;
    const list = children.get(s.parentId) ?? [];
    list.push(s);
    children.set(s.parentId, list);
  }

  const n = story.narration;
  const topicFor = (s: Span): string => {
    const scope = resolveScope(s);
    if (scope !== undefined) {
      const i = subagentIndex.get(scope) ?? 0;
      return (
        n.subagentTopics?.[i] ??
        lowerFirst(need(story.delegations, i, 'delegations'))
      );
    }
    const t = need(n.topics, segmentOf.get(s.id) ?? 0, 'topics');
    return typeof t === 'string' ? t : pick(t, `${s.id}:topic`);
  };

  const summaryUsed = new Set<string>();
  let askCursor = 0;
  const narrate = (s: Span): string => {
    const tools = (children.get(s.id) ?? []).filter((c) => c.tool);
    const first = tools[0];
    const topic = topicFor(s);
    if (first === undefined) {
      const scope = resolveScope(s);
      const slot =
        scope === undefined ? `main:${segmentOf.get(s.id)}` : `sub:${scope}`;
      if (!summaryUsed.has(slot)) {
        summaryUsed.add(slot);
        const text =
          scope === undefined
            ? n.summaries[segmentOf.get(s.id) ?? 0]
            : n.subagentReports?.[subagentIndex.get(scope) ?? 0];
        if (text) return text;
      }
      return fill(pick(ACKS, s.id), { topic });
    }
    const family = familyOf(first.name);
    const same = tools.filter((t) => familyOf(t.name) === family);
    const agentChild = (children.get(first.id) ?? []).find(
      (c) => c.kind === 'subagent',
    );
    const vars: Record<string, string> = {
      topic,
      file: targetOf(first) ?? 'the file',
      n: String(same.length - 1),
      n1: String(same.length),
      more:
        same.length === 2 ? 'one more file' : `${same.length - 1} more files`,
      check: pick(n.checks, `${s.id}:check`),
      search: pick(n.searches, `${s.id}:search`),
      web: pick(n.web ?? n.searches, `${s.id}:web`),
      preview: pick(n.previews ?? [topic], `${s.id}:preview`),
      // asked in story order: narrate() runs chronologically
      ask:
        family === 'ask'
          ? (n.asks?.[askCursor++] ?? 'which option do you prefer?')
          : '',
      moreCmds:
        same.length === 2
          ? 'one more command'
          : `${same.length - 1} more commands`,
      delegation:
        agentChild === undefined
          ? topic
          : need(
              story.delegations,
              subagentIndex.get(agentChild.id) ?? 0,
              'delegations',
            ),
    };
    const multi = same.length > 1 ? MULTI[family] : undefined;
    let templates = multi ?? SINGLE[family];
    if (family === 'shell' && multi === undefined) {
      const exe = targetOf(first) ?? '';
      if (SEARCHY.has(exe)) templates = SINGLE.search;
      else templates = BY_EXE[exe] ?? templates;
    } else if (multi === undefined) {
      templates = BY_EXT[extOf(vars.file ?? '')]?.[family] ?? templates;
    }
    return fill(pick(templates, s.id), vars);
  };

  // --- errors: per tool name, in occurrence order -------------------------
  const errorCursor = new Map<string, number>();
  // verbatim, never templated: error texts carry JSON and JSX braces
  const nextError = (tool: string): string => {
    const list = story.errors[tool];
    if (list === undefined || list.length === 0) {
      throw new Error(`${story.golden}: no error texts for ${tool}`);
    }
    const at = errorCursor.get(tool) ?? 0;
    errorCursor.set(tool, at + 1);
    return list[at % list.length] as string;
  };

  const renameModel = (m: string): string => story.modelRenames?.[m] ?? m;
  const rewritePath = (file: string): string => {
    if (!file.startsWith(story.source.from)) {
      throw new Error(`${story.golden}: unexpected source path ${file}`);
    }
    const rest = file.slice(story.source.from.length);
    return story.source.to + (story.source.rename?.[rest] ?? rest);
  };

  const spans = ordered.map((s): Span => {
    const next: Span = { ...s, provenance: { ...s.provenance } };
    next.provenance.file = rewritePath(s.provenance.file);

    if (s.llm !== undefined) {
      next.name = renameModel(s.name);
      next.llm = { ...s.llm, model: renameModel(s.llm.model) };
    }

    const attrs = { ...(s.attributes as Record<string, unknown>) };
    const oldKey = attrs['runray.targetKey'];
    if (typeof oldKey === 'string') {
      const t = newTarget.get(oldKey);
      if (t === undefined) throw new Error(`unmapped target ${oldKey}`);
      attrs['runray.targetKey'] = t.key;
      if ('runray.target' in attrs) attrs['runray.target'] = t.display;
    }
    const reqModel = attrs['gen_ai.request.model'];
    if (typeof reqModel === 'string') {
      attrs['gen_ai.request.model'] = renameModel(reqModel);
    }
    next.attributes = attrs;

    if (s.content !== undefined) {
      const content: NonNullable<Span['content']> = {};
      if (typeof s.content.promptPreview === 'string') {
        const i = promptIndex.get(s.content.promptPreview) ?? 0;
        content.promptPreview = cap(need(story.prompts, i, 'prompts'));
      }
      if (typeof s.content.delegationReason === 'string') {
        const i = subagentIndex.get(s.id) ?? 0;
        content.delegationReason = need(story.delegations, i, 'delegations');
      }
      if (typeof s.content.outputPreview === 'string') {
        content.outputPreview = cap(
          s.kind === 'llm_call'
            ? s.llm?.model === '<synthetic>'
              ? s.status === 'error'
                ? nextError('<synthetic>')
                : 'No response requested.'
              : narrate(s)
            : nextError(s.name),
        );
      }
      next.content = content;
    }
    return next;
  });

  return {
    source: {
      ...golden.source,
      files: golden.source.files.map(rewritePath),
    },
    title: story.title,
    project: story.project,
    // parse warnings describe the fixture's truncation, not the story
    warnings: [],
    spans: spans.map(({ depth: _depth, ...raw }) => raw),
  };
}
