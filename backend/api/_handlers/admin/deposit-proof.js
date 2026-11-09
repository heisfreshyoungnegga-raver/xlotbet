const { sql, send, guard, requireAdmin } = require('../../_lib');

// The transaction screenshot a player attached to a manual deposit.
// Kept off the queue list itself (images are heavy) — the queue only
// carries a has_proof flag and the admin pulls the image on demand.
module.exports = guard(async (req, res) => {
  const auth = requireAdmin(req, res);
  if (!auth) return;
  let id = (req.query && req.query.id) || '';
  if (!id && req.url) {
    try { id = new URL(req.url, 'http://local').searchParams.get('id') || ''; } catch (e) { /* no id */ }
  }
  const rows = await sql('select proof_image from wallet_transactions where id = $1', [String(id)]);
  if (!rows.length || !rows[0].proof_image) return send(res, 404, { error: 'no_proof' });
  send(res, 200, { proof_image: rows[0].proof_image });
});
