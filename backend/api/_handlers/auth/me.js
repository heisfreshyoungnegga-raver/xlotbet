const { sql, send, guard, requireAuth, publicUser } = require('../../_lib');

module.exports = guard(async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const rows = await sql('select * from users where id = $1', [auth.uid]);
  if (!rows.length) return send(res, 404, { error: 'user_not_found' });
  send(res, 200, { user: publicUser(rows[0]) });
});
