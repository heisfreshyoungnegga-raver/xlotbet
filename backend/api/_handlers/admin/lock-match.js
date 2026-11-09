const { msql, readBody, send, guard, requireSuperAdmin, ensureMatchColumns } = require('../../_lib');

// One-click odds lock for the Matches tab (Prince, 2026-11-09): the
// super admin can lock an UPCOMING match's odds before it starts —
// betting_locked already makes the player site show the match locked
// and makes place.js refuse bets; this endpoint just flips the flag
// on any match (the edit-match lifecycle refuses feed matches, and
// locking must work on those too). Unlocking is the same call.
module.exports = guard(async (req, res) => {
  const auth = requireSuperAdmin(req, res);
  if (!auth) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const body = await readBody(req);
  const id = String(body.id || '');
  if (!id) return send(res, 400, { error: 'match_required' });
  const locked = body.locked === true || body.locked === 1 || body.locked === '1';
  await ensureMatchColumns().catch(() => {});
  const rows = await msql('update matches set betting_locked = $2 where id = $1 returning id, status, betting_locked', [id, locked]);
  if (!rows.length) return send(res, 404, { error: 'match_not_found' });
  return send(res, 200, { ok: true, id: rows[0].id, status: rows[0].status, betting_locked: rows[0].betting_locked === true });
});
