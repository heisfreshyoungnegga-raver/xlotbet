const { sql, send, guard, requireAdmin } = require('../../_lib');

module.exports = guard(async (req, res) => {
  const auth = requireAdmin(req, res);
  if (!auth) return;
  // Prince (2026-11-05): a regular admin's dashboard counts only
  // their OWN referred users — platform-wide totals on an admin's
  // screen read as fake "demo data" and leak other admins' business.
  // The super admin keeps the full platform view ($1 = null).
  const scope = auth.role === 'super_admin' ? null : auth.uid;
  const rows = await sql(
    `select
       (select count(*) from users u where ($1::uuid is null or u.invited_by = $1)) as users,
       (select count(*) from users u where u.status = 'blocked' and ($1::uuid is null or u.invited_by = $1)) as blocked_users,
       (select count(*) from bets b join users u on u.id = b.user_id where b.placed_at::date = current_date and ($1::uuid is null or u.invited_by = $1)) as bets_today,
       (select count(*) from bets b join users u on u.id = b.user_id where b.status = 'open' and ($1::uuid is null or u.invited_by = $1)) as open_bets,
       (select coalesce(sum(b.stake_ghs), 0) from bets b join users u on u.id = b.user_id where b.placed_at::date = current_date and ($1::uuid is null or u.invited_by = $1)) as stakes_today,
       (select count(*) from wallet_transactions w join users u on u.id = w.user_id where w.status = 'pending' and w.kind = 'deposit' and ($1::uuid is null or u.invited_by = $1)) as pending_deposits,
       (select count(*) from wallet_transactions w join users u on u.id = w.user_id where w.status = 'pending' and w.kind = 'withdrawal' and ($1::uuid is null or u.invited_by = $1)) as pending_withdrawals,
       (select count(*) from support_messages sm join users u on u.id = sm.user_id where sm.status = 'open' and ($1::uuid is null or u.invited_by = $1)) as open_support`,
    [scope]
  );
  const r = rows[0];
  send(res, 200, {
    stats: {
      users: Number(r.users), blocked_users: Number(r.blocked_users),
      bets_today: Number(r.bets_today), open_bets: Number(r.open_bets),
      stakes_today_ghs: Number(r.stakes_today),
      pending_deposits: Number(r.pending_deposits), pending_withdrawals: Number(r.pending_withdrawals),
      open_support: Number(r.open_support)
    }
  });
});
