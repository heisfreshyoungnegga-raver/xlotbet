const { sql, send, guard, requireAdmin } = require('../../_lib');

// Per-day admin accountability (Prince, 2026-11-07): the dashboard
// is a daily work sheet. Every recorded admin action that carries
// an actor and a timestamp is aggregated per admin per day —
// deposits and withdrawals they confirmed or rejected (the queue
// stamps confirmed_by/confirmed_at), players who joined through
// their referral link, and the commission they earned / were paid.
// Days are Africa/Accra days. A regular admin sees only their own
// sheet; the super admin sees every admin's sheet for the day and
// can pull any custom date range. Days in the past are the history:
// nothing here is stored separately, the log IS the database.
function accraToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Accra' });
}
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = guard(async (req, res) => {
  const auth = requireAdmin(req, res);
  if (!auth) return;
  const q = req.query || {};
  const today = accraToday();
  let from = today, to = today;
  if (q.from || q.to) {
    if (!DAY_RE.test(q.from || '') || !DAY_RE.test(q.to || '')) {
      return send(res, 400, { error: 'bad_range', detail: 'Give both from and to as YYYY-MM-DD.' });
    }
    from = q.from; to = q.to;
    if (from > to) return send(res, 400, { error: 'bad_range', detail: 'The from date is after the to date.' });
    const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
    if (days > 92) return send(res, 400, { error: 'range_too_large', detail: 'Pick a range of 92 days or less.' });
  } else if (q.date) {
    if (!DAY_RE.test(q.date)) return send(res, 400, { error: 'bad_date', detail: 'Give the date as YYYY-MM-DD.' });
    from = to = q.date;
  }

  const isSuper = auth.role === 'super_admin';
  const roster = isSuper
    ? await sql("select id, phone, display_name, role from users where role in ('admin', 'super_admin') order by (role = 'super_admin') desc, display_name, phone")
    : await sql('select id, phone, display_name, role from users where id = $1', [auth.uid]);
  const ids = roster.map(r => r.id);
  if (!ids.length) return send(res, 200, { period: { from, to }, today, me: null, admins: [] });

  const [decisions, referrals, commissions] = await Promise.all([
    sql(`select confirmed_by as admin_id, kind,
                count(*) filter (where status = 'completed')::int as done_n,
                coalesce(sum(abs(amount_ghs)) filter (where status = 'completed'), 0) as done_ghs,
                count(*) filter (where status = 'rejected')::int as rejected_n
         from wallet_transactions
         where confirmed_by = any($3::uuid[])
           and (confirmed_at at time zone 'Africa/Accra')::date between $1::date and $2::date
         group by confirmed_by, kind`, [from, to, ids]),
    sql(`select invited_by as admin_id, count(*)::int as n
         from users
         where invited_by = any($3::uuid[])
           and (created_at at time zone 'Africa/Accra')::date between $1::date and $2::date
         group by invited_by`, [from, to, ids]),
    sql(`select earner_id as admin_id,
                count(*) filter (where (created_at at time zone 'Africa/Accra')::date between $1::date and $2::date)::int as earned_n,
                coalesce(sum(amount_ghs) filter (where (created_at at time zone 'Africa/Accra')::date between $1::date and $2::date), 0) as earned_ghs,
                coalesce(sum(amount_ghs) filter (where paid_at is not null and (paid_at at time zone 'Africa/Accra')::date between $1::date and $2::date), 0) as paid_ghs
         from commissions
         where earner_id = any($3::uuid[])
           and ((created_at at time zone 'Africa/Accra')::date between $1::date and $2::date
             or (paid_at is not null and (paid_at at time zone 'Africa/Accra')::date between $1::date and $2::date))
         group by earner_id`, [from, to, ids])
  ]);

  const blank = () => ({
    deposits_done_n: 0, deposits_done_ghs: 0, deposits_rejected_n: 0,
    withdrawals_done_n: 0, withdrawals_done_ghs: 0, withdrawals_rejected_n: 0,
    referrals_n: 0, commission_earned_n: 0, commission_earned_ghs: 0, commission_paid_ghs: 0
  });
  const byId = new Map(roster.map(r => [r.id, { admin_id: r.id, phone: r.phone, display_name: r.display_name, role: r.role, ...blank() }]));
  for (const d of decisions) {
    const w = byId.get(d.admin_id); if (!w) continue;
    const p = d.kind === 'deposit' ? 'deposits' : 'withdrawals';
    w[p + '_done_n'] = Number(d.done_n);
    w[p + '_done_ghs'] = Number(d.done_ghs);
    w[p + '_rejected_n'] = Number(d.rejected_n);
  }
  for (const r of referrals) {
    const w = byId.get(r.admin_id); if (w) w.referrals_n = Number(r.n);
  }
  for (const c of commissions) {
    const w = byId.get(c.admin_id); if (!w) continue;
    w.commission_earned_n = Number(c.earned_n);
    w.commission_earned_ghs = Number(c.earned_ghs);
    w.commission_paid_ghs = Number(c.paid_ghs);
  }
  const admins = [...byId.values()];
  const me = byId.get(auth.uid) || null;
  const out = { period: { from, to }, today, me };
  if (isSuper) {
    out.admins = admins;
    out.totals = admins.reduce((t, w) => {
      for (const k of Object.keys(blank())) t[k] += w[k];
      return t;
    }, blank());
  }
  return send(res, 200, out);
});
