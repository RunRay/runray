---
"runray": patch
---

The `%win` button is gone. In its place, the period filter offers the window since your last usage-limit reset, labelled with its start, such as "Since Mon 00:00". Every dashboard figure, ranking and chart follows it, and the trend compares it with the window before it. The window comes from `limitWindow` in `runray.config.json` and defaults to 7 days from Monday 00:00. A link to it carries `period=reset`.

With a budget for the unit the figures lead with (`budgetTokens` or `budgetUSD` in the same block), the headline shows how much of the window it used, for example "485k of 600k tokens ≈81% used (est.)". A bar shows the share and marks an overrun. Without a budget no percentage appears. The window and budgets are now set only in `runray.config.json`. If you set them in the old `%win` settings, set them again there, because those browser-only settings are deleted.

The run Cost view no longer shows a "% of window" figure.
