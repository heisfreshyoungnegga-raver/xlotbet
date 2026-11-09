const { sql, readBody, send, guard, requireSuperAdmin } = require('../../_lib');

// Super admin only: change a user's role (player / admin / super_admin).
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireSuperAdmin(req, res);
  if (!auth) return;
  const { id, role } = await readBody(req);
  if (!['player', 'admin', 'super_admin'].includes(role)) return send(res, 400, { error: 'invalid_role' });
  if (id === auth.uid && role !== 'super_admin') return send(res, 400, { error: 'cannot_demote_yourself' });
  const rows = await sql('update users set role = $1 where id = $2 returning id', [role, id]);
  if (!rows.length) return send(res, 404, { error: 'user_not_found' });
  send(res, 200, { ok: true });
});
