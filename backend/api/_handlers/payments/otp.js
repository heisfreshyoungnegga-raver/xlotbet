const { sql, readBody, send, guard, requireAuth, shinobiConfig, shinobiFetch, mapIntentStatus, ensurePaymentTables } = require('../../_lib');

// Submit the OTP for a VIP payment whose network asked for one
// (next_action.type = submit_otp). Server-side call with the secret key.
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireAuth(req, res);
  if (!auth) return;
  if (!shinobiConfig().secretKey) return send(res, 503, { error: 'provider_not_configured' });
  const { reference, otp } = await readBody(req);
  if (!reference || !otp) return send(res, 400, { error: 'otp_required' });
  await ensurePaymentTables();
  const rows = await sql(
    `select intent_id from payment_attempts where reference = $1 and user_id = $2`,
    [String(reference), auth.uid]
  );
  if (!rows.length || !rows[0].intent_id) return send(res, 404, { error: 'attempt_not_found' });
  let out;
  try {
    out = await shinobiFetch(`/payment_intents/${encodeURIComponent(rows[0].intent_id)}/validate`, {
      method: 'POST',
      body: { otp: String(otp) }
    });
  } catch (e) {
    return send(res, 202, { status: 'unknown', detail: 'Could not confirm the code. If the payment completes, VIP switches on automatically.' });
  }
  const d = out.data || {};
  if (out.status === 200 && d.status) {
    const st = mapIntentStatus(d.status);
    if (st !== 'succeeded') await sql(`update payment_attempts set status = $2 where reference = $1 and status <> 'succeeded'`, [String(reference), st]);
    return send(res, 200, { reference: String(reference), status: st, next_action: d.next_action || null });
  }
  const code = (d.error && d.error.code) || 'otp_failed';
  return send(res, out.status >= 400 && out.status < 500 ? out.status : 402, { error: code, detail: (d.error && d.error.message) || 'That code was not accepted.' });
});
