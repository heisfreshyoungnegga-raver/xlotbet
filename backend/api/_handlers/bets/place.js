const { sql, msql, readBody, send, guard, requireAuth, betCode, keyFor, isCustomMatch, customMatchState, fillOdds, winBonusPct, combinations, ensureBetColumns, ensureBookingCode } = require('../../_lib');

// Place bet(s) from the slip: Single (one ticket per selection, each
// with its own stake), Multiple (one accumulator ticket) or System
// (every k-of-n combination as its own ticket, one stake per
// combination). Multiples and system tickets earn the winnings bonus
// (winBonusPct by legs), folded into potential_ghs at placement —
// settlement pays potential_ghs, so payouts include the bonus with
// no settler change. Odds are read back from the database (never
// trusted from the client), and the single total debit + all tickets
// + selections + one ledger entry happen in ONE statement, so money
// can never half-move.
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireAuth(req, res);
  if (!auth) return;
  await ensureBetColumns();
  const body = await readBody(req);
  const { selections } = body;
  const mode = ['single', 'system'].includes(body.mode) ? body.mode : 'multiple';
  if (!Array.isArray(selections) || !selections.length) return send(res, 400, { error: 'no_selections' });
  if (selections.length > 20) return send(res, 400, { error: 'too_many_selections' });

  const ids = [...new Set(selections.map(s => String(s.match_id)))];
  // A malformed id must be a clean 400, not a Postgres uuid error.
  if (ids.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    return send(res, 400, { error: 'invalid_match_id' });
  }
  const matchRows = await msql('select id, status, odds, odds_full, starts_at, external_ref, goal_events, score_home, score_away, betting_locked from matches where id = any($1::uuid[])', [ids]);
  const byId = new Map(matchRows.map(m => [m.id, m]));

  const clean = [];
  const seenMatches = new Set();
  for (const s of selections) {
    const m = byId.get(String(s.match_id));
    if (!m) return send(res, 400, { error: 'match_not_found' });
    if (m.status === 'finished') return send(res, 400, { error: 'match_finished' });
    // Featured matches finish by the clock even while their stored
    // status still says upcoming — never sell a bet on a finished one.
    if (isCustomMatch(m) && customMatchState(m).status === 'finished') return send(res, 400, { error: 'match_finished' });
    // Live matches are locked (Prince, 2026-11-04, the GoalsVault
    // way): the feed carries pre-match prices, so selling them
    // in-play would let punters bet on a score they can already
    // see. Betting closes at kickoff, on every match.
    if (m.status === 'live') return send(res, 400, { error: 'match_live_locked' });
    if (isCustomMatch(m) && customMatchState(m).status === 'live') return send(res, 400, { error: 'match_live_locked' });
    if (m.status === 'postponed') return send(res, 400, { error: 'match_postponed' });
    if (isCustomMatch(m) && customMatchState(m).status === 'postponed') return send(res, 400, { error: 'match_postponed' });
    // Operator-locked games are visible but not bettable (the
    // featured form's "Lock betting" switch, Prince, 2026-11-05).
    if (m.betting_locked) return send(res, 400, { error: 'betting_locked' });
    if (seenMatches.has(m.id)) return send(res, 400, { error: 'one_selection_per_match' });
    seenMatches.add(m.id);
    const key = keyFor(s.market, s.pick);
    let odds = key ? Number(fillOdds(m.odds)[key]) : NaN;
    if (!(odds > 1)) {
      // Full-book market (API-Football): the price lives in the
      // stored book under the market's real name, not the flat map.
      const book = Array.isArray(m.odds_full) ? m.odds_full.find(b => b.name === s.market) : null;
      const v = book ? book.values.find(x => String(x.value) === String(s.pick)) : null;
      odds = v ? Number(v.odd) : NaN;
    }
    if (!(odds > 1)) return send(res, 400, { error: 'market_unavailable' });
    clean.push({ match_id: m.id, market: s.market, pick: s.pick, odds });
  }

  // Build the tickets for the requested mode.
  let tickets = [];
  if (mode === 'single') {
    for (let i = 0; i < clean.length; i++) {
      const st = Number((selections[i] && selections[i].stake_ghs) != null ? selections[i].stake_ghs : body.stake_ghs);
      if (!(st > 0)) return send(res, 400, { error: 'invalid_stake' });
      tickets.push({ sels: [clean[i]], stake: Math.round(st * 100) / 100, kind: 'single', label: null });
    }
  } else if (mode === 'system') {
    const stakePer = Number(body.stake_ghs);
    if (!(stakePer > 0)) return send(res, 400, { error: 'invalid_stake' });
    const k = Math.trunc(Number(body.system_k));
    if (!(k >= 2) || k > clean.length) return send(res, 400, { error: 'invalid_system' });
    const combos = combinations(clean, k);
    if (combos.length > 250) return send(res, 400, { error: 'system_too_large' });
    tickets = combos.map(c => ({ sels: c, stake: Math.round(stakePer * 100) / 100, kind: 'system', label: k + '/' + clean.length }));
  } else {
    const stake = Number(body.stake_ghs);
    if (!(stake > 0)) return send(res, 400, { error: 'invalid_stake' });
    tickets = [{ sels: clean, stake: Math.round(stake * 100) / 100, kind: clean.length === 1 ? 'single' : 'multiple', label: null }];
  }

  let totalStake = 0;
  let totalPotential = 0;
  for (const t of tickets) {
    t.totalOdds = Math.round(t.sels.reduce((a, s) => a * s.odds, 1) * 1000) / 1000;
    t.bonusPct = t.kind === 'single' ? 0 : winBonusPct(t.sels.length);
    t.potential = Math.round(t.stake * t.totalOdds * (1 + t.bonusPct / 100) * 100) / 100;
    t.code = betCode();
    totalStake += t.stake;
    totalPotential += t.potential;
  }
  totalStake = Math.round(totalStake * 100) / 100;
  totalPotential = Math.round(totalPotential * 100) / 100;

  // One booking code for this slip's games on this account,
  // minted at staking (Prince, 2026-11-06): the same account
  // staking the same games always gets the same code, and it is
  // stamped on every ticket so it shows on the Bets page.
  let bookingCode = null;
  try { bookingCode = await ensureBookingCode(auth.uid, clean); } catch (e) { bookingCode = null; }
  // $1 user, $2 total stake, $3 booking code; ticket values follow,
  // then selection values. Selections join their ticket by code.
  const params = [auth.uid, totalStake, bookingCode];
  const ticketVals = [];
  tickets.forEach(t => {
    const b = params.length + 1;
    ticketVals.push(`($${b}::text, $${b + 1}::numeric, $${b + 2}::numeric, $${b + 3}::numeric, $${b + 4}::text, $${b + 5}::numeric, $${b + 6}::text)`);
    params.push(t.code, t.stake, t.totalOdds, t.potential, t.kind, t.bonusPct, t.label);
  });
  const selVals = [];
  for (const t of tickets) {
    for (const s of t.sels) {
      const b = params.length + 1;
      selVals.push(`($${b}::text, $${b + 1}::uuid, $${b + 2}::text, $${b + 3}::text, $${b + 4}::numeric)`);
      params.push(t.code, s.match_id, s.market, s.pick, s.odds);
    }
  }
  const rows = await sql(
    `with bal as (
       update users set balance_ghs = balance_ghs - $2,
         bonus_ghs = bonus_ghs - least(bonus_ghs, $2)
       where id = $1 and balance_ghs >= $2
       returning id
     ),
     bt as (
       insert into bets (code, user_id, stake_ghs, total_odds, potential_ghs, kind, bonus_pct, system_label, booking_code)
       select v.code, $1, v.stake, v.odds, v.pot, v.kind, v.bonus, v.label, $3
       from bal, (values ${ticketVals.join(', ')}) as v(code, stake, odds, pot, kind, bonus, label)
       returning id, code
     ),
     sel as (
       insert into bet_selections (bet_id, match_id, market, pick, odds)
       select bt.id, v.match_id, v.market, v.pick, v.odds
       from bt join (values ${selVals.join(', ')}) as v(code, match_id, market, pick, odds) on v.code = bt.code
       returning id
     ),
     led as (
       insert into wallet_transactions (user_id, kind, method, amount_ghs, status)
       select $1, 'bet_stake', 'Balance', -$2, 'completed' from bal
       returning id
     )
     select (select count(*) from bal) as debited, (select json_agg(code) from bt) as codes`,
    params
  );
  if (!rows.length || Number(rows[0].debited) === 0) return send(res, 400, { error: 'insufficient_balance' });
  send(res, 201, {
    code: tickets[0].code,
    codes: tickets.map(t => t.code),
    count: tickets.length,
    mode,
    total_stake_ghs: totalStake,
    total_potential_ghs: totalPotential,
    booking_code: bookingCode,
  });
});
