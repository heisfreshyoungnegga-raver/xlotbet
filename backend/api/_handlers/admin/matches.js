const { sql, msql, readBody, send, guard, requireAdmin, ensureMatchColumns, isCustomMatch, customMatchState, fillOdds, fullBookFromOdds } = require('../../_lib');

// Admin match manager: list all matches, create new ones, and update
// live state (status, minute, score). Custom (featured) matches carry
// no stored live state — theirs is derived from the clock, so the
// list enriches them with the derived status, score and label.
module.exports = guard(async (req, res) => {
  const auth = requireAdmin(req, res);
  if (!auth) return;
  if (req.method === 'GET') {
    await ensureMatchColumns().catch(() => {});
    // ?created=1 returns ONLY the games the admin side created
    // (featured + manual). The general list is capped at 200 by
    // kickoff, and feed sweeps run five days ahead — created games
    // would fall off the end and vanish from their own section.
    const onlyCreated = req.query && String(req.query.created || '') === '1';
    const rows = onlyCreated
      ? await msql("select * from matches where external_ref like 'custom:%' or external_ref is null order by starts_at desc limit 200")
      : await msql('select * from matches order by starts_at desc limit 200');
    const now = new Date();
    const out = rows.map(m => {
      if (!isCustomMatch(m)) return m;
      const st = customMatchState(m, now);
      return { ...m, status: st.status, minute: st.minute, minute_label: st.minute_label, phase: st.phase, score_home: st.score_home, score_away: st.score_away };
    });
    return send(res, 200, { matches: out });
  }
  const body = await readBody(req);
  if (req.method === 'POST') {
    const { league, home_team, away_team, starts_at, odds } = body;
    if (!league || !home_team || !away_team || !starts_at) return send(res, 400, { error: 'league_home_away_time_required' });
    // Manual matches get the same derived full book as featured
    // ones, priced from the completed 1X2 line (Prince, 2026-11-05).
    const full = fullBookFromOdds(fillOdds(odds || {}));
    const rows = await msql(
      'insert into matches (league, home_team, away_team, starts_at, odds, odds_full) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb) returning *',
      [league, home_team, away_team, starts_at, JSON.stringify(odds || {}), full.length ? JSON.stringify(full) : null]
    );
    return send(res, 201, { match: rows[0] });
  }
  if (req.method === 'PATCH') {
    const { id, status, minute, score_home, score_away, odds } = body;
    // A price change re-derives the full book from the new 1X2 line.
    const full = odds ? fullBookFromOdds(fillOdds(odds)) : null;
    const rows = await msql(
      `update matches set
         status = coalesce($2, status),
         minute = coalesce($3, minute),
         score_home = coalesce($4, score_home),
         score_away = coalesce($5, score_away),
         odds = coalesce($6::jsonb, odds),
         odds_full = coalesce($7::jsonb, odds_full)
       where id = $1 returning *`,
      [id, status || null, minute ?? null, score_home ?? null, score_away ?? null, odds ? JSON.stringify(odds) : null, full && full.length ? JSON.stringify(full) : null]
    );
    if (!rows.length) return send(res, 404, { error: 'match_not_found' });
    return send(res, 200, { match: rows[0] });
  }
  send(res, 405, { error: 'method_not_allowed' });
});
