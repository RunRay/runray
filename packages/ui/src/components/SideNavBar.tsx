import { tourAttr } from '../lib/tour-attr';
import { useAppStore } from '../store';

export function SideNavBar() {
  const route = useAppStore((s) => s.route);
  const isDashboard = route.view === 'dashboard';
  const isSessions =
    route.view === 'sessions' ||
    route.view === 'timeline' ||
    route.view === 'cost';

  return (
    <nav
      {...tourAttr('nav')}
      className="bg-surface border-r border-border flex flex-col py-4 z-10 w-60 h-screen fixed left-0 top-0 font-sans"
    >
      <a
        href="#/dashboard"
        className="flex items-center gap-2 px-6 mb-6 text-sm font-bold tracking-tight text-text hover:text-brand transition-colors duration-150 select-none"
      >
        <div className="w-6 h-6 rounded-md bg-gradient-to-br from-brand to-brand-secondary flex items-center justify-center">
          <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 fill-white">
            <title>RunRay Logo</title>
            <path d="M8 1L2 5v6l6 4 6-4V5L8 1zm0 2.2L12 5.8v4.4L8 12.8 4 10.2V5.8L8 3.2z" />
          </svg>
        </div>
        <span>RunRay</span>
      </a>

      <div className="flex flex-col gap-0.5 px-2 flex-1">
        <a
          href="#/dashboard"
          className={`flex items-center gap-3 px-3 py-2 rounded-control font-medium transition-all duration-150 relative ${
            isDashboard
              ? 'text-text bg-brand/10'
              : 'text-text-faint hover:text-text hover:bg-text/5'
          }`}
        >
          {isDashboard && (
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 bg-brand rounded-r-sm" />
          )}
          <svg
            className="w-4 h-4 opacity-80"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
          >
            <title>Dashboard</title>
            <rect x="3" y="3" width="7" height="7"></rect>
            <rect x="14" y="3" width="7" height="7"></rect>
            <rect x="14" y="14" width="7" height="7"></rect>
            <rect x="3" y="14" width="7" height="7"></rect>
          </svg>
          Dashboard
        </a>
        <a
          href="#/sessions"
          className={`flex items-center gap-3 px-3 py-2 rounded-control font-medium transition-all duration-150 relative ${
            isSessions
              ? 'text-text bg-brand/10'
              : 'text-text-faint hover:text-text hover:bg-text/5'
          }`}
        >
          {isSessions && (
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 bg-brand rounded-r-sm" />
          )}
          <svg
            className="w-4 h-4 opacity-80"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
          >
            <title>Explorer</title>
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <polyline points="3 3 3 8 8 8" />
            <line x1="12" y1="7" x2="12" y2="12" />
            <line x1="12" y1="12" x2="16" y2="12" />
          </svg>
          Explorer
        </a>
      </div>

      <div className="h-px bg-border mx-6 my-4" />

      <div className="px-6 flex flex-col gap-3 mt-auto">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 font-mono text-[11px] text-text-faint px-2.5 py-1.5 rounded-control bg-surface-2 border border-border flex-1 select-none">
            <div className="w-1.5 h-1.5 rounded-full bg-cache-savings animate-pulse" />
            Local · Offline
          </div>
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}

function ThemeToggle() {
  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const isPaper = theme === 'paper';
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-pressed={isPaper}
      aria-label="Paper theme"
      title={`Switch to ${isPaper ? 'ink' : 'paper'} theme`}
      className="w-8 h-8 rounded-control flex items-center justify-center text-text-faint hover:bg-text/5 hover:text-text transition-colors"
    >
      {isPaper ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      aria-hidden
      className="pointer-events-none"
    >
      <title>Sun</title>
      <circle
        cx="8"
        cy="8"
        r="3.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <line x1="8" y1="1.4" x2="8" y2="2.9" />
        <line x1="8" y1="13.1" x2="8" y2="14.6" />
        <line x1="1.4" y1="8" x2="2.9" y2="8" />
        <line x1="13.1" y1="8" x2="14.6" y2="8" />
        <line x1="3.4" y1="3.4" x2="4.5" y2="4.5" />
        <line x1="11.5" y1="11.5" x2="12.6" y2="12.6" />
        <line x1="3.4" y1="12.6" x2="4.5" y2="11.5" />
        <line x1="11.5" y1="4.5" x2="12.6" y2="3.4" />
      </g>
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      aria-hidden
      className="pointer-events-none"
    >
      <title>Moon</title>
      <path
        fill="currentColor"
        d="M9.4 2.2A5.2 5.2 0 1 0 13.8 8.4 4.2 4.2 0 0 1 9.4 2.2Z"
      />
    </svg>
  );
}
