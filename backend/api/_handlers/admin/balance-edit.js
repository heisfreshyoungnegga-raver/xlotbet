const { sql, readBody, send, guard, requireSuperAdmin, ensureAdminTables } = require('../../_lib');

// Super admin only: adjust ANY account's real balance (player, admin or
// super admin) by a signed amount. Every edit lands in the wallet ledger
// as an 'adjustment' row with the reason, so the account holder sees it
// in their transactions and the change is auditable.
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireSuperAdmin(req, res);
  if (!auth) return;
  await ensureAdminTables();
  const { id, delta_ghs, note } = await readBody(req);
  const delta = Math.round(Number(delta_ghs) * 100) / 100;
  if (!id || !delta || !Number.isFinite(delta)) return send(res, 400, { error: 'id_and_amount_required' });
  if (Math.abs(delta) > 100000) return send(res, 400, { error: 'amount_too_large' });
  const rows = await sql(
    `with upd as (
       update users set balance_ghs = balance_ghs + $2
       where id = $1 and balance_ghs + $2 >= 0
       returning id, balance_ghs
     ),
     ins as (
       insert into wallet_transactions (user_id, kind, method, amount_ghs, status, note, confirmed_by)
       select id, 'adjustment', 'Balance adjustment', $2, 'completed', $3, $4 from upd returning id
     )
     select balance_ghs from upd`,
    [id, delta, (note ? String(note).slice(0, 120) : 'Balance adjusted by super admin'), auth.uid]
  );
  if (!rows.length) return send(res, 400, { error: 'edit_failed', detail: 'Account not found, or the edit would take the balance below zero.' });
  send(res, 200, { ok: true, balance_ghs: Number(rows[0].balance_ghs) });
});
