const { sql, send, guard, requireAdmin } = require('../../_lib');

module.exports = guard(async (req, res) => {
  const auth = requireAdmin(req, res);
  if (!auth) return;
  // Withdrawals are super-admin only (Prince, 2026-11-05): a regular
  // admin's queue shows deposits — their job to confirm — and never
  // a withdrawal row. The filter is here, server-side, so the data
  // itself never reaches an admin's browser.
  const rows = await sql(
    `select wt.id, wt.user_id, u.phone, wt.kind, wt.method, wt.amount_ghs,
            wt.external_ref, wt.created_at, (wt.proof_image is not null) as has_proof,
            wt.payout_meta
     from wallet_transactions wt join users u on u.id = wt.user_id
     where wt.status = 'pending' and wt.kind in ('deposit', 'withdrawal')
       ${auth.role === 'super_admin' ? '' : "and wt.kind <> 'withdrawal'"}
     order by wt.created_at asc`
  );
  send(res, 200, { queue: rows.map(r => ({ ...r, amount_ghs: Number(r.amount_ghs) })) });
});
