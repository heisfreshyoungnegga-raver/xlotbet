const { readBody, send, guard, requireAuth, flwConfig, flwFetch } = require('../../_lib');

// Resolve a Nigerian bank account number to the holder's name through
// Flutterwave, so the withdrawal form shows the player exactly whose
// account will be paid before they submit.
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireAuth(req, res);
  if (!auth) return;
  if (!flwConfig().secretKey) return send(res, 503, { error: 'provider_not_configured' });
  const { account_number, bank_code } = await readBody(req);
  const acct = String(account_number || '').replace(/\D/g, '');
  const code = String(bank_code || '').trim();
  if (acct.length !== 10 || !code) return send(res, 400, { error: 'invalid_account', detail: 'Enter the 10-digit account number and pick the bank.' });
  const got = await flwFetch('/accounts/resolve', { method: 'POST', body: { account_number: acct, account_bank: code } });
  const d = (got.data && got.data.data) || {};
  if (got.status !== 200 || !d.account_name) return send(res, 404, { error: 'account_not_found', detail: 'That account number could not be verified for the selected bank.' });
  send(res, 200, { account_name: d.account_name, account_number: d.account_number || acct });
});
