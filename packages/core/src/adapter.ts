import type { Run, SourceFormat, SourceTool, Span } from '@runray/schema';

/**
 * The Track A plugin contract (05-ARCHITECTURE §2.1): every log source is one
 * `SourceAdapter` implementation, and adding a source must require zero
 * changes in CLI/UI. Adapters resolve everything source-specific; the shared
 * normalizer (task 2.4) turns their `RawRun` into a schema-valid `Run`.
 */

/** One discoverable run, before parsing. Produced by a cheap scan — no file contents are read. */
export interface Candidate {
  /** Adapter-scoped stable reference to one run (session file path, db row ref, export file, …). */
  runRef: string;
  format: SourceFormat;
  /** Absolute paths `parse()` will read (session file + subagent transcripts, db file, …). */
  files: string[];
  /** Most recent modification time across `files`, ms since epoch. */
  mtimeMs: number;
  /** Total size across `files`, bytes. */
  sizeBytes: number;
}

export interface ParseOptions {
  /**
   * Redaction happens here in core, never as a UI-side filter (AGENTS.md):
   * with `redact: true` prompt-derived text must not leave the parser —
   * `content` fields are emitted as null while counts and structure stay.
   */
  redact: boolean;
}

export type RunWarning = NonNullable<Run['warnings']>[number];

/**
 * A span as the adapter emits it: source facts only. Derived fields are the
 * normalizer's job — `depth` is absent, ordering is not guaranteed, and
 * `parentId` may dangle (the normalizer applies the Flat Trace Fallback).
 */
export type RawSpan = Omit<Span, 'depth'>;

/** Adapter output — the intermediate format consumed by `normalize(RawRun): Run`. */
export interface RawRun {
  source: Run['source'];
  title?: string;
  project?: Run['project'];
  spans: RawSpan[];
  /** Non-fatal parse problems (malformed lines, unsupported legacy markers, …). */
  warnings: RunWarning[];
}

export interface SourceAdapter {
  id: Exclude<SourceTool, 'unknown'>;
  /**
   * Zero-config default root directories (add-profiler-depth A1). `detect()`
   * derives its default scan locations from this same method so discovery
   * and file-watching can never diverge; import-only sources (OTLP) return
   * an empty list and are ignored by zero-config watch.
   */
  defaultRoots(): string[];
  /**
   * Cheap scan of known default locations plus user-provided roots. Never
   * parses file contents; input paths are canonicalized by the caller and
   * symlinks outside the scan root are not followed (05-ARCHITECTURE §6).
   */
  detect(roots: string[]): Promise<Candidate[]>;
  /** Full parse of one run into the intermediate format. */
  parse(candidate: Candidate, opts: ParseOptions): Promise<RawRun>;
}
