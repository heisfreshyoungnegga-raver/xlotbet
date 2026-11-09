const { sql, readBody, send, guard, requireAdmin } = require('../../_lib');

module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireAdmin(req, res);
  if (!auth) return;
  const { id, status } = await readBody(req);
  if (!['active', 'blocked'].includes(status)) return send(res, 400, { error: 'invalid_status' });
  if (id === auth.uid) return send(res, 400, { error: 'cannot_change_own_status' });
  const target = await sql('select role, invited_by from users where id = $1', [id]);
  if (target.length && target[0].role !== 'player' && auth.role !== 'super_admin') {
    return send(res, 403, { error: 'only_super_admin_can_block_admins' });
  }
  // A regular admin manages only their own referred users (Prince,
  // 2026-11-05) — blocking a stranger's player is the super's job.
  if (target.length && auth.role !== 'super_admin' && target[0].invited_by !== auth.uid) {
    return send(res, 403, { error: 'not_your_referred_user' });
  }
  const rows = await sql('update users set status = $1 where id = $2 returning id', [status, id]);
  if (!rows.length) return send(res, 404, { error: 'user_not_found' });
  send(res, 200, { ok: true });
});
