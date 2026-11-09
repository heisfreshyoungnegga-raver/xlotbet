const { msql, readBody, send, guard, verifyToken, ensureBookingCode } = require('../../_lib');

// Booking codes (Prince, 2026-11-06): a betslip is stored server-side
// behind a short 5-character mixed code, bookmaker-style. The old client-side
// base64 blob was unusable as a code anyone could read out or type.
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const body = await readBody(req);
  const sels = Array.isArray(body.selections) ? body.selections : [];
  const clean = sels.map(s => ({
    match_id: String((s && s.match_id) || ''),
    market: String((s && s.market) || '').slice(0, 60),
    pick: String((s && s.pick) || '').slice(0, 40),
  }));
  if (!clean.length || clean.length > 50 || clean.some(s => !s.match_id || !s.market || !s.pick)) {
    return send(res, 400, { error: 'invalid_selections' });
  }
  const ids = [...new Set(clean.map(s => s.match_id))];
  const found = await msql('select id from matches where id = any($1::uuid[])', [ids]);
  if (found.length !== ids.length) return send(res, 400, { error: 'unknown_match' });
  // One unique code per account + games (Prince, 2026-11-06): a
  // signed-in player's code is bound to their account, so booking
  // or staking the same games again returns the SAME code — it
  // never auto-changes. The code itself is not consumed by loading:
  // any player can load it, any number of times, and stake the
  // same games with their own money.
  let uid = null;
  try {
    const p = verifyToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (p) uid = p.uid;
  } catch (e) { /* anonymous booking */ }
  const code = await ensureBookingCode(uid, clean);
  if (!code) return send(res, 503, { error: 'code_unavailable' });
  return send(res, 201, { code });
});
