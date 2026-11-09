const crypto = require('crypto');
const { sql, readBody, send, guard, requireSuperAdmin, ensureAdminTables } = require('../../_lib');

// Super admin only: timed, one-time invite links. POST {kind} mints a
// token that expires (default 48h): kind 'admin' registers an admin in
// 'pending' status (super admin verifies it afterwards); kind
// 'super_admin' registers a fully active super admin — the link itself
// is the authorisation, so it is single-use and short-lived. GET lists
// the invites still outstanding.
module.exports = guard(async (req, res) => {
  const auth = requireSuperAdmin(req, res);
  if (!auth) return;
  await ensureAdminTables();
  if (req.method === 'GET') {
    const rows = await sql(
      `select i.token, i.kind, i.expires_at, i.created_at, u.phone as created_by_phone
       from invites i left join users u on u.id = i.created_by
       where i.used_by is null and i.expires_at > now()
       order by i.created_at desc limit 20`
    );
    return send(res, 200, { invites: rows });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const { kind, hours } = await readBody(req);
  const k = kind === 'super_admin' ? 'super_admin' : 'admin';
  const hrs = Math.min(Math.max(Number(hours) || 48, 1), 168);
  const token = crypto.randomBytes(18).toString('hex');
  const rows = await sql(
    `insert into invites (token, kind, created_by, expires_at)
     values ($1, $2, $3, now() + ($4 || ' hours')::interval) returning token, expires_at`,
    [token, k, auth.uid, String(hrs)]
  );
  // The link lands on the ADMIN portal's own account-creation page
  // (Prince, 2026-11-05) — an invited admin should never land on the
  // player signup and wonder where they are.
  send(res, 201, { token: rows[0].token, kind: k, expires_at: rows[0].expires_at, path: '/admin.html?admin_invite=' + rows[0].token });
});
