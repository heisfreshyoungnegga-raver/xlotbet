const { sql, send, guard, requireAuth } = require('../../_lib');
const G = require('../../_games');

// The player's own recent rounds plus the platform's latest settled
// rounds (real rows only, names masked) for the lobby strips.
module.exports = guard(async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireAuth(req, res);
  if (!auth) return;
  await G.ensureGameTables();
  const game = req.query && req.query.game;
  const mine = await sql(
    `select * from game_rounds where user_id = $1 ${game && G.GAME_NAMES[game] ? 'and game = $2' : ''}
     order by created_at desc limit 20`,
    game && G.GAME_NAMES[game] ? [auth.uid, game] : [auth.uid]
  );
  const recent = await sql(
    `select r.game, r.stake_ghs, r.payout_ghs, r.status, r.created_at, r.state,
            coalesce(u.display_name, u.phone, 'Player') as who
     from game_rounds r join users u on u.id = r.user_id
     where r.status != 'open'
     order by r.settled_at desc nulls last limit 20`
  );
  send(res, 200, {
    mine: mine.map(r => G.publicRound(r)),
    recent: recent.map(r => ({
      game: r.game, who: String(r.who).slice(0, 2) + '***',
      stake: Number(r.stake_ghs), payout: Number(r.payout_ghs), status: r.status, at: r.created_at,
      // A settled Aviator flight's crash point is public proof, so
      // the recent strip can show it (the seed itself stays private
      // to the player who flew it).
      crash: r.game === 'aviator' ? (r.state || {}).crash : undefined,
    })),
  });
});
