# Front Step Sites: customer websites

Every customer site lives in `sites/<slug>/` and deploys as its own free Render static site (root directory = its folder, so only its own changes redeploy it).

Nobody edits these by hand. Customers open requests in the portal; the `agent` workflow picks one up, has Claude Code make the change under `AGENTS.md`, checks the result with `agent/validate.mjs` (only that site's folder, no injected scripts, form and footer intact), commits, publishes, and replies to the customer.

- `templates/trades/`: the starting point for a new site (the questionnaire fills it in).
- `agent/run.mjs`: pick + finish around the AI edit. `node --test agent/validate.test.mjs` for the safety rules.
- `nightly` workflow: calls the portal's nightly job (domain sync, renewals, reminders, transfers).
- Setup: repo secrets `AGENT_TOKEN`, `ANTHROPIC_API_KEY`, `RENDER_API_KEY`, `CRON_SECRET`; repo variables `PORTAL_URL`, `RENDER_OWNER_ID`.
