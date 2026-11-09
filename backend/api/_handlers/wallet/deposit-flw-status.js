const { sql, send, guard, requireAuth, settleFlwAttempt } = require('../../_lib');

// Flutterwave deposit reconciler (twin of deposit-status): the payer's
// browser lands back on the site with ?flw_return=1&tx_ref=...&
// transaction_id=... — the client polls this endpoint, which records
// the transaction id on the attempt and settles through the shared
// settler, so a lost webhook can never strand a paid deposit.
module.exports = guard(async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const q = req.query || {};
  const url = new URL(req.url, 'http://x');
  const reference = String(q.reference || url.searchParams.get('reference') || '');
  const transactionId = String(q.transaction_id || url.searchParams.get('transaction_id') || '');
  if (!reference) return send(res, 400, { error: 'reference_required' });
  const rows = await sql(
    `select id, user_id, provider, reference, intent_id, amount_ghs, amount_minor, currency, status
     from payment_attempts where reference = $1 and user_id = $2`,
    [reference, auth.uid]
  );
  if (!rows.length) return send(res, 404, { error: 'attempt_not_found' });
  const attempt = rows[0];
  if (attempt.provider !== 'flutterwave') return send(res, 400, { error: 'wrong_provider' });
  if (transactionId && !attempt.intent_id) {
    await sql(`update payment_attempts set intent_id = $2 where id = $1 and intent_id is null`, [attempt.id, transactionId]);
    attempt.intent_id = transactionId;
  }
  let status = attempt.status;
  if (status !== 'succeeded' && attempt.intent_id) {
    const result = await settleFlwAttempt(attempt);
    if (result === 'credited' || result === 'already') status = 'succeeded';
  }
  const bal = await sql('select balance_ghs from users where id = $1', [auth.uid]);
  send(res, 200, { status, balance_ghs: bal.length ? Number(bal[0].balance_ghs) : 0 });
});
