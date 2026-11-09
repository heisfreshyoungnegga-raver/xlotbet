const crypto = require('crypto');
const { sql, readBody, send, guard, requireAuth, shinobiConfig, shinobiFetch, mapIntentStatus, detectNetwork, ensurePaymentTables, getSetting } = require('../../_lib');

// Buy a VIP subscription with a ShinobiPay direct MoMo push: create a
// payment intent and ShinobiPay pushes the approval prompt to the
// customer's phone. This handler NEVER grants VIP — settlement happens
// only in the webhook handler after re-verification (see
// shinobipay-webhook.js). The price comes from operator_settings, never
// from the browser. ShinobiPay charges the customer the plan price
// + 2.5%; VIP is granted for exactly the plan bought.
const PLANS = {
  weekly: { setting: 'vip_price_weekly', days: 7, label: 'Weekly' },
  monthly: { setting: 'vip_price_monthly', days: 30, label: 'Monthly' }
};

module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireAuth(req, res);
  if (!auth) return;
  if (!shinobiConfig().secretKey) return send(res, 503, { error: 'provider_not_configured', detail: 'MoMo payment is being switched on. Please join on WhatsApp for now.' });
  if ((await getSetting('vip_enabled')) === 'false') return send(res, 503, { error: 'vip_disabled', detail: 'VIP sales are switched off right now.' });

  const { plan, phone, network } = await readBody(req);
  const p = PLANS[String(plan || '')];
  if (!p) return send(res, 400, { error: 'invalid_plan', detail: 'Pick the Weekly or Monthly plan.' });
  const price = Number(await getSetting(p.setting));
  if (!(price > 0)) return send(res, 503, { error: 'price_not_set' });
  const amountMinor = Math.round(price * 100);

  // Normalise the phone to international form (233...) for the API, and
  // keep the local form (0...) for prefix-based network detection.
  const digits = String(phone || '').replace(/[\s+]/g, '');
  const local = digits.startsWith('233') ? '0' + digits.slice(3) : digits;
  if (!/^0\d{9}$/.test(local)) return send(res, 400, { error: 'invalid_phone', detail: 'Enter a valid Ghana phone number.' });
  const intl = '233' + local.slice(1);

  let net = String(network || '').toUpperCase();
  if (!['MTN', 'TELECEL', 'AIRTELTIGO'].includes(net)) net = detectNetwork(local) || '';
  if (!net) return send(res, 400, { error: 'invalid_network', detail: 'Pick the network for that number.' });

  const me = await sql('select status from users where id = $1', [auth.uid]);
  if (!me.length) return send(res, 401, { error: 'not_logged_in' });
  if (me[0].status !== 'active') return send(res, 403, { error: 'account_blocked' });

  await ensurePaymentTables();
  // One attempt row per try. Its reference is unique per merchant
  // account and its id doubles as the Idempotency-Key, so a retry of
  // THIS call can never create a second charge.
  const reference = 'vip_' + crypto.randomUUID().replace(/-/g, '');
  const attemptRows = await sql(
    `insert into payment_attempts (user_id, reference, amount_ghs, amount_minor, phone, network, plan, plan_days, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'created') returning id`,
    [auth.uid, reference, amountMinor / 100, amountMinor, intl, net, String(plan), p.days]
  );
  const attemptId = attemptRows[0].id;

  let created;
  try {
    created = await shinobiFetch('/payment_intents', {
      method: 'POST',
      idempotencyKey: attemptId,
      body: {
        amount: amountMinor,
        currency: 'GHS',
        method: 'mobile_money',
        network: net,
        customer: { phone: intl },
        reference,
        description: `Oddaroa VIP ${p.label}`
      }
    });
  } catch (e) {
    // Network failure mid-create: the intent may or may not exist. Mark
    // the attempt unknown and tell the customer to wait — never blindly
    // create a second charge.
    await sql(`update payment_attempts set status = 'unknown' where id = $1`, [attemptId]);
    return send(res, 202, { reference, status: 'unknown', detail: 'We could not confirm the payment request. If a prompt arrives, approve it once — do not pay twice.' });
  }

  const d = created.data || {};
  if (created.status === 201 && d.id) {
    await sql(
      `update payment_attempts set intent_id = $2, client_secret = $3, status = $4 where id = $1`,
      [attemptId, d.id, d.client_secret || null, mapIntentStatus(d.status)]
    );
    return send(res, 201, {
      reference,
      status: mapIntentStatus(d.status),
      next_action: d.next_action || { type: 'await_prompt' },
      charged_total_ghs: typeof d.amount === 'number' ? d.amount / 100 : amountMinor / 100 * 1.025,
      plan: String(plan),
      plan_days: p.days
    });
  }

  // A prompt for this customer is already live: attach to that intent
  // instead of charging again.
  if (created.status === 429 && d.error && d.error.code === 'payment_in_progress' && d.intent_id) {
    await sql(
      `update payment_attempts set intent_id = $2, client_secret = $3, status = 'awaiting' where id = $1`,
      [attemptId, d.intent_id, d.client_secret || null]
    );
    return send(res, 200, { reference, status: 'awaiting', resumed: true, next_action: { type: 'await_prompt' }, plan: String(plan), plan_days: p.days });
  }

  const code = (d.error && d.error.code) || 'payment_failed';
  const message = (d.error && d.error.message) || 'The payment could not be started.';
  await sql(`update payment_attempts set status = 'failed', fail_reason = $2 where id = $1`, [attemptId, code]);
  return send(res, created.status >= 400 && created.status < 500 ? created.status : 402, { error: code, detail: message, reference });
});
