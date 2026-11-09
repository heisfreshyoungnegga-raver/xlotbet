const { sql, matchesById, send, guard, requireAuth, getSettings, cashoutQuoteFor, isCustomMatch, customMatchState, livePriceFor, currentPickOdds } = require('../../_lib');

module.exports = guard(async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const rows = await sql(
    `select b.id, b.code, b.booking_code, b.stake_ghs, b.total_odds, b.potential_ghs, b.status, b.placed_at, b.settled_at, b.kind, b.bonus_pct, b.system_label, b.payout_ghs,
            coalesce(json_agg(json_build_object(
              'match_id', s.match_id, 'market', s.market, 'pick', s.pick,
              'odds', s.odds, 'result', s.result
            ) order by s.id) filter (where s.id is not null), '[]') as selections
     from bets b
     left join bet_selections s on s.bet_id = b.id
     where b.user_id = $1
     group by b.id
     order by b.placed_at desc
     limit 100`,
    [auth.uid]
  );
  // Team facts are hydrated from the catalog DB — matches moved to
  // their own Neon project on 2026-11-07, so the core query can no
  // longer join them. A catalog outage degrades names to null
  // instead of failing the whole Bets page.
  const matchMap = await matchesById(
    rows.flatMap(b => (b.selections || []).map(x => x.match_id))
  ).catch(() => new Map());
  for (const b of rows) {
    for (const x of (b.selections || [])) {
      const m = matchMap.get(x.match_id);
      x.home_team = m ? m.home_team : null;
      x.away_team = m ? m.away_team : null;
      x.league = m ? m.league : null;
      x.starts_at = m ? m.starts_at : null;
    }
  }
  // Attach a live cashout quote to each open ticket (null when no
  // cashout is offered — e.g. a leg is live — and the client then
  // shows no button and no message, Prince's rule, 2026-11-05).
  const openIds = rows.filter(b => b.status === 'open').map(b => b.id);
  if (openIds.length) {
    const selLegs = await sql(
      'select bet_id, match_id, market, pick, result from bet_selections where bet_id = any($1::uuid[])',
      [openIds]
    );
    const legMatches = await matchesById(selLegs.map(r => r.match_id)).catch(() => new Map());
    const legs = selLegs.map(r => ({ bet_id: r.bet_id, market: r.market, pick: r.pick, result: r.result, match: legMatches.get(r.match_id) || null }));
    const settings = await getSettings(['cashout_margin_pct']);
    const byBet = new Map();
    for (const l of legs) {
      if (!byBet.has(l.bet_id)) byBet.set(l.bet_id, []);
      byBet.get(l.bet_id).push(l);
    }
    const matchById = new Map();
    for (const l of legs) if (l.match && l.match.id) matchById.set(l.match.id, l.match);
    for (const b of rows) {
      if (b.status !== 'open') continue;
      b.cashout_ghs = cashoutQuoteFor(b, byBet.get(b.id) || [], settings.cashout_margin_pct);
      // Live state per leg (Prince's ask 2026-11-05, same as
      // PrimeStake): the Bets view shows a leg's match as LIVE with
      // its current score and clock instead of a bare "pending".
      // Custom matches derive state from their real football clock
      // (minute_label carries 45+2′ / HT / 90+3′); feed matches use
      // their stored status and score.
      for (const s of (b.selections || [])) {
        const m = matchById.get(s.match_id);
        if (!m) continue;
        if (isCustomMatch(m)) {
          const st = customMatchState(m);
          s.match_status = st.status;
          s.live_home = st.score_home;
          s.live_away = st.score_away;
          s.live_minute = st.minute;
          s.live_label = st.minute_label || null;
        } else {
          s.match_status = m.status;
          s.live_home = m.score_home;
          s.live_away = m.score_away;
          // Feed matches DO carry a live clock: both ingests keep
          // matches.minute current while a game is in play (Prince's
          // reference shows the time on the ticket, 2026-11-06).
          s.live_minute = m.minute != null ? Number(m.minute) : null;
          s.live_label = null;
        }
        // The pick's CURRENT price (Prince, 2026-11-06: the odds
        // must move as the match is live, based on the score): for
        // a live match it is the modelled in-play price, for an
        // upcoming one the book's current stored price.
        if (!s.result || s.result === 'pending') {
          try {
            if (s.match_status === 'live') {
              const src = isCustomMatch(m)
                ? { ...m, status: 'live', score_home: s.live_home, score_away: s.live_away, minute: s.live_minute }
                : m;
              s.now_odds = livePriceFor(src, s.market, s.pick);
            } else if (s.match_status === 'upcoming') {
              s.now_odds = currentPickOdds(m, s.market, s.pick);
            } else s.now_odds = null;
          } catch (e) { s.now_odds = null; }
        }
      }
      // Live potential (Prince, 2026-11-06): what this ticket
      // returns if the live prices froze now — the user's stake
      // carried by the moving odds. Singles and multiples only;
      // system tickets price per combination, so they keep the
      // static potential.
      if ((b.kind === 'multiple' || b.kind === 'single') &&
          (b.selections || []).some(x => x.match_status === 'live')) {
        let prod = 1, dead = false;
        for (const s of b.selections) {
          if (s.result === 'lost') { dead = true; break; }
          prod *= s.result === 'won' ? (Number(s.odds) || 1) : (Number(s.now_odds || s.odds) || 1);
        }
        // The cap is Prince's rule (2026-11-08): the potential win
        // may NEVER pass the ticket's real win amount. Live prices
        // drifting up made a 600 @ 29.57 ticket (true win 17,742)
        // display a 73,470 "potential" it could never pay.
        b.live_potential_ghs = dead ? 0
          : Math.min(
              Math.round(Number(b.stake_ghs) * prod * (1 + (Number(b.bonus_pct) || 0) / 100) * 100) / 100,
              Number(b.potential_ghs) || Infinity
            );
      }
    }
  }
  // Honest win percentile for the celebration popup: among all
  // betslips that WON in the last 30 days, the share that paid less
  // than this ticket. Needs a real sample (>= 5 wins) or it stays
  // null and the client hides the panel.
  const wonMine = rows.filter(b => b.status === 'won');
  if (wonMine.length) {
    const stats = await sql(
      `select potential_ghs from bets where status = 'won' and settled_at > now() - interval '30 days'`
    );
    if (stats.length >= 5) {
      const pots = stats.map(r => Number(r.potential_ghs));
      for (const b of wonMine) {
        const below = pots.filter(p => p < Number(b.potential_ghs)).length;
        b.win_pct = Math.round(100 * below / pots.length);
      }
    }
  }
  send(res, 200, { bets: rows });
});
