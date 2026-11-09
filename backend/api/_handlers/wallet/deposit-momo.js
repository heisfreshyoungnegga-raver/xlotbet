const crypto = require('crypto');
const { sql, readBody, send, guard, requireAuth, shinobiConfig, shinobiFetch, mapIntentStatus, detectNetwork, ensurePaymentTables, ensureAdminTables, getSettings } = require('../../_lib');

// Instant MoMo deposit (ShinobiPay direct push): create a payment intent,
// ShinobiPay pushes the approval prompt to the customer's phone. This
// handler NEVER credits the wallet — settlement happens through the
// shared settleAttempt in _lib.js, driven by the webhook first and by
// the deposit-status reconciler as the safety net.
// Amounts: the API speaks integer pesewas. The customer is charged the
// requested amount + 2.5% by ShinobiPay; the wallet is later credited
// exactly the requested amount.
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireAuth(req, res);
  if (!auth) return;
  if (!shinobiConfig().secretKey) return send(res, 503, { error: 'provider_not_configured' });
  await ensureAdminTables();
  const settings = await getSettings(['gateway_enabled']);
  if (settings.gateway_enabled === '0') return send(res, 503, { error: 'gateway_disabled', detail: 'Instant deposits are switched off right now. Please use Manual transfer.' });

  const { amount_ghs, phone, network } = await readBody(req);
  const amount = Number(amount_ghs);
  if (!(amount >= 210) || amount > 5000) return send(res, 400, { error: 'invalid_amount', detail: 'Enter an amount between GHS 210 and GHS 5,000.' });
  const amountMinor = Math.round(amount * 100);
  if (Math.abs(amount * 100 - amountMinor) > 0.001) return send(res, 400, { error: 'invalid_amount', detail: 'Amount must be in whole pesewas.' });

  // Normalise the phone to international form (233...) for the API, and
  // keep the local form (0...) for prefix-based network detection.
  const digits = String(phone || '').replace(/[\s+]/g, '');
  const local = digits.startsWith('233') ? '0' + digits.slice(3) : digits;
  if (!/^0\d{9}$/.test(local)) return send(res, 400, { error: 'invalid_phone', detail: 'Enter a valid Ghana phone number.' });
  const intl = '233' + local.slice(1);

  let net = String(network || '').toUpperCase();
  if (!['MTN', 'TELECEL', 'AIRTELTIGO'].includes(net)) net = detectNetwork(local) || '';
  if (!net) return send(res, 400, { error: 'invalid_network', detail: 'Pick the network for that number.' });

  await ensurePaymentTables();
  // Anti-storm guard (Prince, 2026-11-09): ShinobiPay temp-blocks
  // numbers, and rapid retries keep the block alive — one number
  // racked up 46 blocked attempts in a day, and 49 attempts in 48h
  // died as payment_in_progress collisions. Refuse early, WITHOUT
  // poking the provider, when this number already has a prompt in
  // flight or was blocked within the last 30 minutes.
  const lastTry = await sql(
    `select status, fail_reason, created_at from payment_attempts
     where phone = $1 order by created_at desc limit 1`,
    [intl]
  );
  if (lastTry.length) {
    const ageMin = (Date.now() - new Date(lastTry[0].created_at).getTime()) / 60000;
    if ((lastTry[0].status === 'awaiting' || lastTry[0].status === 'created') && ageMin < 10) {
      return send(res, 409, { error: 'payment_in_progress', detail: 'A payment prompt is already waiting for this number — approve it on the phone, or wait a few minutes for it to expire before trying again.' });
    }
    if (lastTry[0].fail_reason === 'number_blocked' && ageMin < 30) {
      return send(res, 429, { error: 'number_blocked', detail: 'This phone number is temporarily blocked by the payment provider. Please wait about 30 minutes before trying again — repeated tries can extend the block.' });
    }
  }
  // One attempt row per try. Its reference is unique per merchant account
  // and its id doubles as the Idempotency-Key, so a retry of THIS call
  // can never create a second charge.
  const reference = 'dep_' + crypto.randomUUID().replace(/-/g, '');
  const attemptRows = await sql(
    `insert into payment_attempts (user_id, reference, amount_ghs, amount_minor, phone, network, status)
     values ($1, $2, $3, $4, $5, $6, 'created') returning id`,
    [auth.uid, reference, amountMinor / 100, amountMinor, intl, net]
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
        description: 'Oddaroa wallet deposit'
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
      credit_ghs: amountMinor / 100
    });
  }

  // A prompt for this customer is already live: attach to that intent
  // instead of charging again.
  if (created.status === 429 && d.error && d.error.code === 'payment_in_progress' && d.intent_id) {
    await sql(
      `update payment_attempts set intent_id = $2, client_secret = $3, status = 'awaiting' where id = $1`,
      [attemptId, d.intent_id, d.client_secret || null]
    );
    return send(res, 200, { reference, status: 'awaiting', resumed: true, next_action: { type: 'await_prompt' }, credit_ghs: amountMinor / 100 });
  }

  const code = (d.error && d.error.code) || 'payment_failed';
  const message = (d.error && d.error.message) || 'The payment could not be started.';
  await sql(`update payment_attempts set status = 'failed', fail_reason = $2 where id = $1`, [attemptId, code]);
  return send(res, created.status >= 400 && created.status < 500 ? created.status : 402, { error: code, detail: message, reference });
});
