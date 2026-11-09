const { sql, send, guard, requireAuth, shinobiConfig, shinobiFetch, mapIntentStatus, ensurePaymentTables, settleAttempt } = require('../../_lib');

// Status for one of the signed-in customer's own MoMo deposit attempts,
// and the settlement reconciler: while an attempt is open, each poll
// asks ShinobiPay for the intent's live state. If the provider confirms
// the payment succeeded, this handler settles the attempt itself
// through the shared settleAttempt (same re-verification and
// single-statement credit as the webhook) — so a lost or unverifiable
// webhook can never strand a paid deposit, and the player's own
// waiting screen heals itself within one poll.
module.exports = guard(async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const reference = String((req.query && req.query.reference) || '');
  if (!reference) return send(res, 400, { error: 'reference_required' });
  await ensurePaymentTables();
  const rows = await sql(
    `select id, user_id, reference, intent_id, amount_ghs, amount_minor, network, status from payment_attempts where reference = $1 and user_id = $2`,
    [reference, auth.uid]
  );
  if (!rows.length) return send(res, 404, { error: 'attempt_not_found' });
  const a = rows[0];
  let networkStatus = null;
  const open = ['created', 'awaiting', 'processing', 'unknown'].includes(a.status);
  if (open && a.intent_id && shinobiConfig().secretKey) {
    try {
      const got = await shinobiFetch(`/payment_intents/${encodeURIComponent(a.intent_id)}`);
      if (got.status === 200 && got.data && got.data.status) {
        networkStatus = mapIntentStatus(got.data.status);
        if (networkStatus === 'succeeded') {
          const result = await settleAttempt(a);
          if (result === 'credited' || result === 'already') a.status = 'succeeded';
        } else if (['failed', 'processing', 'awaiting'].includes(networkStatus) && networkStatus !== a.status) {
          await sql(`update payment_attempts set status = $2 where reference = $1 and status not in ('succeeded', 'failed')`, [reference, networkStatus]);
          a.status = networkStatus;
        }
      }
    } catch (e) { /* poll is best-effort; the webhook remains a signal */ }
  }
  send(res, 200, { reference, status: a.status, network_status: networkStatus, amount_ghs: Number(a.amount_ghs) });
});
