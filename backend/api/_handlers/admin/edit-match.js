const { sql, msql, readBody, send, guard, requireSuperAdmin, ensureMatchColumns, isCustomMatch, customMatchState, expandOdds, fullBookFromOdds, cleanGoalSchedule, cleanCrestUrl } = require('../../_lib');

// Super admin only: edit a game HE created (a featured/custom match
// or a manual one) — Prince, 2026-11-05. Names, league, crests and
// stoppages can change any time before the game finishes; kickoff,
// the 1X2 odds and the goal schedule lock at kickoff, because bets
// are placed against them.
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireSuperAdmin(req, res);
  if (!auth) return;
  await ensureMatchColumns().catch(() => {});
  const body = await readBody(req);
  const id = String(body.id || '');
  if (!id) return send(res, 400, { error: 'match_required' });
  const rows = await msql('select * from matches where id = $1', [id]);
  if (!rows.length) return send(res, 404, { error: 'match_not_found' });
  const m = rows[0];
  const custom = isCustomMatch(m);
  if (!custom && m.external_ref) {
    return send(res, 400, { error: 'not_a_created_match', detail: 'Only games you created can be edited — this one came from a feed.' });
  }
  // Lifecycle actions (Prince, 2026-11-05): postpone and delete.
  if (body.action === 'delete') {
    const cnt = await sql('select count(*)::int as n from bet_selections where match_id = $1', [id]);
    if (cnt[0].n > 0) {
      return send(res, 409, { error: 'match_has_bets', detail: 'This game has ' + cnt[0].n + ' bet(s) on it — postpone it instead. Deleting would break those bet records.' });
    }
    await msql('delete from matches where id = $1', [id]);
    return send(res, 200, { ok: true, deleted: true });
  }
  if (body.action === 'postpone') {
    const st = custom ? customMatchState(m) : null;
    if ((custom && st.status === 'finished') || (!custom && m.status === 'finished')) {
      return send(res, 409, { error: 'match_finished', detail: 'This game has already finished.' });
    }
    if (m.status === 'postponed') return send(res, 409, { error: 'already_postponed', detail: 'This game is already postponed.' });
    // Snapshot the current score so the frozen game shows where it
    // stopped; the derived clock respects the stored status.
    const snapH = custom ? st.score_home : m.score_home;
    const snapA = custom ? st.score_away : m.score_away;
    const upd = await msql("update matches set status = 'postponed', score_home = $2, score_away = $3 where id = $1 returning *", [id, snapH, snapA]);
    return send(res, 200, { ok: true, match: upd[0] });
  }
  let kickedOff, finished;
  const startedAlready = new Date(m.starts_at) <= new Date();
  if (custom) {
    const st = customMatchState(m);
    finished = st.status === 'finished';
    kickedOff = st.status === 'live' || (st.status === 'postponed' && startedAlready);
  } else {
    finished = m.status === 'finished';
    kickedOff = m.status === 'live' || (m.status === 'postponed' && startedAlready);
  }
  if (finished) return send(res, 409, { error: 'match_finished', detail: 'This game has finished and can no longer be edited.' });
  if (kickedOff && (body.starts_at !== undefined || body.goals !== undefined || body.o1 !== undefined || body.ox !== undefined || body.o2 !== undefined || body.odds_full !== undefined)) {
    return send(res, 409, { error: 'match_already_live', detail: 'Kickoff, odds and the goal schedule lock once the game has kicked off. Names, crests and stoppages can still be edited.' });
  }

  const sets = [], vals = [];
  const put = (col, v, cast) => { vals.push(v); sets.push(col + ' = $' + vals.length + (cast ? '::' + cast : '')); };
  const name = (v, cur) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, 80) : cur; };
  const clampStop = v => Math.min(15, Math.max(0, Math.round(Number(v) || 0)));

  if (body.league !== undefined) put('league', name(body.league, m.league));
  if (body.home_team !== undefined) put('home_team', name(body.home_team, m.home_team));
  if (body.away_team !== undefined) put('away_team', name(body.away_team, m.away_team));
  if (body.home_logo !== undefined || body.away_logo !== undefined) {
    const hl = body.home_logo === undefined ? undefined : cleanCrestUrl(body.home_logo);
    const al = body.away_logo === undefined ? undefined : cleanCrestUrl(body.away_logo);
    if ((body.home_logo && !hl) || (body.away_logo && !al)) {
      return send(res, 400, { error: 'crest_invalid', detail: 'That crest image could not be accepted — use an image link or a smaller uploaded image.' });
    }
    if (hl !== undefined) put('home_logo', hl);
    if (al !== undefined) put('away_logo', al);
  }
  // The betting lock is a safety switch, not a price: the super
  // admin can flip it even while the game is live (Prince, 2026-11-07
  // — full edit control over his created games).
  if (body.betting_locked !== undefined) put('betting_locked', !!body.betting_locked);
  if (custom && body.ht_stoppage !== undefined) put('ht_stoppage', clampStop(body.ht_stoppage));
  if (custom && body.ft_stoppage !== undefined) put('ft_stoppage', clampStop(body.ft_stoppage));

  if (!kickedOff) {
    if (body.starts_at) {
      const d = new Date(body.starts_at);
      if (Number.isNaN(d.getTime())) return send(res, 400, { error: 'invalid_start_time' });
      put('starts_at', d.toISOString());
      // A postponed game given a new kickoff comes back to life.
      if (m.status === 'postponed') put('status', 'upcoming');
    }
    if (custom && Array.isArray(body.goals)) put('goal_events', JSON.stringify(cleanGoalSchedule(body.goals)), 'jsonb');
    const { o1, ox, o2 } = body;
    if (Number(o1) > 1 && Number(ox) > 1 && Number(o2) > 1) {
      let newOdds;
      if (custom) {
        newOdds = expandOdds(Number(o1), Number(ox), Number(o2));
      } else {
        const cur = m.odds && typeof m.odds === 'object' ? m.odds : {};
        newOdds = { ...cur, o1: Number(o1), ox: Number(ox), o2: Number(o2) };
      }
      put('odds', JSON.stringify(newOdds), 'jsonb');
      // The full book follows the 1X2 line it was derived from.
      const full = fullBookFromOdds(newOdds);
      if (full.length) put('odds_full', JSON.stringify(full), 'jsonb');
    }
    // All-markets editor (Prince, 2026-11-07): prices the super
    // admin typed for specific markets win over the derived book —
    // same acceptance rules as the create form (only markets the
    // generator can settle, prices in (1, 1000], at least 2 values).
    if (custom && Array.isArray(body.odds_full) && body.odds_full.length) {
      const base = (Number(o1) > 1 && Number(ox) > 1 && Number(o2) > 1)
        ? expandOdds(Number(o1), Number(ox), Number(o2))
        : (m.odds && typeof m.odds === 'object' ? m.odds : {});
      const derivedFull = fullBookFromOdds(base);
      if (derivedFull.length) {
        const allowed = new Map(derivedFull.map(b => [b.name, b]));
        const byName = new Map();
        for (const mkt of body.odds_full.slice(0, 40)) {
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
        if (byName.size) {
          const merged = derivedFull.map(b => byName.get(b.name) || b);
          // Replace any odds_full queued by the 1X2 branch above.
          const ix = sets.findIndex(x => x.indexOf('odds_full') === 0);
          if (ix >= 0) { vals[ix] = JSON.stringify(merged); }
          else put('odds_full', JSON.stringify(merged), 'jsonb');
        }
      }
    }
  }
  if (!sets.length) return send(res, 400, { error: 'nothing_to_update' });
  vals.push(id);
  const upd = await msql('update matches set ' + sets.join(', ') + ' where id = $' + vals.length + ' returning *', vals);
  send(res, 200, { match: upd[0] });
});
