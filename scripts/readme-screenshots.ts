/**
 * readme-screenshots.ts — retakes the README screenshots from `runray demo`.
 *
 *   pnpm build                  # the CLI dist and the UI dist it serves
 *   pnpm docs:screenshots [--out <dir>]
 *
 * Writes dashboard.png, waste.png, errors.png and timeline.png at 1920x1080
 * into docs/images/ (or --out). The three run views show the demo's invoices
 * table run.
 *
 * The demo server runs with a throwaway config dir (APPDATA and
 * XDG_CONFIG_HOME both point into a temp dir). Its onboarding state has the
 * welcome, tours and first-run checklist already closed, so none of them lands
 * in frame, and your own onboarding state is left untouched. Each shot uses a
 * fresh headless Chrome profile.
 *
 * Chrome is found through CHROME_PATH or the usual install locations. The
 * header shows the capture time ("as of HH:MM"), so a retake is never
 * byte-identical.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliBin = join(repoRoot, 'packages', 'cli', 'dist', 'bin.js');
const uiIndex = join(repoRoot, 'packages', 'ui', 'dist', 'index.html');
/** The run behind the Waste, Errors and Timeline shots. */
const showcaseRun = join(
  repoRoot,
  'demo',
  'runs',
  'claude-code',
  'invoices-table-redesign.json',
);

const outFlag = process.argv.indexOf('--out');
const outDir =
  outFlag === -1
    ? join(repoRoot, 'docs', 'images')
    : resolve(process.argv[outFlag + 1] ?? '');

function findChrome(): string {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const found = candidates.find((c) => c !== undefined && existsSync(c));
  if (found === undefined) {
    throw new Error('Chrome not found; set CHROME_PATH');
  }
  return found;
}

for (const [file, hint] of [
  [cliBin, 'run `pnpm build` first'],
  [uiIndex, 'run `pnpm build` first'],
  [showcaseRun, 'run `pnpm demo:build` first'],
] as const) {
  if (!existsSync(file)) throw new Error(`missing ${file}: ${hint}`);
}

const chrome = findChrome();
const runId = (JSON.parse(readFileSync(showcaseRun, 'utf8')) as { id: string })
  .id;
const temp = mkdtempSync(join(tmpdir(), 'runray-shots-'));
const configDir = join(temp, 'config');
mkdirSync(join(configDir, 'runray'), { recursive: true });
writeFileSync(
  join(configDir, 'runray', 'state.json'),
  JSON.stringify({
    demoSeenAt: '2026-01-01T00:00:00.000Z',
    onboarding: {
      welcomeDismissedAt: '2026-01-01T00:00:00.000Z',
      tours: { dashboard: 'skipped', run: 'skipped' },
      checklist: { dismissed: true },
    },
  }),
);
mkdirSync(outDir, { recursive: true });

const server = spawn(
  process.execPath,
  [cliBin, 'demo', '--no-open', '--port', '4390'],
  {
    env: { ...process.env, APPDATA: configDir, XDG_CONFIG_HOME: configDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

// drain stderr for the whole run: an unread pipe can fill up and stall the
// server, and its text is the only clue when the server fails to start
let serverStderr = '';
server.stderr.on('data', (chunk) => {
  serverStderr += String(chunk);
});

const STARTUP_TIMEOUT_MS = 30_000;

try {
  const url = await new Promise<string>((resolveUrl, reject) => {
    const fail = (reason: string) =>
      reject(new Error(`demo server ${reason}\n${serverStderr.trim()}`));
    const timer = setTimeout(
      () => fail(`did not print its URL within ${STARTUP_TIMEOUT_MS / 1000}s`),
      STARTUP_TIMEOUT_MS,
    );
    server.stdout.on('data', (chunk) => {
      const match = /(http:\/\/127\.0\.0\.1:\d+)/.exec(String(chunk));
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolveUrl(match[1]);
      }
    });
    server.on('error', (err) => {
      clearTimeout(timer);
      fail(`failed to spawn: ${err.message}`);
    });
    server.on('exit', (code) => {
      clearTimeout(timer);
      fail(`exited early (code ${code})`);
    });
  });

  const shots: Record<string, string> = {
    dashboard: `${url}/`,
    waste: `${url}/#/run/${runId}/waste`,
    errors: `${url}/#/run/${runId}/errors`,
    timeline: `${url}/#/run/${runId}/timeline`,
  };
  for (const [name, target] of Object.entries(shots)) {
    const out = join(outDir, `${name}.png`);
    execFileSync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--window-size=1920,1080',
        // lets the UI fetch the trace file and render before the capture
        '--virtual-time-budget=20000',
        `--user-data-dir=${join(temp, `chrome-${name}`)}`,
        `--screenshot=${out}`,
        target,
      ],
      { stdio: 'ignore' },
    );
    console.log(`wrote ${out}`);
  }
} finally {
  server.kill();
  rmSync(temp, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
