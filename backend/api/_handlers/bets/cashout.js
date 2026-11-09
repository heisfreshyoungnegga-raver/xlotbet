const { sql, readBody, send, guard, requireAuth, getSettings, cashoutQuoteFor, matchesById } = require('../../_lib');

// Cashout (Prince, 2026-11-05): an open ticket can be sold back to
// the house for its current mathematical value — potential payout
// discounted by the current odds of its pending legs and the
// operator's cashout margin (see cashoutQuoteFor in _lib). The quote
// is ALWAYS recomputed here from live prices; nothing the client
// sends about money is trusted. No quote exists while any leg's
// match is live: the button simply is not shown then, and a stale
// tap lands here and gets cashout_unavailable.
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { bet_id } = await readBody(req);
  if (!bet_id || !/^[0-9a-f-]{36}$/i.test(String(bet_id))) return send(res, 400, { error: 'bet_required' });
  const bets = await sql('select * from bets where id = $1 and user_id = $2', [bet_id, auth.uid]);
  if (!bets.length) return send(res, 404, { error: 'bet_not_found' });
  const bet = bets[0];
  if (bet.status !== 'open') return send(res, 409, { error: 'bet_not_open' });
  const selLegs = await sql(
    'select match_id, market, pick, result from bet_selections where bet_id = $1',
    [bet.id]
  );
  const legMatches = await matchesById(selLegs.map(r => r.match_id)).catch(() => new Map());
  const legs = selLegs.map(r => ({ market: r.market, pick: r.pick, result: r.result, match: legMatches.get(r.match_id) || null }));
  const settings = await getSettings(['cashout_margin_pct']);
  const quote = cashoutQuoteFor(bet, legs, settings.cashout_margin_pct);
  if (quote === null) return send(res, 400, { error: 'cashout_unavailable' });
  // One statement: flip the ticket (the status='open' guard makes a
  // double cashout impossible), write the ledger row, credit the
  // balance — mirroring the bet_win payout in settleMatch.
  const rows = await sql(
    `with upd as (update bets set status = 'cashed_out', settled_at = now(), payout_ghs = $3
                  where id = $1 and user_id = $2 and status = 'open' returning user_id),
          led as (insert into wallet_transactions (user_id, kind, method, amount_ghs, status)
                  select user_id, 'cashout', 'Balance', $3, 'completed' from upd returning id),
          bal as (update users set balance_ghs = balance_ghs + $3
                  where id = (select user_id from upd) returning balance_ghs)
     select balance_ghs from bal`,
    [bet.id, auth.uid, quote]
  );
  if (!rows.length) return send(res, 409, { error: 'bet_not_open' });
  send(res, 200, { ok: true, cashout_ghs: quote, balance_ghs: Number(rows[0].balance_ghs) });
});
