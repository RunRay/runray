import type { Span } from '@runray/schema';

/**
 * Span-kind → background utility (03-design.md §2 span palette). Containers
 * (session/turn/other) read as structure, not work — dimmed neutral.
 */
export const KIND_BG: Record<Span['kind'], string> = {
  llm_call: 'bg-span-llm',
  tool_call: 'bg-span-tool',
  subagent: 'bg-span-subagent',
  mcp_call: 'bg-span-mcp',
  hook: 'bg-span-hook',
  session: 'bg-span-hook/40',
  turn: 'bg-span-hook/40',
  other: 'bg-span-hook/40',
};
