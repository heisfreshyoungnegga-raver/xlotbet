# Oddaroa backend package

- schema.sql: the full Postgres schema (users, matches, bets,
  bet_selections, wallet ledger, support, operator settings). The
  6-deposit withdrawal rule is a database trigger, not just UI text.
- API.md: the endpoint contract the front end will call.

Status: APPLIED LIVE on 2026-11-02. The Neon project "oddaroa"
(project ID empty-boat-34522343, US East, database neondb, branch
production, Postgres 18, free plan) was created in the owner's console,
and schema.sql ran clean as a single script: all 21 queries succeeded,
and the Tables view verified users, operator_settings, matches, bets,
bet_selections, wallet_transactions, support_messages and the
admin_pending_queue view. Remaining work: the /api/v1 layer on Vercel
plus front-end wiring, which needs DATABASE_URL set in Vercel by the
owner (the connection string carries the database password and is never
shared in chat).
