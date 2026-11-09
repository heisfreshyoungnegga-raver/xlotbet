const { sql, readBody, send, guard, requireAuth, ensureSupportColumns } = require('./_lib');

// Player support CHAT (Prince, 2026-11-08): one continuous conversation
// per player with the super admin. GET returns the thread (oldest first)
// and marks the admin's messages as read; POST adds a player message.
// The old ticket fields (subject/status) are still stored for the admin
// dashboard stats; a subject is accepted but optional.
module.exports = guard(async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  await ensureSupportColumns().catch(() => {});
  if (req.method === 'POST') {
    const { subject, body } = await readBody(req);
    const text = String(body || '').trim();
    if (!text) return send(res, 400, { error: 'message_required' });
    const rows = await sql(
      `insert into support_messages (user_id, subject, body, sender)
       values ($1, $2, $3, 'user') returning id, sender, body, created_at`,
      [auth.uid, String(subject || '').slice(0, 120), text.slice(0, 2000)]
    );
    return send(res, 201, { message: rows[0] });
  }
  const rows = await sql(
    `select * from (
       select id, subject, body, sender, status, created_at
       from support_messages where user_id = $1
       order by created_at desc limit 200
     ) t order by created_at asc`,
    [auth.uid]
  );
  await sql(
    `update support_messages set read_at = now()
     where user_id = $1 and sender = 'admin' and read_at is null`,
    [auth.uid]
  );
  send(res, 200, { messages: rows });
});
