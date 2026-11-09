# Oddaroa API contract

Base path: /api/v1 (Vercel serverless functions over the Postgres schema
in schema.sql). All money values are GHS numbers with 2 decimals. Auth is
a bearer session token issued at login; admin routes require role=admin.

## Auth
- POST /auth/register {phone, password, display_name} -> {user, token}
- POST /auth/login {phone, password} -> {user, token}
- POST /auth/logout
- GET  /auth/me -> current user incl. balance_ghs

## Matches and betting
- GET  /matches?status=upcoming|live&sport=&date= -> match rows with odds
- POST /bets {selections:[{match_id, market, pick}], stake_ghs}
  -> creates bet + bet_selections, debits balance via a bet_stake ledger
     row in one transaction, returns the bet code (PB-XXXXXX)
- GET  /bets/mine -> the player's bets with selections
- POST /bets/{code}/cashout -> demo rules until a pricing engine exists
- GET  /bets/verify/{code} -> public ticket check (code, status, stake,
  total odds, potential) with no account data exposed

## Wallet
- GET  /wallet -> {balance_ghs, deposits_completed, deposits_required,
  withdrawals_unlocked, transactions[]}
- POST /wallet/deposit/manual {amount_ghs, sender_phone, external_ref}
  -> creates a PENDING deposit; it counts toward the withdrawal rule
     only after an admin confirms it
- POST /wallet/deposit/instant {amount_ghs, method}
  -> stays a stub until a licensed payment processor is connected;
     never mark real money completed without processor confirmation
- POST /wallet/withdraw {amount_ghs, method}
  -> the database trigger rejects the insert until the user reaches the
     required completed deposits (operator setting, default 6)

## Admin
- GET  /admin/stats -> users, bets today, pending queue counts
- GET  /admin/queue -> admin_pending_queue view rows
- POST /admin/transactions/{id}/confirm -> marks completed, credits or
  pays out the balance in the same transaction, stamps confirmed_by
- POST /admin/transactions/{id}/reject
- GET  /admin/users, POST /admin/users/{id}/block
- GET  /admin/support, POST /admin/support/{id}/answer

## Support
- POST /support {subject, body}
- GET  /support/mine

## Going live checklist
1. Create the database (Neon project or Supabase project).
2. Run schema.sql once.
3. Set env vars on Vercel: DATABASE_URL (from the database console,
   entered by the owner, never shared in chat), SESSION_SECRET.
4. Point the front end's data layer at /api/v1 and remove demo fixtures.
5. Real-money deposits and withdrawals stay OFF until the operator's
   Gaming Commission licence position is settled in writing.
