import { describe, expect, it } from 'vitest';
import { TOOL_ATTR } from './attributes.js';
import {
  type Classification,
  classifyCommand,
  toolUsageAttributes,
} from './classify.js';
import {
  ACTIVITIES,
  RUNNER_IDS,
  TOOL_DEFS,
  TOOL_IDS,
  toolById,
} from './registry.js';
import { MAX_COMMAND_CHARS, type ShellDialect } from './shell.js';

/**
 * Command classification (tool-usage spec: "Runner unwrapping", "Subcommand
 * tables", "Package-manager scripts", "Activity taxonomy", "Primary tool
 * selection", "Privacy class of identity values"). One row per command shape;
 * only the fields a row names are compared.
 */

interface Row {
  command: string;
  dialect?: ShellDialect;
  expect: Partial<Classification> & {
    noTool?: true;
    noSub?: true;
    /** `toMatchObject` cannot say a field is absent; this does. */
    noScript?: true;
  };
}

function check(rows: Row[]): void {
  for (const row of rows) {
    it(row.command.replace(/\n/g, '⏎'), () => {
      const got = classifyCommand(row.command, row.dialect ?? 'posix');
      const { noTool, noSub, noScript, ...fields } = row.expect;
      expect(got).toMatchObject(fields);
      if (noScript === true) expect(got.script).toBeUndefined();
      if (noTool === true) expect(got.tool).toBeUndefined();
      if (noSub === true) expect(got.sub).toBeUndefined();
    });
  }
}

describe('runner unwrapping', () => {
  check([
    {
      command: 'npx vitest run',
      expect: { tool: 'vitest', sub: 'run', via: 'npx', activity: 'test' },
    },
    {
      command: 'pnpm --filter web exec tsc --noEmit',
      expect: { tool: 'tsc', via: 'pnpm exec', activity: 'check' },
    },
    {
      command: 'npx @biomejs/biome check',
      expect: { tool: 'biome', sub: 'check', via: 'npx' },
    },
    {
      command: 'bash -c "cd api && cargo test"',
      expect: { tool: 'cargo', sub: 'test', via: 'bash -c', activity: 'test' },
    },
    {
      command: 'npx -y typescript@5.6.3 --noEmit',
      expect: { tool: 'tsc', via: 'npx' },
    },
    {
      command: 'npx --package=@playwright/test playwright test',
      expect: { tool: 'playwright', sub: 'test', via: 'npx' },
    },
    {
      command: 'pnpm dlx @changesets/cli status',
      expect: { tool: 'changeset', via: 'pnpm dlx' },
    },
    {
      command: 'yarn workspace web exec eslint .',
      expect: { tool: 'eslint', via: 'yarn exec' },
    },
    {
      command: 'bunx prettier --check .',
      expect: { tool: 'prettier', via: 'bunx' },
    },
    {
      command: 'uv run pytest tests/ -q',
      expect: { tool: 'pytest', via: 'uv run', activity: 'test' },
    },
    {
      command: 'uv run --with requests python fetch.py',
      expect: {
        tool: 'python',
        sub: 'script',
        via: 'uv run',
        script: 'fetch.py',
      },
    },
    {
      command: 'uvx ruff check .',
      expect: { tool: 'ruff', sub: 'check', via: 'uvx' },
    },
    {
      command: 'python -m pytest -q',
      expect: { tool: 'pytest', via: 'python -m', activity: 'test' },
    },
    {
      command: 'python3 -m http.server 8000',
      expect: { tool: 'http-server', via: 'python -m' },
    },
    {
      command: 'py -3 -m pip install -r requirements.txt',
      expect: {
        tool: 'pip',
        sub: 'install',
        via: 'python -m',
        activity: 'deps',
      },
    },
    {
      command: 'poetry run mypy src',
      expect: { tool: 'mypy', via: 'poetry run', activity: 'check' },
    },
    {
      command: 'bundle exec rspec',
      expect: { tool: 'rspec', via: 'bundle exec' },
    },
    {
      command: 'rustup run nightly cargo fmt',
      expect: {
        tool: 'cargo',
        sub: 'fmt',
        via: 'rustup run',
        activity: 'check',
      },
    },
    {
      command: 'xcrun simctl list devices',
      expect: { tool: 'simctl', sub: 'list', via: 'xcrun' },
    },
    {
      command: 'wsl -e bash -lc "cargo build --release"',
      expect: { tool: 'cargo', sub: 'build', via: 'wsl' },
    },
    {
      command: 'cmd /c "npm run build"',
      expect: { tool: 'npm', sub: 'run', via: 'cmd /c', activity: 'build' },
    },
    {
      command:
        'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process | Sort-Object CPU"',
      expect: { tool: 'get-process', via: 'powershell -command' },
    },
    {
      command: 'pnpm exec my-internal-cli sync',
      expect: {
        noTool: true,
        via: 'pnpm exec',
        activity: 'other',
        name: 'my-internal-cli',
      },
    },
    { command: 'npx', expect: { tool: 'npx', noSub: true } },
    { command: 'pnpm exec', expect: { tool: 'pnpm', sub: 'exec' } },
    {
      command: 'bash -c "bash -c \\"bash -c \'docker ps\'\\""',
      expect: { tool: 'bash', sub: 'inline' },
    },
  ]);
});

describe('subcommand tables', () => {
  check([
    {
      command: 'git -C ../api diff --stat',
      expect: { tool: 'git', sub: 'diff', activity: 'vcs' },
    },
    {
      command: 'docker compose -f dev.yml up -d',
      expect: { tool: 'docker', sub: 'compose up', activity: 'infra' },
    },
    {
      command: 'docker-compose up -d',
      expect: { tool: 'docker', sub: 'compose up' },
    },
    {
      command: 'git frobnicate ./secret-plan',
      expect: { tool: 'git', noSub: true },
    },
    {
      command: 'docker run --rm -p 8080:80 nginx:1.27 nginx -g "daemon off;"',
      expect: { tool: 'docker', sub: 'run' },
    },
    {
      command: 'docker build -t acme/api .',
      expect: { tool: 'docker', sub: 'build', activity: 'build' },
    },
    {
      command: 'gh pr checks 44 --watch',
      expect: { tool: 'gh', sub: 'pr checks' },
    },
    {
      command: 'gh api repos/acme/web/pulls',
      expect: { tool: 'gh', sub: 'api' },
    },
    {
      command: 'kubectl -n prod rollout status deploy/api',
      expect: { tool: 'kubectl', sub: 'rollout status' },
    },
    {
      command: 'terraform -chdir=infra plan',
      expect: { tool: 'terraform', sub: 'plan', activity: 'infra' },
    },
    {
      command: 'cargo +nightly clippy --all-targets',
      expect: { tool: 'cargo', sub: 'clippy', activity: 'check' },
    },
    {
      command: 'go mod tidy',
      expect: { tool: 'go', sub: 'mod tidy', activity: 'deps' },
    },
    {
      command: 'dotnet ef migrations add Init',
      expect: { tool: 'dotnet', sub: 'ef migrations', activity: 'data' },
    },
    {
      command: 'flutter pub get',
      expect: { tool: 'flutter', sub: 'pub get', activity: 'deps' },
    },
    {
      command: 'supabase db reset --local',
      expect: { tool: 'supabase', sub: 'db reset', activity: 'data' },
    },
    {
      command: 'vercel env pull .env.local',
      expect: { tool: 'vercel', sub: 'env pull', activity: 'cloud' },
    },
    {
      command: 'aws --profile acme s3 ls s3://bucket',
      expect: { tool: 'aws', sub: 's3' },
    },
    {
      command: 'next dev --turbopack',
      expect: { tool: 'next', sub: 'dev', activity: 'run' },
    },
    {
      command: 'vite build',
      expect: { tool: 'vite', sub: 'build', activity: 'build' },
    },
    {
      command: 'prisma migrate dev --name init',
      expect: { tool: 'prisma', sub: 'migrate dev', activity: 'data' },
    },
    {
      command: 'mvn clean install -DskipTests',
      expect: { tool: 'mvn', sub: 'install', activity: 'build' },
    },
    {
      command:
        'xcodebuild -scheme App -destination "platform=iOS Simulator" clean test',
      expect: { tool: 'xcodebuild', sub: 'test', activity: 'test' },
    },
    { command: '/usr/bin/git status', expect: { tool: 'git', sub: 'status' } },
    {
      command: './node_modules/.bin/vitest run',
      expect: { tool: 'vitest', sub: 'run' },
    },
  ]);
});

describe('package-manager scripts', () => {
  check([
    {
      command: 'pnpm build',
      expect: { tool: 'pnpm', sub: 'run', script: 'build', activity: 'build' },
    },
    {
      command: 'npm run db:reset',
      expect: { tool: 'npm', sub: 'run', script: 'db:reset', activity: 'data' },
    },
    {
      // spec scenario "Own command": no script name is reported
      command: 'pnpm install --frozen-lockfile',
      expect: {
        tool: 'pnpm',
        sub: 'install',
        activity: 'deps',
        noScript: true,
      },
    },
    {
      command: 'pnpm -r run build',
      expect: { tool: 'pnpm', sub: 'run', script: 'build', activity: 'build' },
    },
    {
      command: 'npm test',
      expect: { tool: 'npm', sub: 'run', script: 'test', activity: 'test' },
    },
    {
      command: 'npm --prefix packages/ui run lint',
      expect: { tool: 'npm', sub: 'run', script: 'lint', activity: 'check' },
    },
    {
      command: 'yarn',
      expect: { tool: 'yarn', noSub: true, activity: 'deps' },
    },
    {
      command: 'yarn workspace web build',
      expect: { tool: 'yarn', sub: 'run', script: 'build', activity: 'build' },
    },
    {
      command: 'bun test',
      expect: { tool: 'bun', sub: 'test', activity: 'test' },
    },
    {
      command: 'bun run dev',
      expect: { tool: 'bun', sub: 'run', script: 'dev', activity: 'run' },
    },
    {
      command: 'bun src/index.ts',
      expect: { tool: 'bun', sub: 'script', script: 'index.ts' },
    },
    {
      command: 'make -j 8 test',
      expect: { tool: 'make', sub: 'run', script: 'test', activity: 'test' },
    },
    {
      command: 'make',
      expect: { tool: 'make', noSub: true, activity: 'build' },
    },
    {
      command: 'make all',
      expect: { tool: 'make', sub: 'run', script: 'all', activity: 'build' },
    },
    {
      command: './gradlew clean assembleDebug',
      expect: {
        tool: 'gradle',
        sub: 'run',
        script: 'assembleDebug',
        activity: 'build',
      },
    },
    {
      command: 'turbo run lint test --filter=web',
      expect: { tool: 'turbo', sub: 'run', script: 'lint', activity: 'check' },
    },
    {
      command: 'deno task dev',
      expect: { tool: 'deno', sub: 'task', script: 'dev', activity: 'run' },
    },
    {
      command: 'pnpm deploy-preview',
      expect: {
        tool: 'pnpm',
        sub: 'run',
        script: 'deploy-preview',
        activity: 'run',
      },
    },
  ]);
});

describe('activity taxonomy', () => {
  check([
    { command: 'cargo test', expect: { activity: 'test' } },
    { command: 'cargo build', expect: { activity: 'build' } },
    { command: 'cargo clippy', expect: { activity: 'check' } },
    { command: 'pnpm test:e2e', expect: { activity: 'test' } },
    { command: 'pnpm typecheck', expect: { activity: 'check' } },
    { command: 'pnpm dev', expect: { activity: 'run' } },
    {
      command: '"$BIN" --version',
      expect: { activity: 'other', noTool: true },
    },
    { command: 'node --test', expect: { tool: 'node', activity: 'test' } },
    {
      command: 'node scripts/build.mjs --watch',
      expect: {
        tool: 'node',
        sub: 'script',
        script: 'build.mjs',
        activity: 'run',
      },
    },
    {
      command: 'node -e "console.log(1)"',
      expect: { tool: 'node', sub: 'inline' },
    },
    {
      command: 'python -c "import sys; print(sys.version)"',
      expect: { tool: 'python', sub: 'inline' },
    },
    {
      command: 'curl -sS https://example.com | jq .',
      expect: { tool: 'curl', activity: 'web' },
    },
    {
      command: 'psql -h localhost -U app -c "select 1"',
      expect: { tool: 'psql', activity: 'data' },
    },
    {
      command: 'adb -s emulator-5554 logcat',
      expect: { tool: 'adb', sub: 'logcat', activity: 'devices' },
    },
    {
      command: './scripts/deploy.sh --prod',
      expect: { tool: 'script', script: 'deploy.sh', activity: 'run' },
    },
    {
      command: '.\\build.ps1 -Release',
      dialect: 'powershell',
      expect: { tool: 'script', script: 'build.ps1', activity: 'build' },
    },
    {
      command:
        'Get-ChildItem -Recurse | Where-Object { $_.Length -gt 1 } | Select-Object -First 5',
      dialect: 'powershell',
      expect: { tool: 'get-childitem', activity: 'explore' },
    },
    {
      command: '$out = docker ps -q; Write-Host $out',
      dialect: 'powershell',
      expect: { tool: 'docker', sub: 'ps' },
    },
    { command: '', expect: { activity: 'other', noTool: true, also: [] } },
    { command: 'FOO=bar', expect: { activity: 'other', noTool: true } },
  ]);
});

describe('a PowerShell string assigned to a variable is not a call', () => {
  check([
    {
      // was: the `script` pseudo-tool, named after the path's last segment
      command: '$dir = "D:\\GIT\\project"; Get-ChildItem $dir',
      dialect: 'powershell',
      expect: { tool: 'get-childitem', activity: 'explore', also: [] },
    },
    {
      command: '$name = "docker"; Write-Host $name',
      dialect: 'powershell',
      expect: { tool: 'write-host', also: [] },
    },
    {
      command: '$file = "package.json"',
      dialect: 'powershell',
      expect: { activity: 'other', noTool: true },
    },
    {
      command: '$out = docker ps -q; $out.Count',
      dialect: 'powershell',
      expect: { tool: 'docker', sub: 'ps', activity: 'infra' },
    },
    {
      // list elements on lines of their own are not runs of a script
      command:
        '$files = @(\n  "src\\app.ts",\n  "src\\db.ts"\n)\nGet-Content $files',
      dialect: 'powershell',
      expect: { tool: 'get-content', activity: 'explore', also: [] },
    },
    {
      command: '$tool = & "C:\\tools\\git.exe" status',
      dialect: 'powershell',
      expect: { tool: 'git', sub: 'status' },
    },
  ]);

  it('reads a quoted program when another shell may run the text', () => {
    const command = '"C:\\Program Files\\nodejs\\node.exe" hooks\\format.mjs';
    expect(classifyCommand(command, 'powershell').tool).toBeUndefined();
    expect(
      classifyCommand(command, 'powershell', { quotedWordsRun: true }),
    ).toMatchObject({ tool: 'node', sub: 'script', script: 'format.mjs' });
    // a shell nested in such a command is read by its own rules
    expect(
      classifyCommand(
        'powershell -Command "$d = \'D:\\work\'; pnpm test"',
        'posix',
        { quotedWordsRun: true },
      ),
    ).toMatchObject({ tool: 'pnpm', activity: 'test', also: [] });
  });

  it('reports no program name for the assigned text', () => {
    for (const command of [
      '$file = "package.json"',
      '$dir = "D:\\GIT\\project"',
      "$h = @{ tool = 'terraform'; dir = 'infra' }",
    ]) {
      const got = classifyCommand(command, 'powershell');
      expect(got.name, command).toBeUndefined();
      expect(got.script, command).toBeUndefined();
      expect(got.tool, command).toBeUndefined();
    }
  });
});

describe('primary tool selection', () => {
  check([
    {
      command: 'cd web && pnpm test 2>&1 | tail -20',
      expect: { tool: 'pnpm', activity: 'test', also: [] },
    },
    {
      command: 'git add -A && pnpm build',
      expect: { tool: 'pnpm', activity: 'build', also: ['git'] },
    },
    { command: 'ls -la | grep config', expect: { tool: 'ls', also: [] } },
    {
      command: 'cat dump.sql | docker exec -i db psql',
      expect: { tool: 'docker', sub: 'exec' },
    },
    {
      command: 'cd packages/ui',
      expect: { tool: 'cd', activity: 'system', also: [] },
    },
    {
      command: 'ls && acme-deploy --prod',
      expect: { noTool: true, activity: 'other', name: 'acme-deploy' },
    },
    {
      command:
        'docker compose up -d && pnpm test && git commit -m done && gh pr create',
      expect: { tool: 'pnpm', also: ['docker', 'git', 'gh'] },
    },
    {
      command: 'git status; git diff; git log -1',
      expect: { tool: 'git', sub: 'status', also: [] },
    },
    {
      command: 'sleep 5 && curl -sf localhost:3000/health',
      expect: { tool: 'curl' },
    },
    {
      command: 'until curl -sf localhost:3000; do sleep 2; done',
      expect: { tool: 'curl', also: [] },
    },
    {
      command: 'export NODE_ENV=test\nnpx vitest run\necho done',
      expect: { tool: 'vitest', via: 'npx' },
    },
    {
      command: "cat <<'EOF' > plan.md\ndocker run acme\npnpm build\nEOF",
      expect: { tool: 'cat', also: [] },
    },
    {
      // a check that docker exists is not a docker call
      command: 'command -v docker >/dev/null && echo found',
      expect: { tool: 'which', activity: 'explore', also: [] },
    },
    {
      command: 'command -v pnpm',
      expect: { tool: 'which', activity: 'explore', also: [] },
    },
    {
      // the apostrophe in the message used to swallow everything after it
      command:
        "git commit -m \"$(cat <<'EOF'\nfix: don't run docker here\nEOF\n)\" && pnpm test",
      expect: { tool: 'pnpm', activity: 'test', also: ['git'] },
    },
    {
      command: 'echo "pnpm build && docker push"',
      expect: { tool: 'echo', activity: 'system', also: [] },
    },
    {
      command: 'ssh deploy@host "docker compose pull && docker compose up -d"',
      expect: { tool: 'ssh', activity: 'web', also: [] },
    },
  ]);

  it('caps the also-ran list at eight', () => {
    const tools = [
      'git',
      'docker',
      'kubectl',
      'helm',
      'terraform',
      'aws',
      'gcloud',
      'az',
      'vercel',
      'supabase',
      'psql',
    ];
    const got = classifyCommand(
      `cargo build && ${tools.join(' x && ')} x`,
      'posix',
    );
    expect(got.tool).toBe('cargo');
    expect(got.also).toHaveLength(8);
    expect(got.also).toEqual(tools.slice(0, 8));
  });
});

describe('privacy class of identity values', () => {
  it('emits the same closed-vocabulary values in both modes (spec scenario)', () => {
    const commands = [
      'cd apps/web && pnpm exec vitest run 2>&1 | tail -20',
      'git add -A && pnpm build',
      'npm run db:reset',
      'acme-deploy --prod',
      './scripts/deploy.sh',
      'node scripts/seed.mjs',
    ];
    const closed = [
      TOOL_ATTR.activity,
      TOOL_ATTR.tool,
      TOOL_ATTR.sub,
      TOOL_ATTR.via,
      TOOL_ATTR.also,
    ];
    const free = [TOOL_ATTR.name, TOOL_ATTR.script];
    for (const command of commands) {
      const open = toolUsageAttributes(command, 'posix', false);
      const redacted = toolUsageAttributes(command, 'posix', true);
      for (const key of closed)
        expect(redacted[key], `${command} ${key}`).toEqual(open[key]);
      for (const key of free)
        expect(key in redacted, `${command} ${key}`).toBe(false);
    }
    expect(
      toolUsageAttributes('npm run db:reset', 'posix', false)[TOOL_ATTR.script],
    ).toBe('db:reset');
    expect(
      toolUsageAttributes('acme-deploy --prod', 'posix', false)[TOOL_ATTR.name],
    ).toBe('acme-deploy');
  });

  it('never emits an argument, path or option value (spec scenario)', () => {
    const command =
      'docker exec acme-db psql -U alice -c "select secret from vault" && cd /Users/alex/work/acme-billing && git -C /Users/alex/private push origin feature/top-secret';
    for (const redact of [false, true]) {
      const serialized = JSON.stringify(
        toolUsageAttributes(command, 'posix', redact),
      );
      for (const leak of [
        'acme',
        'alice',
        'secret',
        'vault',
        'alex',
        'Users',
        'origin',
        'feature',
      ]) {
        expect(serialized, `${leak} (redact=${redact})`).not.toContain(leak);
      }
    }
  });

  it('gives a program outside the registry no id and no name under redaction (spec scenario)', () => {
    expect(toolUsageAttributes('acme-deploy --prod', 'posix', true)).toEqual({
      [TOOL_ATTR.activity]: 'other',
    });
  });

  it('keeps fragments of inline code out of the free-form name', () => {
    for (const command of [
      'x',
      '"SELECT 1"',
      'f() { :; }',
      'a=(1 2 3)',
      '{ "json": true }',
    ]) {
      expect(
        TOOL_ATTR.name in toolUsageAttributes(command, 'posix', false),
        command,
      ).toBe(false);
    }
  });

  it('carries the activity alone for an unresolved command', () => {
    expect(toolUsageAttributes('"$BIN" --version', 'posix', false)).toEqual({
      [TOOL_ATTR.activity]: 'other',
    });
  });
});

/** Deterministic PRNG, same construction as shell.test.ts. */
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

/**
 * Tool-usage spec, "Decomposition is total and bounded": no input throws and
 * the cost is linear in the input. Every registry entry that hands the rest
 * of the words to another resolution is repeated up to the scanner's cap.
 */
describe('classification is total and bounded', () => {
  /** One unit per way the registry hands off, read from the registry. */
  const units = new Set<string>(['sudo', 'env', 'xargs', 'timeout 5']);
  for (const def of TOOL_DEFS) {
    if (def.runner === true) units.add(def.id);
    for (const sub of def.runnerSubs ?? []) units.add(`${def.id} ${sub}`);
    if (def.moduleFlag !== undefined) units.add(`${def.id} ${def.moduleFlag}`);
    for (const sub of Object.keys(def.skipAfter ?? {})) {
      units.add(`${def.id} ${sub} a`);
    }
    if (def.shell !== undefined) units.add(`${def.id} ${def.shell.flags[0]}`);
  }
  const repeated = (unit: string): string =>
    `${unit} `.repeat(Math.ceil(MAX_COMMAND_CHARS / (unit.length + 1)) + 8);

  it('covers runners, runner subcommands, module flags and shells', () => {
    for (const unit of ['npx', 'uv run', 'pnpm exec', 'python -m', 'bash -c']) {
      expect([...units], unit).toContain(unit);
    }
    expect([...units].some((u) => u.startsWith('yarn workspace'))).toBe(true);
  });

  it('never throws on a command that repeats a hand-off up to the cap', () => {
    for (const unit of units) {
      for (const dialect of ['posix', 'powershell'] as const) {
        expect(
          () => classifyCommand(repeated(unit), dialect),
          `${unit} (${dialect})`,
        ).not.toThrow();
      }
    }
  });

  it('never throws on mixed hand-offs either', () => {
    const all = [...units];
    const random = mulberry32(0x7001);
    for (let round = 0; round < 40; round++) {
      let command = '';
      while (command.length < MAX_COMMAND_CHARS + 64) {
        command += `${all[Math.floor(random() * all.length)]} `;
      }
      expect(() => classifyCommand(command, 'posix'), command).not.toThrow();
    }
  });

  it('stays linear: a capped command of hand-offs costs milliseconds', () => {
    // before the hand-off limit these took 80 to 170 ms each (quadratic);
    // the bound leaves two orders of magnitude for a loaded machine
    for (const unit of ['pnpm exec', 'yarn workspace a', 'uv run', 'npx']) {
      const command = repeated(unit);
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 5; run++) {
        const start = performance.now();
        classifyCommand(command, 'posix');
        best = Math.min(best, performance.now() - start);
      }
      expect(best, unit).toBeLessThan(25);
    }
  });

  check([
    {
      // four hand-offs are followed
      command: 'npx npx npx npx vitest run',
      expect: { tool: 'vitest', sub: 'run', activity: 'test' },
    },
    {
      // the fifth is not: the runner that would hand off again names the call
      command: 'npx npx npx npx npx vitest run',
      expect: { tool: 'npx', noSub: true },
    },
    {
      command: 'uv run python -m pytest -k slow',
      expect: { tool: 'pytest', activity: 'test' },
    },
    {
      command: 'pnpm exec dotenv -e .env -- npx prisma migrate deploy',
      expect: { tool: 'prisma' },
    },
    {
      command: 'yarn workspace web workspace api build',
      expect: { tool: 'yarn', activity: 'build' },
    },
  ]);
});

describe('closed vocabulary, by construction', () => {
  const WORDS = [
    'git',
    'docker',
    'compose',
    'up',
    'pnpm',
    'npm',
    'npx',
    'run',
    'exec',
    'dlx',
    'test',
    'build',
    'bash',
    '-c',
    '-lc',
    'python',
    '-m',
    'pytest',
    'uv',
    'cargo',
    '+nightly',
    'vitest',
    'cd',
    'x',
    'sudo',
    'env',
    'FOO=1',
    '&&',
    '||',
    ';',
    '|',
    '"',
    "'",
    '$(',
    ')',
    '\n',
    '$BIN',
    './a.sh',
    '--filter',
    'web',
    '-C',
    '..',
    'acme-tool',
    'node',
    '-e',
    'make',
    'wsl',
    'cmd',
    '/c',
    '@scope/pkg@1',
    'tool',
    'workspace',
    'yarn',
    'rustup',
    'nightly',
    'gh',
    'pr',
    'view',
    'kubectl',
    '-n',
    'prod',
    'get',
  ];
  const TOKENS = new Set(['run', 'script', 'inline']);

  it('only ever emits registry ids, table subcommands, runner ids and activities', () => {
    const random = mulberry32(0xc1a55);
    for (let round = 0; round < 3000; round++) {
      const length = 1 + Math.floor(random() * 10);
      const parts: string[] = [];
      for (let k = 0; k < length; k++) {
        parts.push(WORDS[Math.floor(random() * WORDS.length)] as string);
      }
      const command = parts.join(' ');
      for (const dialect of ['posix', 'powershell'] as const) {
        const got = classifyCommand(command, dialect);
        expect(ACTIVITIES, command).toContain(got.activity);
        if (got.tool !== undefined)
          expect(TOOL_IDS, command).toContain(got.tool);
        if (got.via !== undefined)
          expect(RUNNER_IDS, command).toContain(got.via);
        for (const id of got.also) expect(TOOL_IDS, command).toContain(id);
        expect(got.also.length).toBeLessThanOrEqual(8);
        expect(new Set(got.also).size).toBe(got.also.length);
        if (got.tool !== undefined) expect(got.also).not.toContain(got.tool);
        if (got.sub !== undefined && !TOKENS.has(got.sub)) {
          const table = toolById(got.tool as string)?.subs ?? {};
          expect(Object.hasOwn(table, got.sub), `${command} → ${got.sub}`).toBe(
            true,
          );
        }
        expect(classifyCommand(command, dialect)).toEqual(got);
      }
    }
  });

  it('is a function of the text alone: no call changes the next one', () => {
    // the same command before and after a batch of unrelated ones, in both
    // dialects, so state kept between calls would show
    const command = 'cd apps/web && pnpm exec vitest run';
    const before = JSON.stringify(toolUsageAttributes(command, 'posix', true));
    for (const other of [
      'docker compose up -d',
      '$dir = "D:\\work"; Get-ChildItem $dir',
      "cat <<'EOF'\nbody\nEOF",
      'npx npx npx npx npx vitest',
    ]) {
      classifyCommand(other, 'posix');
      classifyCommand(other, 'powershell');
    }
    expect(JSON.stringify(toolUsageAttributes(command, 'posix', true))).toBe(
      before,
    );
    expect(JSON.parse(before)).toEqual({
      'runray.toolActivity': 'test',
      'runray.tool': 'vitest',
      'runray.toolSub': 'run',
      'runray.toolVia': 'pnpm exec',
    });
  });
});
