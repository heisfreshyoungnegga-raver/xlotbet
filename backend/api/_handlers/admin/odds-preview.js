const { readBody, send, guard, requireSuperAdmin, expandOdds, fullBookFromOdds } = require('../../_lib');

// Price preview for the featured-match form's market editor
// (Prince, 2026-11-05): the admin can randomize the whole book —
// classic ladder plus all 30 full-book markets — from a 1X2 line
// or a favourite, then tweak any price before creating the game.
// Uses the exact generators create-match saves with, so what the
// form shows is what the game carries. FAV_PROBS mirrors the
// auto-pricing table in create-match.js.
const FAV_PROBS = {
  even: [0.36, 0.28, 0.36],
  home: [0.46, 0.27, 0.27],
  home_strong: [0.60, 0.23, 0.17],
  away: [0.27, 0.27, 0.46],
  away_strong: [0.17, 0.23, 0.60],
};

module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireSuperAdmin(req, res);
  if (!auth) return;
  const { o1, ox, o2, fav } = await readBody(req);
  let odds;
  if (Number(o1) > 1 && Number(ox) > 1 && Number(o2) > 1) {
    odds = expandOdds(Number(o1), Number(ox), Number(o2));
  } else {
    const base = FAV_PROBS[fav] || FAV_PROBS.even;
    const jit = base.map(p => Math.max(0.08, p + (Math.random() * 0.06 - 0.03)));
    const sum = jit.reduce((a, b) => a + b, 0);
    const toOdds = p => Math.max(1.02, Math.round((0.94 / (p / sum)) * 100) / 100);
    odds = expandOdds(toOdds(jit[0]), toOdds(jit[1]), toOdds(jit[2]));
  }
  if (!odds.o1) return send(res, 400, { error: 'valid_1x2_odds_required' });
  send(res, 200, { odds, odds_full: fullBookFromOdds(odds) });
});
