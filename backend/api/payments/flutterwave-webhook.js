// Flutterwave webhook — settlement source of truth for NGN deposits,
// and the failure net for NGN payouts.
//
// Trust rules (mirroring the ShinobiPay webhook's discipline):
//  1. The `verif-hash` header must equal our FLUTTERWAVE_WEBHOOK_HASH
//     before anything in the body is trusted.
//  2. Idempotent per event+transaction id — delivery is at-least-once.
//  3. On a successful charge, RE-VERIFY with Flutterwave and credit
//     only through settleFlwAttempt (exactly once, exact amount).
//  4. If the hash is not configured yet, answer 503 so Flutterwave
//     keeps retrying instead of us processing unverified events.
//  5. A FAILED payout transfer refunds the player's hold and re-marks
//     the withdrawal rejected, so money never vanishes into a
//     'completed' row that never arrived.
const { sql, readBody, send, flwConfig, ensurePaymentTables, settleFlwAttempt } = require('../_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const { webhookHash, secretKey } = flwConfig();
  if (!process.env.DATABASE_URL || !webhookHash || !secretKey) return send(res, 503, { error: 'not_configured' });
  if (String(req.headers['verif-hash'] || '') !== webhookHash) return send(res, 401, { error: 'invalid_hash' });
  let eventId = '';
  try {
    const event = await readBody(req);
    const data = event.data || {};
    await ensurePaymentTables();
    eventId = 'flw:' + String(event.event || '') + ':' + String(data.id || data.tx_ref || '');
    const seen = await sql(
      `insert into webhook_events (event_id) values ($1) on conflict (event_id) do nothing returning event_id`,
      [eventId]
    );
    if (!seen.length) return send(res, 200, { ok: true, duplicate: true });

    if (event.event === 'charge.completed' && data.status === 'successful') {
      const rows = await sql(
        `select id, user_id, provider, reference, intent_id, amount_ghs, amount_minor, currency, status
         from payment_attempts where reference = $1 and provider = 'flutterwave'`,
        [String(data.tx_ref || '')]
      );
      if (!rows.length) return send(res, 200, { ok: true, unmatched: true });
      const attempt = rows[0];
      if (data.id && !attempt.intent_id) {
        await sql(`update payment_attempts set intent_id = $2 where id = $1 and intent_id is null`, [attempt.id, String(data.id)]);
        attempt.intent_id = String(data.id);
      }
      const result = await settleFlwAttempt(attempt);
      if (result === 'unverified') {
        await sql(`delete from webhook_events where event_id = $1`, [eventId]);
        return send(res, 500, { error: 'verification_failed' });
      }
      return send(res, 200, { ok: true, credited: result === 'credited' });
    }

    if (event.event === 'charge.completed' && data.status !== 'successful') {
      await sql(
        `update payment_attempts set status = 'failed' where reference = $1 and provider = 'flutterwave' and status <> 'succeeded'`,
        [String(data.tx_ref || '')]
      );
      return send(res, 200, { ok: true });
    }

    if (event.event === 'transfer.completed' && data.status === 'FAILED') {
      // The payout never arrived: refund the hold (the amount was
      // debited at request time and stored negative) and mark the
      // withdrawal rejected, exactly once.
      const ref = String(data.reference || '');
      if (ref) {
        await sql(
          `with t as (
             update wallet_transactions set status = 'rejected'
             where kind = 'withdrawal' and status = 'completed'
               and payout_meta ->> 'flw_ref' = $1
             returning user_id, amount_ghs
           )
           update users set balance_ghs = balance_ghs - (select amount_ghs from t)
           where id = (select user_id from t) and exists (select 1 from t)`,
          [ref]
        );
      }
      return send(res, 200, { ok: true });
    }

    return send(res, 200, { ok: true, ignored: event.event || null });
  } catch (e) {
    if (eventId) {
      try { await sql(`delete from webhook_events where event_id = $1`, [eventId]); } catch (ignored) { /* best effort */ }
    }
    if (!res.writableEnded) send(res, 500, { error: 'webhook_error' });
  }
};
