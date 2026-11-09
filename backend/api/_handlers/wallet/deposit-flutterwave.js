const crypto = require('crypto');
const { sql, readBody, send, guard, requireAuth, flwConfig, flwFetch, ensurePaymentTables, ensureAdminTables, getSettings, currencyOfPhone, moneyRules, depositFloorFor } = require('../../_lib');

// Instant NGN deposit (Flutterwave hosted checkout): create a payment
// attempt, send the payer to Flutterwave's hosted page (card, bank
// transfer, USSD), and let settlement happen through the shared
// settleFlwAttempt in _lib.js — driven by the webhook first and by the
// deposit-flw-status reconciler when the payer returns to the site.
// This handler NEVER credits the wallet itself.
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireAuth(req, res);
  if (!auth) return;
  if (!flwConfig().secretKey) return send(res, 503, { error: 'provider_not_configured' });
  await ensureAdminTables();
  const settings = await getSettings(['gateway_enabled']);
  if (settings.gateway_enabled === '0') return send(res, 503, { error: 'gateway_disabled', detail: 'Instant deposits are switched off right now. Please use Manual transfer.' });

  const users = await sql('select phone, email, display_name, role from users where id = $1', [auth.uid]);
  if (!users.length) return send(res, 404, { error: 'user_not_found' });
  const user = users[0];
  if (currencyOfPhone(user.phone) !== 'NGN') return send(res, 400, { error: 'wrong_currency', detail: 'Flutterwave deposits are for Nigerian accounts. Ghana accounts deposit with Mobile Money.' });
  if (!user.email) return send(res, 400, { error: 'email_required', detail: 'Your account needs an email address for the payment receipt. Please contact support.' });

  const rules = moneyRules('NGN');
  const { amount_ghs } = await readBody(req);
  const amount = Number(amount_ghs);
  const floor = depositFloorFor(user, 'NGN');
  if (!(amount >= floor) || amount > rules.maxDeposit) {
    return send(res, 400, { error: 'invalid_amount', detail: `Enter an amount between ${rules.symbol}${floor.toLocaleString('en-GB')} and ${rules.symbol}${rules.maxDeposit.toLocaleString('en-GB')}.` });
  }
  const amountMinor = Math.round(amount * 100);
  if (Math.abs(amount * 100 - amountMinor) > 0.001) return send(res, 400, { error: 'invalid_amount', detail: 'Amount must be in whole kobo.' });

  await ensurePaymentTables();
  const reference = 'flw_' + crypto.randomUUID().replace(/-/g, '');
  const attemptRows = await sql(
    `insert into payment_attempts (user_id, provider, reference, amount_ghs, amount_minor, phone, network, currency, status)
     values ($1, 'flutterwave', $2, $3, $4, $5, 'FLUTTERWAVE', 'NGN', 'created') returning id`,
    [auth.uid, reference, amountMinor / 100, amountMinor, user.phone]
  );
  const attemptId = attemptRows[0].id;

  const host = req.headers['x-forwarded-host'] || req.headers.host || 'oddaroa.com';
  const redirect = `https://${host}/?flw_return=1`;
  let created;
  try {
    created = await flwFetch('/payments', {
      method: 'POST',
      body: {
        tx_ref: reference,
        amount: amountMinor / 100,
        currency: 'NGN',
        redirect_url: redirect,
        customer: { email: user.email, phonenumber: user.phone, name: user.display_name || 'Oddaroa player' },
        customizations: { title: 'Oddaroa', description: 'Wallet deposit' }
      }
    });
  } catch (e) {
    await sql(`update payment_attempts set status = 'failed', fail_reason = 'network_error' where id = $1`, [attemptId]);
    return send(res, 502, { error: 'provider_unreachable', detail: 'Flutterwave could not be reached. Nothing was charged — please try again.' });
  }
  const link = created.data && created.data.data && created.data.data.link;
  if (created.status !== 200 || !link) {
    await sql(`update payment_attempts set status = 'failed', fail_reason = $2 where id = $1`,
      [attemptId, String((created.data && created.data.message) || 'create_failed').slice(0, 200)]);
    return send(res, 502, { error: 'provider_rejected', detail: 'Flutterwave could not start that payment. Nothing was charged — please try again.' });
  }
  await sql(`update payment_attempts set status = 'awaiting' where id = $1`, [attemptId]);
  send(res, 201, { reference, link });
});
