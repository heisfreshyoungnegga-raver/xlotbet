const { sql, readBody, send, guard, requireAuth } = require('../../_lib');
const G = require('../../_games');

// One action inside an open round — today that is a Penalty
// Shootout kick: pick a zone, the keeper picks his, state advances
// on the server and the round closes on a save or the fifth goal.
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireAuth(req, res);
  if (!auth) return;
  await G.ensureGameTables();
  const { round_id, zone } = await readBody(req);
  if (!Number.isInteger(zone) || zone < 0 || zone > 5) return send(res, 400, { error: 'invalid_zone' });
  const rows = await sql('select * from game_rounds where id = $1 and user_id = $2', [round_id, auth.uid]);
  if (!rows.length) return send(res, 404, { error: 'round_not_found' });
  const round = rows[0];
  if (round.game !== 'shootout') return send(res, 400, { error: 'wrong_game' });
  if (round.status !== 'open') return send(res, 409, { error: 'round_closed', round: G.publicRound(round) });

  const keeper = require('crypto').randomInt(6);
  const goal = keeper !== zone;
  const st = round.state || {};
  const kicks = (st.kicks || 0) + 1;
  const goals = (st.goals || 0) + (goal ? 1 : 0);
  const history = [...(st.history || []), { zone, keeper, goal }];
  const patch = { kicks, goals, history, result: { kicks, goals, last: { zone, keeper, goal } } };

  let closed = null;
  if (!goal) closed = await G.closeRound(round, 'lost', 0, patch);
  else if (kicks >= 5) closed = await G.closeRound(round, 'won', G.money2(Number(round.stake_ghs) * G.SHOOTOUT_LADDER[4]), patch);
  if (closed) return send(res, 200, { round: G.publicRound(closed), kick: { zone, keeper, goal }, balance: await G.balanceOf(auth.uid) });

  const upd = await sql(
    "update game_rounds set state = $1::jsonb where id = $2 and status = 'open' returning *",
    [JSON.stringify({ ...st, ...patch }), round.id]
  );
  if (!upd.length) return send(res, 409, { error: 'round_closed' });
  return send(res, 200, { round: G.publicRound(upd[0]), kick: { zone, keeper, goal }, balance: await G.balanceOf(auth.uid) });
});
