/**
 * stories.ts — the storylines behind `runray demo`.
 *
 * Each story re-skins one scrubbed golden (see skin.ts). The numbers,
 * timings and span trees are real; the text is written to match what the
 * session actually does: which tools it calls, in what order, where it
 * fails. When a golden changes shape (new prompt, new subagent), the build
 * fails loudly and the story needs a matching line.
 *
 * Deliberately absent from the demo:
 * - claude-code/duplicate-records: a 4-call parser edge case, not a showcase,
 * - otlp/claude-traces-beta-1: a 12-second probe with no real work in it,
 * - opencode/storage + sqlite-1: the same session as export-json, captured
 *   three ways to prove cross-era parity.
 */
import type { DemoStory } from './skin.js';

const HOME = '/home/dev';

function under(root: string, paths: string[]): string[] {
  return paths.map((p) => `${root}/${p}`);
}

// ---------------------------------------------------------------------------
// 1. Claude Code, Windows, two days — invoices table redesign with a live
//    preview. Heavy on Edit + preview tools; most of the errors are preview
//    screenshots timing out and Edit strings that no longer match.
// ---------------------------------------------------------------------------

const BILLING = 'C:/code/billing-dashboard';
const INVOICES = 'src/features/invoices/components';

const invoicesTable: DemoStory = {
  golden: 'claude-code/tool-errors',
  out: 'claude-code/invoices-table-redesign',
  title: 'Redesign the invoices table: sticky header, filters, CSV export',
  project: {
    name: 'billing-dashboard',
    path: 'C:\\code\\billing-dashboard',
    gitBranch: 'feat/invoices-table',
  },
  source: {
    from: 'fixtures/claude-code/tool-errors/',
    to: 'C:/Users/dev/.claude/projects/C--code-billing-dashboard/',
    rename: {
      'tool-errors.jsonl': '72d7b780-6856-4e7b-9e5d-58b7c5aa71ad.jsonl',
    },
  },
  prompts: [
    'continue',
    'go ahead',
    'next',
    'the dev server hangs on start, can you check?',
    'ok, next step from the plan please',
    'The amount filter should accept ranges like 100-500, and remember the sort order per user.',
    "Two issues: in dark mode the sticky header is transparent and rows scroll behind it, and the status badge colors don't match the design tokens. Fix both with tokens, no hex values.",
    'Run the whole test suite and fix whatever broke. Stop any preview servers you left running when you are done.',
    'Add an empty state for when the filters match nothing, with a reset button.',
    'why did you rewrite the file?',
    'Show the number of active filters on the Filters button, and make Reset clear the URL params too. Check it in the preview.',
    'The badge overlaps the filter icon on mobile.\nMove it after the label.',
    'now pagination',
    'The page jumps back to 1 when I change the sort. Keep the cursor unless the filters change.',
    "Good morning. Let's add bulk actions for the selected rows: mark as paid and send a reminder. API first, then the UI.",
    'what happens if one invoice in the batch fails?',
    'Build the bulk actions bar: it appears when rows are selected and shows the count. Confirm before sending reminders.',
    'Add tests for the bulk endpoint: happy path, one failing invoice, more than 200 ids, and an empty id list.',
    'Run the full suite and the type check, then give me a short summary of what changed today.',
    'The reminder email should include the invoice number and the due date. Check the template test too.',
    'Customers with more than 50 overdue invoices time out on the reminder action. Send the emails in chunks of 20 and show progress in the bulk bar.',
    'Before we merge: write a short QA checklist for the table in docs/qa, update the CHANGELOG, and double-check that the CSV export respects the current filters and sort order.',
    'The dev server on 5173 is still running from yesterday and blocks the preview.\n- find the process\n- stop it\n- restart the preview on the default port',
    "It's still there. Probably a vite process from another terminal:\n- list node processes with their command line\n- stop only the one serving 5173\n- don't touch my other terminals",
    'The preview still does not start. Check .claude/launch.json: the port there may not match vite.config.ts. Make both use 5173, start the preview and check that the table loads.',
    'The CSV export button is disabled while the filters load but never enables again if the request fails. Fix it and show an error toast.',
    'Test the failure path: make the export endpoint return 500 (the dev server has a debugFail flag for that), check the toast, and make sure the button is enabled again.',
    'Last feature for this branch: saved views. Users save the current filters and sort as a named view and switch between them. Plan it first.',
    'The saved views picker overlaps the filters on narrow screens. Move it into the filter popover below 640px.',
  ],
  delegations: [
    'Map the invoices table components',
    'Find existing filter and popover patterns',
  ],
  // ordered by the segment that first touches each file (see the comments)
  files: {
    tsx: under(BILLING, [
      // S0 plan + first pass: sticky header, column layout
      `${INVOICES}/InvoicesTable.tsx`,
      `${INVOICES}/InvoicesTableHeader.tsx`,
      `${INVOICES}/InvoiceRow.tsx`,
      `${INVOICES}/SortableHeader.tsx`,
      `${INVOICES}/StatusBadge.tsx`,
      'src/pages/InvoicesPage.tsx',
      `${INVOICES}/AmountCell.tsx`,
      `${INVOICES}/DueDateCell.tsx`,
      `${INVOICES}/CustomerCell.tsx`,
      `${INVOICES}/TableSkeleton.tsx`,
      `${INVOICES}/StickyTableHead.tsx`,
      `${INVOICES}/InvoicesColumns.tsx`,
      // S1 preview check
      'src/app/Providers.tsx',
      // S2 column filters
      `${INVOICES}/ColumnFilter.tsx`,
      `${INVOICES}/FilterPopover.tsx`,
      `${INVOICES}/StatusFilter.tsx`,
      `${INVOICES}/DateRangeFilter.tsx`,
      // S3 CSV export
      `${INVOICES}/ExportCsvButton.tsx`,
      `${INVOICES}/InvoicesToolbar.tsx`,
      'src/components/ui/Button.tsx',
      // S4 hanging dev server (circular import)
      'src/app/App.tsx',
      // S5 server-side filtering
      `${INVOICES}/CustomerFilter.tsx`,
      'src/components/ui/Select.tsx',
      `${INVOICES}/AmountRangeFilter.tsx`,
      `${INVOICES}/ActiveFilterChips.tsx`,
      `${INVOICES}/FiltersButton.tsx`,
      `${INVOICES}/FilterSummary.tsx`,
      `${INVOICES}/FilterResetButton.tsx`,
      `${INVOICES}/InvoicesTable.test.tsx`,
      'src/features/invoices/InvoicesProvider.tsx',
      'src/components/ui/Badge.tsx',
      'src/components/ui/Popover.tsx',
      // S8 test suite fixes
      `${INVOICES}/ColumnFilter.test.tsx`,
      // S11 empty state
      `${INVOICES}/EmptyState.tsx`,
      // S13 active filter count
      'src/components/ui/CountBadge.tsx',
      // S14 badge position
      `${INVOICES}/FilterIcon.tsx`,
      // S15 pagination
      `${INVOICES}/Pagination.tsx`,
      // S16 sort cursor
      `${INVOICES}/PageSizeSelect.tsx`,
      'src/features/invoices/InvoicesTableContainer.tsx',
      // S17 bulk actions
      'src/components/ui/Checkbox.tsx',
      `${INVOICES}/RowSelectCheckbox.tsx`,
      `${INVOICES}/BulkActionsBar.tsx`,
      // S20 bulk tests
      `${INVOICES}/BulkActionsBar.test.tsx`,
      'src/test/renderWithProviders.tsx',
      // S27 launch config
      'src/main.tsx',
      // S28 export error state
      'src/components/ui/Toast.tsx',
      // S29 export failure path
      `${INVOICES}/ExportCsvButton.test.tsx`,
      // S30 saved views
      'src/components/ui/Menu.tsx',
      `${INVOICES}/SavedViewsPicker.tsx`,
      `${INVOICES}/SaveViewDialog.tsx`,
    ]),
    css: under(BILLING, [
      'src/styles/tokens.css',
      'src/features/invoices/invoices.module.css',
    ]),
    md: under(BILLING, [
      'docs/plans/invoices-table.md', // S0
      'docs/qa/invoices-table.md', // S1
      'CHANGELOG.md', // S1
      'docs/api/invoices.md', // S5
    ]),
    ts: under(BILLING, [
      'src/features/invoices/columns.ts', // S0
      'src/features/invoices/api.ts', // S5
      'src/features/invoices/filters.ts',
      'server/queries/filterInvoices.ts',
      'src/lib/format.ts', // S8
      'server/routes/invoices.ts', // S17
      'server/routes/invoices.bulk.ts',
      'src/features/invoices/useBulkActions.ts', // S19
      'src/features/invoices/bulk.ts',
      'src/features/invoices/types.ts',
      'server/routes/invoices.bulk.test.ts', // S20
      'server/test/fixtures/invoices.ts',
      'server/services/reminders.ts', // S22
      'server/emails/reminderEmail.ts',
      'src/features/invoices/savedViews.ts', // S30
    ]),
    json: under(BILLING, ['.claude/launch.json']),
    sql: under(BILLING, [
      'server/db/migrations/0031_invoices_status_issued_at_idx.sql', // S5
      'server/db/migrations/0032_bulk_action_log.sql', // S17
      'server/db/migrations/0033_invoices_reminder_sent_at.sql', // S19
      'server/db/seed/invoices_bulk_test.sql', // S20
      'server/db/migrations/0034_reminder_batches.sql', // S23
      'server/db/migrations/0035_saved_views.sql', // S30
    ]),
  },
  commands: [
    'pnpm',
    'git',
    'cd',
    'npx',
    'node',
    'rg',
    'curl',
    'ls',
    'cat',
    'tail',
    'head',
    'grep',
    'echo',
    'taskkill',
    'sleep',
    'wc',
    'mkdir',
    'psql',
    'find',
    'diff',
  ],
  errors: {
    '<synthetic>': [
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      'API Error: Request timed out. Check your connection and retry.',
      'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}} · the request can be retried',
    ],
    mcp__Claude_Preview__preview_start: [
      'Failed to start "web": port 5173 is already in use (EADDRINUSE). Another process is listening on it. Stop that process or set a different port in .claude/launch.json.',
      'Failed to start "web": no response on http://localhost:5174 within 30s. launch.json expects port 5174, but vite.config.ts sets server.port to 5173.',
    ],
    Edit: [
      '<tool_use_error>String to replace not found in file.\nString: <th className={styles.headerCell}></tool_use_error>',
      '<tool_use_error>Found 4 matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one, add more context.\nString: color: #0f5132;</tool_use_error>',
      '<tool_use_error>Found 4 matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one, add more context.\nString: color: #842029;</tool_use_error>',
      '<tool_use_error>File has been modified since read, either by the user or by a linter. Read it again before writing to it.</tool_use_error>',
      "<tool_use_error>String to replace not found in file.\nString:   it('rejects more than 200 ids', async () => {</tool_use_error>",
      '<tool_use_error>String to replace not found in file.\nString: disabled={isLoading}</tool_use_error>',
    ],
    mcp__Claude_Preview__preview_screenshot: [
      'Screenshot timed out after 30000ms: the page has not finished loading. The dev server may still be compiling; wait and retry, or check preview_logs.',
    ],
    mcp__Claude_Preview__preview_resize: [
      'No preview server is running. Call preview_start first.',
    ],
    mcp__Claude_Preview__preview_console_logs: [
      'No preview server is running. Call preview_start first.',
    ],
    mcp__Claude_Preview__preview_eval: [
      'ReferenceError: invoiceStore is not defined at <anonymous>:1:1',
      "TypeError: Cannot read properties of null (reading 'click')",
    ],
    Bash: [
      "Exit code 1\n FAIL  src/emails/ReminderEmail.test.tsx > includes the invoice number\nAssertionError: expected 'Invoice  is due on 2026-07-01' to contain 'INV-2026-0142'",
      'Exit code 127\n/usr/bin/bash: line 1: http: command not found',
    ],
    PowerShell: [
      'Invoke-WebRequest : The remote server returned an error: (500) Internal Server Error.\nAt line:1 char:1\n+ Invoke-WebRequest -Uri "http://localhost:5173/api/invoices/export?debugFail=1"',
    ],
  },
  narration: {
    topics: [
      ['the sticky header', 'the column layout', 'the table redesign plan'],
      ['the sticky header', 'column widths'],
      ['the column filters', 'the filter popovers'],
      'the CSV export',
      'the hanging dev server',
      ['server-side filtering', 'the invoices endpoint', 'the status index'],
      ['amount ranges', 'the sort preference'],
      ['the dark-mode header', 'the status badge tokens'],
      'the failing tests',
      'the next plan step',
      'the interrupted test run',
      'the empty state',
      'the empty state',
      'the active filter count',
      'the badge position',
      'cursor pagination',
      'the sort cursor',
      ['the bulk actions endpoint', 'the bulk action log'],
      'partial batch failures',
      'the bulk actions bar',
      'the bulk endpoint tests',
      'the full test run',
      'the reminder email',
      ['chunked reminders', 'the reminder progress'],
      ['the QA checklist', 'the changelog', 'the export filters'],
      'the stale dev server',
      'the stale dev server',
      'the launch config',
      'the export error state',
      'the export failure path',
      ['the saved views plan', 'saved views'],
      'the saved views picker',
    ],
    summaries: [
      'First pass is in: the table has a sticky header and the column layout from the plan. Next I will check it in the preview at desktop and mobile widths.',
      'The sticky header works at 1280px and 375px. Column widths are fixed and the amount column is right-aligned. I flagged an unrelated Sidebar re-render as a separate task.',
      'Column filters are in for status, customer and date range. The popovers close on Escape and return focus to their trigger.',
      'CSV export is in. It exports all filtered rows, not just the visible page, and writes amounts as plain numbers.',
      'The hang came from a circular import between App.tsx and Providers.tsx that sent Vite into an HMR loop. App.tsx now imports the providers lazily.',
      'Filters now run on the server: GET /api/invoices takes status, customerId, from and to. I added a migration with an index on (status, issued_at), and the table keeps its filter state in the URL.',
      'The amount filter accepts ranges (100-500, >1000, <50). Sort order is saved per user under invoices.sort.',
      'The header now has a solid --surface-1 background in both themes and a bottom border while stuck. Badges use the status tokens instead of hex values.',
      'Two tests were failing because of the new header markup. Both fixed, and the preview servers are stopped.',
      'Next in the plan is the bulk actions bar. The test run from before was interrupted, so I will re-run it first.',
      'Tests are green again (184 passed). The bulk actions bar is next.',
      'The empty state shows when filters match nothing and offers a Reset filters button.',
      'EmptyState.tsx was a 12-line placeholder, so rewriting it was smaller than patching it. The new version takes onReset and the active filter count.',
      'The Filters button shows a count badge, and Reset now clears both the filters and the URL query.',
      'The badge now sits after the label and no longer covers the icon at 375px.',
      'Pagination uses the cursor from the API, 50 rows per page, and keeps the current page in the URL.',
      'Changing the sort keeps the cursor now. Only a filter change resets to the first page.',
      'The API side is done: POST /api/invoices/bulk with mark_paid or send_reminder, capped at 200 ids and run in one transaction.',
      'The whole batch rolls back and the response lists the failing ids with a reason. The UI shows which rows failed and keeps them selected.',
      'The bulk actions bar slides in when rows are selected, shows the count, and asks for confirmation before sending reminders.',
      'Added 4 tests in invoices.bulk.test.ts covering those cases. All pass.',
      'Suite: 212 passed. Type check: clean. Today: the bulk endpoint and its tests, the bulk actions bar with confirmation, and migrations for the bulk action log and reminder_sent_at.',
      'The template now renders the invoice number and due date. The test was checking an empty field; it passes now.',
      'Reminders go out in chunks of 20, and the bulk bar shows progress (40 / 180 sent). A failed chunk stops the run and reports which invoices were not sent.',
      'QA checklist added in docs/qa/invoices-table.md and the CHANGELOG is updated. The export uses the current filters and sort order; I added a test for that.',
      'Stopped the node process on 5173 (PID 18244). The preview is starting on the default port.',
      'Found it: a vite process from another terminal was serving 5173. I stopped only that one; your other terminals are untouched.',
      'launch.json pointed at 5174 while vite.config.ts uses 5173. Both use 5173 now, and the table loads in the preview.',
      'The button re-enables when the export request fails and shows an error toast with a Retry action.',
      'With debugFail=1 the endpoint returns 500, the toast appears, and the button is enabled again.',
      'The plan is in docs/plans/invoices-table.md under Saved views: a saved_views table, CRUD endpoints, a picker in the toolbar and a save dialog. The migration, types, picker and dialog are in; sharing is left for a follow-up.',
      'Below 640px the picker now lives inside the filter popover.',
    ],
    checks: [
      'the table tests',
      'the type check',
      'the invoices unit tests',
      'a lint pass',
      'the API tests',
    ],
    searches: [
      'where the table defines its columns',
      'existing popover usage',
      'every hard-coded status color',
      'callers of useInvoices',
      'the export handler',
      'what is still listening on port 5173',
    ],
    // one per AskUserQuestion call, in session order (S0, S5, S17, S19,
    // S22, S24, S30)
    asks: [
      'which columns should stay visible on a 375px screen?',
      'keep the filter state in the URL, or in component state only?',
      'should mark as paid also ask for confirmation, or only reminders?',
      'show the bulk bar above the table or pinned to the bottom?',
      'format the due date as 1 July 2026 or 2026-07-01 in the email?',
      'should the QA checklist cover keyboard navigation too?',
      'saved views: shared with the team, or private per user?',
    ],
    subagentTopics: [
      'the invoices table components',
      'filter and popover patterns',
    ],
  },
};

// ---------------------------------------------------------------------------
// 2. Claude Code, one afternoon — migrate a Node API from raw SQL strings to
//    a typed query builder with 19 agents. Plan mode, parallel module
//    migrations, and a TaskStop retry loop on a job that had already ended.
// ---------------------------------------------------------------------------

const ORDERS = `${HOME}/code/orders-api`;
/** Every module except admin/audit, which the main thread migrates itself. */
const AGENT_MODULES = [
  'orders',
  'customers',
  'invoices',
  'payments',
  'inventory',
  'shipments',
  'reports',
  'catalog',
  'pricing',
  'webhooks',
  'notifications',
  'auth',
];
/** Module files a migration agent reads beyond repository/service/controller. */
const MODULE_ROLES = [
  'routes',
  'schema',
  'mapper',
  'types',
  'repository.test',
  'service.test',
  'validators',
  'errors',
  'controller.test',
];
function moduleFiles(m: string, roles: string[] = MODULE_ROLES): string[] {
  return roles.map((r) => `src/modules/${m}/${m}.${r}.ts`);
}
function queries(m: string, names: string[]): string[] {
  return names.map((q) => `db/queries/${m}/${q}.sql`);
}

const ordersMigration: DemoStory = {
  golden: 'claude-code/subagents',
  out: 'claude-code/orders-api-kysely-migration',
  title: 'Migrate orders-api from raw SQL strings to the Kysely query builder',
  project: {
    name: 'orders-api',
    path: ORDERS,
    gitBranch: 'refactor/kysely-migration',
  },
  source: {
    from: 'fixtures/claude-code/subagents/',
    to: `${HOME}/.claude/projects/-home-dev-code-orders-api/`,
  },
  prompts: [
    'Plan approved, with two changes:\n1. keep the .sql files for the reporting queries, they are tuned by hand\n2. fix the unreleased pool client in payments.service.ts first, as its own commit\nThen start the migration.',
    'why is the test run still going?',
    'Stop the old watchers and finish the remaining modules. Run the full suite once at the end.',
    "The full suite you started in the background should be done by now.\n- show me the result\n- if something failed, tell me why before you change anything\n- don't re-run the suite yet",
    'Why did you keep sql`` templates for the reporting queries instead of the builder? I want to understand the trade-off before I approve it, especially for the cohort retention query.',
    'fix the failures',
    "good. update the CHANGELOG and we're done",
  ],
  // chronological; A9/A11/A13 are spawned by A3, A14/A16 by A5, A15/A17/A18
  // by A8
  delegations: [
    'Map raw SQL call sites in src/',
    'Inventory repositories and their callers',
    'Check how transactions and pools are used',
    'Map each .sql file to a Kysely query',
    'Migrate the orders repository to Kysely',
    'Migrate invoices and payments queries',
    'Migrate the customers repository',
    'Migrate the inventory repository',
    'Migrate shipments and tracking queries',
    'Check jsonb column typing',
    'Wrap the reporting queries (read-only)',
    'Verify order_items column types',
    'Port the repository tests to Kysely',
    'Confirm invoice number sequence usage',
    'Check numeric to number coercion',
    'Verify shipment status enum values',
    'Look up Kysely onConflict syntax',
    'Check the tracking_events indexes',
    'Confirm the carriers table has no triggers',
  ],
  // pools keyed `<ext>@<scope>`: A<i> = subagent i, S<n> = main segment n
  files: {
    'ts@A0': under(ORDERS, [
      ...AGENT_MODULES.map((m) => `src/modules/${m}/${m}.repository.ts`),
      'src/db/client.ts',
      'src/server.ts',
      'src/app.ts',
      'src/routes.ts',
    ]),
    'ts@A1': under(ORDERS, [
      ...AGENT_MODULES.flatMap((m) => [
        `src/modules/${m}/${m}.service.ts`,
        `src/modules/${m}/${m}.controller.ts`,
      ]),
      'src/modules/index.ts',
      'src/container.ts',
    ]),
    'ts@A2': under(ORDERS, [
      'src/db/tx.ts',
      'src/db/pool.ts',
      'src/db/health.ts',
      'src/middleware/transaction.ts',
      'src/jobs/reconcilePayments.ts',
      'src/jobs/releaseReservations.ts',
      'src/jobs/sendReminders.ts',
      'src/jobs/syncCarriers.ts',
      'src/jobs/nightlyReports.ts',
      'src/jobs/queue.ts',
      'src/config/database.ts',
      'src/config/env.ts',
      'src/lib/retry.ts',
      'src/lib/logger.ts',
      'test/setup/db.ts',
      'test/setup/transactions.ts',
    ]),
    'ts@A3': under(ORDERS, [
      'src/db/schema.ts',
      'src/db/kysely.ts',
      'src/db/types/generated.ts',
      'src/db/types/json.ts',
      'src/db/queries.ts',
      'src/db/sqlFile.ts',
      'scripts/listQueries.ts',
      'src/db/types/enums.ts',
    ]),
    'ts@A4': under(ORDERS, [
      ...moduleFiles('orders'),
      'src/modules/orders/orderItems.repository.ts',
      'src/modules/orders/orderItems.mapper.ts',
      'src/modules/orders/orderItems.types.ts',
      'src/modules/orders/orderItems.repository.test.ts',
      'src/modules/orders/orders.search.ts',
      'src/modules/orders/orders.search.test.ts',
      'src/modules/orders/orders.events.ts',
      'src/modules/orders/orders.status.ts',
      'src/modules/catalog/catalog.types.ts',
      'src/modules/pricing/pricing.types.ts',
      'src/lib/money.ts',
      'src/lib/pagination.ts',
      'src/lib/sort.ts',
    ]),
    'ts@A5': under(ORDERS, [
      ...moduleFiles('invoices'),
      ...moduleFiles('payments'),
      'src/modules/invoices/invoiceNumber.ts',
      'src/modules/payments/refunds.ts',
    ]),
    'ts@A6': under(ORDERS, [
      ...moduleFiles('customers', [
        'routes',
        'schema',
        'mapper',
        'types',
        'repository.test',
        'validators',
        'errors',
        'controller.test',
      ]),
      'src/modules/customers/customers.merge.ts',
      'src/modules/customers/customers.search.ts',
    ]),
    'ts@A7': under(
      ORDERS,
      moduleFiles('inventory', [
        'routes',
        'schema',
        'mapper',
        'types',
        'repository.test',
      ]),
    ),
    'ts@A8': under(ORDERS, [
      ...moduleFiles('shipments'),
      'src/modules/shipments/tracking.repository.ts',
      'src/modules/shipments/tracking.mapper.ts',
      'src/modules/shipments/tracking.types.ts',
      'src/modules/shipments/carriers.repository.ts',
      'src/modules/shipments/carriers.types.ts',
      'src/modules/shipments/shipments.status.ts',
    ]),
    'ts@A10': under(ORDERS, moduleFiles('reports')),
    'ts@A12': under(ORDERS, [
      'test/helpers/kyselyHarness.ts',
      'test/helpers/factories.ts',
      'test/helpers/withTestTx.ts',
      'vitest.config.ts',
      'test/setup/global.ts',
      'test/helpers/seed.ts',
      'test/helpers/clock.ts',
      'test/helpers/assertions.ts',
    ]),
    'ts@S3': under(ORDERS, [
      'src/modules/admin/admin.repository.ts',
      'src/modules/admin/admin.service.ts',
      'src/modules/admin/admin.types.ts',
      'src/modules/audit/audit.repository.ts',
      'src/modules/audit/audit.service.ts',
      'src/modules/audit/audit.types.ts',
      'src/modules/audit/audit.repository.test.ts',
      'src/db/numeric.ts',
    ]),
    'ts@S6': under(ORDERS, ['src/modules/reports/reports.filters.ts']),
    'sql@A0': under(ORDERS, [
      ...queries('orders', ['search']),
      ...queries('customers', ['search', 'find_by_email']),
      ...queries('reports', ['top_customers', 'slow_movers']),
    ]),
    'sql@A2': under(ORDERS, [
      ...queries('payments', ['record', 'refund', 'reconcile']),
      ...queries('inventory', ['reserve', 'release']),
      ...queries('invoices', ['next_number']),
      ...queries('orders', ['insert']),
    ]),
    'sql@A3': under(ORDERS, [
      ...queries('orders', [
        'find_by_id',
        'list_by_customer',
        'update_status',
        'items_by_order',
      ]),
      ...queries('customers', ['upsert', 'merge']),
      ...queries('invoices', ['create', 'totals_by_month', 'find_unpaid']),
      ...queries('payments', ['by_invoice']),
      ...queries('inventory', ['stock_levels', 'low_stock']),
      ...queries('shipments', ['create', 'track', 'by_order', 'update_status']),
      ...queries('reports', ['revenue_by_day', 'cohort_retention']),
      ...queries('admin', ['list_users', 'audit_trail']),
      ...queries('legacy', [
        'orders_v1',
        'invoice_export_v1',
        'customer_sync_v1',
      ]),
    ]),
    'sql@S3': under(ORDERS, [
      'db/migrations/0015_orders_search_index.sql',
      'db/migrations/0016_drop_legacy_views.sql',
    ]),
    'md@S0': [
      ...under(ORDERS, [
        'docs/database.md',
        'README.md',
        'docs/architecture.md',
        'AGENTS.md',
      ]),
      `${HOME}/.claude/plans/kysely-migration.md`,
      `${ORDERS}/docs/adr/0007-query-builder.md`,
    ],
    'md@A0': under(ORDERS, ['db/queries/README.md']),
    'md@A2': under(ORDERS, ['docs/runbooks/transactions.md']),
    'md@S1': under(ORDERS, ['docs/migration-progress.md', 'CHANGELOG.md']),
    'json@S0': under(ORDERS, ['package.json']),
    'json@A2': under(ORDERS, ['tsconfig.json', 'config/database.json']),
    'tsx@A0': under(ORDERS, [
      'src/emails/components/Layout.tsx',
      'src/emails/ShipmentEmail.tsx',
    ]),
    'tsx@A4': under(ORDERS, ['src/emails/OrderConfirmation.tsx']),
    'tsx@A5': under(ORDERS, ['src/emails/InvoiceEmail.tsx']),
    'tsx@A6': under(ORDERS, ['src/emails/WelcomeEmail.tsx']),
    'tsx@A7': under(ORDERS, ['src/emails/LowStockAlert.tsx']),
    'mjs@A2': under(ORDERS, ['scripts/seed.mjs']),
    'mjs@S3': under(ORDERS, ['scripts/codegen.mjs']),
    'yml@A12': under(ORDERS, [
      'docker-compose.yml',
      '.github/workflows/ci.yml',
    ]),
    'example@A6': under(ORDERS, ['config/.env.test.example']),
    'example@S6': under(ORDERS, ['.env.example']),
    'output@S1': ['/tmp/claude/tasks/bq41x7.output'],
    'output@S4': ['/tmp/claude/tasks/bq52m3.output'],
    '@A1': under(ORDERS, ['Dockerfile']),
  },
  commands: [
    'pnpm',
    'rg',
    'git',
    'npx',
    'cat',
    'ls',
    'psql',
    'docker',
    'node',
    'head',
    'wc',
    'find',
    'grep',
    'cd',
    'jq',
    'tail',
    'diff',
    'echo',
    'awk',
    'curl',
  ],
  errors: {
    Bash: [
      'Exit code 2\nrg: db/queries/legacy/archive: No such file or directory (os error 2)',
      'Exit code 2\npsql: error: connection to server at "localhost" (127.0.0.1), port 5432 failed: Connection refused\n\tIs the server running on that host and accepting TCP/IP connections?',
      "Exit code 1\n FAIL  src/modules/invoices/invoices.repository.test.ts > totals by month\nAssertionError: expected '1520.00' to be 1520 // Object.is equality",
      'Exit code 1\ncat: .env: No such file or directory',
      'Exit code 143\nCommand timed out after 2m 0s: pnpm vitest run --reporter=dot',
    ],
    Read: [
      'File does not exist. Note: your current working directory is /home/dev/code/orders-api.',
      'File content (31204 tokens) exceeds maximum allowed tokens (25000). Use offset and limit parameters to read specific portions of the file, or search for specific content instead.',
      'File does not exist. Did you mean src/modules/reports/reports.repository.ts?',
    ],
    Edit: [
      '<tool_use_error>String to replace not found in file.\nString:   const client = await pool.connect();</tool_use_error>',
      '<tool_use_error>File has been modified since read, either by the user or by a linter. Read it again before writing to it.</tool_use_error>',
    ],
    TaskStop: [
      'No task found with ID: bq41x7. It may have already finished or been stopped.',
    ],
  },
  narration: {
    topics: [
      ['the migration plan', 'raw SQL call sites', 'the query inventory'],
      ['the payments client leak', 'the migration progress'],
      'the stuck test run',
      [
        'the admin queries',
        'the audit-log queries',
        'the numeric mapping',
        'the remaining repositories',
        'the legacy .sql files',
      ],
      'the background test results',
      'the reporting query trade-off',
      ['the report date filters', 'the failing report tests'],
      'the changelog',
    ],
    summaries: [
      'Plan: 1) fix the pool client leak in payments.service.ts, 2) map every .sql file to a Kysely query, 3) migrate the repositories module by module, one agent each, 4) run the suite after each module. The reporting queries stay as .sql files.',
      'The client leak is fixed in its own commit: payments.service.ts now goes through withTransaction(). Progress is tracked in docs/migration-progress.md.',
      'Two vitest watchers started by the migration agents are still running in the background. That is why the run looks stuck.',
      'All repositories are migrated: 142 call sites use Kysely, numerics are mapped once in src/db/numeric.ts, and the 3 unused legacy .sql files are gone. The full suite is running in the background.',
      'It finished: 409 passed, 3 failed, all in reports.repository.test.ts. The report filters now pass Date objects where the old SQL compared date strings, so rows on the boundary day drop out. Nothing else is affected.',
      'The reporting queries use window functions and a hand-tuned join order. Rebuilding them with the builder would change the generated SQL and risk the plans, so they stay as .sql files behind typed sql`` calls. Everything else uses the builder.',
      'Fixed: the report filters pass plain dates again, and the test setup pins TZ=UTC (added to .env.example). Full suite: 412 passed, 0 failed.',
      'CHANGELOG updated under Unreleased: the Kysely migration, the payments pool-client fix, and the report date filter fix. Ready to commit.',
    ],
    checks: [
      'the orders module tests',
      'the type check',
      'the repository tests',
      'a lint pass',
      'the integration tests against local Postgres',
    ],
    searches: [
      'every db.query( call',
      'template-string SQL',
      'imports from db/queries',
      'callers of withTransaction',
      'manual BEGIN/COMMIT blocks',
      'numeric columns in the schema',
    ],
    web: [
      'the Kysely transaction API',
      'Kysely numeric type mapping for Postgres',
    ],
    subagentTopics: [
      'raw SQL call sites',
      'the repositories and their callers',
      'transaction handling',
      'the .sql query files',
      'the orders repository',
      'the invoices and payments queries',
      'the customers repository',
      'the inventory repository',
      'the shipments queries',
      'jsonb typing',
      'the reporting queries',
      'order_items column types',
      'the repository tests',
      'invoice numbering',
      'numeric coercion',
      'shipment status values',
      'onConflict syntax',
      'the tracking_events indexes',
      'the carriers table',
    ],
    subagentReports: [
      'Found 142 raw SQL call sites across 12 modules. Most go through db.query(sql, params) in *.repository.ts; 9 build SQL with template strings, 3 of them with user input (order search, customer lookup, report filters).',
      'Every module has one repository; services call only their own repository, except invoices.service.ts, which also reads payments. No controller touches SQL directly.',
      'Transactions are opened in two ways: withTransaction() in src/db/tx.ts, and a manual BEGIN/COMMIT in payments.service.ts. The manual one never releases the pool client on error.',
      'db/queries has 35 .sql files. 29 map one-to-one onto builder queries, 3 legacy files have no importer, and the reporting queries should stay raw.',
      'Orders repository migrated: 18 queries moved to Kysely, and the search query is now parameterized. Module tests pass.',
      'Invoices and payments migrated: 23 queries. invoice_number still comes from the Postgres sequence. Totals return numeric strings; that needs one shared fix.',
      'Customers repository migrated: 11 queries, including the upsert via onConflict. Module tests pass.',
      'Inventory repository migrated: 9 queries. reserve/release keep their row locks through forUpdate().',
      'Shipments migrated: 12 queries. Status is now typed as the ShipmentStatus union from the schema.',
      '',
      'The 4 reporting queries stay as .sql files, called through typed sql`` templates. The generated SQL is unchanged.',
      '',
      'Repository tests now run on the Kysely test harness with a transaction per test. 46 test files updated; CI needs Postgres from docker-compose.',
    ],
  },
};

// ---------------------------------------------------------------------------
// 3. Claude Code, one evening plus a long break — a frontmatter migration
//    script for a docs site. Small session; the break expires the cache.
// ---------------------------------------------------------------------------

const DOCS = `${HOME}/code/docs-site`;

const frontmatter: DemoStory = {
  golden: 'claude-code/simple',
  out: 'claude-code/docs-frontmatter-migration',
  title: 'Write a script that migrates blog frontmatter to the v2 schema',
  project: {
    name: 'docs-site',
    path: DOCS,
    gitBranch: 'chore/frontmatter-v2',
  },
  source: {
    from: 'fixtures/claude-code/simple/',
    to: `${HOME}/.claude/projects/-home-dev-code-docs-site/`,
    rename: { 'simple.jsonl': '055e1023-9744-4675-a703-df3c948974da.jsonl' },
  },
  prompts: [
    'Looks good. Before running it for real:\n- keep the old `date` field as `publishedAt`\n- skip drafts\n- print a summary of the files that would change',
    "I'm back. The API errored before, so apply those three changes and run the migration in dry-run mode over content/blog again.",
  ],
  delegations: [],
  files: {
    md: under(DOCS, ['docs/content-schema.md', 'CONTRIBUTING.md']),
    js: under(DOCS, ['scripts/migrate-frontmatter.js']),
  },
  commands: [],
  errors: {
    '<synthetic>': [
      'API Error: Request timed out. Check your connection and retry.',
    ],
  },
  narration: {
    topics: [
      ['the v2 frontmatter schema', 'the migration script'],
      'the review changes',
      'the dry run',
    ],
    summaries: [
      'I wrote scripts/migrate-frontmatter.js. It reads every post under content/blog, maps the old keys to the v2 schema from docs/content-schema.md, and supports --dry-run. Want me to run it?',
      '',
      'Dry run done: 214 posts scanned, 187 would change, 27 drafts skipped. `date` is kept as `publishedAt`. Run it with --write when you are ready.',
    ],
    checks: ['the dry run'],
    searches: [
      'every post under content/blog',
      'posts that still use the old date key',
      'draft posts',
    ],
  },
};

// ---------------------------------------------------------------------------
// 4. OpenCode (export JSON), 8 minutes — a DST bug in a date library.
// ---------------------------------------------------------------------------

const TZDATE = `${HOME}/code/tzdate`;

const dstFix: DemoStory = {
  golden: 'opencode/export-json',
  out: 'opencode/tzdate-dst-fix',
  title: 'Fix parseLocalDate failures around the DST switch',
  project: { name: 'tzdate', path: TZDATE },
  source: {
    from: 'fixtures/opencode/export-json/',
    to: `${HOME}/exports/`,
    rename: { 'simple.json': 'ses_tzdate-dst-fix.json' },
  },
  prompts: [
    'parseLocalDate tests started failing after the DST change. Find out why and fix it.',
  ],
  delegations: [],
  files: { md: under(TZDATE, ['README.md']) },
  commands: ['npm', 'git', 'ls', 'node', 'cat', 'rg'],
  errors: {},
  narration: {
    topics: ['', 'the DST offset bug'],
    summaries: [
      '',
      'Fixed. parseLocalDate used the UTC offset of the current date instead of the target date, so any date across the DST boundary was one hour off. It now resolves the offset per date. Added 6 regression tests; all 142 tests pass.',
    ],
    checks: ['the test suite', 'the failing parseLocalDate tests'],
    searches: ['uses of getTimezoneOffset', 'the offset helper'],
  },
};

// ---------------------------------------------------------------------------
// 5. OpenCode (SQLite), 20 minutes — dark mode for checkout form components,
//    with one subagent to find hard-coded colors.
// ---------------------------------------------------------------------------

const STORE = `${HOME}/code/storefront-ui`;
const CHECKOUT = 'src/components/checkout';

const darkMode: DemoStory = {
  golden: 'opencode/sqlite-2',
  out: 'opencode/storefront-dark-mode',
  title: 'Dark mode for the checkout form components',
  project: { name: 'storefront-ui', path: STORE },
  source: {
    from: 'fixtures/opencode/sqlite/subagents/',
    to: `${HOME}/.local/share/opencode/`,
  },
  prompts: [
    'Add dark mode to the checkout form components. Use the color tokens from src/styles/tokens.css, no hard-coded hex values. Start with AddressForm and PaymentForm, and keep the light theme exactly as it is.',
    'document it in docs/theming.md',
    'Now do the rest of src/components/checkout the same way. Replace every hard-coded color with a token and add a dark variant where one is missing. Use a subagent to find them. Run lint and tests at the end.',
    'Search src/components/checkout for hard-coded colors.\nReport the file, line and value for every hex, rgb() or named color.\nDo not edit anything.',
  ],
  delegations: ['Find hard-coded colors'],
  files: {
    '': [STORE, `${STORE}/src`, `${STORE}/${CHECKOUT}`],
    css: under(STORE, [
      'src/styles/tokens.css',
      'src/styles/globals.css',
      `${CHECKOUT}/checkout.module.css`,
      'src/components/forms/forms.module.css',
    ]),
    tsx: under(STORE, [
      `${CHECKOUT}/AddressForm.tsx`,
      `${CHECKOUT}/PaymentForm.tsx`,
      'src/components/forms/TextField.tsx',
      'src/components/forms/SelectField.tsx',
      'src/components/forms/Checkbox.tsx',
      'src/components/forms/FieldError.tsx',
      'src/components/forms/Label.tsx',
      'src/theme/ThemeProvider.tsx',
      'src/theme/ThemeToggle.tsx',
      `${CHECKOUT}/CheckoutPage.tsx`,
      `${CHECKOUT}/ShippingOptions.tsx`,
      `${CHECKOUT}/OrderSummary.tsx`,
      `${CHECKOUT}/CardNumberInput.tsx`,
      `${CHECKOUT}/ExpiryInput.tsx`,
      `${CHECKOUT}/CvcInput.tsx`,
      `${CHECKOUT}/PromoCodeField.tsx`,
      `${CHECKOUT}/StepIndicator.tsx`,
      `${CHECKOUT}/DeliveryDatePicker.tsx`,
      `${CHECKOUT}/BillingSameAsShipping.tsx`,
      `${CHECKOUT}/PlaceOrderButton.tsx`,
      `${CHECKOUT}/SummaryLine.tsx`,
      `${CHECKOUT}/CartItemRow.tsx`,
      `${CHECKOUT}/GiftWrapOption.tsx`,
      `${CHECKOUT}/SavedAddresses.tsx`,
      `${CHECKOUT}/AddressAutocomplete.tsx`,
      `${CHECKOUT}/CountrySelect.tsx`,
      `${CHECKOUT}/PhoneField.tsx`,
      `${CHECKOUT}/PaymentMethodTabs.tsx`,
      `${CHECKOUT}/WalletButtons.tsx`,
      `${CHECKOUT}/SecureBadge.tsx`,
      `${CHECKOUT}/ErrorBanner.tsx`,
      `${CHECKOUT}/LoadingOverlay.tsx`,
      `${CHECKOUT}/TermsCheckbox.tsx`,
      `${CHECKOUT}/OrderNotes.tsx`,
      `${CHECKOUT}/TaxBreakdown.tsx`,
      `${CHECKOUT}/ShippingEstimate.tsx`,
      `${CHECKOUT}/EmptyCart.tsx`,
      `${CHECKOUT}/ConfirmationPanel.tsx`,
      'src/components/ui/Button.tsx',
      'src/components/ui/Card.tsx',
      'src/components/ui/Divider.tsx',
      'src/components/ui/Tooltip.tsx',
      'src/components/ui/Spinner.tsx',
      'src/components/ui/Badge.tsx',
      'src/components/ui/Icon.tsx',
      'src/app/layout.tsx',
    ]),
    ts: under(STORE, ['src/theme/tokens.ts']),
    md: under(STORE, ['docs/theming.md']),
    json: under(STORE, ['package.json', 'tsconfig.json', '.eslintrc.json']),
  },
  commands: [
    'npm',
    'rg',
    'git',
    'ls',
    'npx',
    'cat',
    'node',
    'find',
    'head',
    'wc',
    'grep',
  ],
  errors: {
    apply_patch: [
      "apply_patch verification failed: Failed to find expected lines in src/components/checkout/OrderSummary.tsx:\n  <div className={styles.summary} style={{ background: '#fff' }}>",
    ],
  },
  narration: {
    topics: [
      '',
      ['the checkout form colors', 'AddressForm and PaymentForm'],
      'the theming docs',
      [
        'the remaining checkout components',
        'hard-coded colors',
        'dark variants',
      ],
    ],
    summaries: [
      '',
      'AddressForm and PaymentForm now take their colors from the tokens and switch with the dark class on <html>. The light theme is unchanged. Shall I do the other checkout components the same way?',
      'Added a Dark mode section to docs/theming.md: how the tokens switch, and how to add a dark variant for a new color.',
      'All checkout components use color tokens now: 36 patches across 18 files, plus two new tokens (--color-surface-raised, --color-danger-fg) for missing dark variants. npm run lint and npm test pass (212 tests).',
    ],
    checks: ['npm run lint', 'npm test', 'the type check'],
    searches: [
      'hex colors in src/components/checkout',
      'rgb() values',
      'uses of the color tokens',
      'named colors like white and black',
    ],
    subagentTopics: ['hard-coded colors'],
    subagentReports: [
      'Found 23 hard-coded colors in 9 files. Most are #fff and #111 backgrounds in the summary cards; the error text in CardNumberInput.tsx and ExpiryInput.tsx uses #d93025.',
    ],
  },
};

// ---------------------------------------------------------------------------
// 6. Claude Code OTel traces (OTLP import), 2.5 minutes — a pre-commit
//    review. OTLP carries no title or project; the demo supplies both so the
//    session reads like the others.
// ---------------------------------------------------------------------------

const preCommitReview: DemoStory = {
  golden: 'otlp/claude-traces-beta-2',
  out: 'otlp/orders-api-precommit-review',
  title: 'Review the staged diff before committing',
  project: { name: 'orders-api', path: ORDERS },
  source: {
    from: 'fixtures/otlp/claude-traces-beta/',
    to: `${HOME}/otel/`,
    rename: { 'subagents.json': 'claude-code-traces-2026-07-07.json' },
  },
  // `[1m]` marks the 1M-context variant; the bundled table prices the base id
  modelRenames: { 'claude-opus-4-8[1m]': 'claude-opus-4-8' },
  prompts: ['review the staged diff before I commit'],
  delegations: [],
  files: {},
  commands: [],
  errors: {},
  narration: {
    topics: ['', 'the staged diff'],
    summaries: ['', ''],
    checks: ['git diff --staged'],
    searches: ['the staged files'],
  },
};

export const STORIES: DemoStory[] = [
  invoicesTable,
  ordersMigration,
  frontmatter,
  dstFix,
  darkMode,
  preCommitReview,
];
