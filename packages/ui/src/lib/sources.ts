import {
  PLAYBOOK_SOURCE_LABEL,
  PLAYBOOK_SOURCES,
  type PlaybookSource,
} from '@runray/core/insights-meta';
import type { Run } from '@runray/schema';

/**
 * The coding agents whose own session files RunRay reads. Every other
 * source (an OTLP import, a source this build does not know) is a custom
 * agent: its hints are worded for whoever builds the agent, and its cost is
 * not "computed from the recorded transcript". The list is core's playbook
 * list without the OTLP entry, so a source core learns to read arrives here
 * with it, and the switches over `AgentSource` stop compiling until they
 * word it.
 */
export type AgentSource = Exclude<PlaybookSource, 'otlp'>;

const AGENT_SOURCES = PLAYBOOK_SOURCES.filter(
  (s): s is AgentSource => s !== 'otlp',
);

/** The source as a coding agent RunRay reads; `undefined` for a custom one. */
export function agentSource(source: string): AgentSource | undefined {
  return AGENT_SOURCES.find((s) => s === source);
}

/** Product names of the agents these runs came from, in a fixed order. */
export function agentNames(runs: readonly Run[]): string[] {
  const present = new Set<string>(runs.map((r) => r.source.tool));
  return AGENT_SOURCES.filter((s) => present.has(s)).map(
    (s) => PLAYBOOK_SOURCE_LABEL[s],
  );
}
