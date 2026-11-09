const { sql, readBody, send, guard, requireAdmin, requireSuperAdmin, ensureAdminTables, getSettings } = require('../../_lib');

const KEYS = ['gateway_enabled', 'payouts_frozen', 'admin_commission_pct', 'user_cashback_pct', 'referral_deposit_bonus_ghs', 'referral_deposit_bonus_ngn', 'cashout_margin_pct', 'fx_ngn_per_ghs', 'deposit_bonus_ghs_ratio', 'deposit_bonus_ngn_ratio'];

// Platform control settings. Any admin can read them (dashboards show
// the state); only the super admin can change them: the ShinobiPay
// gateway on/off, the payout freeze, and the two commission rates.
module.exports = guard(async (req, res) => {
  await ensureAdminTables();
  if (req.method === 'GET') {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    return send(res, 200, { settings: await getSettings(KEYS) });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireSuperAdmin(req, res);
  if (!auth) return;
  const body = await readBody(req);
  const updates = {};
  if (body.gateway_enabled !== undefined) updates.gateway_enabled = body.gateway_enabled ? '1' : '0';
  if (body.payouts_frozen !== undefined) updates.payouts_frozen = body.payouts_frozen ? '1' : '0';
  for (const k of ['admin_commission_pct', 'user_cashback_pct']) {
    if (body[k] !== undefined) {
      const v = Number(body[k]);
      // Cap raised 50 -> 100 on 2026-11-05: Prince set the admin
      // referral commission to 70%.
      if (!(v >= 0 && v <= 100)) return send(res, 400, { error: 'invalid_percent', detail: k + ' must be between 0 and 100.' });
      updates[k] = String(v);
    }
  }
  if (body.cashout_margin_pct !== undefined) {
    const v = Number(body.cashout_margin_pct);
    if (!(v >= 0 && v <= 50)) return send(res, 400, { error: 'invalid_percent', detail: 'Cashout margin must be between 0 and 50.' });
    updates.cashout_margin_pct = String(v);
  }
  if (body.referral_deposit_bonus_ngn !== undefined) {
    const v = Number(body.referral_deposit_bonus_ngn);
    if (!(v >= 0 && v <= 10000000)) return send(res, 400, { error: 'invalid_bonus', detail: 'Referral deposit bonus (NGN) must be between 0 and 10000000.' });
    updates.referral_deposit_bonus_ngn = String(v);
  }
  if (body.fx_ngn_per_ghs !== undefined) {
    const v = Number(body.fx_ngn_per_ghs);
    if (!(v >= 10 && v <= 1000)) return send(res, 400, { error: 'invalid_fx', detail: 'Exchange rate (NGN per 1 GHS) must be between 10 and 1000.' });
    updates.fx_ngn_per_ghs = String(v);
  }
  for (const k of ['deposit_bonus_ghs_ratio', 'deposit_bonus_ngn_ratio']) {
    if (body[k] !== undefined) {
      const v = Number(body[k]);
      if (!(v >= 0 && v <= 1)) return send(res, 400, { error: 'invalid_bonus_ratio', detail: 'Bonus ratios must be between 0 and 1.' });
      updates[k] = String(v);
    }
  }
  if (body.referral_deposit_bonus_ghs !== undefined) {
    const v = Number(body.referral_deposit_bonus_ghs);
    if (!(v >= 0 && v <= 100000)) return send(res, 400, { error: 'invalid_bonus', detail: 'Referral deposit bonus must be between 0 and 100000 GHS.' });
    updates.referral_deposit_bonus_ghs = String(v);
  }
  for (const [k, v] of Object.entries(updates)) {
    await sql('insert into operator_settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [k, v]);
  }
  send(res, 200, { ok: true, settings: await getSettings(KEYS) });
});
