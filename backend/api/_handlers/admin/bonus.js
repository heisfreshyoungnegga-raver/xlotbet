const { sql, readBody, send, guard, requireSuperAdmin, ensureAdminTables } = require('../../_lib');

// Super admin only: give a bonus. scope 'all' credits every active
// player; scope 'one' credits a single chosen account. Either way each
// credit is a real balance change with a 'Bonus' ledger row.
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireSuperAdmin(req, res);
  if (!auth) return;
  await ensureAdminTables();
  const { scope, user_id, amount_ghs, note } = await readBody(req);
  const amount = Math.round(Number(amount_ghs) * 100) / 100;
  if (!(amount > 0) || amount > 10000) return send(res, 400, { error: 'invalid_amount' });
  const noteText = note ? String(note).slice(0, 120) : 'Bonus from Oddaroa';
  let rows;
  if (scope === 'all') {
    rows = await sql(
      `with targets as (
         update users set balance_ghs = balance_ghs + $1
         where role = 'player' and status = 'active' returning id
       ),
       ins as (
         insert into wallet_transactions (user_id, kind, method, amount_ghs, status, note, confirmed_by)
         select id, 'adjustment', 'Bonus', $1, 'completed', $2, $3 from targets returning id
       )
       select count(*) as credited from targets`,
      [amount, noteText, auth.uid]
    );
  } else if (scope === 'one' && user_id) {
    rows = await sql(
      `with targets as (
         update users set balance_ghs = balance_ghs + $1 where id = $2 returning id
       ),
       ins as (
         insert into wallet_transactions (user_id, kind, method, amount_ghs, status, note, confirmed_by)
         select id, 'adjustment', 'Bonus', $1, 'completed', $3, $4 from targets returning id
       )
       select count(*) as credited from targets`,
      [amount, user_id, noteText, auth.uid]
    );
  } else {
    return send(res, 400, { error: 'scope_required', detail: "Use scope 'all' or scope 'one' with a user_id." });
  }
  const credited = rows.length ? Number(rows[0].credited) : 0;
  if (!credited) return send(res, 404, { error: 'no_accounts_credited' });
  send(res, 200, { ok: true, credited, amount_ghs: amount });
});
