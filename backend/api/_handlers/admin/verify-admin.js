const { sql, readBody, send, guard, requireSuperAdmin, ensureAdminTables } = require('../../_lib');

// Super admin only: decide on an invited admin account that is waiting
// in 'pending'. verify -> active admin. remove -> stripped back to a
// blocked player, so the account can never sign in as an admin.
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireSuperAdmin(req, res);
  if (!auth) return;
  await ensureAdminTables();
  const { id, action } = await readBody(req);
  if (!id || !['verify', 'remove'].includes(action)) return send(res, 400, { error: 'id_and_action_required' });
  if (id === auth.uid) return send(res, 400, { error: 'cannot_change_yourself' });
  let rows;
  if (action === 'verify') {
    rows = await sql("update users set status = 'active' where id = $1 and role = 'admin' and status = 'pending' returning id", [id]);
  } else {
    rows = await sql("update users set role = 'player', status = 'blocked' where id = $1 and role = 'admin' returning id", [id]);
  }
  if (!rows.length) return send(res, 404, { error: 'pending_admin_not_found' });
  send(res, 200, { ok: true });
});
