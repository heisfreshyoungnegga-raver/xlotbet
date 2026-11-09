const { sql, readBody, send, guard, requireSuperAdmin, ensureAdminTables } = require('../../_lib');

// Super admin only: pay out an earner's pending referral commissions
// (any account can earn them). The total is credited to that earner's
// own Oddaroa wallet balance (from where they can withdraw it), the
// commission rows are stamped paid, and the payout itself lands in
// their ledger.
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireSuperAdmin(req, res);
  if (!auth) return;
  await ensureAdminTables();
  const { earner_id } = await readBody(req);
  if (!earner_id) return send(res, 400, { error: 'earner_required' });
  const rows = await sql(
    `with due as (
       update commissions set paid_at = now()
       where earner_id = $1 and paid_at is null returning amount_ghs
     ),
     total as (select coalesce(sum(amount_ghs), 0) as amt, count(*) as n from due),
     cred as (
       update users set balance_ghs = balance_ghs + (select amt from total)
       where id = $1 and (select amt from total) > 0 returning id
     ),
     ins as (
       insert into wallet_transactions (user_id, kind, method, amount_ghs, status, note, confirmed_by)
       select $1, 'adjustment', 'Commission payout', (select amt from total), 'completed',
              'Commission payout for ' || (select n from total) || ' deposit(s)', $2
       where (select amt from total) > 0 returning id
     )
     select amt, n from total`,
    [earner_id, auth.uid]
  );
  const amt = rows.length ? Number(rows[0].amt) : 0;
  if (!(amt > 0)) return send(res, 404, { error: 'nothing_to_pay' });
  // Settle any open payout request from this earner (payout-request.js).
  await sql(
    `update commission_payout_requests set status = 'paid', decided_at = now(), decided_by = $2
     where earner_id = $1 and status = 'pending'`,
    [earner_id, auth.uid]
  );
  send(res, 200, { ok: true, paid_ghs: amt, entries: Number(rows[0].n) });
});
