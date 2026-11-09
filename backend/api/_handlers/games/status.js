const { sql, send, guard, requireAuth } = require('../../_lib');
const G = require('../../_games');

// Poll one round. For Aviator this is also the settler of last
// resort: auto cash-outs and crashes are applied here so a flight
// resolves even if the player closes the tab mid-air.
module.exports = guard(async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireAuth(req, res);
  if (!auth) return;
  await G.ensureGameTables();
  const id = req.query && req.query.round_id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(String(id))) return send(res, 400, { error: 'round_required' });
  const rows = await sql('select * from game_rounds where id = $1 and user_id = $2', [id, auth.uid]);
  if (!rows.length) return send(res, 404, { error: 'round_not_found' });
  let round = rows[0];
  if (round.game === 'aviator') round = await G.syncAviator(round);
  const extra = {};
  if (round.game === 'aviator' && round.status === 'open') {
    const elapsed = Date.now() - new Date(round.state.started_at).getTime();
    extra.current_multiplier = Math.floor(G.multiplierAt(elapsed) * 100) / 100;
  }
  send(res, 200, { round: G.publicRound(round, extra), balance: await G.balanceOf(auth.uid), server_now: Date.now() });
});
