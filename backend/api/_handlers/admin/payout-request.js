const { sql, send, guard, requireAdmin, ensureAdminTables } = require('../../_lib');

// An admin-tier earner asks the super admin to pay out their pending
// referral commissions. The request snapshots the pending total; the
// super admin settles it with the Pay Out button (payout.js), which
// credits the earner's wallet balance and closes the request here.
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireAdmin(req, res);
  if (!auth) return;
  await ensureAdminTables();
  const open = await sql(
    `select id, amount_ghs, created_at from commission_payout_requests
     where earner_id = $1 and status = 'pending'`, [auth.uid]);
  if (open.length) {
    return send(res, 200, { ok: true, already: true, request: { ...open[0], amount_ghs: Number(open[0].amount_ghs) } });
  }
  const tot = await sql(
    `select coalesce(sum(amount_ghs), 0) as pending from commissions
     where earner_id = $1 and paid_at is null`, [auth.uid]);
  const pending = Number(tot[0].pending || 0);
  if (!(pending > 0)) {
    return send(res, 400, { error: 'nothing_pending', detail: 'You have no pending commission to pay out yet.' });
  }
  const rows = await sql(
    `insert into commission_payout_requests (earner_id, amount_ghs) values ($1, $2)
     on conflict (earner_id) where status = 'pending' do nothing
     returning id, amount_ghs, created_at`, [auth.uid, pending]);
  if (!rows.length) {
    const again = await sql(
      `select id, amount_ghs, created_at from commission_payout_requests
       where earner_id = $1 and status = 'pending'`, [auth.uid]);
    return send(res, 200, { ok: true, already: true, request: { ...again[0], amount_ghs: Number(again[0].amount_ghs) } });
  }
  send(res, 201, { ok: true, request: { ...rows[0], amount_ghs: Number(rows[0].amount_ghs) } });
});
