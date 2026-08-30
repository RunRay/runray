import { z } from 'zod';

/**
 * Zod source of truth for the TraceFile contract (frozen v0.1).
 * `schema/runray.schema.json` at the repo root is generated from this file
 * (see `json-schema.ts`); CI fails on drift. Any semantic change here is a
 * schema change and requires a version bump plus a human decision — see
 * AGENTS.md hard rules and `docs/02-DATA-MODEL.md`.
 *
 * Property order mirrors the published JSON Schema so the generated output
 * stays stable and reviewable.
 */

export const SCHEMA_VERSION = '0.1.0';

export const SourceToolSchema = z.enum([
  'claude-code',
  'opencode',
  'otlp',
  'unknown',
]);

export const SourceFormatSchema = z.enum([
  'claude-jsonl',
  'opencode-storage',
  'opencode-sqlite',
  'opencode-export',
  'otlp-json',
]);

export const SpanKindSchema = z.enum([
  'session',
  'turn',
  'llm_call',
  'tool_call',
  'subagent',
  'mcp_call',
  'hook',
  'other',
]);

export const SpanStatusSchema = z.enum([
  'ok',
  'error',
  'cancelled',
  'in_progress',
  'unknown',
]);

export const CostSourceSchema = z.enum(['reported', 'computed', 'unknown']);

export const InsightSeveritySchema = z.enum(['info', 'warning', 'critical']);

const isoDateTime = z.iso.datetime();

const TokenCountsSchema = z.object({
  input: z.number().int().min(0),
  output: z.number().int().min(0),
  cacheRead: z.number().int().min(0),
  cacheWrite: z.number().int().min(0),
  reasoning: z.number().int().min(0).optional(),
});

const LlmInfoSchema = z.object({
  provider: z.string(),
  model: z.string(),
  tokens: TokenCountsSchema,
  costUSD: z.number().min(0).optional(),
  costSource: CostSourceSchema,
  stopReason: z.string().optional(),
});

const ToolInfoSchema = z.object({
  name: z.string(),
  mcpServer: z.string().optional(),
  isError: z.boolean(),
  exitCode: z.number().int().optional(),
  outputBytes: z.number().int().min(0).optional(),
  linesAdded: z.number().int().min(0).optional(),
  linesRemoved: z.number().int().min(0).optional(),
});

const AgentInfoSchema = z.object({
  name: z.string().optional(),
  sessionId: z.string().optional(),
});

const ContentSchema = z.object({
  promptPreview: z.string().nullable().optional(),
  outputPreview: z.string().nullable().optional(),
  delegationReason: z.string().nullable().optional(),
});

const ProvenanceSchema = z.object({
  file: z.string(),
  line: z.number().int().min(1).optional(),
  recordId: z.string().optional(),
});

export const SpanSchema = z
  .object({
    id: z.string(),
    parentId: z.string().nullable(),
    kind: SpanKindSchema,
    name: z.string(),
    status: SpanStatusSchema,
    statusReason: z.string().optional(),
    startedAt: isoDateTime,
    endedAt: isoDateTime.optional(),
    durationMs: z.number().min(0).optional(),
    depth: z.number().int().min(0),
    llm: LlmInfoSchema.optional(),
    tool: ToolInfoSchema.optional(),
    agent: AgentInfoSchema.optional(),
    content: ContentSchema.optional(),
    attributes: z.record(z.string(), z.unknown()),
    provenance: ProvenanceSchema,
  })
  .meta({ id: 'Span' });

const RunTotalsTokensSchema = z.object({
  input: z.number().int(),
  output: z.number().int(),
  cacheRead: z.number().int(),
  cacheWrite: z.number().int(),
  reasoning: z.number().int().optional(),
  total: z.number().int(),
});

const RunTotalsCostSchema = z.object({
  total: z.number(),
  wastedEstimate: z.number(),
  byModel: z.record(z.string(), z.number()),
});

const RunTotalsCountsSchema = z.object({
  llmCalls: z.number().int(),
  toolCalls: z.number().int(),
  toolErrors: z.number().int(),
  subagents: z.number().int(),
  maxDepth: z.number().int(),
});

const RunTotalsCacheSchema = z.object({
  hitRate: z.number().min(0).max(1),
});

const RunTotalsCodeChangesSchema = z.object({
  linesAdded: z.number().int().min(0),
  linesRemoved: z.number().int().min(0),
});

export const RunTotalsSchema = z
  .object({
    tokens: RunTotalsTokensSchema,
    costUSD: RunTotalsCostSchema,
    counts: RunTotalsCountsSchema,
    cache: RunTotalsCacheSchema,
    codeChanges: RunTotalsCodeChangesSchema.optional(),
  })
  .meta({ id: 'RunTotals' });

export const InsightSchema = z
  .object({
    id: z.string(),
    ruleId: z
      .string()
      .describe(
        'Rule identifier. v0 registry: retry-loop, low-cache-hit, context-bloat, expensive-subagent, dead-end-run. New rules may be added in minor schema versions.',
      ),
    severity: InsightSeveritySchema,
    title: z.string(),
    detail: z.string(),
    spanIds: z.array(z.string()),
    estimatedWasteUSD: z.number().min(0).optional(),
    suggestion: z.string().optional(),
  })
  .meta({ id: 'Insight' });

const SourceSchema = z.object({
  tool: SourceToolSchema,
  format: SourceFormatSchema,
  files: z.array(z.string()),
});

const ProjectSchema = z.object({
  name: z.string().optional(),
  path: z.string().optional(),
  gitBranch: z.string().optional(),
});

const WarningSchema = z.object({
  message: z.string(),
  file: z.string().optional(),
  line: z.number().int().min(1).optional(),
});

export const RunSchema = z
  .object({
    id: z.string(),
    source: SourceSchema,
    title: z.string().optional(),
    project: ProjectSchema.optional(),
    startedAt: isoDateTime,
    endedAt: isoDateTime.optional(),
    durationMs: z.number().min(0).optional(),
    warnings: z.array(WarningSchema).optional(),
    spans: z.array(SpanSchema),
    totals: RunTotalsSchema,
    insights: z.array(InsightSchema),
  })
  .meta({ id: 'Run' });

export const TraceFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  generator: z.object({
    name: z.string(),
    version: z.string(),
  }),
  generatedAt: isoDateTime,
  runs: z.array(RunSchema),
});

export type SourceTool = z.infer<typeof SourceToolSchema>;
export type SourceFormat = z.infer<typeof SourceFormatSchema>;
export type SpanKind = z.infer<typeof SpanKindSchema>;
export type SpanStatus = z.infer<typeof SpanStatusSchema>;
export type CostSource = z.infer<typeof CostSourceSchema>;
export type InsightSeverity = z.infer<typeof InsightSeveritySchema>;
export type Span = z.infer<typeof SpanSchema>;
export type RunTotals = z.infer<typeof RunTotalsSchema>;
export type Insight = z.infer<typeof InsightSchema>;
export type Run = z.infer<typeof RunSchema>;
export type TraceFile = z.infer<typeof TraceFileSchema>;
