import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as clack from '@clack/prompts';
import type { PricingTable, ThresholdOverrides } from '@runray/core';
import { SCHEMA_VERSION, type TraceFile } from '@runray/schema';
import { loadDemoTraceFile, resolveDemoDataDir } from './demo.js';
import {
  buildTraceFile,
  formatNoDataHints,
  type ScannedRoot,
} from './discover.js';
import { readState, writeState } from './onboarding-state.js';

export function getCliVersion(): string {
  const pkg = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../package.json', import.meta.url)),
      'utf8',
    ),
  ) as { version?: string };
  return pkg.version ?? '0.0.0';
}

export function writeFirstRunBanner(
  runsCount: number,
  locationCount: number,
  snapshotDate: string,
  statePath?: string,
): void {
  const state = readState(statePath);
  if (state.firstSeenAt) {
    return;
  }
  // A non-TTY run must not consume the banner: mark the machine as seen only
  // once the banner has actually been shown, or the first interactive run
  // (the one the banner exists for) would print nothing.
  if (!process.stderr.isTTY) {
    return;
  }
  writeState({ firstSeenAt: new Date().toISOString() }, statePath);

  const version = getCliVersion();
  let output = `RunRay ${version}. Local agent profiler, first run. Nothing leaves this machine.\n`;
  if (runsCount > 0) {
    output += `Read ${runsCount} session(s) from ${locationCount} location(s). Pricing: bundled snapshot ${snapshotDate}.\n`;
  }
  process.stderr.write(output);
}

export function shouldRunWizard(
  runsCount: number,
  explicitPath?: string,
  serveEmpty?: boolean,
): boolean {
  return (
    runsCount === 0 &&
    process.stdin.isTTY === true &&
    process.stderr.isTTY === true &&
    explicitPath === undefined &&
    serveEmpty !== true
  );
}

export const SETUP_GUIDES_TEXT = `Claude Code
  Nothing to configure. Any session writes JSONL under ~/.claude/projects.
  Run:  claude "explain this repo"     then:  runray view

OpenCode
  Nothing to configure. Sessions land in ~/.local/share/opencode — both the
  legacy file storage and the newer SQLite store are read.
  Installed somewhere non-standard? runray view <that folder>

Other agents (Cursor, custom pipelines)
  No on-disk session logs to read. Export OTLP/JSON with an OTel Collector
  file exporter, then:  runray view <that file>

All three are read locally. RunRay makes no network calls.
`;

export function formatCustomPathFailure(pathStr: string): string {
  return `Nothing readable in ${pathStr}.\n\nExpected one of: Claude Code JSONL, an OpenCode store, or OTLP/JSON.\nTry the parent folder, or a single session file directly.\n`;
}

// A Windows path carries backslashes — JSON's escape character — and often
// spaces. Interpolating one raw produced a snippet that either failed to parse
// (`\G` is not a legal escape) or parsed to a corrupted path (`\t` became a
// tab), so following our own instructions broke every later command. The two
// lines need different quoting: the config is serialised, so backslashes are
// escaped; the command line is merely quoted, where they must not be.
/**
 * Quote a path for the copy-paste command line.
 *
 * Two shapes survive the wizard's `.trim()` and break naive quoting: a
 * trailing separator, where `"C:\My Logs\"` makes the shell read `\"` as an
 * escaped quote and swallow the rest of the line; and a metacharacter with no
 * space (`&`, `^`, `(`, `;`…), which an unquoted argument lets cmd.exe split
 * and execute. So: drop trailing separators, and quote on anything outside a
 * conservative safe set rather than on spaces alone.
 */
function quoteForShell(pathStr: string): string {
  const trimmed = pathStr.replace(/[\\/]+$/, '') || pathStr;
  return /^[\w.:\\/-]+$/.test(trimmed) ? trimmed : `"${trimmed}"`;
}

export function formatConfigSnippet(pathStr: string): string {
  const config = JSON.stringify({ dataRoots: [pathStr] });
  return `To run this again:  runray view ${quoteForShell(pathStr)}\n\nTo make this the default, add to runray.config.json:\n\n  ${config}\n`;
}

export const WIZARD_EXIT_TEXT = `No configuration was written.\n`;

export const DEMO_BRIDGE_TEXT = `This is a scrubbed sample session, not your data.\nWhen you've run an agent on this machine:  runray view\n`;

export interface ClackPrompts {
  intro(title?: string): void;
  select(opts: unknown): Promise<unknown>;
  text(opts: unknown): Promise<unknown>;
  isCancel(val: unknown): boolean;
  cancel(msg?: string): void;
}

export interface RunWizardOptions {
  rootsScanned: ScannedRoot[];
  source?: string;
  sinceMs?: number;
  redact: boolean;
  thresholds?: ThresholdOverrides;
  pricing?: PricingTable;
  generatorVersion: string;
  statePath?: string;
}

export type WizardResult =
  | {
      action: 'serve';
      traceFile: TraceFile;
      rootsScanned?: ScannedRoot[];
      configSnippetPath?: string;
      isDemo?: boolean;
    }
  | { action: 'exit'; exitCode: 3 };

export async function runWizard(
  options: RunWizardOptions,
  prompts: ClackPrompts = clack,
): Promise<WizardResult> {
  prompts.intro('RunRay — no agent sessions found in the standard locations.');

  while (true) {
    const selection = await prompts.select({
      message: 'What would you like to do?',
      initialValue: 'sample',
      options: [
        {
          value: 'sample',
          label: 'Open the sample session',
          hint: 'recommended — nothing to install',
        },
        {
          value: 'guides',
          label: 'Show setup guides',
          hint: 'Claude Code · OpenCode · OTLP',
        },
        {
          value: 'path',
          label: 'Point at a folder',
          hint: 'logs live somewhere else',
        },
        {
          value: 'empty',
          label: 'Open the dashboard anyway',
          hint: 'empty, but it explains itself',
        },
        {
          value: 'exit',
          label: 'Exit',
          hint: 'show me where you looked',
        },
      ],
    });

    if (prompts.isCancel(selection) || selection === 'exit') {
      if (prompts.isCancel(selection)) {
        prompts.cancel();
      }
      process.stderr.write(
        formatNoDataHints(options.rootsScanned, { source: options.source }),
      );
      process.stderr.write(WIZARD_EXIT_TEXT);
      return { action: 'exit', exitCode: 3 };
    }

    if (selection === 'sample') {
      const demoDir = resolveDemoDataDir();
      if (demoDir === undefined) {
        process.stderr.write('Demo data not found.\n');
        process.stderr.write(
          formatNoDataHints(options.rootsScanned, { source: options.source }),
        );
        process.stderr.write(WIZARD_EXIT_TEXT);
        return { action: 'exit', exitCode: 3 };
      }
      const demoTrace = loadDemoTraceFile(demoDir, options.generatorVersion);
      return { action: 'serve', traceFile: demoTrace, isDemo: true };
    }

    if (selection === 'guides') {
      process.stderr.write(SETUP_GUIDES_TEXT);
      continue;
    }

    if (selection === 'path') {
      let attempts = 0;
      let pathSuccess = false;
      let foundTraceFile: TraceFile | null = null;
      let usedPath = '';

      while (attempts < 3) {
        attempts++;
        const pathInput = await prompts.text({
          message: 'Folder or session file',
          placeholder: '~/projects/my-app/.agent-logs',
          validate: (val: string | undefined) =>
            val === undefined || val.trim().length === 0
              ? 'Enter a path, or press Escape to go back.'
              : undefined,
        });

        if (prompts.isCancel(pathInput)) {
          break;
        }

        const trimmed = (pathInput as string).trim();
        const res = await buildTraceFile({
          paths: [trimmed],
          source: options.source,
          sinceMs: options.sinceMs,
          redact: options.redact,
          thresholds: options.thresholds,
          pricing: options.pricing,
          generatorVersion: options.generatorVersion,
        });

        if (res.traceFile.runs.length > 0) {
          pathSuccess = true;
          foundTraceFile = res.traceFile;
          usedPath = trimmed;
          process.stderr.write(formatConfigSnippet(trimmed));
          break;
        } else {
          process.stderr.write(formatCustomPathFailure(trimmed));
        }
      }

      if (pathSuccess && foundTraceFile) {
        return {
          action: 'serve',
          traceFile: foundTraceFile,
          configSnippetPath: usedPath,
        };
      }

      if (attempts >= 3) {
        process.stderr.write(
          formatNoDataHints(options.rootsScanned, { source: options.source }),
        );
        process.stderr.write(WIZARD_EXIT_TEXT);
        return { action: 'exit', exitCode: 3 };
      }

      // User cancelled path prompt -> return to menu
      continue;
    }

    if (selection === 'empty') {
      const emptyTraceFile: TraceFile = {
        schemaVersion: SCHEMA_VERSION,
        generator: {
          name: 'runray',
          version: options.generatorVersion,
        },
        generatedAt: new Date().toISOString(),
        runs: [],
      };
      return {
        action: 'serve',
        traceFile: emptyTraceFile,
        rootsScanned: options.rootsScanned,
      };
    }
  }
}

export function writeDemoBridge(statePath?: string): void {
  const state = readState(statePath);
  if (state.demoSeenAt) {
    return;
  }
  writeState({ demoSeenAt: new Date().toISOString() }, statePath);
  process.stderr.write(DEMO_BRIDGE_TEXT);
}

export interface HintDef {
  key: string;
  isEligible: (traceFile: TraceFile) => boolean;
  text: string;
}

export const NEXT_STEP_HINTS: HintDef[] = [
  {
    key: 'shortcuts',
    isEligible: () => true,
    text: 'In the dashboard: ? for shortcuts, ⌘K (Ctrl-K) for the command palette.',
  },
  {
    key: 'diff',
    isEligible: (tf) => tf.runs.length >= 2,
    text: 'Same task twice? Compare them:  runray diff <runA> <runB>',
  },
  {
    key: 'watch',
    isEligible: (tf) => {
      const tenMinAgo = Date.now() - 10 * 60 * 1000;
      return tf.runs.some((r) => {
        const time = Date.parse(r.startedAt);
        return !Number.isNaN(time) && time >= tenMinAgo;
      });
    },
    text: 'Session still running? Live-tail it:  runray view --watch',
  },
  {
    key: 'export',
    isEligible: (tf) =>
      tf.runs.some((r) => Array.isArray(r.insights) && r.insights.length > 0),
    text: 'Share a finding without sharing prompts:\n  runray export -o report.html --redact',
  },
];

export function writeNextStepHints(
  traceFile: TraceFile,
  statePath?: string,
): void {
  if (!process.stderr.isTTY) {
    return;
  }
  const state = readState(statePath);
  const shown = new Set(state.hintsShown ?? []);
  // Hints belong to the FIRST successful view only (cli spec, "Hints not
  // repeated"): once anything has been shown, the channel is closed for good.
  if (shown.size > 0) {
    return;
  }
  const eligible = NEXT_STEP_HINTS.filter((h) => h.isEligible(traceFile));
  if (eligible.length === 0) {
    return;
  }
  const toShow = eligible.slice(0, 2);
  const hintKeys = toShow.map((h) => h.key);
  for (const h of toShow) {
    process.stderr.write(`${h.text}\n`);
  }
  writeState({ hintsShown: [...shown, ...hintKeys] }, statePath);
}

export function countLocations(traceFile: TraceFile): number {
  const dirs = new Set<string>();
  for (const run of traceFile.runs) {
    for (const f of run.source.files) {
      dirs.add(dirname(f));
    }
  }
  return dirs.size;
}
