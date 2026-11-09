const { readBody, send, guard, requireSuperAdmin } = require('../../_lib');
const { LEAGUES, syncLeagues } = require('../../_espn');
const { afEnabled, refreshAf } = require('../../_apifootball');

// Manual feed sync from the admin portal: with an API-Football key
// configured, the button refreshes fixtures + odds from API-Football
// (the primary source); otherwise it runs the classic ESPN sweep of
// the chosen leagues over the coming days. Live scores between
// manual syncs are kept fresh automatically by the public match list.
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireSuperAdmin(req, res);
  if (!auth) return;
  if (afEnabled()) {
    const { imported, priced } = await refreshAf();
    return send(res, 200, { ok: true, source: 'api-football', imported, priced });
  }
  const body = await readBody(req);
  const leagues = Array.isArray(body.leagues) && body.leagues.length
    ? body.leagues.filter(l => LEAGUES[l])
    : Object.keys(LEAGUES);
  const daysAhead = Math.min(Math.max(Number(body.days) || 7, 1), 14);
  const offsets = [];
  for (let o = -1; o <= daysAhead; o++) offsets.push(o);
  const { report, imported, withOdds } = await syncLeagues(leagues, offsets);
  send(res, 200, { ok: true, imported, with_odds: withOdds, leagues: report });
});
