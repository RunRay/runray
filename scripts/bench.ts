/**
 * bench.ts — informational perf bench (task 2.7) against the budgets in
 * `docs/05-ARCHITECTURE.md §5`.
 *
 *   pnpm bench
 *
 * Runs on the machine-local `large` fixture; when it is absent (CI, fresh
 * checkout) a synthetic one is generated first (`scripts/synth-large.ts`,
 * Option B in the fixture README). Always exits 0 — CI treats the step as
 * informational (`continue-on-error`), failing builds only on 2× regressions
 * is a later, baseline-driven stage.
 *
 * Not measured here: waterfall scroll fps (browser-only) and `view` render
 * time — this bench covers the data half of the cold-start budget.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bench } from 'tinybench';
import {
  adapters,
  applyInsights,
  normalize,
  priceRun,
} from '../packages/core/src/index.js';
import { classifyCommand } from '../packages/core/src/tools/index.js';
import { ensureLargeFixture } from './synth-large.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const claudeCode = adapters.all().find((a) => a.id === 'claude-code');
if (claudeCode === undefined) throw new Error('claude-code adapter missing');

async function candidateIn(dir: string) {
  const candidates = (await claudeCode.detect([dir])).filter(
    (c) => !/[\\/]raw[\\/]/.test(c.runRef),
  );
  const candidate = candidates[0];
  if (candidate === undefined) throw new Error(`no fixture run in ${dir}`);
  return candidate;
}

type Candidate = Awaited<ReturnType<typeof candidateIn>>;

async function fullPipeline(candidate: Candidate) {
  return applyInsights(
    normalize(priceRun(await claudeCode.parse(candidate, { redact: false })), {
      baseDir: repoRoot,
    }),
  );
}

/** Peak RSS sampled while `fn` runs (MB). */
async function peakRssMb(fn: () => Promise<unknown>): Promise<number> {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 25);
  try {
    await fn();
  } finally {
    clearInterval(timer);
  }
  peak = Math.max(peak, process.memoryUsage().rss);
  return peak / (1024 * 1024);
}

const { path: largePath, synthesized } = ensureLargeFixture(32 * 1024 * 1024);
const largeMb = statSync(largePath).size / (1024 * 1024);
console.log(
  `large fixture: ${largePath} (${largeMb.toFixed(1)} MB${synthesized ? ', synthesized from tool-errors' : ', local'})`,
);

const largeCandidate = await candidateIn(dirname(largePath));
const subagentsCandidate = await candidateIn(
  join(repoRoot, 'fixtures', 'claude-code', 'subagents'),
);

const bench = new Bench({ iterations: 3, time: 0, warmup: true });
bench.add('parse large.jsonl (streaming)', async () => {
  await claudeCode.parse(largeCandidate, { redact: false });
});
bench.add('full pipeline large (parse→price→normalize→insights)', async () => {
  await fullPipeline(largeCandidate);
});
bench.add('full pipeline subagents (committed, ~1.4k spans)', async () => {
  await fullPipeline(subagentsCandidate);
});
// tool-usage classification (add-tool-usage-breakdown 1.5): one bounded pass
// per shell span, so it must stay negligible next to the parse itself
const TYPICAL_COMMANDS = [
  'cd apps/web && pnpm exec vitest run 2>&1 | tail -20',
  'git add -A && git commit -m "fix: retry; then && done" && git push',
  'docker compose -f dev.yml up -d && docker ps',
  'grep -rn "TODO" src | head -40',
  'npx tsc --noEmit -p packages/core',
  'until curl -sf localhost:3000/health; do sleep 2; done',
  "cat <<'EOF' > notes.md\nline one\nline two && docker run x\nEOF",
  'DATABASE_URL=postgres://x sudo timeout 30 psql -c "select 1"',
  'bash -lc "cd api && cargo test --workspace"',
  'Get-ChildItem -Recurse | Where-Object { $_.Length -gt 1 } | Select-Object -First 5',
];
const HUGE_COMMAND =
  'echo "$(git log | wc -l)" && pnpm build | tee log; '.repeat(20_000);
// the worst case inside the cap: every word hands the rest to the next
// resolution. Unwrapping must stay linear in the words; the 1 MB entry
// cannot show that, since only its first 8 kB of ordinary commands are read
const RUNNER_CHAIN = 'pnpm exec '.repeat(900);
bench.add('classify 10k shell commands', () => {
  for (let i = 0; i < 10_000; i++) {
    classifyCommand(
      TYPICAL_COMMANDS[i % TYPICAL_COMMANDS.length] as string,
      i % 10 === 9 ? 'powershell' : 'posix',
    );
  }
});
bench.add('classify one 1 MB command', () => {
  classifyCommand(HUGE_COMMAND, 'posix');
});
bench.add('classify an 8 kB runner chain', () => {
  classifyCommand(RUNNER_CHAIN, 'posix');
});
await bench.run();

const rssPeak = await peakRssMb(() => fullPipeline(largeCandidate));

const meanMs = (name: string): number => {
  const task = bench.tasks.find((t) => t.name === name);
  const mean = task?.result?.latency.mean;
  if (mean === undefined) throw new Error(`no result for bench '${name}'`);
  return mean;
};

const parseMs = meanMs('parse large.jsonl (streaming)');
const pipelineLargeMs = meanMs(
  'full pipeline large (parse→price→normalize→insights)',
);
const subagentsMs = meanMs('full pipeline subagents (committed, ~1.4k spans)');
const mbPerSec = largeMb / (parseMs / 1000);
// The classification entries are short CPU-bound loops measured three times:
// one collector pause in one iteration moves their mean by a third. The
// median says what the code costs.
const medianMs = (name: string): number => {
  const task = bench.tasks.find((t) => t.name === name);
  const median = task?.result?.latency.p50;
  if (median === undefined) throw new Error(`no result for bench '${name}'`);
  return median;
};
const classifyBatchMs = medianMs('classify 10k shell commands');
const classifyHugeMs = medianMs('classify one 1 MB command');
const classifyChainMs = medianMs('classify an 8 kB runner chain');

const templatePath = join(
  repoRoot,
  'packages',
  'ui',
  'dist-export',
  'index.html',
);
const templateKb = existsSync(templatePath)
  ? statSync(templatePath).size / 1024
  : undefined;

const rows: [string, string, string, boolean][] = [
  [
    'parse large JSONL',
    `${(parseMs / 1000).toFixed(2)} s (${mbPerSec.toFixed(1)} MB/s)`,
    '< 5 s / 100 MB (≥ 20 MB/s)',
    mbPerSec >= 20,
  ],
  [
    'full pipeline large',
    `${(pipelineLargeMs / 1000).toFixed(2)} s`,
    '(informational)',
    true,
  ],
  [
    'cold-start data, ~1.4k spans',
    `${(subagentsMs / 1000).toFixed(2)} s`,
    '< 2 s incl. render at 2k spans',
    subagentsMs < 2000,
  ],
  [
    'classify 10k shell commands',
    `${classifyBatchMs.toFixed(1)} ms`,
    '< 250 ms (25 µs per span)',
    classifyBatchMs < 250,
  ],
  [
    'classify one 1 MB command',
    `${classifyHugeMs.toFixed(2)} ms`,
    '< 5 ms (reads 8 kB)',
    classifyHugeMs < 5,
  ],
  [
    'classify an 8 kB runner chain',
    `${classifyChainMs.toFixed(2)} ms`,
    '< 5 ms (linear in the words)',
    classifyChainMs < 5,
  ],
  ['peak RSS on large', `${rssPeak.toFixed(0)} MB`, '< 500 MB', rssPeak < 500],
  [
    'export template size',
    templateKb === undefined
      ? 'n/a (ui not built)'
      : `${templateKb.toFixed(0)} kB`,
    '< 1536 kB + data',
    templateKb === undefined || templateKb < 1536,
  ],
];

console.log('\nbudgets (docs/05-ARCHITECTURE §5) — informational:');
for (const [op, value, budget, ok] of rows) {
  console.log(
    `  ${ok ? 'OK  ' : 'OVER'}  ${op.padEnd(30)} ${value.padEnd(24)} budget: ${budget}`,
  );
}
console.log(
  '  n/a   waterfall scroll 60 fps        (browser-only, not measured here)',
);
