const crypto = require('crypto');
const { sql, msql, readBody, send, guard, requireSuperAdmin, ensureAdminTables, ensureMatchColumns, expandOdds, fullBookFromOdds, cleanGoalSchedule, cleanCrestUrl } = require('../../_lib');

// Super admin only: create a "featured" match that plays like a real
// one. Two ways in (Prince's design, 2026-11-03):
//  - MANUAL: the super admin sets league, teams, kickoff, the 1X2
//    prices and the goal schedule (which minute each goal lands).
//  - AUTO: whatever he leaves blank is generated — fictional team
//    names from the bank below, odds priced from who he makes the
//    favourite, and a random goal schedule that matches the odds
//    (the favourite scores more). He can type only the team names,
//    or nothing at all.
// The public feed derives the live clock and score from the goal
// schedule, settlement uses the scheduled final score, and the full
// odds book (Double Chance, Over/Under ladder, BTTS) is priced from
// the 1X2 line.
const NAME_A = ['Accra', 'Tema', 'Kumasi', 'Osu', 'Spintex', 'Takoradi', 'Madina', 'Legon', 'Achimota', 'Dansoman', 'Kasoa', 'Ho', 'Tamale', 'Cape Coast', 'Sunyani', 'Koforidua', 'Nungua', 'Teshie', 'Ashaiman', 'Winneba'];
const NAME_B = ['Falcons', 'Royals', 'Iron', 'City', 'Stars', 'Lions', 'Warriors', 'United', 'Rovers', 'Athletic', 'Giants', 'Eagles', 'Sharks', 'Kings', 'Pirates', 'Rangers'];
const pickOne = arr => arr[crypto.randomInt(arr.length)];
function teamName(taken) {
  let n = pickOne(NAME_A) + ' ' + pickOne(NAME_B);
  while (taken.includes(n)) n = pickOne(NAME_A) + ' ' + pickOne(NAME_B);
  return n;
}
// Base 1X2 probabilities per favourite choice; jittered per game so
// auto fixtures do not all price identically.
const FAV_PROBS = {
  even: [0.36, 0.28, 0.36],
  home: [0.46, 0.27, 0.27],
  home_strong: [0.60, 0.23, 0.17],
  away: [0.27, 0.27, 0.46],
  away_strong: [0.17, 0.23, 0.60],
};
function poisson(lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireSuperAdmin(req, res);
  if (!auth) return;
  await ensureAdminTables();
  await ensureMatchColumns().catch(() => {});
  const { league, home_team, away_team, starts_at, o1, ox, o2, goals, fav, ht_stoppage, ft_stoppage, home_logo, away_logo, odds_full, betting_locked } = await readBody(req);
  // Match-level stoppage (Prince, 2026-11-05): minutes added to each
  // half, 0-15. Crests ("flags") are a URL or a small data image the
  // portal downscaled; anything else is ignored.
  const clampStop = v => Math.min(15, Math.max(0, Math.round(Number(v) || 0)));
  const htStop = clampStop(ht_stoppage);
  const ftStop = clampStop(ft_stoppage);
  const homeLogo = cleanCrestUrl(home_logo);
  const awayLogo = cleanCrestUrl(away_logo);
  // A crest the admin actually provided must never vanish silently
  // (Prince, 2026-11-08): reject loudly instead of storing nothing.
  if ((home_logo && !homeLogo) || (away_logo && !awayLogo)) {
    return send(res, 400, { error: 'crest_invalid', detail: 'That crest image could not be accepted — use an image link or a smaller uploaded image.' });
  }

  let home = String(home_team || '').trim();
  let away = String(away_team || '').trim();
  if (!home) home = teamName([away]);
  if (!away || away === home) away = teamName([home]);
  const leagueName = String(league || '').trim() || 'Oddaroa Featured';

  const start = starts_at ? new Date(starts_at) : new Date(Date.now() + 30 * 60000);
  if (Number.isNaN(start.getTime())) return send(res, 400, { error: 'invalid_start_time' });

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
  if (!odds.o1) return send(res, 400, { error: 'valid_1x2_odds_required', detail: 'Home, draw and away odds must all be above 1.00.' });

  // Goals are COMPULSORY (Prince's order, 2026-11-05): a created
  // match runs ONLY the script the super admin built — the server
  // no longer invents a schedule when none is supplied. An empty
  // array is the explicit 0-0 script (the form sends it only when
  // the "No goals" box is ticked).
  if (!Array.isArray(goals)) {
    return send(res, 400, { error: 'goals_required', detail: 'The goal script is compulsory — build the goals in the form (or tick "No goals" for a 0-0 match). The match must run exactly what the super admin set.' });
  }
  let cleanGoals = cleanGoalSchedule(goals);
  if (goals.length && !cleanGoals.length) {
    return send(res, 400, { error: 'invalid_goals', detail: 'No valid goals in the script — minutes must be 1-90 (stoppage like 45+2 is fine), sides home or away.' });
  }

  // The full market book (Correct Score, HT/FT, half markets,
  // handicaps, margins...) is derived from the same 1X2 line, so
  // typed prices and the autofill/randomizer produce it alike
  // (Prince, 2026-11-05).
  const derivedFull = fullBookFromOdds(odds);
  // Admin-specified prices from the form's market editor override
  // the derived book market-by-market; anything unspecified keeps
  // its derived price, so the game always carries the full book.
  // Only markets the generator itself can settle are accepted.
  let oddsFull = derivedFull;
  if (Array.isArray(odds_full) && odds_full.length) {
    const allowed = new Map(derivedFull.map(b => [b.name, b]));
    const byName = new Map();
    for (const mkt of odds_full.slice(0, 40)) {
      if (!mkt || !allowed.has(mkt.name) || !Array.isArray(mkt.values)) continue;
      const seen = new Set();
      const values = [];
      for (const v of mkt.values.slice(0, 64)) {
        const value = String(v && v.value != null ? v.value : '').trim().slice(0, 40);
        const odd = Math.round(Number(v && v.odd) * 100) / 100;
        if (!value || seen.has(value) || !(odd > 1) || odd > 1000) continue;
        seen.add(value);
        values.push({ value, odd });
      }
      if (values.length >= 2) byName.set(mkt.name, { id: allowed.get(mkt.name).id, name: mkt.name, values });
    }
    if (byName.size) oddsFull = derivedFull.map(b => byName.get(b.name) || b);
  }
  const rows = await msql(
    `insert into matches (league, home_team, away_team, starts_at, odds, external_ref, goal_events, home_logo, away_logo, ht_stoppage, ft_stoppage, odds_full, betting_locked)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10, $11, $12::jsonb, $13) returning *`,
    [leagueName.slice(0, 80), home.slice(0, 80), away.slice(0, 80),
     start.toISOString(), JSON.stringify(odds), 'custom:' + crypto.randomUUID(), JSON.stringify(cleanGoals),
     homeLogo, awayLogo, htStop, ftStop, oddsFull.length ? JSON.stringify(oddsFull) : null, !!betting_locked]
  );
  send(res, 201, { match: rows[0] });
});
