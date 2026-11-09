const { sql, send, guard, requireAuth, ensureAdminTables, ensureInviteCode } = require('../../_lib');

// Admin-tier accounts only: the account's permanent referral link,
// the users it brought in, and its referral earnings (earned / paid /
// pending). Referral commission lands in the same ledger admins use;
// the super admin pays it out from the admin dashboard.
module.exports = guard(async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  await ensureAdminTables();
  // Referral links are admin-tier only (Prince's rule, 2026-11-03):
  // players do not get a link, a referred list or earnings here.
  const me = await sql('select role from users where id = $1', [auth.uid]);
  if (!me.length) return send(res, 404, { error: 'account_not_found' });
  if (me[0].role === 'player') return send(res, 403, { error: 'referrals_admin_only', detail: 'Referral links are for admin accounts only.' });
  const code = await ensureInviteCode(auth.uid);
  if (!code) return send(res, 404, { error: 'account_not_found' });
  const [invited, totals] = await Promise.all([
    sql(`select u.id, u.phone, u.display_name, u.created_at,
                coalesce((select sum(t.amount_ghs) from wallet_transactions t
                          where t.user_id = u.id and t.kind = 'deposit' and t.status = 'completed'), 0) as deposits_ghs
         from users u where u.invited_by = $1 order by u.created_at desc limit 100`, [auth.uid]),
    sql(`select coalesce(sum(amount_ghs), 0) as earned,
                coalesce(sum(amount_ghs) filter (where paid_at is not null), 0) as paid,
                coalesce(sum(amount_ghs) filter (where paid_at is null), 0) as pending
         from commissions where earner_id = $1`, [auth.uid])
  ]);
  const t = totals[0] || {};
  send(res, 200, {
    invite_code: code,
    invite_path: '/?ref=' + code,
    invited_users: invited.map(u => ({ ...u, deposits_ghs: Number(u.deposits_ghs) })),
    commissions: {
      earned_ghs: Number(t.earned || 0),
      paid_ghs: Number(t.paid || 0),
      pending_ghs: Number(t.pending || 0)
    }
  });
});
