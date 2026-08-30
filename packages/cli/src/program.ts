import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  bundledPricing,
  diffRuns,
  readTranscriptSlice,
  type TranscriptSlice,
} from '@runray/core';
import type { Run, TraceFile } from '@runray/schema';
import { Command } from 'commander';
import { loadConfig } from './config.js';
import { loadDemoTraceFile, resolveDemoDataDir } from './demo.js';
import { formatDiffSummary } from './diff.js';
import {
  abbreviateHome,
  buildTraceFile,
  type DiscoveryResult,
  formatNoDataHints,
  parseSince,
  reportDiscoveryErrors,
  reportUnpricedCoverage,
  resolveWatchRoots,
  type ScannedRoot,
} from './discover.js';
import {
  exportConsent,
  injectGlobal,
  injectTraceData,
  selectRun,
} from './export.js';
import { formatRunTable, summarizeRuns } from './list.js';
import {
  countLocations,
  runWizard,
  shouldRunWizard,
  writeDemoBridge,
  writeFirstRunBanner,
  writeNextStepHints,
} from './onboarding.js';
import { openBrowser } from './open.js';
import { effectivePricing, refreshPricing } from './pricing.js';
import { createNotifier, DEFAULT_PORT, startServer } from './server.js';
import { resolveExportTemplate, resolveUiDistDir } from './ui-dist.js';
import { watchRoots } from './watch.js';

function cliVersion(): string {
  const pkg = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../package.json', import.meta.url)),
      'utf8',
    ),
  ) as { version?: string };
  return pkg.version ?? '0.0.0';
}

/** id→provenance lookup for /api/transcript: ids in, never paths (D4). */
export async function resolveTranscript(
  traceFile: TraceFile,
  runId: string,
  spanId: string,
  redact: boolean,
): Promise<TranscriptSlice> {
  const run = traceFile.runs.find((r) => r.id === runId);
  const span = run?.spans.find((s) => s.id === spanId);
  if (run === undefined || span === undefined) {
    return { status: 'unavailable', reason: 'unknown run or span id' };
  }
  return readTranscriptSlice(span.provenance, run.source.tool, { redact });
}

/**
 * CLI surface (05-ARCHITECTURE §3, cli spec). Exit codes: 0 success,
 * 1 execution error, 3 no data found.
 */
export function createProgram(): Command {
  const program = new Command();
  program
    .name('runray')
    .description('Zero-config, local-first observability for coding agents')
    .version(cliVersion())
    .option('--config <file>', 'path to runray.config.json')
    .option('--verbose', 'verbose logging');

  program
    // bare `runray` = `runray view` (D7); typo'd subcommands now land in
    // view's [path] argument and exit 3 with hints instead of "unknown
    // command" — flagged in the proposal, judged acceptable
    .command('view', { isDefault: true })
    .description(
      'discover sessions and open the local dashboard (127.0.0.1 only)',
    )
    .argument('[path]', 'directory to scan instead of the default locations')
    .option('--source <tool>', 'only one source: claude | opencode | otlp')
    .option(
      '--since <duration>',
      'only sessions modified within e.g. 7d, 24h, 30m',
    )
    .option('--port <n>', 'base port (default 4173, increments when taken)')
    .option(
      '--watch',
      'live-tail: refresh the UI when session files change (zero-config watches each adapter’s default roots; otlp is import-only and not watched)',
    )
    .option(
      '--redact',
      'strip prompt/output text in core; keep structure and counts',
    )
    .option('--serve-empty', 'start the server even when no sessions are found')
    .option('--no-open', 'do not open the browser')
    .action(async (path: string | undefined, opts: Record<string, unknown>) => {
      const globals = program.opts<{ config?: string; verbose?: boolean }>();
      const config = loadConfig(globals.config);
      const roots = path !== undefined ? [path] : (config.dataRoots ?? []);
      const redact = Boolean(opts.redact ?? config.redact ?? false);

      // capture-once (C2): one effective table per trace build — spans,
      // insight dollars, and /api/pricing always agree within a snapshot.
      // Re-capture happens exactly when the watch cache invalidates (the
      // same rebuild path add-persistent-index later hooks).
      let pricing = effectivePricing();
      const build = async (): Promise<DiscoveryResult> => {
        pricing = effectivePricing();
        const result = await buildTraceFile({
          paths: roots,
          ...(opts.source === undefined
            ? {}
            : { source: opts.source as string }),
          ...(opts.since === undefined
            ? {}
            : { sinceMs: parseSince(opts.since as string) }),
          redact,
          thresholds: config.insights?.thresholds ?? {},
          pricing: pricing.table,
          generatorVersion: cliVersion(),
        });
        reportDiscoveryErrors(result.errors, result.traceFile.runs.length);
        reportUnpricedCoverage(result.traceFile);
        if (globals.verbose === true) {
          console.error(
            `scanned ${result.candidatesScanned} candidate(s), ${result.traceFile.runs.length} run(s)`,
          );
        }
        return result;
      };

      const firstResult = await build();
      let first = firstResult.traceFile;
      let servedRootsScanned: ScannedRoot[] | undefined =
        firstResult.rootsScanned;
      let isDemo = false;

      writeFirstRunBanner(
        first.runs.length,
        countLocations(first),
        pricing.table.snapshotDate,
      );

      if (first.runs.length === 0) {
        if (opts.serveEmpty === true) {
          // Explicit opt-in --serve-empty
        } else if (
          shouldRunWizard(first.runs.length, path, Boolean(opts.serveEmpty))
        ) {
          const wizardRes = await runWizard({
            rootsScanned: firstResult.rootsScanned,
            source: opts.source as string | undefined,
            sinceMs:
              opts.since === undefined
                ? undefined
                : parseSince(opts.since as string),
            redact,
            thresholds: config.insights?.thresholds ?? {},
            pricing: pricing.table,
            generatorVersion: cliVersion(),
          });
          if (wizardRes.action === 'exit') {
            process.exitCode = wizardRes.exitCode;
            return;
          }
          first = wizardRes.traceFile;
          if (wizardRes.rootsScanned) {
            servedRootsScanned = wizardRes.rootsScanned;
          }
          if (wizardRes.isDemo) {
            isDemo = true;
          }
        } else {
          process.stderr.write(
            formatNoDataHints(firstResult.rootsScanned, {
              source: opts.source as string | undefined,
            }),
          );
          process.exitCode = 3;
          return;
        }
      }

      let cache: TraceFile | null = first;
      const events = opts.watch === true ? createNotifier() : undefined;
      if (events !== undefined) {
        // zero-config watches the adapters' default roots (A1) — the old
        // `roots.length > 0` guard left `--watch` silently inert without an
        // explicit path or configured dataRoots
        const watchTargets = resolveWatchRoots(
          roots,
          opts.source as string | undefined,
        );
        if (watchTargets.length > 0) {
          const inner = createNotifier();
          watchRoots(watchTargets, inner);
          inner.subscribe(() => {
            cache = null; // next /api/tracefile rebuilds
            events.emit();
          });
        }
      }

      const basePort = Number(opts.port ?? config.port ?? DEFAULT_PORT);
      const uiDistDir = resolveUiDistDir();
      if (uiDistDir === undefined && globals.verbose === true) {
        console.error('ui dist not found; serving the placeholder page');
      }
      const server = await startServer({
        getTraceFile: async () => {
          cache ??= (await build()).traceFile;
          return cache;
        },
        basePort,
        ...(events === undefined ? {} : { events }),
        ...(uiDistDir === undefined ? {} : { uiDistDir }),
        // serves the capture-once table of the CURRENT build (C2)
        getPricing: () => ({
          origin: pricing.origin,
          ...(pricing.path === undefined ? {} : { path: pricing.path }),
          table: pricing.table,
        }),
        // id-only lookup against the served snapshot (D4) — clients can
        // never supply file paths; redaction refuses inside core's reader
        getTranscript: async (runId, spanId) => {
          cache ??= (await build()).traceFile;
          return resolveTranscript(cache, runId, spanId, redact);
        },
        // `rootsScanned` is live-only and `~`-abbreviated (§4.7): the export
        // payload below never carries it, for the same reason it never
        // carries the pricing `path`
        getViewConfig: () => ({
          ...(config.limitWindow === undefined
            ? {}
            : { limitWindow: config.limitWindow }),
          ...(servedRootsScanned === undefined
            ? {}
            : {
                rootsScanned: servedRootsScanned.map((r) => ({
                  path: abbreviateHome(r.path),
                  verdict: r.verdict,
                })),
              }),
          ...(isDemo ? { isSample: true } : {}),
        }),
      });

      if (isDemo) {
        console.log(
          `RunRay demo: ${first.runs.length} scrubbed sample run(s) at ${server.url}`,
        );
        writeDemoBridge();
      } else {
        console.log(
          `RunRay viewing ${first.runs.length} run(s) at ${server.url}`,
        );
        if (first.runs.length > 0) {
          writeNextStepHints(first);
        }
      }

      if (opts.open !== false) openBrowser(server.url);
    });

  program
    .command('list')
    .description('list discovered runs (scripting: --json)')
    .argument('[path]', 'directory to scan instead of the default locations')
    .option('--json', 'machine-readable summary on stdout')
    .option(
      '--since <duration>',
      'only sessions modified within e.g. 7d, 24h, 30m',
    )
    .option('--source <tool>', 'only one source: claude | opencode | otlp')
    .action(async (path: string | undefined, opts: Record<string, unknown>) => {
      const globals = program.opts<{ config?: string }>();
      const config = loadConfig(globals.config);
      const roots = path !== undefined ? [path] : (config.dataRoots ?? []);
      const pricing = effectivePricing();
      const result = await buildTraceFile({
        paths: roots,
        ...(opts.source === undefined ? {} : { source: opts.source as string }),
        ...(opts.since === undefined
          ? {}
          : { sinceMs: parseSince(opts.since as string) }),
        redact: true,
        thresholds: config.insights?.thresholds ?? {},
        pricing: pricing.table,
        generatorVersion: cliVersion(),
      });

      if (opts.json !== true) {
        writeFirstRunBanner(
          result.traceFile.runs.length,
          countLocations(result.traceFile),
          pricing.table.snapshotDate,
        );
      }

      reportDiscoveryErrors(result.errors, result.traceFile.runs.length);
      reportUnpricedCoverage(result.traceFile);
      const summaries = summarizeRuns(result.traceFile);
      if (summaries.length === 0) {
        if (opts.json === true) console.log('[]');
        else
          process.stderr.write(
            formatNoDataHints(result.rootsScanned, {
              source: opts.source as string | undefined,
            }),
          );
        process.exitCode = 3;
        return;
      }
      console.log(
        opts.json === true
          ? JSON.stringify(summaries, null, 2)
          : formatRunTable(summaries),
      );
    });

  program
    .command('diff')
    .description(
      'compare two runs: cost, tokens, errors, alignment (scripting: --json)',
    )
    .argument('<runA>', 'baseline run id (unique prefix ok)')
    .argument('<runB>', 'comparison run id (unique prefix ok)')
    .argument('[path]', 'directory to scan instead of the default locations')
    .option('--json', 'machine-readable RunDiff on stdout (the CI-gate input)')
    .option('--source <tool>', 'only one source: claude | opencode | otlp')
    .option(
      '--since <duration>',
      'only sessions modified within e.g. 7d, 24h, 30m',
    )
    .action(
      async (
        runA: string,
        runB: string,
        path: string | undefined,
        opts: Record<string, unknown>,
      ) => {
        const globals = program.opts<{ config?: string }>();
        const config = loadConfig(globals.config);
        const roots = path !== undefined ? [path] : (config.dataRoots ?? []);
        const result = await buildTraceFile({
          paths: roots,
          ...(opts.source === undefined
            ? {}
            : { source: opts.source as string }),
          ...(opts.since === undefined
            ? {}
            : { sinceMs: parseSince(opts.since as string) }),
          redact: true,
          thresholds: config.insights?.thresholds ?? {},
          pricing: effectivePricing().table,
          generatorVersion: cliVersion(),
        });
        reportDiscoveryErrors(result.errors, result.traceFile.runs.length);
        if (result.traceFile.runs.length === 0) {
          process.stderr.write(
            formatNoDataHints(result.rootsScanned, {
              source: opts.source as string | undefined,
            }),
          );
          process.exitCode = 3;
          return;
        }
        const resolved: Run[] = [];
        for (const ref of [runA, runB]) {
          const match = selectRun(result.traceFile, ref);
          const run = match?.runs[0];
          if (run === undefined) {
            process.stderr.write(
              `No single run matches '${ref}' (try \`runray list\`).\n`,
            );
            process.exitCode = 3;
            return;
          }
          resolved.push(run);
        }
        // C7 honesty: unpriced calls in either run make the cost delta a
        // coverage artifact — warn on stderr (stdout/--json stays clean),
        // like every other cost-reporting command
        reportUnpricedCoverage({ ...result.traceFile, runs: resolved });
        const diff = diffRuns(resolved[0] as Run, resolved[1] as Run);
        if (opts.json === true) {
          console.log(JSON.stringify(diff, null, 2));
          return;
        }
        console.log(formatDiffSummary(diff));
      },
    );

  program
    .command('export')
    .description('bundle runs into a single offline HTML file (ADR-5)')
    .argument(
      '[target]',
      'run id to export, or a directory to scan (default: all discovered runs)',
    )
    .requiredOption(
      '-o, --output <file>',
      'output html path (e.g. report.html)',
    )
    .option('--redact', 'strip prompt/output text; keep structure and counts')
    .option('--yes', 'bypass the unredacted-export confirmation prompt')
    .option(
      '--json <file>',
      'also write the normalized TraceFile JSON to this path',
    )
    .option('--source <tool>', 'only one source: claude | opencode | otlp')
    .option(
      '--since <duration>',
      'only sessions modified within e.g. 7d, 24h, 30m',
    )
    .action(
      async (target: string | undefined, opts: Record<string, unknown>) => {
        const globals = program.opts<{ config?: string }>();
        const config = loadConfig(globals.config);
        const redact = Boolean(opts.redact ?? config.redact ?? false);
        const yes = Boolean(opts.yes ?? false);

        const consent = exportConsent({
          redact,
          yes,
          interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
        });

        if (consent === 'abort') {
          process.stderr.write(
            'Refusing unredacted export in non-interactive mode. Pass --redact or --yes to proceed.\n',
          );
          process.exitCode = 1;
          return;
        }

        if (consent === 'ask') {
          const rl = createInterface({
            input: process.stdin,
            output: process.stderr,
          });
          try {
            const answer = await rl.question(
              'Export contains prompt and tool input text. Include prompt text? [y/N] ',
            );
            if (!/^y(es)?$/i.test(answer.trim())) {
              process.stderr.write('Export cancelled.\n');
              process.exitCode = 1;
              return;
            }
          } finally {
            rl.close();
          }
        }

        const template = resolveExportTemplate();
        if (template === undefined) {
          process.stderr.write(
            'Export template not found. In a monorepo checkout run `pnpm --filter @runray/ui build`; in an installed package this is a broken install.\n',
          );
          process.exitCode = 1;
          return;
        }

        // A target that exists on disk is a scan root; anything else is a run id.
        const isPath = target !== undefined && existsSync(target);
        const roots = isPath ? [target] : (config.dataRoots ?? []);
        const pricing = effectivePricing(); // capture-once, priced AND embedded
        const discovery = await buildTraceFile({
          paths: roots,
          ...(opts.source === undefined
            ? {}
            : { source: opts.source as string }),
          ...(opts.since === undefined
            ? {}
            : { sinceMs: parseSince(opts.since as string) }),
          redact,
          thresholds: config.insights?.thresholds ?? {},
          pricing: pricing.table,
          generatorVersion: cliVersion(),
        });
        reportDiscoveryErrors(
          discovery.errors,
          discovery.traceFile.runs.length,
        );
        reportUnpricedCoverage(discovery.traceFile);

        let selected = discovery.traceFile;
        if (target !== undefined && !isPath) {
          const byRun = selectRun(discovery.traceFile, target);
          if (byRun === undefined) {
            process.stderr.write(
              `No single run matches '${target}' (try \`runray list\`).\n`,
            );
            process.exitCode = 3;
            return;
          }
          selected = byRun;
        }
        if (selected.runs.length === 0) {
          process.stderr.write(
            formatNoDataHints(discovery.rootsScanned, {
              source: opts.source as string | undefined,
            }),
          );
          process.exitCode = 3;
          return;
        }

        // pricing and view config ride beside the data (same sanitization);
        // `path` is a local filesystem path and never enters a shareable file
        const html = injectGlobal(
          injectGlobal(
            injectTraceData(readFileSync(template, 'utf8'), selected),
            '__RUNRAY_PRICING__',
            { origin: pricing.origin, table: pricing.table },
          ),
          '__RUNRAY_VIEW_CONFIG__',
          config.limitWindow === undefined
            ? {}
            : { limitWindow: config.limitWindow },
        );
        writeFileSync(opts.output as string, html);
        if (opts.json !== undefined) {
          writeFileSync(
            opts.json as string,
            `${JSON.stringify(selected, null, 2)}\n`,
          );
        }
        const kb = Math.round(Buffer.byteLength(html) / 1024);
        console.log(
          `wrote ${opts.output} (${selected.runs.length} run(s), ${kb} kB${redact ? ', redacted' : ''})${opts.json === undefined ? '' : ` and ${opts.json}`}`,
        );
      },
    );

  program
    .command('demo')
    .description('open the local dashboard with a scrubbed sample session (D8)')
    .option('--port <n>', 'base port (default 4173, increments when taken)')
    .option('--no-open', 'do not open the browser')
    .action(async (opts: Record<string, unknown>) => {
      const demoDir = resolveDemoDataDir();
      if (demoDir === undefined) {
        process.stderr.write(
          'demo data directory not found; this build is missing packaged demo fixtures\n',
        );
        process.exitCode = 1;
        return;
      }
      const traceFile = loadDemoTraceFile(demoDir, cliVersion());
      writeFirstRunBanner(
        traceFile.runs.length,
        countLocations(traceFile),
        bundledPricing().snapshotDate,
      );
      const basePort =
        opts.port !== undefined
          ? Number.parseInt(opts.port as string, 10)
          : DEFAULT_PORT;
      const server = await startServer({
        getTraceFile: async () => traceFile,
        basePort,
        uiDistDir: resolveUiDistDir(),
        // demo is a deterministic showcase — always the bundled table
        getPricing: () => ({ origin: 'bundled', table: bundledPricing() }),
        getViewConfig: () => ({ isSample: true }),
        // demo provenance points at scrubbed fixtures: resolves in a repo
        // checkout, degrades to a structured status elsewhere
        getTranscript: (runId, spanId) =>
          resolveTranscript(traceFile, runId, spanId, false),
      });
      console.log(
        `RunRay demo: ${traceFile.runs.length} scrubbed sample run(s) at ${server.url}`,
      );
      writeDemoBridge();
      if (opts.open !== false) openBrowser(server.url);
    });

  program
    .command('pricing')
    .description(
      'show the effective pricing snapshot, or refresh it (network!)',
    )
    .option('--show', 'print snapshot metadata (default)')
    .option(
      '--refresh',
      'fetch current prices from LiteLLM — the ONLY network operation in runray',
    )
    .action(async (opts: Record<string, unknown>) => {
      if (opts.refresh === true) {
        console.log('fetching current prices (explicit opt-in network call)…');
        const result = await refreshPricing();
        console.log(
          `wrote ${result.path} (${result.entries} models, snapshot ${result.snapshotDate})`,
        );
        return;
      }
      const effective = effectivePricing();
      console.log(
        [
          `origin:   ${effective.origin}${effective.path === undefined ? '' : ` (${effective.path})`}`,
          `source:   ${effective.table.source}`,
          `snapshot: ${effective.table.snapshotDate}`,
          `models:   ${effective.table.entries.length}`,
        ].join('\n'),
      );
    });

  return program;
}
