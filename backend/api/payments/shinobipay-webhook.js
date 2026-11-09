// ShinobiPay webhook — the settlement source of truth for MoMo deposits.
//
// Trust rules (from the ShinobiPay integration docs, followed exactly):
//  1. Verify the HMAC signature against the RAW request bytes before
//     trusting anything. Re-serialised JSON never matches.
//  2. Idempotent on event.id — delivery is at-least-once.
//  3. Per-intent sequence guard — a late "processing" must never
//     overwrite a "succeeded".
//  4. On succeeded, RE-VERIFY with a GET to ShinobiPay and credit only
//     if it still says succeeded and the merchant amount matches the
//     attempt. Credit happens exactly once, in one statement, for
//     exactly the requested amount (never the grossed prompt amount).
//  5. If the webhook secret is not configured yet, answer 503 so
//     ShinobiPay keeps retrying instead of us processing unverified
//     events.
const crypto = require('crypto');
const { sql, send, shinobiConfig, ensurePaymentTables, settleAttempt } = require('../_lib');

// Vercel: keep the raw body stream intact for signature verification.
module.exports.config = { api: { bodyParser: false } };

function verifySignature(rawBody, header, secret) {
  const parts = {};
  String(header || '').split(',').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) parts[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  const t = Number(parts.t);
  if (!t || !parts.v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > 300) return false; // 5-minute replay window
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const { webhookSecret, secretKey } = shinobiConfig();
  if (!process.env.DATABASE_URL || !webhookSecret) return send(res, 503, { error: 'webhook_not_configured' });
  let eventId = '';
  try {
    const raw = await readRawBody(req);
    if (!verifySignature(raw, req.headers['x-akwapay-signature'], webhookSecret)) {
      return send(res, 401, { error: 'invalid_signature' });
    }
    const event = JSON.parse(raw || '{}');
    const data = event.data || {};
    await ensurePaymentTables();

    // Idempotency: a second delivery of the same event is a no-op.
    eventId = String(event.id || '');
    const seen = await sql(
      `insert into webhook_events (event_id) values ($1) on conflict (event_id) do nothing returning event_id`,
      [eventId]
    );
    if (!seen.length) return send(res, 200, { ok: true, duplicate: true });

    const rows = await sql(
      `select id, user_id, reference, intent_id, amount_ghs, amount_minor, network, status, last_sequence
       from payment_attempts where reference = $1 or intent_id = $2`,
      [String(data.reference || ''), String(data.intent_id || '')]
    );
    if (!rows.length) return send(res, 200, { ok: true, unmatched: true });
    const attempt = rows[0];

    // Ordering: discard events older than the newest one processed.
    const seq = Number(event.sequence || 0);
    if (seq && seq < Number(attempt.last_sequence)) return send(res, 200, { ok: true, stale: true });
    if (seq) await sql(`update payment_attempts set last_sequence = $2 where id = $1`, [attempt.id, seq]);

    if (event.type === 'payment_intent.succeeded') {
      // Re-verify and credit through the shared settler (exactly the
      // attempt's amount, exactly once).
      const result = await settleAttempt(attempt);
      if (result === 'unverified') {
        // Never strand a paid deposit behind a silent 200: drop the
        // idempotency record so ShinobiPay's redelivery is processed
        // fresh, and answer 500 so it actually retries on its backoff.
        // The deposit-status reconciler is the second safety net.
        await sql(`delete from webhook_events where event_id = $1`, [String(event.id || '')]);
        return send(res, 500, { error: 'verification_failed' });
      }
      return send(res, 200, { ok: true, credited: result === 'credited' });
    }

    if (event.type === 'payment_intent.failed') {
      await sql(`update payment_attempts set status = 'failed' where id = $1 and status <> 'succeeded'`, [attempt.id]);
      return send(res, 200, { ok: true });
    }

    if (event.type === 'payment_intent.processing') {
      await sql(`update payment_attempts set status = 'processing' where id = $1 and status in ('created', 'awaiting', 'unknown')`, [attempt.id]);
      return send(res, 200, { ok: true });
    }

    return send(res, 200, { ok: true, ignored: event.type || null });
  } catch (e) {
    // A 500 makes ShinobiPay retry on its backoff schedule — right for
    // transient failures (database blip, re-verify fetch down). Drop
    // the idempotency record so the redelivery is processed fresh
    // instead of being dropped as a duplicate of a failed attempt.
    if (eventId) {
      try { await sql(`delete from webhook_events where event_id = $1`, [eventId]); } catch (ignored) { /* best effort */ }
    }
    if (!res.writableEnded) send(res, 500, { error: 'webhook_error' });
  }
};

// Exported for the local signature unit test only.
module.exports.verifySignature = verifySignature;
