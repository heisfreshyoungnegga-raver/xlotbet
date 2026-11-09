const { sql, readBody, send, guard, requireSuperAdmin, ensureAdminTables } = require('../../_lib');

// Super admin only: permanently delete an account and everything
// attached to it (bets, ledger, deposit attempts, commissions,
// invites). Built for clearing test accounts. You cannot delete
// yourself — another super admin must do it, which keeps one fat
// finger from wiping the operator account.
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireSuperAdmin(req, res);
  if (!auth) return;
  await ensureAdminTables();
  const { id } = await readBody(req);
  if (!id) return send(res, 400, { error: 'id_required' });
  if (id === auth.uid) return send(res, 400, { error: 'cannot_delete_yourself' });
  const target = await sql('select id, phone from users where id = $1', [id]);
  if (!target.length) return send(res, 404, { error: 'user_not_found' });
  await sql('update wallet_transactions set confirmed_by = null where confirmed_by = $1', [id]);
  await sql('update users set invited_by = null where invited_by = $1', [id]);
  await sql('delete from bet_selections where bet_id in (select id from bets where user_id = $1)', [id]);
  await sql('delete from bets where user_id = $1', [id]);
  await sql('delete from commissions where earner_id = $1 or source_user_id = $1', [id]);
  await sql('delete from wallet_transactions where user_id = $1', [id]);
  await sql('delete from payment_attempts where user_id = $1', [id]);
  await sql('delete from support_messages where user_id = $1', [id]);
  await sql('delete from invites where used_by = $1', [id]);
  await sql('update invites set created_by = null where created_by = $1', [id]);
  await sql('delete from users where id = $1', [id]);
  send(res, 200, { ok: true, deleted: target[0].phone });
});
