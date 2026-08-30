import { watch } from 'chokidar';
import type { ChangeNotifier } from './server.js';

/**
 * Watch discovered data roots and push a debounced `changed` signal
 * (05-ARCHITECTURE §3: chokidar with polling fallback → SSE → UI refetch).
 */
export function watchRoots(
  roots: string[],
  notifier: ChangeNotifier,
  debounceMs = 500,
): { ready: Promise<void>; close(): Promise<void> } {
  const watcher = watch(roots, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });
  let timer: NodeJS.Timeout | undefined;
  watcher.on('all', () => {
    clearTimeout(timer);
    timer = setTimeout(() => notifier.emit(), debounceMs);
  });
  // `ignoreInitial` suppresses events during the initial scan, so a write
  // before the scan completes is silently dropped. Expose the 'ready' event
  // (fires once the scan is done) so callers can wait deterministically
  // instead of racing a fixed sleep.
  const ready = new Promise<void>((resolve) => {
    watcher.on('ready', () => resolve());
  });
  return {
    ready,
    close: async () => {
      clearTimeout(timer);
      await watcher.close();
    },
  };
}
