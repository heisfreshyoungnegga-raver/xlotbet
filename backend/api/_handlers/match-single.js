const { msql: sql, send, guard, fillOdds, isCustomMatch, customMatchState, ensureMatchColumns } = require('../_lib');

// One match, in full: the list endpoint ships a has_full flag and
// keeps the heavy market book out of the list payload; the details
// page fetches the book for a single match from here. This used to
// be the exact route api/match.js — it moved under _handlers when
// the Vercel Hobby function limit forced a consolidation
// (2026-11-04): /api/match now rewrites to /api/matches (see
// vercel.json), and matches.js delegates here when an id is given.
// Railway's server.js mounts matches.js for /api/match the same way.
module.exports = guard(async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
  const id = req.query && req.query.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(String(id))) return send(res, 400, { error: 'match_required' });
  await ensureMatchColumns().catch(() => {});
  const rows = await sql(
    `select id, league, home_team, away_team, starts_at, status, minute,
            score_home, score_away, odds, odds_full, home_logo, away_logo, external_ref, goal_events, betting_locked,
            ht_stoppage, ft_stoppage
     from matches where id = $1`,
    [id]
  );
  if (!rows.length) return send(res, 404, { error: 'match_not_found' });
  const m = rows[0];
  let out = { ...m, odds: fillOdds(m.odds), goal_events: undefined };
  if (isCustomMatch(m)) {
    const st = customMatchState(m, new Date());
    out = { ...out, status: st.status, minute: st.minute, minute_label: st.minute_label, score_home: st.score_home, score_away: st.score_away };
  }
  send(res, 200, { match: out });
});
