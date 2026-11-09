const { sql, readBody, send, guard, requireAdmin, ensureAdminTables, getSettings, applyDepositRewards, flwConfig, flwFetch, currencyOfPhone } = require('../../_lib');

// Confirm a pending deposit or withdrawal. A confirmed deposit credits
// the balance in the same statement and then pays the deposit rewards
// (user cashback + inviter commission). A confirmed withdrawal was
// already debited when the player requested it, so only the status
// changes — and withdrawals cannot be confirmed while payouts are
// frozen by the super admin.
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireAdmin(req, res);
  if (!auth) return;
  const { id } = await readBody(req);
  await ensureAdminTables();
  const pending = await sql('select user_id, kind, amount_ghs, method, payout_meta from wallet_transactions where id = $1 and status = $2', [id, 'pending']);
  if (!pending.length) return send(res, 404, { error: 'pending_transaction_not_found' });
  const txn = pending[0];
  // Withdrawal approvals are super-admin only (Prince's rule,
  // 2026-11-04): a regular admin can confirm deposits, but only the
  // super admin can approve money leaving the platform.
  if (txn.kind === 'withdrawal' && auth.role !== 'super_admin') {
    return send(res, 403, { error: 'super_admin_only', detail: 'Only the super admin can approve withdrawals.' });
  }
  if (txn.kind === 'withdrawal') {
    const settings = await getSettings(['payouts_frozen']);
    if (settings.payouts_frozen === '1') {
      return send(res, 403, { error: 'payouts_frozen', detail: 'Payouts are frozen by the super admin. Unfreeze them in Platform Control before confirming withdrawals.' });
    }
  }
  // Nigerian bank payout (Prince, 2026-11-07): when the withdrawal
  // carries bank details and Flutterwave is configured, confirming
  // FIRES the transfer first. If Flutterwave refuses, nothing is
  // marked paid and the row stays pending for another try. Without
  // the key the confirm falls back to the manual flow (paid by hand).
  const meta = txn.payout_meta || null;
  if (txn.kind === 'withdrawal' && meta && meta.currency === 'NGN' && flwConfig().secretKey) {
    const ref = 'wd_' + String(id).replace(/-/g, '');
    let tr = null;
    try {
      tr = await flwFetch('/transfers', {
        method: 'POST',
        body: {
          account_bank: meta.bank_code,
          account_number: meta.account_number,
          amount: Math.abs(Number(txn.amount_ghs)),
          currency: 'NGN',
          narration: 'Oddaroa withdrawal payout',
          reference: ref,
          debit_currency: 'NGN'
        }
      });
    } catch (e) { tr = null; }
    if (!tr || tr.status !== 200 || !tr.data || tr.data.status !== 'success') {
      return send(res, 502, {
        error: 'transfer_failed',
        detail: 'Flutterwave refused the transfer (' + String((tr && tr.data && tr.data.message) || 'provider unreachable') + '). The withdrawal is still pending — nothing was marked paid.'
      });
    }
    await sql(
      `update wallet_transactions set payout_meta = coalesce(payout_meta, '{}'::jsonb) || $2::jsonb where id = $1`,
      [id, JSON.stringify({ flw_ref: ref, flw_transfer_id: String((tr.data.data && tr.data.data.id) || '') })]
    );
  }
  const rows = await sql(
    `with t as (
       update wallet_transactions
       set status = 'completed', confirmed_by = $2, confirmed_at = now()
       where id = $1 and status = 'pending'
       returning user_id, kind, amount_ghs
     ),
     credit as (
       update users set balance_ghs = balance_ghs + (select amount_ghs from t)
       where id = (select user_id from t) and (select kind from t) = 'deposit'
       returning id
     )
     select (select count(*) from t) as updated`,
    [id, auth.uid]
  );
  if (!rows.length || Number(rows[0].updated) === 0) return send(res, 404, { error: 'pending_transaction_not_found' });
  if (txn.kind === 'deposit') {
    const du = await sql('select phone from users where id = $1', [txn.user_id]);
    await applyDepositRewards(txn.user_id, id, Number(txn.amount_ghs), du.length ? currencyOfPhone(du[0].phone) : 'GHS');
  }
  if (txn.kind === 'withdrawal') {
    // The portal plays an animated SMS-style receipt for the payout
    // (Prince, 2026-11-05, admins only), worded exactly like a real
    // MoMo text — sender "Mobile Money", the standard template —
    // so hand it everything the message needs: amount paid, the
    // player's name for the Reference line, an 11-digit display
    // transaction ID derived from the withdrawal row, and the
    // player's resulting balance for both balance lines.
    const u = await sql('select phone, display_name, balance_ghs from users where id = $1', [txn.user_id]);
    let h = 0; const rawId = String(id || '');
    for (let i = 0; i < rawId.length; i++) h = (h * 31 + rawId.charCodeAt(i)) >>> 0;
    return send(res, 200, {
      ok: true,
      payout: {
        amount_ghs: Math.abs(Number(txn.amount_ghs)),
        method: txn.method || 'Mobile Money',
        phone: meta && meta.currency === 'NGN'
          ? `${meta.account_name || ''} \u00b7 ${meta.bank_name || ''} ${meta.account_number || ''}`.trim()
          : ((u[0] && u[0].phone) || ''),
        reference: (u[0] && u[0].display_name) || 'Oddaroa',
        txn_ref: String(10000000000 + (h % 89999999999)).slice(0, 11),
        balance_ghs: Number((u[0] && u[0].balance_ghs) || 0)
      }
    });
  }
  send(res, 200, { ok: true });
});
