import type { SourceAdapter } from '../adapter.js';
import { claudeCodeAdapter } from './claude-code.js';
import { opencodeAdapter } from './opencode.js';
import { otlpAdapter } from './otlp.js';

/**
 * Adapter registry (05-ARCHITECTURE §2.1): adding a source = one new adapter
 * file + a registration below — CLI and UI stay untouched. Registration order
 * is the discovery priority order (claude-code → opencode → otlp) and must
 * stay deterministic; consumers never sort it themselves.
 */
export interface AdapterRegistry {
  register(adapter: SourceAdapter): void;
  get(id: SourceAdapter['id']): SourceAdapter | undefined;
  /** Registered adapters in priority (registration) order. */
  all(): readonly SourceAdapter[];
}

export function createAdapterRegistry(): AdapterRegistry {
  const adapters: SourceAdapter[] = [];
  return {
    register(adapter) {
      if (adapters.some((a) => a.id === adapter.id)) {
        throw new Error(`adapter already registered: ${adapter.id}`);
      }
      adapters.push(adapter);
    },
    get(id) {
      return adapters.find((a) => a.id === id);
    },
    all() {
      return adapters;
    },
  };
}

/** The default registry the CLI consumes. */
export const adapters: AdapterRegistry = createAdapterRegistry();

// Concrete adapters register here as they land (priority order):
adapters.register(claudeCodeAdapter);
adapters.register(opencodeAdapter);
adapters.register(otlpAdapter);
