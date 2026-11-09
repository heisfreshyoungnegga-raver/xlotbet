const { sql, hashPassword, verifyPassword, readBody, send, guard, requireAuth } = require('../../_lib');

module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { current_password, new_password } = await readBody(req);
  if (!new_password || String(new_password).length < 6) return send(res, 400, { error: 'password_too_short' });
  const rows = await sql('select * from users where id = $1', [auth.uid]);
  if (!rows.length || !verifyPassword(String(current_password || ''), rows[0].password_hash)) {
    return send(res, 401, { error: 'current_password_wrong' });
  }
  await sql('update users set password_hash = $1 where id = $2', [hashPassword(String(new_password)), auth.uid]);
  send(res, 200, { ok: true });
});
