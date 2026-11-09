const { sql, readBody, send, guard, requireAdmin, requireSuperAdmin, ensureSupportColumns } = require('../../_lib');

// Admin support. Two shapes:
//  - Legacy ticket inbox (all admins): GET flat list, POST {id, status}.
//  - Support CHAT (super admin only, Prince 2026-11-08): GET ?threads=1
//    lists one conversation per player with unread counts; GET ?user=<id>
//    returns that thread and marks the player's messages read; POST
//    {user_id, body} sends a reply into the player's chat.
module.exports = guard(async (req, res) => {
  const auth = requireAdmin(req, res);
  if (!auth) return;
  await ensureSupportColumns().catch(() => {});
  const q = req.query || {};
  if (req.method === 'POST') {
    const body = await readBody(req);
    if (body && body.user_id && body.body !== undefined) {
      if (!requireSuperAdmin(req, res)) return;
      const text = String(body.body || '').trim();
      if (!text) return send(res, 400, { error: 'message_required' });
      const target = String(body.user_id);
      const rows = await sql(
        `insert into support_messages (user_id, subject, body, sender, admin_id, status)
         values ($1, '', $2, 'admin', $3, 'answered') returning id, sender, body, created_at`,
        [target, text.slice(0, 2000), auth.uid]
      );
      await sql(
        `update support_messages set status = 'answered'
         where user_id = $1 and sender = 'user' and status = 'open'`,
        [target]
      );
      return send(res, 201, { message: rows[0] });
    }
    const { id, status } = body || {};
    if (!['open', 'answered', 'closed'].includes(status)) return send(res, 400, { error: 'invalid_status' });
    const rows = await sql('update support_messages set status = $1 where id = $2 returning id', [status, id]);
    if (!rows.length) return send(res, 404, { error: 'message_not_found' });
    return send(res, 200, { ok: true });
  }
  if (q.threads !== undefined) {
    if (!requireSuperAdmin(req, res)) return;
    const rows = await sql(
      `select u.id as user_id, u.display_name, u.phone,
         (select body from support_messages sm2 where sm2.user_id = u.id order by sm2.created_at desc limit 1) as last_body,
         (select sender from support_messages sm3 where sm3.user_id = u.id order by sm3.created_at desc limit 1) as last_sender,
         (select (read_at is not null) from support_messages sm4 where sm4.user_id = u.id order by sm4.created_at desc limit 1) as last_seen,
         max(sm.created_at) as last_at,
         count(*) filter (where sm.sender = 'user' and sm.read_at is null) as unread
       from support_messages sm join users u on u.id = sm.user_id
       group by u.id, u.display_name, u.phone
       order by last_at desc limit 100`
    );
    return send(res, 200, {
      threads: rows.map(r => ({ ...r, unread: Number(r.unread) }))
    });
  }
  if (q.user !== undefined) {
    if (!requireSuperAdmin(req, res)) return;
    const target = String(q.user);
    const rows = await sql(
      `select * from (
         select id, body, sender, created_at, read_at
         from support_messages where user_id = $1
         order by created_at desc limit 200
       ) t order by created_at asc`,
      [target]
    );
    await sql(
      `update support_messages set read_at = now()
       where user_id = $1 and sender = 'user' and read_at is null`,
      [target]
    );
    return send(res, 200, { messages: rows });
  }
  const rows = await sql(
    `select sm.id, sm.subject, sm.body, sm.status, sm.created_at, u.phone
     from support_messages sm left join users u on u.id = sm.user_id
     order by (sm.status = 'open') desc, sm.created_at desc limit 100`
  );
  send(res, 200, { messages: rows });
});
