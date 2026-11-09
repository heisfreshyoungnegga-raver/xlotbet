const { sql, send, guard, requireAuth, shinobiConfig, shinobiFetch, mapIntentStatus, ensurePaymentTables, publicUser } = require('../../_lib');

// Status for one of the signed-in customer's own VIP payment attempts.
// Display only: this handler NEVER grants VIP. Granting happens
// exclusively in the webhook handler after re-verification. When the
// attempt has settled it also returns the customer's current VIP state
// so the page can flip to "VIP active" without a second call.
module.exports = guard(async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const reference = String((req.query && req.query.reference) || '');
  if (!reference) return send(res, 400, { error: 'reference_required' });
  await ensurePaymentTables();
  const rows = await sql(
    `select reference, intent_id, amount_ghs, plan, status from payment_attempts where reference = $1 and user_id = $2`,
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
        // Advance display-safe states only. 'succeeded' is deliberately
        // NOT written here — the webhook owns settlement.
        if (['failed', 'processing', 'awaiting'].includes(networkStatus) && networkStatus !== a.status) {
          await sql(`update payment_attempts set status = $2 where reference = $1 and status not in ('succeeded', 'failed')`, [reference, networkStatus]);
          a.status = networkStatus;
        }
      }
    } catch (e) { /* poll is best-effort; the webhook is the real signal */ }
  }
  let vip = null;
  if (a.status === 'succeeded') {
    const me = await sql('select * from users where id = $1', [auth.uid]);
    if (me.length) vip = publicUser(me[0]);
  }
  send(res, 200, { reference, status: a.status, network_status: networkStatus, amount_ghs: Number(a.amount_ghs), plan: a.plan, vip });
});
