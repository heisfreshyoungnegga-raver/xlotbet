// GET /api/tips — official Oddaroa tips from the database.
// Free tips are public. VIP tips come back locked ({locked:true}, no
// pick) unless the caller is logged in with active VIP or an admin role.
const { sql, send, verifyToken, guard } = require('../../_lib');

module.exports = guard(async (req, res) => {
  const settings = await sql("select value from operator_settings where key = 'tips_enabled'");
  if (settings.length && settings[0].value !== 'true') return send(res, 200, { tips: [], disabled: true });

  let canSeeVip = false;
  const header = req.headers.authorization || '';
  const payload = verifyToken(header.replace(/^Bearer\s+/i, ''));
  if (payload) {
    if (payload.role === 'admin' || payload.role === 'super_admin') canSeeVip = true;
    else {
      const rows = await sql('select vip_until from users where id = $1', [payload.uid]);
      canSeeVip = !!(rows.length && rows[0].vip_until && new Date(rows[0].vip_until) > new Date());
    }
  }

  const tips = await sql(
    "select * from tips where play_date >= current_date - 1 order by play_date desc, created_at desc limit 100"
  );
  return send(res, 200, {
    tips: tips.map(t => (t.tier === 'vip' && !canSeeVip)
      ? { id: t.id, match: t.match, league: t.league, tier: 'vip', locked: true, result: t.result, play_date: t.play_date }
      : t)
  });
});
