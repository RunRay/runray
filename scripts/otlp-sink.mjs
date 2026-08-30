// otlp-sink.mjs — capture Claude Code beta OTLP/JSON traces to a file (task 1.3).
//
// A dev-only fixture-collection aid, NOT part of the shipped product. It binds
// 127.0.0.1 only (same loopback posture as the product server) and speaks just
// enough OTLP/HTTP to persist spans — no OTel Collector needed.
//
// Claude Code run with OTEL_EXPORTER_OTLP_PROTOCOL=http/json POSTs
// {"resourceSpans":[…]} straight to /v1/traces; this server merges every export
// batch and rewrites one OTLP/JSON document to disk (rewritten after each batch,
// so you keep data even without a clean shutdown).
//
//   node scripts/otlp-sink.mjs [outFile] [port]     (or: pnpm otlp-sink -- [outFile] [port])
//   defaults: ./otlp-capture.json  on  127.0.0.1:4318
//
// Full capture recipe (env vars, the required beta flag, subagents/tool-errors
// variants) is in fixtures/otlp/README.md and docs/04-SAMPLE-LOGS.md §3.
// The raw capture holds your real email + prompts — scrub before committing:
//   pnpm scrub <outFile> -o fixtures/otlp/claude-traces-beta/<variant>.json --source otlp
import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';

const outFile = process.argv[2] ?? 'otlp-capture.json';
const port = Number(process.argv[3] ?? 4318);
const host = '127.0.0.1'; // loopback only; match the exporter endpoint's 127.0.0.1

const resourceSpans = [];
let batches = 0;

function spanCount() {
  let n = 0;
  for (const rs of resourceSpans)
    for (const ss of rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? [])
      n += (ss.spans ?? []).length;
  return n;
}

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      let buf = Buffer.concat(chunks);
      if ((req.headers['content-encoding'] ?? '').includes('gzip'))
        buf = gunzipSync(buf);
      const signal = (req.url ?? '').split('?')[0];
      if (signal.endsWith('/v1/traces')) {
        const body = JSON.parse(buf.toString('utf8'));
        const got = body.resourceSpans ?? [];
        for (const rs of got) resourceSpans.push(rs);
        batches++;
        writeFileSync(
          outFile,
          `${JSON.stringify({ resourceSpans }, null, 2)}\n`,
        );
        process.stdout.write(
          `  [traces] batch ${batches}: +${got.length} resourceSpans, ${spanCount()} spans total -> ${outFile}\n`,
        );
      } else {
        // metrics/logs land here too if their exporters are on — ignore.
        process.stdout.write(`  [ignored] ${signal}\n`);
      }
      // OTLP success response (empty body = full success) so the exporter
      // does not retry or log an error.
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    } catch (err) {
      process.stderr.write(`  ! failed to handle ${req.url}: ${err.message}\n`);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    }
  });
});

server.listen(port, host, () => {
  // The sink starts with an empty buffer, so the first batch OVERWRITES an
  // existing file — restarting on the same path drops the previous capture.
  // Use a distinct filename per variant (otlp-simple.json, otlp-subagents.json).
  if (existsSync(outFile))
    process.stdout.write(
      `WARNING: ${outFile} exists and will be overwritten on the first batch — use a distinct filename to keep separate captures.\n`,
    );
  process.stdout.write(
    `otlp-sink listening http://${host}:${port}  (POST /v1/traces)\n` +
      `writing OTLP/JSON -> ${outFile}\n` +
      `Run Claude Code now (see fixtures/otlp/README.md); Ctrl+C when done.\n`,
  );
});

process.on('SIGINT', () => {
  process.stdout.write(
    `\ncaptured ${spanCount()} spans in ${batches} batch(es) -> ${outFile}\n` +
      `next: pnpm scrub ${outFile} -o fixtures/otlp/claude-traces-beta/<variant>.json --source otlp\n`,
  );
  server.close(() => process.exit(0));
});
