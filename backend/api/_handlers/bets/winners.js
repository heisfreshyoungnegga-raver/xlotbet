const { sql, send, guard } = require('../../_lib');

const GAME_NAMES = {
  aviator: 'Aviator', plinko: 'Plinko X', dice: 'Lucky Dice',
  coinflip: 'Coin Flip', shootout: 'Penalty Shootout', penalty: 'Football Penalty',
};
function maskPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  const local = d.length > 9 ? '0' + d.slice(-9) : d;
  return local.length >= 6 ? local.slice(0, 3) + '****' + local.slice(-3) : 'Player';
}

// Winning Cup (Prince, 2026-11-05): the biggest REAL wins of the
// last 30 days — settled betslips and casino game rounds — ranked
// on one board. Phones are masked the same way as the home winners
// ticker; nothing here is invented, an empty board just means no
// big win has landed yet.
module.exports = guard(async (req, res) => {
  const [bets, games] = await Promise.all([
    sql(`select b.code, b.potential_ghs::float as won, b.settled_at as at, u.phone
           from bets b join users u on u.id = b.user_id
          where b.status = 'won' and b.settled_at > now() - interval '30 days'
          order by b.potential_ghs desc limit 30`),
    sql(`select g.game, g.payout_ghs::float as won, g.settled_at as at, u.phone
           from game_rounds g join users u on u.id = g.user_id
          where g.payout_ghs > g.stake_ghs and g.settled_at > now() - interval '30 days'
          order by g.payout_ghs desc limit 30`)
  ]);
  const rows = [
    ...bets.map(b => ({ who: maskPhone(b.phone), won: Number(b.won), what: 'Betslip ' + b.code, at: b.at })),
    ...games.map(g => ({ who: maskPhone(g.phone), won: Number(g.won), what: GAME_NAMES[g.game] || g.game, at: g.at }))
  ].sort((a, b) => b.won - a.won).slice(0, 20);
  send(res, 200, { winners: rows });
});
