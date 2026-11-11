import { describe, expect, it } from 'vitest';
import {
  decompose,
  MAX_COMMAND_CHARS,
  type ShellDialect,
  stageProgram,
} from './shell.js';

/**
 * Shell command decomposition and program resolution (tool-usage spec:
 * "Shell command decomposition", "Program resolution within a stage",
 * "Decomposition is total and bounded"). Table-driven: one row per shape a
 * transcript actually contains.
 */

interface SplitCase {
  name: string;
  command: string;
  dialect?: ShellDialect;
  expected: string[][][];
}

const SPLIT: SplitCase[] = [
  {
    name: 'compound command (spec scenario)',
    command: 'cd apps/web && pnpm test 2>&1 | tail -20',
    expected: [
      [['cd', 'apps/web']],
      [
        ['pnpm', 'test', '2>&1'],
        ['tail', '-20'],
      ],
    ],
  },
  {
    name: 'separator inside double quotes (spec scenario)',
    command: 'git commit -m "fix; retry && done"',
    expected: [[['git', 'commit', '-m', 'fix; retry && done']]],
  },
  {
    name: 'separator inside single quotes',
    command: "echo 'a | b && c' ; ls",
    expected: [[['echo', 'a | b && c']], [['ls']]],
  },
  {
    name: 'heredoc body is not a command (spec scenario)',
    command: "cat <<'EOF' > notes.md\ndocker run --rm acme\nrm -rf /\nEOF\nls",
    expected: [[['cat', '>', 'notes.md']], [['ls']]],
  },
  {
    name: 'heredoc with a dash and an unquoted delimiter, piped',
    command: 'cat <<-END | grep x\n\tdocker ps\n\tEND\necho done',
    expected: [[['cat'], ['grep', 'x']], [['echo', 'done']]],
  },
  {
    name: 'here-string is an ordinary redirection',
    command: 'grep foo <<< "docker ps" && ls',
    expected: [[['grep', 'foo', '<<<', 'docker ps']], [['ls']]],
  },
  {
    name: 'every chain operator',
    command: 'a && b || c ; d\ne & f',
    expected: [[['a']], [['b']], [['c']], [['d']], [['e']], [['f']]],
  },
  {
    name: 'pipe-and-stderr and redirections stay inside the stage',
    command: 'make 2>&1 |& tee log &> /dev/null >&2',
    expected: [
      [
        ['make', '2>&1'],
        ['tee', 'log', '&>', '/dev/null', '>&2'],
      ],
    ],
  },
  {
    name: 'a trailing pipe continues on the next line',
    command: 'cat file |\n  grep x |\n  wc -l',
    expected: [
      [
        ['cat', 'file'],
        ['grep', 'x'],
        ['wc', '-l'],
      ],
    ],
  },
  {
    name: 'backslash continuation and escaped characters',
    command: 'docker run \\\n  --rm img echo a\\;b',
    expected: [[['docker', 'run', '--rm', 'img', 'echo', 'a;b']]],
  },
  {
    name: 'command substitution is opaque',
    command: 'echo $(git status | wc -l) && kill `cat a.pid; echo`',
    expected: [
      [['echo', '$(git status | wc -l)']],
      [['kill', '`cat a.pid; echo`']],
    ],
  },
  {
    name: 'substitution with quotes inside double quotes',
    command: 'echo "v$(node -p "1;2") done" | cat',
    expected: [[['echo', 'v$(node -p "1;2") done'], ['cat']]],
  },
  {
    name: 'process substitution is opaque',
    command: 'diff <(sort a | uniq) <(sort b)',
    expected: [[['diff', '<(sort a | uniq)', '<(sort b)']]],
  },
  {
    name: 'comments end at the newline',
    command: 'ls # list && rm -rf x\npwd',
    expected: [[['ls']], [['pwd']]],
  },
  {
    name: 'a hash inside a word is not a comment',
    command: 'curl http://x/y#frag',
    expected: [[['curl', 'http://x/y#frag']]],
  },
  {
    name: 'subshell and group braces separate',
    command: '(cd a && make) ; { echo x; }',
    expected: [[['cd', 'a']], [['make']], [['echo', 'x']]],
  },
  {
    name: 'braces inside a word are text',
    command: 'find . -name "*.ts" -exec rm {} \\;',
    expected: [[['find', '.', '-name', '*.ts', '-exec', 'rm', '{}', ';']]],
  },
  {
    name: 'a function definition drops the name',
    command: 'retry() { curl -sf "$1"; }',
    expected: [[['curl', '-sf', '$1']]],
  },
  {
    name: 'an array literal stays in the assignment',
    command: 'files=(a b c) && ls',
    expected: [[['files=(a b c)']], [['ls']]],
  },
  {
    name: 'a Windows path in double quotes keeps its backslashes',
    command: '"C:\\Program Files\\Git\\bin\\git.exe" status',
    expected: [[['C:\\Program Files\\Git\\bin\\git.exe', 'status']]],
  },
  {
    name: 'PowerShell call operator (spec scenario)',
    command: '& "C:\\tools\\flutter\\bin\\flutter.bat" test; Get-Process',
    dialect: 'powershell',
    expected: [
      [['&', 'C:\\tools\\flutter\\bin\\flutter.bat', 'test']],
      [['Get-Process']],
    ],
  },
  {
    name: 'PowerShell backtick continuation and escape',
    command: 'docker run `\n  --rm img; Write-Host "a`"b"',
    dialect: 'powershell',
    expected: [[['docker', 'run', '--rm', 'img']], [['Write-Host', 'a"b']]],
  },
  {
    name: 'PowerShell here-string is one opaque argument',
    command: "git commit -m @'\nfix; docker ps && rm x\n'@\ngit push",
    dialect: 'powershell',
    expected: [[['git', 'commit', '-m', '']], [['git', 'push']]],
  },
  {
    name: 'PowerShell pipeline with a script block',
    command: 'Get-ChildItem -Recurse | Where-Object { $_.Length -gt 1 }',
    dialect: 'powershell',
    expected: [
      [['Get-ChildItem', '-Recurse'], ['Where-Object']],
      [['$_.Length', '-gt', '1']],
    ],
  },
  {
    name: 'PowerShell doubled quote and block comment',
    command: "Write-Output 'it''s' <# docker ps #> ; ls",
    dialect: 'powershell',
    expected: [[['Write-Output', "it's"]], [['ls']]],
  },
  { name: 'empty input', command: '', expected: [] },
  { name: 'only separators', command: ' ;; && | \n', expected: [] },
];

describe('decompose', () => {
  for (const c of SPLIT) {
    it(c.name, () => {
      expect(decompose(c.command, c.dialect ?? 'posix')).toEqual(c.expected);
    });
  }
});

interface ProgramCase {
  name: string;
  stage: string;
  dialect?: ShellDialect;
  /** `undefined` = no program; `null` = unresolved; otherwise the name. */
  program: string | null | undefined;
  args?: string[];
  hasPath?: boolean;
}

const PROGRAMS: ProgramCase[] = [
  {
    name: 'assignment and wrappers are skipped (spec scenario)',
    stage: 'DATABASE_URL=x sudo timeout 30 docker ps',
    program: 'docker',
    args: ['ps'],
  },
  {
    name: 'Windows path and extension (spec scenario)',
    stage: '"C:\\Program Files\\Git\\bin\\git.exe" status',
    program: 'git',
    args: ['status'],
    hasPath: true,
  },
  {
    name: 'variable directory, literal name (spec scenario)',
    stage: '$ANDROID_HOME/platform-tools/adb devices',
    program: 'adb',
    hasPath: true,
  },
  {
    name: 'variable program is unresolved (spec scenario)',
    stage: '"$BIN" --version',
    program: null,
  },
  {
    name: 'substitution in program position',
    stage: '$(which node) x.js',
    program: null,
  },
  {
    name: 'loop keyword before the program',
    stage: 'until curl -sf localhost',
    program: 'curl',
  },
  { name: 'do keyword', stage: 'do sleep 2', program: 'sleep' },
  { name: 'negation', stage: '! grep -q x file', program: 'grep' },
  {
    name: 'loop header holds no program',
    stage: 'for f in a b c',
    program: undefined,
  },
  { name: 'closing keyword', stage: 'done', program: undefined },
  { name: 'only assignments', stage: 'FOO=1 BAR=2', program: undefined },
  {
    name: 'env wrapper with its own assignments',
    stage: '/usr/bin/env -u X NODE_ENV=test node a.js',
    program: 'node',
    args: ['a.js'],
  },
  {
    name: 'sudo option with a value',
    stage: 'sudo -u postgres psql -c x',
    program: 'psql',
  },
  {
    name: 'xargs as a filter stage',
    stage: 'xargs -n 1 -I {} rm {}',
    program: 'rm',
  },
  {
    name: 'nested wrappers',
    stage: 'nohup nice -n 5 time make all',
    program: 'make',
  },
  {
    name: 'cross-env',
    stage: 'cross-env NODE_ENV=production vite build',
    program: 'vite',
  },
  {
    name: 'wrapper separator',
    stage: 'dotenv -e .env -- prisma migrate dev',
    program: 'prisma',
  },
  {
    name: 'a wrapper with nothing to wrap is the program',
    stage: 'sudo -v',
    program: 'sudo',
    args: [],
  },
  {
    name: 'leading redirection',
    stage: '2>/dev/null > out.txt ls -la',
    program: 'ls',
  },
  {
    name: 'relative script keeps its extension',
    stage: './scripts/deploy.sh --prod',
    program: 'deploy.sh',
    hasPath: true,
  },
  { name: 'uppercase and .cmd', stage: 'NPM.CMD install', program: 'npm' },
  { name: 'test bracket', stage: '[ -f package.json ]', program: 'test' },
  { name: 'dot is source', stage: '. ./env.sh', program: 'source' },
  { name: 'a number is not a program', stage: '42 foo', program: undefined },
  {
    name: 'punctuation is not a program',
    stage: '.Length -gt 1',
    program: undefined,
  },
  { name: 'a directory is not a program', stage: 'src/', program: undefined },
  {
    name: 'PowerShell call operator with a variable is unresolved',
    stage: '& $cmd --flag',
    dialect: 'powershell',
    program: null,
  },
  {
    name: 'PowerShell variable at the head of a pipeline is data',
    stage: '$files',
    dialect: 'powershell',
    program: undefined,
  },
  {
    name: 'PowerShell assignment whose value is a command',
    stage: '$out = docker ps -q',
    dialect: 'powershell',
    program: 'docker',
    args: ['ps', '-q'],
  },
  {
    name: 'PowerShell env assignment then command',
    stage: "$env:NODE_ENV='test' ; ",
    dialect: 'powershell',
    program: undefined,
  },
  {
    name: 'PowerShell keyword is case-insensitive',
    stage: 'ForEach ($f in $x)',
    dialect: 'powershell',
    program: undefined,
  },
  {
    name: 'PowerShell cmdlet is lowercased',
    stage: 'Get-ChildItem -Recurse',
    dialect: 'powershell',
    program: 'get-childitem',
  },
  {
    name: 'PowerShell variable directory through the call operator',
    stage: '& "$env:JAVA_HOME\\bin\\java.exe" -version',
    dialect: 'powershell',
    program: 'java',
    hasPath: true,
  },
];

describe('stageProgram', () => {
  for (const c of PROGRAMS) {
    it(c.name, () => {
      const dialect = c.dialect ?? 'posix';
      const stage = decompose(c.stage, dialect)[0]?.[0] ?? [];
      const got = stageProgram(stage, dialect);
      if (c.program === undefined) {
        expect(got).toBeUndefined();
        return;
      }
      expect(got).toBeDefined();
      if (c.program === null) {
        expect(got?.unresolved).toBe(true);
        expect(got?.name).toBeUndefined();
      } else {
        expect(got?.unresolved).toBe(false);
        expect(got?.name).toBe(c.program);
      }
      if (c.args !== undefined) expect(got?.args).toEqual(c.args);
      if (c.hasPath !== undefined) expect(got?.hasPath).toBe(c.hasPath);
    });
  }

  it('finds the programs of a loop, never its keywords (spec scenario)', () => {
    const names = decompose(
      'until curl -sf localhost:3000; do sleep 2; done',
      'posix',
    )
      .flat()
      .map((stage) => stageProgram(stage, 'posix')?.name);
    expect(names).toEqual(['curl', 'sleep', undefined]);
  });
});

/** Deterministic PRNG so a failure reproduces from the seed alone. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [
  ...'\'"`$(){}[]|&;<>\\\n\t\r #=@-./:*?!%~+,',
  'a',
  'b',
  'Z',
  '0',
  '9',
  '<<',
  '<<<',
  '$(',
  '&&',
  '||',
  "@'",
  '@"',
  '<#',
  'EOF',
  'do',
  'if',
  '\u0000',
  '\ud83d',
  'é',
];

describe('decomposition is total and bounded', () => {
  it('returns a result for malformed input (spec scenario)', () => {
    const malformed = [
      "'",
      '"',
      '`',
      '$(',
      '$((((',
      '"$(',
      '<<EOF',
      "<<'",
      "@'\nnever closed",
      '<# never closed',
      '\\',
      'a |',
      '| | |',
      '&&&&',
      '((((',
      '))))',
      '{ { {',
      'a=(',
      'x() ',
      '\u0000\u0001\u001b[31m',
      'echo "unterminated && docker ps',
    ];
    for (const dialect of ['posix', 'powershell'] as const) {
      for (const command of malformed) {
        expect(() => {
          for (const pipeline of decompose(command, dialect)) {
            for (const stage of pipeline) stageProgram(stage, dialect);
          }
        }).not.toThrow();
      }
    }
  });

  it('never throws on random input and only returns non-empty stages', () => {
    const random = mulberry32(0x5eed);
    for (let round = 0; round < 4000; round++) {
      const length = Math.floor(random() * 120);
      let command = '';
      for (let k = 0; k < length; k++) {
        command += ALPHABET[Math.floor(random() * ALPHABET.length)];
      }
      for (const dialect of ['posix', 'powershell'] as const) {
        const pipelines = decompose(command, dialect);
        for (const pipeline of pipelines) {
          expect(pipeline.length).toBeGreaterThan(0);
          for (const stage of pipeline) {
            expect(stage.length).toBeGreaterThan(0);
            const program = stageProgram(stage, dialect);
            if (program?.name !== undefined) {
              expect(program.name).toMatch(/^[a-z0-9_][a-z0-9_.+@-]*$/);
            }
          }
        }
      }
    }
  });

  it('reads only the first MAX_COMMAND_CHARS characters (spec scenario)', () => {
    const filler = 'echo x; '.repeat(MAX_COMMAND_CHARS / 8); // exactly the cap
    expect(filler.length).toBe(MAX_COMMAND_CHARS);
    const huge = `${filler}docker ps; ${'y '.repeat(500_000)}`;
    expect(huge.length).toBeGreaterThan(1_000_000);
    const programs = decompose(huge, 'posix')
      .flat()
      .map((stage) => stageProgram(stage, 'posix')?.name);
    expect(programs.length).toBe(MAX_COMMAND_CHARS / 8);
    expect(programs).not.toContain('docker');
  });

  it('is deterministic', () => {
    const command = 'cd a && FOO=1 npx vitest run | tee out.log';
    expect(decompose(command, 'posix')).toEqual(decompose(command, 'posix'));
  });
});
