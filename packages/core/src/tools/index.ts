/**
 * Tool usage (tool-usage capability): which program a tool call ran and
 * what kind of work it was. Browser-safe subpath `@runray/core/tools` — the
 * adapters classify commands with it at parse time, and the visualizer reads
 * labels and vocabularies from the same registry, never from a copy.
 */
export {
  type Classification,
  classifyCommand,
  TOOL_ATTR,
  toolUsageAttributes,
} from './classify.js';
export {
  ACTIVITIES,
  ACTIVITY_RANK,
  type Activity,
  activityRank,
  HARNESS_TOOLS,
  type HarnessTool,
  harnessActivity,
  lookupTool,
  RUNNER_IDS,
  scriptActivity,
  TOOL_IDS,
  type ToolDef,
  toolById,
  toolLabel,
} from './registry.js';
export {
  decompose,
  MAX_COMMAND_CHARS,
  type Pipeline,
  type ShellDialect,
  type Stage,
  type StageProgram,
  stageProgram,
} from './shell.js';
