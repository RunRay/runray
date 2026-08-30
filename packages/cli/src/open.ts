import { spawn } from 'node:child_process';

/** Best-effort browser launch; failures are silent (the URL is printed anyway). */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args as string[], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // no browser available — the printed URL is enough
  }
}
