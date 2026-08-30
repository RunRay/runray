---
name: RunRay
colors:
  surface: '#13131b'
  surface-dim: '#13131b'
  surface-bright: '#393841'
  surface-container-lowest: '#0d0d15'
  surface-container-low: '#1b1b23'
  surface-container: '#1f1f27'
  surface-container-high: '#292932'
  surface-container-highest: '#34343d'
  on-surface: '#e4e1ed'
  on-surface-variant: '#c7c4d7'
  inverse-surface: '#e4e1ed'
  inverse-on-surface: '#303038'
  outline: '#908fa0'
  outline-variant: '#464554'
  surface-tint: '#c0c1ff'
  primary: '#c0c1ff'
  on-primary: '#1000a9'
  primary-container: '#8083ff'
  on-primary-container: '#0d0096'
  inverse-primary: '#494bd6'
  secondary: '#bec6e0'
  on-secondary: '#283044'
  secondary-container: '#3f465c'
  on-secondary-container: '#adb4ce'
  tertiary: '#bcc7de'
  on-tertiary: '#263143'
  tertiary-container: '#8691a7'
  on-tertiary-container: '#1f2a3c'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#e1e0ff'
  primary-fixed-dim: '#c0c1ff'
  on-primary-fixed: '#07006c'
  on-primary-fixed-variant: '#2f2ebe'
  secondary-fixed: '#dae2fd'
  secondary-fixed-dim: '#bec6e0'
  on-secondary-fixed: '#131b2e'
  on-secondary-fixed-variant: '#3f465c'
  tertiary-fixed: '#d8e3fb'
  tertiary-fixed-dim: '#bcc7de'
  on-tertiary-fixed: '#111c2d'
  on-tertiary-fixed-variant: '#3c475a'
  background: '#13131b'
  on-background: '#e4e1ed'
  surface-variant: '#34343d'
  success-emerald: '#10b981'
  error-rose: '#f43f5e'
  warning-amber: '#f59e0b'
  data-indigo: '#818cf8'
  border-slate: '#334155'
  bg-deep-gray: '#020617'
typography:
  headline-lg:
    fontFamily: Geist
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Geist
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-base:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Geist
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  data-mono:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  data-mono-bold:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '600'
    lineHeight: 18px
  label-caps:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '700'
    lineHeight: 12px
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  gutter: 16px
  margin-page: 24px
  panel-padding: 12px
  trace-row-height: 32px
---

## Brand & Style

The design system embodies the "Sophisticated IDE" aesthetic: a high-performance, developer-centric environment where information density is prioritized over marketing aesthetics. It is a technical tool for engineers who value precision, speed, and deep-dive observability.

The design style is **Minimalist / Corporate Modern** with a heavy focus on **functional density**. It borrows the rigorous structural integrity of tools like JetBrains, Grafana, and Vercel.

**Key Brand Pillars:**
- **Analytical Precision:** Layouts are driven by data, using thin borders and rigid grids to organize complex hierarchical information.
- **Observability Excellence:** High-contrast status indicators (Success, Error, Warning) cut through a monochromatic base to direct attention instantly.
- **Invisible UI:** The interface recedes to let the agent logs and waterfall traces take center stage.
- **Technical Authority:** Extensive use of monospaced typography for all data points, signaling a "local-first" and "code-first" philosophy.

## Colors

The system is **dark-themed by default** to reduce eye strain during long debugging sessions and to mimic the environment of a modern IDE.

- **Primary (Electric Indigo):** Used sparingly for brand presence, primary actions, and highlighting active trace paths.
- **Surface & Background:** A tiered scale of deep slates and grays. The background is nearly black (`#020617`), with surfaces stepping up in lightness to create functional containment.
- **Functional Accents:**
    - **Emerald:** Indicates successful spans and agent completion.
    - **Rose:** Critical for flagging failed tools, broken loops, and LLM errors.
    - **Amber:** Used for warnings, such as high token usage or "blocked on user" states.
- **Borders:** A consistent, low-contrast slate (`#334155`) is used to define the grid without adding visual noise.

## Typography

Typography is split between **Geist** for UI navigation and structural labels, and **JetBrains Mono** for all technical data, tokens, costs, and trace IDs.

- **UI Sans (Geist):** Provides a modern, clean feel for headers and descriptive text. Its high legibility ensures the interface remains approachable.
- **Data Mono (JetBrains Mono):** The workhorse font. Used for everything inside the waterfall view, code snippets, and metric counters. It reinforces the tool’s identity as an engineering instrument.
- **Scaling:** Sizes are intentionally kept small (12px - 14px) to support high information density. Headers rarely exceed 24px to maintain the "dashboard" feel.

## Layout & Spacing

The layout follows a **Fixed-Fluid Hybrid** model typical of professional monitoring tools.

- **Sidebar/Navigation:** Fixed width (240px) for session history and high-level filters.
- **Main Viewport:** Fluid area containing the dashboard or waterfall.
- **Information Density:** A strict 4px baseline grid. Spacing is tight to ensure that complex delegation chains can be viewed with minimal scrolling.
- **Waterfall Grid:** The trace view uses a custom 12-column grid within its container, but individual spans occupy dynamic widths based on `durationMs`.
- **Breakpoints:**
    - **Desktop (1280px+):** Full multi-pane view with visible attributes panel.
    - **Tablet (768px - 1279px):** Collapsible attributes panel; focus on the timeline.
    - **Mobile:** Not prioritized for this MVP; simple list-view fallback for session summaries only.

## Elevation & Depth

This design system avoids heavy shadows and skeuomorphism, favoring **Tonal Layering** and **Subtle Outlines**.

- **Surface Levels:**
    - **Base:** `#020617` (Deepest)
    - **Cards/Panels:** `#0f172a` (1px border: `#334155`)
    - **Popovers/Modals:** `#1e293b` (Subtle 4px ambient shadow, indigo-tinted)
- **Hierarchy via Borders:** Depth is communicated primarily through 1px solid borders. Hover states on trace rows should use a slight background tint (`#1e293b`) rather than an elevation change.
- **Active State:** The active span in a waterfall view is indicated by a 2px vertical "indigo-light" bar on its left edge and a subtle glow effect on its duration bar.

## Shapes

The shape language is "Soft-Technical." Elements use a small border-radius (4px) to feel modern without losing the precision of a grid-based tool.

- **Standard Elements:** 4px (rounded-md) for buttons, input fields, and cards.
- **Trace Bars:** 2px roundedness to ensure that even very short durations (thin bars) remain visible and distinct.
- **Status Pills:** Fully rounded (pill) only for status indicators (Success/Error) to distinguish them from interactive buttons.

## Components

### Buttons & Inputs
- **Primary:** Solid Electric Indigo with white text.
- **Secondary/Ghost:** Slate borders with transparent backgrounds. Hover state shifts background to `#1e293b`.
- **Inputs:** Dark slate background, 1px border, monospace text for values.

### Trace Waterfall Rows
- **Structure:** 32px height. Left side contains the tree-nesting lines (1px width) and type icon. Center contains the span name. Right side contains the duration bar.
- **Icons:** Use geometric, glyph-like icons for `agent`, `llm`, and `tool`.

### Metric Chips
- Used in the session overview. Label in `label-caps`, value in `data-mono-bold`. 
- **Cost Chip:** Always highlights `totalCostUsd` in Indigo if normal, or Rose if exceeding a (future) budget.

### Cards
- Used for "Session Overview" statistics. No shadows. 1px `#334155` border. Background `#0f172a`.

### Status Indicators
- **Error Spans:** The entire row in the waterfall gets a very faint rose background tint (`#f43f5e10`) and a rose-colored error message icon.
- **Success:** Simple emerald dot next to the span name.

### Code/JSON Block
- Background `#000000`. Syntax highlighting should use a high-contrast palette (Vivid Indigo, Lime, Amber) against the black background.