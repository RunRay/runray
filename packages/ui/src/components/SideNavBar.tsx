import type { Route } from '../lib/router';
import { tourAttr } from '../lib/tour-attr';
import { useAppStore } from '../store';

/**
 * The navigation rail. Expanded it carries the wordmark, the two
 * destinations with their names and the local-only status; collapsed it
 * keeps every destination as an icon with its name for assistive tech and
 * a tooltip, so nothing becomes unreachable. The choice persists like the
 * theme (`ui.navCollapsed`), toggles from the chevron at the bottom, the
 * `[` key and the palette. Width changes without animation: the guardrail
 * allows only transform and opacity, and a sliding rail would reflow the
 * whole shell on every frame. `SideNavBar` wires the store; `NavRail` is
 * the presentational part, rendered from props so it can be tested in
 * either state.
 */
export function SideNavBar() {
  const route = useAppStore((s) => s.route);
  const collapsed = useAppStore((s) => s.ui.navCollapsed);
  const toggleNav = useAppStore((s) => s.toggleNav);
  return <NavRail route={route} collapsed={collapsed} onToggle={toggleNav} />;
}

export function NavRail({
  route,
  collapsed,
  onToggle,
}: {
  route: Route;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const isDashboard = route.view === 'dashboard';
  const isSessions =
    route.view === 'sessions' ||
    route.view === 'timeline' ||
    route.view === 'cost' ||
    route.view === 'time' ||
    route.view === 'errors' ||
    route.view === 'waste';

  return (
    <nav
      {...tourAttr('nav')}
      aria-label="Main navigation"
      data-collapsed={collapsed ? 'true' : undefined}
      className={`bg-surface border-r border-border flex flex-col py-4 z-10 h-screen fixed left-0 top-0 font-sans ${
        collapsed ? 'w-14' : 'w-60'
      }`}
    >
      <a
        href="#/dashboard"
        title={collapsed ? 'RunRay' : undefined}
        className={`flex items-center gap-2 mb-6 text-sm font-bold tracking-tight text-text hover:text-brand transition-colors duration-150 select-none ${
          collapsed ? 'justify-center px-0' : 'px-6'
        }`}
      >
        <div className="w-6 h-6 shrink-0 rounded-md bg-gradient-to-br from-brand to-brand-secondary flex items-center justify-center">
          <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 fill-white">
            <title>RunRay Logo</title>
            <path d="M8 1L2 5v6l6 4 6-4V5L8 1zm0 2.2L12 5.8v4.4L8 12.8 4 10.2V5.8L8 3.2z" />
          </svg>
        </div>
        {!collapsed && <span>RunRay</span>}
      </a>

      <div className="flex flex-col gap-0.5 px-2 flex-1">
        <NavLink
          href="#/dashboard"
          label="Dashboard"
          active={isDashboard}
          collapsed={collapsed}
          icon={
            <svg
              className="w-4 h-4 opacity-80"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <title>Dashboard</title>
              <rect x="3" y="3" width="7" height="7"></rect>
              <rect x="14" y="3" width="7" height="7"></rect>
              <rect x="14" y="14" width="7" height="7"></rect>
              <rect x="3" y="14" width="7" height="7"></rect>
            </svg>
          }
        />
        <NavLink
          href="#/sessions"
          label="Explorer"
          active={isSessions}
          collapsed={collapsed}
          icon={
            <svg
              className="w-4 h-4 opacity-80"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <title>Explorer</title>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <polyline points="3 3 3 8 8 8" />
              <line x1="12" y1="7" x2="12" y2="12" />
              <line x1="12" y1="12" x2="16" y2="12" />
            </svg>
          }
        />
      </div>

      <div className={`h-px bg-border my-4 ${collapsed ? 'mx-3' : 'mx-6'}`} />

      <div
        className={`flex mt-auto ${
          collapsed ? 'flex-col items-center gap-2 px-2' : 'flex-col gap-3 px-6'
        }`}
      >
        <div
          className={`flex items-center gap-2 ${collapsed ? 'flex-col' : 'justify-between'}`}
        >
          {collapsed ? (
            <span
              role="status"
              title="Local · Offline"
              aria-label="Local · Offline"
              className="flex h-8 w-8 items-center justify-center"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-cache-savings animate-pulse" />
            </span>
          ) : (
            <div className="flex items-center gap-1.5 font-mono text-[11px] text-text-faint px-2.5 py-1.5 rounded-control bg-surface-2 border border-border flex-1 select-none">
              <div className="w-1.5 h-1.5 rounded-full bg-cache-savings animate-pulse" />
              Local · Offline
            </div>
          )}
          <ThemeToggle />
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={
            collapsed ? 'Expand the navigation' : 'Collapse the navigation'
          }
          title={`${collapsed ? 'Expand' : 'Collapse'} the navigation ( [ )`}
          className={`flex h-8 items-center gap-2 rounded-control text-text-faint transition-colors duration-150 ease-out hover:bg-text/5 hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary active:bg-text/10 ${
            collapsed ? 'w-8 justify-center' : 'px-2.5 text-[11px] font-mono'
          }`}
        >
          <ChevronIcon pointing={collapsed ? 'right' : 'left'} />
          {!collapsed && 'Collapse'}
        </button>
      </div>
    </nav>
  );
}

function NavLink({
  href,
  label,
  active,
  collapsed,
  icon,
}: {
  href: string;
  label: string;
  active: boolean;
  collapsed: boolean;
  icon: React.ReactNode;
}) {
  return (
    <a
      href={href}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
      className={`flex items-center gap-3 py-2 rounded-control font-medium transition-colors duration-150 relative ${
        collapsed ? 'justify-center px-0' : 'px-3'
      } ${
        active
          ? 'text-text bg-brand/10'
          : 'text-text-faint hover:text-text hover:bg-text/5'
      }`}
    >
      {active && (
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 bg-brand rounded-r-sm" />
      )}
      {icon}
      {!collapsed && label}
    </a>
  );
}

function ChevronIcon({ pointing }: { pointing: 'left' | 'right' }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      className={`pointer-events-none ${pointing === 'right' ? 'rotate-180' : ''}`}
    >
      <title>Chevron</title>
      <path
        d="M10 3 5 8l5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
      className="w-8 h-8 shrink-0 rounded-control flex items-center justify-center text-text-faint hover:bg-text/5 hover:text-text transition-colors"
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
