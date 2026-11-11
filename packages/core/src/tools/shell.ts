/**
 * Shell command decomposition (tool-usage capability, design T4).
 *
 * One left-to-right pass over at most MAX_COMMAND_CHARS characters splits a
 * command into pipelines (`&&`, `||`, `;`, newline, background `&`) and each
 * pipeline into stages (`|`). It recognises word boundaries and separators
 * and nothing else: no expansion, no globbing, no evaluation. Text inside
 * quotes, command substitutions and heredoc bodies is never split and never
 * read as a command.
 *
 * The scanner is total: it returns a result for any input, including
 * unterminated quotes and stray operators, and every loop advances its
 * index, so the cost is linear in the (capped) input length.
 */

export type ShellDialect = 'posix' | 'powershell';

/** Only this much of a command is ever read. */
export const MAX_COMMAND_CHARS = 8192;

/** One stage of a pipeline: its words, quotes removed. */
export type Stage = string[];
/** Stages joined by `|`. */
export type Pipeline = Stage[];

/**
 * A stage and what removing the quotes lost: which of its words opened with
 * one. `$dir = "D:\work"` and `$out = docker ps` are the same three words
 * once the quotes are gone, and only the second runs a program.
 */
export interface ScannedStage {
  words: Stage;
  /** Indexes into `words`; one shared empty set when no word was quoted. */
  quoted: ReadonlySet<number>;
}

const NONE_QUOTED: ReadonlySet<number> = new Set();

/** Index just past the closing `"` of a string opened before `from`. */
function skipDouble(src: string, from: number, ps: boolean): number {
  const n = src.length;
  let i = from;
  while (i < n) {
    const c = src.charAt(i);
    if (c === '"') {
      if (ps && src.charAt(i + 1) === '"') {
        i += 2;
        continue;
      }
      return i + 1;
    }
    if (ps ? c === '`' : c === '\\') {
      i += 2;
      continue;
    }
    i++;
  }
  return n;
}

/**
 * Index just past the `)` matching the `(` at `open`; the input's end when
 * it never closes. Quotes inside are skipped as units, and so is the body of
 * a heredoc opened inside: `"$(cat <<'EOF' … EOF)"` is how a commit message
 * is usually passed, and its text holds apostrophes and brackets that open
 * and close nothing.
 */
function skipParens(src: string, open: number, ps: boolean): number {
  const n = src.length;
  // `$((1 << 4))` is arithmetic: `<<` shifts, it opens no heredoc
  const heredocsAllowed = !ps && src.charAt(open + 1) !== '(';
  /** Heredocs opened on the current line; their bodies start at its end. */
  let heredocs: string[] | undefined;
  let depth = 0;
  let i = open;
  while (i < n) {
    const c = src.charAt(i);
    if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return n;
      i = end;
    } else if (c === '"') {
      i = skipDouble(src, i + 1, ps) - 1;
    } else if (ps ? c === '`' : c === '\\') {
      i++;
    } else if (heredocsAllowed && c === '<' && src.charAt(i + 1) === '<') {
      if (src.charAt(i + 2) === '<') {
        i += 2; // here-string
      } else {
        const [delimiter, after] = heredocDelimiter(src, i + 2);
        if (delimiter !== '') {
          heredocs ??= [];
          heredocs.push(delimiter);
        }
        i = after - 1;
      }
    } else if (c === '\n' && heredocs !== undefined) {
      i++;
      for (const delimiter of heredocs) i = skipHeredoc(src, i, delimiter);
      heredocs = undefined;
      continue;
    }
    i++;
  }
  return n;
}

/**
 * The delimiter a heredoc names and the index just past it, read from the
 * character after `<<`. An empty delimiter means the text names none.
 */
function heredocDelimiter(
  src: string,
  from: number,
): [delimiter: string, after: number] {
  const n = src.length;
  let j = from;
  if (src.charAt(j) === '-') j++;
  while (src.charAt(j) === ' ' || src.charAt(j) === '\t') j++;
  const quote = src.charAt(j);
  if (quote === "'" || quote === '"') {
    const end = src.indexOf(quote, j + 1);
    return [src.slice(j + 1, end === -1 ? n : end), end === -1 ? n : end + 1];
  }
  if (src.charAt(j) === '\\') j++;
  const start = j;
  while (j < n && /[A-Za-z0-9_.-]/.test(src.charAt(j))) j++;
  return [src.slice(start, j), j];
}

/** Index of the line after the heredoc body that `delimiter` closes. */
function skipHeredoc(src: string, from: number, delimiter: string): number {
  const n = src.length;
  let pos = from;
  while (pos < n) {
    const end = src.indexOf('\n', pos);
    const line = src.slice(pos, end === -1 ? n : end);
    pos = end === -1 ? n : end + 1;
    if (line.trim() === delimiter) return pos;
  }
  return n;
}

/**
 * Split a command into pipelines and stages. Words keep the text of command
 * substitutions verbatim (`$(…)`), so a later step can tell that a program
 * position holds an expansion.
 */
export function decompose(command: string, dialect: ShellDialect): Pipeline[] {
  return scan(command, dialect).map((pipeline) =>
    pipeline.map((stage) => stage.words),
  );
}

/** `decompose`, with each stage's quoted words marked. */
export function scan(command: string, dialect: ShellDialect): ScannedStage[][] {
  const src =
    command.length > MAX_COMMAND_CHARS
      ? command.slice(0, MAX_COMMAND_CHARS)
      : command;
  const ps = dialect === 'powershell';
  const escapeChar = ps ? '`' : '\\';
  const n = src.length;

  const pipelines: ScannedStage[][] = [];
  let pipeline: ScannedStage[] = [];
  let stage: Stage = [];
  /** Indexes of the open stage's quoted words; allocated on first use. */
  let quoted: Set<number> | undefined;
  let word = '';
  let inWord = false;
  /** The open word has no quoted or escaped part. */
  let bare = true;
  /** The open word began with a quote. */
  let opensQuoted = false;
  /** The last operator was `|` and nothing has followed it yet. */
  let afterPipe = false;
  const heredocs: string[] = [];

  const pushStage = () => {
    if (stage.length > 0) {
      pipeline.push({ words: stage, quoted: quoted ?? NONE_QUOTED });
    }
    stage = [];
    quoted = undefined;
  };
  const pushPipeline = () => {
    if (pipeline.length > 0) pipelines.push(pipeline);
    pipeline = [];
    afterPipe = false;
  };
  const endWord = () => {
    if (!inWord) return;
    // a lone, unquoted brace opens or closes a group: a separator, not a word
    const group = bare && (word === '{' || word === '}');
    if (!group) {
      if (opensQuoted) {
        quoted ??= new Set();
        quoted.add(stage.length);
      }
      stage.push(word);
    }
    word = '';
    inWord = false;
    bare = true;
    opensQuoted = false;
    if (group) {
      pushStage();
      pushPipeline();
    }
  };
  const endStage = () => {
    endWord();
    pushStage();
  };
  const endPipeline = () => {
    endWord();
    pushStage();
    pushPipeline();
  };

  let i = 0;
  while (i < n) {
    const c = src.charAt(i);
    const next = src.charAt(i + 1);

    if (c === '\n') {
      i++;
      if (heredocs.length > 0) {
        for (const delimiter of heredocs) i = skipHeredoc(src, i, delimiter);
        heredocs.length = 0;
      }
      // `a |` at the end of a line continues on the next one
      if (afterPipe && !inWord && stage.length === 0) continue;
      endPipeline();
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
      continue;
    }
    if (c === escapeChar) {
      if (next === '\n') {
        i += 2; // line continuation
        continue;
      }
      if (next === '\r' && src.charAt(i + 2) === '\n') {
        i += 3;
        continue;
      }
      word += next;
      inWord = true;
      bare = false;
      i += 2;
      continue;
    }
    if (c === "'") {
      if (!inWord) opensQuoted = true;
      let j = i + 1;
      for (;;) {
        const end = src.indexOf("'", j);
        if (end === -1) {
          word += src.slice(j);
          j = n;
          break;
        }
        word += src.slice(j, end);
        if (ps && src.charAt(end + 1) === "'") {
          word += "'"; // PowerShell doubles a quote to escape it
          j = end + 2;
          continue;
        }
        j = end + 1;
        break;
      }
      inWord = true;
      bare = false;
      i = j;
      continue;
    }
    if (c === '"') {
      if (!inWord) opensQuoted = true;
      let j = i + 1;
      while (j < n) {
        const d = src.charAt(j);
        if (d === '"') {
          if (ps && src.charAt(j + 1) === '"') {
            word += '"';
            j += 2;
            continue;
          }
          break;
        }
        if (d === escapeChar) {
          const e = src.charAt(j + 1);
          // POSIX: a backslash inside double quotes escapes only these
          if (
            ps ||
            e === '$' ||
            e === '`' ||
            e === '"' ||
            e === '\\' ||
            e === '\n'
          ) {
            if (e !== '\n') word += e;
            j += 2;
            continue;
          }
          word += d;
          j++;
          continue;
        }
        if (d === '$' && src.charAt(j + 1) === '(') {
          const end = skipParens(src, j + 1, ps);
          word += src.slice(j, end);
          j = end;
          continue;
        }
        word += d;
        j++;
      }
      inWord = true;
      bare = false;
      i = j + 1;
      continue;
    }
    if (ps && c === '@' && !inWord && (next === "'" || next === '"')) {
      // here-string: an opaque argument up to the closing `'@` / `"@` line
      const terminator = `\n${next}@`;
      const end = src.indexOf(terminator, i + 2);
      i = end === -1 ? n : end + terminator.length;
      opensQuoted = true;
      inWord = true;
      bare = false;
      continue;
    }
    if (next === '(' && (c === '$' || (!ps && (c === '<' || c === '>')))) {
      // command, arithmetic or process substitution: opaque
      const end = skipParens(src, i + 1, ps);
      word += src.slice(i, end);
      inWord = true;
      bare = false;
      i = end;
      continue;
    }
    if (!ps && c === '`') {
      const end = src.indexOf('`', i + 1);
      const stop = end === -1 ? n : end + 1;
      word += src.slice(i, stop);
      inWord = true;
      bare = false;
      i = stop;
      continue;
    }
    if (c === '#' && !inWord) {
      const end = src.indexOf('\n', i);
      i = end === -1 ? n : end; // the newline still ends the pipeline
      continue;
    }
    if (ps && c === '<' && next === '#' && !inWord) {
      const end = src.indexOf('#>', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (!ps && c === '<' && next === '<') {
      if (src.charAt(i + 2) === '<') {
        word += '<<<'; // here-string: an ordinary redirection
        inWord = true;
        i += 3;
        continue;
      }
      const [delimiter, after] = heredocDelimiter(src, i + 2);
      if (delimiter !== '') heredocs.push(delimiter);
      endWord();
      i = after;
      continue;
    }
    if (c === ';') {
      endPipeline();
      i++;
      continue;
    }
    if (c === '|') {
      if (next === '|') {
        endPipeline();
        i += 2;
        continue;
      }
      endStage();
      afterPipe = true;
      i += !ps && next === '&' ? 2 : 1;
      continue;
    }
    if (c === '&') {
      if (next === '&') {
        endPipeline();
        i += 2;
        continue;
      }
      if (inWord && (word.endsWith('>') || word.endsWith('<'))) {
        word += c; // 2>&1
        i++;
        continue;
      }
      if (next === '>') {
        word += c; // &>file
        inWord = true;
        i++;
        continue;
      }
      if (ps && !inWord && stage.length === 0) {
        stage.push('&'); // call operator, kept for program resolution
        i++;
        continue;
      }
      endPipeline(); // background
      i++;
      continue;
    }
    if (c === '(') {
      if (!ps && inWord && next === ')') {
        // `name()` opens a function definition: the name is not a program
        word = '';
        inWord = false;
        bare = true;
        opensQuoted = false;
        i += 2;
        continue;
      }
      if (!ps && inWord && word.endsWith('=')) {
        const end = skipParens(src, i, ps); // array literal: part of the assignment
        word += src.slice(i, end);
        i = end;
        continue;
      }
      endPipeline();
      i++;
      continue;
    }
    if (c === ')') {
      endPipeline();
      i++;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  endPipeline();
  return pipelines;
}

/** What a stage runs, as far as the text shows. */
export interface StageProgram {
  /** Lowercase basename without a Windows executable extension. Absent when
   * the program position holds an expansion. */
  name?: string;
  /** The program position holds a variable or a substitution, so no name
   * can be read without evaluating the command. */
  unresolved: boolean;
  /** The program word carried a directory part (`./x`, `/usr/bin/x`). */
  hasPath: boolean;
  /** The words after the program. */
  args: string[];
}

interface WrapperSpec {
  /** Options that take a separate value. */
  valueOptions?: readonly string[];
  /** Positional words the wrapper consumes before the wrapped command. */
  positionals?: number;
}

/** Commands that run another command and are never the tool themselves. */
const WRAPPERS: Readonly<Record<string, WrapperSpec>> = {
  sudo: {
    valueOptions: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U'],
  },
  doas: { valueOptions: ['-u', '-C'] },
  env: { valueOptions: ['-u', '-C', '-S'] },
  nohup: {},
  nice: { valueOptions: ['-n'] },
  ionice: { valueOptions: ['-c', '-n', '-p'] },
  command: {},
  builtin: {},
  exec: { valueOptions: ['-a'] },
  stdbuf: {},
  unbuffer: {},
  winpty: {},
  setsid: {},
  caffeinate: {},
  chronic: {},
  time: { valueOptions: ['-f', '-o'] },
  timeout: {
    valueOptions: ['-s', '-k', '--signal', '--kill-after'],
    positionals: 1,
  },
  gtimeout: {
    valueOptions: ['-s', '-k', '--signal', '--kill-after'],
    positionals: 1,
  },
  xargs: { valueOptions: ['-n', '-I', '-P', '-d', '-L', '-s', '-a', '-E'] },
  watch: { valueOptions: ['-n', '--interval'] },
  flock: { valueOptions: ['-w', '--timeout', '-E'], positionals: 1 },
  'cross-env': {},
  'cross-env-shell': {},
  dotenv: { valueOptions: ['-e', '-v', '-p'] },
  'env-cmd': { valueOptions: ['-f', '-e', '-r'] },
  shx: {},
  call: {},
};

/** Words that introduce or continue a compound command; the program follows. */
const SKIP_KEYWORDS: Readonly<Record<ShellDialect, ReadonlySet<string>>> = {
  posix: new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!']),
  powershell: new Set([
    'if',
    'elseif',
    'else',
    'do',
    'while',
    'until',
    'try',
    'catch',
    'finally',
  ]),
};

/** Words after which the stage holds no program at all. */
const TERMINAL_KEYWORDS: Readonly<Record<ShellDialect, ReadonlySet<string>>> = {
  posix: new Set([
    'for',
    'select',
    'case',
    'esac',
    'function',
    'done',
    'fi',
    'in',
    'return',
    'break',
    'continue',
    'exit',
  ]),
  powershell: new Set([
    'for',
    'foreach',
    'switch',
    'function',
    'filter',
    'param',
    'begin',
    'process',
    'end',
    'return',
    'break',
    'continue',
    'exit',
    'throw',
  ]),
};

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const PS_ASSIGNMENT = /^\$[A-Za-z_][\w:]*\+?=/;
const REDIRECTION = /^(\d*|&)[<>]/;
const BARE_REDIRECTION = /^(\d*|&)[<>]{1,2}$/;
const PROGRAM_NAME = /^[a-z0-9_][a-z0-9_.+@-]{0,63}$/;

type NameResult =
  | { kind: 'name'; name: string; hasPath: boolean }
  | { kind: 'unresolved'; hasPath: boolean }
  | { kind: 'none' };

function programName(
  word: string,
  dialect: ShellDialect,
  called: boolean,
): NameResult {
  if (dialect === 'posix') {
    if (word === '.') return { kind: 'name', name: 'source', hasPath: false };
    if (word === '[' || word === '[[')
      return { kind: 'name', name: 'test', hasPath: false };
    if (word === ':') return { kind: 'name', name: 'true', hasPath: false };
  }
  const normalized = word.replace(/\\/g, '/');
  const cut = normalized.lastIndexOf('/');
  const hasPath = cut !== -1;
  const base = hasPath ? normalized.slice(cut + 1) : normalized;
  if (base === '') return { kind: 'none' };
  if (/[$`%*?]/.test(base)) {
    // a variable at the head of a PowerShell pipeline is data, not a command,
    // unless the call operator invoked it
    if (dialect === 'powershell' && !called && !hasPath)
      return { kind: 'none' };
    return { kind: 'unresolved', hasPath };
  }
  const name = base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
  if (!PROGRAM_NAME.test(name) || /^\d+$/.test(name)) return { kind: 'none' };
  return { kind: 'name', name, hasPath };
}

/**
 * The program a stage runs: variable assignments, wrapper commands and shell
 * control keywords are skipped, then the next word is normalised to a
 * lowercase basename without a Windows executable extension. Returns
 * `undefined` when the stage holds no program (only assignments, a loop
 * header, a bare keyword).
 *
 * `quoted` is the stage's `ScannedStage.quoted`. It settles the one case the
 * words alone cannot: after `$x =` PowerShell runs a bare word as a command
 * and takes a quoted one as the value, so `$dir = "D:\work"` holds no program
 * while `$out = docker ps` holds `docker`.
 */
export function stageProgram(
  words: readonly string[],
  dialect: ShellDialect,
  quoted: ReadonlySet<number> = NONE_QUOTED,
): StageProgram | undefined {
  const ps = dialect === 'powershell';
  const skip = SKIP_KEYWORDS[dialect];
  const terminal = TERMINAL_KEYWORDS[dialect];
  let i = 0;
  let called = false;
  /** The words so far were `$x =`: what follows is the value assigned. */
  let assigned = false;
  let lastWrapper: string | undefined;

  while (i < words.length) {
    const word = words[i] as string;
    const following = words[i + 1];

    if (ps && (word === '&' || word === '.')) {
      called = true; // call operator / dot-sourcing
      i++;
      continue;
    }
    if (BARE_REDIRECTION.test(word)) {
      i += 2;
      continue;
    }
    if (REDIRECTION.test(word)) {
      i++;
      continue;
    }
    if (following === '=' || following === '+=') {
      i += 2; // `$x = cmd` — the right-hand side may still be a command
      assigned = true;
      continue;
    }
    if (ASSIGNMENT.test(word) || (ps && PS_ASSIGNMENT.test(word))) {
      i++;
      continue;
    }
    const keyword = ps ? word.toLowerCase() : word;
    if (skip.has(keyword)) {
      i++;
      continue;
    }
    if (terminal.has(keyword)) return undefined;
    // a string literal assigned to a variable; only the call operator runs a
    // quoted word (`$out = & "C:\tools\x.exe"`)
    if (ps && assigned && !called && quoted.has(i)) return undefined;

    const resolved = programName(word, dialect, called);
    if (resolved.kind === 'none') return undefined;
    if (resolved.kind === 'unresolved') {
      return {
        unresolved: true,
        hasPath: resolved.hasPath,
        args: words.slice(i + 1),
      };
    }
    const wrapper = Object.hasOwn(WRAPPERS, resolved.name)
      ? WRAPPERS[resolved.name]
      : undefined;
    if (wrapper === undefined) {
      return {
        name: resolved.name,
        unresolved: false,
        hasPath: resolved.hasPath,
        args: words.slice(i + 1),
      };
    }
    // step over the wrapper's own options and positionals
    lastWrapper = resolved.name;
    i++;
    let positionals = wrapper.positionals ?? 0;
    while (i < words.length) {
      const w = words[i] as string;
      if (w === '--') {
        i++;
        break;
      }
      if (w.startsWith('-') && w.length > 1) {
        i += wrapper.valueOptions?.includes(w) === true ? 2 : 1;
        continue;
      }
      if (positionals > 0 && !ASSIGNMENT.test(w)) {
        positionals--;
        i++;
        continue;
      }
      break;
    }
  }
  // a wrapper with nothing to wrap (`env`, `sudo -v`) is itself the program
  if (lastWrapper !== undefined) {
    return { name: lastWrapper, unresolved: false, hasPath: false, args: [] };
  }
  return undefined;
}
