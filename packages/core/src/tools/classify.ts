/**
 * Command classification (tool-usage capability): from a shell command to the
 * tool that did the work, its subcommand, an activity and the other tools
 * the command ran.
 *
 * The result has two privacy classes (design D1). Closed-vocabulary values
 * (tool id, table subcommand, activity, runner) come from lists in
 * `registry.ts` and are safe in every redaction mode. Free-form values (a
 * program name outside the registry, a script name) are text from the
 * session: `toolUsageAttributes` emits them only when redaction is off. No
 * argument, path or option value is ever part of the result.
 */
import { TOOL_ATTR } from './attributes.js';
import {
  ACTIVITY_RANK,
  type Activity,
  activityRank,
  lookupTool,
  MODULE_ALIASES,
  PACKAGE_ALIASES,
  scriptActivity,
  type ToolDef,
} from './registry.js';
import { decompose, type ShellDialect, stageProgram } from './shell.js';

/** What a command ran, as far as its text shows. */
export interface Classification {
  activity: Activity;
  /** Registry id of the primary tool; absent when nothing resolved. */
  tool?: string;
  sub?: string;
  via?: string;
  /** Other distinct registry tools, in order of appearance. */
  also: string[];
  /** Free-form: the primary program's name when it is outside the registry. */
  name?: string;
  /** Free-form: the script, task or script file the primary tool ran. */
  script?: string;
}

interface Candidate {
  id?: string;
  activity: Activity;
  plumbing: boolean;
  sub?: string;
  via?: string;
  name?: string;
  script?: string;
}

/** Nested `bash -c "…"` commands are followed this deep. */
const MAX_SHELL_DEPTH = 2;
const MAX_ALSO = 8;
const PLUMBING_RANK = ACTIVITY_RANK.length + 1;

const PROGRAM_NAME = /^[a-z0-9_][a-z0-9_.+@-]{0,63}$/;
/** Shape gate for a free-form program name: keeps script fragments out. */
const FREE_NAME = /^[a-z0-9][a-z0-9._+-]{1,39}$/;
const SCRIPT_NAME = /^[A-Za-z0-9:][A-Za-z0-9:._+@-]{0,59}$/;
const SCRIPT_FILE =
  /\.(sh|bash|zsh|ps1|psm1|py|js|mjs|cjs|ts|mts|cts|tsx|jsx|rb|pl|php|lua)$/i;
const ASSIGNMENT_ARG = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECTION = /^(\d*|&)[<>]/;
const BARE_REDIRECTION = /^(\d*|&)[<>]{1,2}$/;
const NUMERIC = /^\d+$/;

function own<T>(
  table: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function looksLikeFile(word: string): boolean {
  return word.includes('/') || word.includes('\\') || SCRIPT_FILE.test(word);
}

/** Basename of a script argument, when it is fit to show. */
function scriptName(word: string): string | undefined {
  const normalized = word.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return SCRIPT_NAME.test(base) ? base : undefined;
}

function stem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

interface Positional {
  word: string;
  index: number;
}

/** The words of `args` that are neither options, option values, variable
 * assignments nor redirections. */
function positionals(
  args: readonly string[],
  def: ToolDef,
  from = 0,
): Positional[] {
  const caseless = def.shell?.dialect === 'powershell';
  const out: Positional[] = [];
  let literal = false;
  for (let i = from; i < args.length; i++) {
    const word = args[i] as string;
    if (!literal) {
      if (word === '--') {
        literal = true;
        continue;
      }
      if (word.startsWith('-') && word.length > 1) {
        const option = caseless ? word.toLowerCase() : word;
        if (def.valueOptions?.includes(option) === true) i++;
        continue;
      }
      if (def.toolchainPrefix === true && word.startsWith('+')) continue;
      if (ASSIGNMENT_ARG.test(word)) continue;
      if (BARE_REDIRECTION.test(word)) {
        i++;
        continue;
      }
      if (REDIRECTION.test(word)) continue;
    }
    out.push({ word, index: i });
  }
  return out;
}

/** `args` from the first word that is not one of the runner's own options. */
function runnerRest(args: readonly string[], def: ToolDef): string[] {
  let i = 0;
  while (i < args.length) {
    const word = args[i] as string;
    if (word === '--') {
      i++;
      break;
    }
    if (word.startsWith('-') && word.length > 1) {
      i += def.valueOptions?.includes(word) === true ? 2 : 1;
      continue;
    }
    break;
  }
  return args.slice(i);
}

function unknownProgram(name: string, via: string | undefined): Candidate {
  const free = FREE_NAME.test(name) ? name : undefined;
  return {
    activity: 'other',
    plumbing: false,
    ...(free === undefined ? {} : { name: free }),
    ...(via === undefined ? {} : { via }),
  };
}

/** A file run by path: the registry's `script` pseudo-tool. */
function projectScript(name: string, via: string | undefined): Candidate {
  const script = scriptName(name);
  return {
    id: 'script',
    activity: scriptActivity(stem(name)),
    plumbing: false,
    ...(script === undefined ? {} : { script }),
    ...(via === undefined ? {} : { via }),
  };
}

function resolveNamed(
  name: string,
  hasPath: boolean,
  args: readonly string[],
  dialect: ShellDialect,
  depth: number,
  via: string | undefined,
): Candidate[] {
  const match = lookupTool(name);
  if (match === undefined) {
    return hasPath || SCRIPT_FILE.test(name)
      ? [projectScript(name, via)]
      : [unknownProgram(name, via)];
  }
  const full = match.prefix.length > 0 ? [...match.prefix, ...args] : args;
  return resolveTool(match.def, full, dialect, depth, via);
}

/** The program a runner launches: `rest[0]` is a program or a package spec. */
function resolveRunnerTarget(
  rest: readonly string[],
  dialect: ShellDialect,
  depth: number,
  via: string,
): Candidate[] {
  const spec = rest[0];
  if (spec === undefined) return [];
  // `pkg@1.2.3` and `@scope/pkg@latest`: drop the version, keep the scope
  const at = spec.lastIndexOf('@');
  if (at > 0 || spec.startsWith('@')) {
    const bare = (at > 0 ? spec.slice(0, at) : spec).toLowerCase();
    const aliased = own(PACKAGE_ALIASES, bare);
    const name =
      aliased ??
      (bare.startsWith('@') ? bare.slice(bare.indexOf('/') + 1) : bare);
    if (!PROGRAM_NAME.test(name)) return [];
    return resolveNamed(name, false, rest.slice(1), dialect, depth, via);
  }
  const aliased = own(PACKAGE_ALIASES, spec.toLowerCase());
  if (aliased !== undefined) {
    return resolveNamed(aliased, false, rest.slice(1), dialect, depth, via);
  }
  return resolveWords(rest, dialect, depth, via);
}

function resolveTool(
  def: ToolDef,
  args: readonly string[],
  dialect: ShellDialect,
  depth: number,
  via: string | undefined,
): Candidate[] {
  const base = (extra: Partial<Candidate> = {}): Candidate => ({
    id: def.id,
    activity: def.activity,
    plumbing: def.plumbing === true,
    ...(via === undefined ? {} : { via }),
    ...extra,
  });

  // a shell handed a command string: the tools are inside the string
  if (def.shell !== undefined) {
    const shell = def.shell;
    const caseless = shell.dialect === 'powershell';
    for (let i = 0; i < args.length; i++) {
      const word = args[i] as string;
      const flag = word.toLowerCase();
      const hit =
        shell.flags.includes(flag) ||
        (shell.clustered === true && /^-[a-z]*c$/.test(word));
      if (hit) {
        const command =
          shell.rest === true ? args.slice(i + 1).join(' ') : args[i + 1];
        if (command === undefined || command === '') break;
        if (depth >= MAX_SHELL_DEPTH) return [base({ sub: 'inline' })];
        const nested = candidatesOf(
          command,
          shell.dialect,
          depth + 1,
          via ?? `${def.id} ${shell.flags[0]}`,
        );
        return nested.length > 0 ? nested : [base({ sub: 'inline' })];
      }
      if (
        word.startsWith('-') ||
        word.startsWith('+') ||
        word.startsWith('/')
      ) {
        if (def.valueOptions?.includes(caseless ? flag : word) === true) i++;
        continue;
      }
      break; // a positional before any command flag: a script file
    }
    const file = positionals(args, def)[0];
    if (file === undefined) return [base()];
    const script = scriptName(file.word);
    return [
      base({ sub: 'script', ...(script === undefined ? {} : { script }) }),
    ];
  }

  // the program itself hands off (npx, uvx, wsl, xcrun)
  if (def.runner === true) {
    const found = resolveRunnerTarget(
      runnerRest(args, def),
      dialect,
      depth,
      via ?? def.id,
    );
    return found.length > 0 ? found : [base()];
  }

  const first = positionals(args, def)[0];

  // `python -m pytest`: the module is the tool
  if (def.moduleFlag !== undefined) {
    const at = args.indexOf(def.moduleFlag);
    const module = args[at + 1];
    if (
      at !== -1 &&
      module !== undefined &&
      (first === undefined || at < first.index)
    ) {
      const lower = module.toLowerCase();
      const target = own(MODULE_ALIASES, lower) ?? lower;
      if (!PROGRAM_NAME.test(target)) return [base()];
      return resolveNamed(
        target,
        false,
        args.slice(at + 2),
        dialect,
        depth,
        via ?? `${def.id} ${def.moduleFlag}`,
      );
    }
  }

  // a flag that changes what the call is (`node --test`)
  if (def.activityFlags !== undefined) {
    for (let i = 0; i < (first?.index ?? args.length); i++) {
      const activity = own(def.activityFlags, args[i] as string);
      if (activity !== undefined) return [base({ activity })];
    }
  }

  // an interpreter: inline code or a script file
  if (def.interpreter !== undefined) {
    const inlineAt = args.findIndex((a) => def.interpreter?.inline.includes(a));
    if (inlineAt !== -1 && (first === undefined || inlineAt < first.index)) {
      return [base({ sub: 'inline' })];
    }
    if (
      first !== undefined &&
      (def.scripts !== true || looksLikeFile(first.word))
    ) {
      const script = scriptName(first.word);
      return [
        base({ sub: 'script', ...(script === undefined ? {} : { script }) }),
      ];
    }
    if (def.scripts !== true) return [base()];
  }

  return resolveSubs(def, args, dialect, depth, via, 0, base);
}

/** Subcommand table, runner subcommands and user-defined scripts. */
function resolveSubs(
  def: ToolDef,
  args: readonly string[],
  dialect: ShellDialect,
  depth: number,
  via: string | undefined,
  from: number,
  base: (extra?: Partial<Candidate>) => Candidate,
): Candidate[] {
  const table = def.subs ?? {};
  // a script's default follows the tool, except that a package manager's
  // own default (dependencies) says nothing about what its scripts do
  const fallback: Activity = def.activity === 'deps' ? 'run' : def.activity;
  /** `other` is never a pattern result, so it marks "no pattern matched". */
  const named = (word: string): boolean =>
    scriptActivity(stem(word), 'other') !== 'other';
  const asScript = (word: string): Candidate => {
    const script = looksLikeFile(word)
      ? scriptName(word)
      : SCRIPT_NAME.test(word)
        ? word
        : undefined;
    return base({
      sub: 'run',
      activity: scriptActivity(stem(word), fallback),
      ...(script === undefined ? {} : { script }),
    });
  };
  const pos = positionals(args, def, from).filter((p) => !NUMERIC.test(p.word));

  if (def.multi === true) {
    // several targets in one call: the best-ranked one names it; on a tie a
    // target whose name says what it does beats one that fell back to the
    // tool's default (`gradle clean assembleDebug` is the assemble)
    let best: Candidate | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const p of pos.slice(0, 8)) {
      if (def.scriptNext?.includes(p.word) === true) continue;
      let candidate: Candidate | undefined;
      let known = true;
      if (Object.hasOwn(table, p.word)) {
        candidate = base({
          sub: p.word,
          activity: table[p.word] ?? def.activity,
        });
      } else if (def.scripts === true) {
        candidate = asScript(p.word);
        known = named(p.word);
      }
      if (candidate === undefined) continue;
      const score = activityRank(candidate.activity) * 2 + (known ? 0 : 1);
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return [best ?? base()];
  }

  const p0 = pos[0];
  if (p0 === undefined) return [base()];
  const p1 = pos[1];
  let sub: string | undefined;
  let last = p0;
  const two = p1 === undefined ? undefined : `${p0.word} ${p1.word}`;
  if (two !== undefined && p1 !== undefined && Object.hasOwn(table, two)) {
    sub = two;
    last = p1;
  } else if (Object.hasOwn(table, p0.word)) {
    sub = p0.word;
  }
  if (sub === undefined) {
    return def.scripts === true ? [asScript(p0.word)] : [base()];
  }

  if (def.runnerSubs?.includes(sub) === true) {
    let rest = runnerRest(args.slice(last.index + 1), def);
    const skip =
      def.runnerSkip === undefined ? 0 : (own(def.runnerSkip, sub) ?? 0);
    for (let k = 0; k < skip; k++) rest = runnerRest(rest.slice(1), def);
    const found = resolveRunnerTarget(
      rest,
      dialect,
      depth,
      via ?? `${def.id} ${sub}`,
    );
    return found.length > 0 ? found : [base({ sub })];
  }
  const skipAfter =
    def.skipAfter === undefined ? undefined : own(def.skipAfter, sub);
  if (skipAfter !== undefined) {
    const resume = positionals(args, def, last.index + 1)[skipAfter];
    return resume === undefined
      ? [base({ sub })]
      : resolveSubs(def, args, dialect, depth, via, resume.index, base);
  }
  if (def.scriptNext?.includes(sub) === true) {
    const next = positionals(args, def, last.index + 1).find(
      (p) => !NUMERIC.test(p.word),
    );
    return next === undefined
      ? [base({ sub })]
      : [{ ...asScript(next.word), sub }];
  }
  return [base({ sub, activity: table[sub] ?? def.activity })];
}

function resolveWords(
  words: readonly string[],
  dialect: ShellDialect,
  depth: number,
  via: string | undefined,
): Candidate[] {
  const program = stageProgram(words, dialect);
  if (program === undefined) return [];
  if (program.name === undefined) {
    return [
      {
        activity: 'other',
        plumbing: false,
        ...(via === undefined ? {} : { via }),
      },
    ];
  }
  return resolveNamed(
    program.name,
    program.hasPath,
    program.args,
    dialect,
    depth,
    via,
  );
}

function candidatesOf(
  command: string,
  dialect: ShellDialect,
  depth: number,
  via: string | undefined,
): Candidate[] {
  const out: Candidate[] = [];
  for (const pipeline of decompose(command, dialect)) {
    for (const stage of pipeline) {
      for (const c of resolveWords(stage, dialect, depth, via)) out.push(c);
    }
  }
  return out;
}

/**
 * Classify a shell command. Pure and total: any input yields a result, and
 * the same text yields the same result on every call.
 *
 * The primary tool is the program whose activity ranks highest in the
 * expected-duration order (ties go to the earlier program, shell plumbing
 * ranks last). The other distinct registry tools whose activity is neither
 * `explore` nor `system` are the also-ran tools.
 */
export function classifyCommand(
  command: string,
  dialect: ShellDialect,
): Classification {
  const candidates = candidatesOf(command, dialect, 0, undefined);
  let primary: Candidate | undefined;
  let best = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const rank = c.plumbing ? PLUMBING_RANK : activityRank(c.activity);
    if (rank < best) {
      best = rank;
      primary = c;
    }
  }
  if (primary === undefined) return { activity: 'other', also: [] };

  const also: string[] = [];
  for (const c of candidates) {
    if (also.length === MAX_ALSO) break;
    if (c.id === undefined || c.plumbing || c.id === primary.id) continue;
    if (c.activity === 'explore' || c.activity === 'system') continue;
    if (!also.includes(c.id)) also.push(c.id);
  }
  return {
    activity: primary.activity,
    ...(primary.id === undefined ? {} : { tool: primary.id }),
    ...(primary.sub === undefined ? {} : { sub: primary.sub }),
    ...(primary.via === undefined ? {} : { via: primary.via }),
    also,
    ...(primary.name === undefined ? {} : { name: primary.name }),
    ...(primary.script === undefined ? {} : { script: primary.script }),
  };
}

/**
 * The `span.attributes` payload for one shell tool call. The activity is
 * always present; the free-form name and script only when redaction is off.
 */
export function toolUsageAttributes(
  command: string,
  dialect: ShellDialect,
  redact: boolean,
): Record<string, unknown> {
  const c = classifyCommand(command, dialect);
  const out: Record<string, unknown> = { [TOOL_ATTR.activity]: c.activity };
  if (c.tool !== undefined) out[TOOL_ATTR.tool] = c.tool;
  if (c.sub !== undefined) out[TOOL_ATTR.sub] = c.sub;
  if (c.via !== undefined) out[TOOL_ATTR.via] = c.via;
  if (c.also.length > 0) out[TOOL_ATTR.also] = c.also;
  if (!redact) {
    if (c.name !== undefined) out[TOOL_ATTR.name] = c.name;
    if (c.script !== undefined) out[TOOL_ATTR.script] = c.script;
  }
  return out;
}
