const { sql, readBody, send, guard, requireAuth } = require('../../_lib');
const G = require('../../_games');

// Cash out an open Aviator flight or Shootout ladder. The credit
// lands in the same statement that closes the round, so a round
// can never pay twice no matter how the request races.
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireAuth(req, res);
  if (!auth) return;
  await G.ensureGameTables();
  const { round_id } = await readBody(req);
  const rows = await sql('select * from game_rounds where id = $1 and user_id = $2', [round_id, auth.uid]);
  if (!rows.length) return send(res, 404, { error: 'round_not_found' });
  let round = rows[0];

  if (round.game === 'aviator') {
    round = await G.syncAviator(round); // may settle as auto-cash or crash first
    if (round.status === 'open') {
      const elapsed = Date.now() - new Date(round.state.started_at).getTime();
      const mult = Math.floor(G.multiplierAt(elapsed) * 100) / 100;
      if (mult >= round.state.crash) {
        round = (await G.closeRound(round, 'lost', 0, { final_mult: round.state.crash })) || round;
      } else {
        round = (await G.closeRound(round, 'cashed', G.money2(Number(round.stake_ghs) * mult), { cashed_at_mult: mult })) || round;
      }
    }
    return send(res, 200, { round: G.publicRound(round), balance: await G.balanceOf(auth.uid) });
  }
  if (round.game === 'shootout') {
    if (round.status !== 'open') return send(res, 409, { error: 'round_closed', round: G.publicRound(round) });
    const goals = (round.state && round.state.goals) || 0;
    if (!goals) return send(res, 400, { error: 'nothing_to_cash', detail: 'Score at least one goal before cashing out.' });
    round = (await G.closeRound(round, 'cashed', G.money2(Number(round.stake_ghs) * G.SHOOTOUT_LADDER[goals - 1]), {})) || round;
    return send(res, 200, { round: G.publicRound(round), balance: await G.balanceOf(auth.uid) });
  }
  return send(res, 400, { error: 'not_cashable' });
});
