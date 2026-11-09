const { send, guard, requireAuth, flwConfig, flwFetch } = require('../../_lib');

// Nigerian bank list for the withdrawal form, proxied from Flutterwave
// and cached in memory for a day (the list changes rarely, and the
// cache keeps the form instant and the account's API quota untouched).
let cache = { at: 0, banks: [] };
module.exports = guard(async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  if (!flwConfig().secretKey) return send(res, 503, { error: 'provider_not_configured' });
  if (Date.now() - cache.at > 24 * 3600 * 1000 || !cache.banks.length) {
    const got = await flwFetch('/banks/NG');
    const list = (got.data && got.data.data) || [];
    if (got.status === 200 && list.length) {
      cache = { at: Date.now(), banks: list.map(b => ({ code: b.code, name: b.name })).sort((a, b) => a.name.localeCompare(b.name)) };
    }
  }
  if (!cache.banks.length) return send(res, 502, { error: 'banks_unavailable' });
  send(res, 200, { banks: cache.banks });
});
