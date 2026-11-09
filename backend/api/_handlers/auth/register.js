const { sql, hashPassword, issueToken, readBody, send, guard, publicUser, ensureAdminTables, ensureInviteCode } = require('../../_lib');

// Registration. Two invite paths can ride along:
//  - ref=<invite code>: the new account is attributed to whoever shared
//    the link — every account (player, admin, super admin) owns a
//    permanent referral code, and attribution is what the referral
//    commission ledger pays on.
//  - admin_invite=<token>: a one-time super-admin invite. The account
//    is created as an admin in 'pending' status — no session is issued
//    until the super admin verifies it.
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const { phone, password, display_name, ref, admin_invite, email } = await readBody(req);
  let cleanPhone = String(phone || '').replace(/\s+/g, '');
  // Canonicalise Ghana numbers to international form (+233…) so one
  // person keeps one phone identity however the number was typed.
  if (/^0\d{9}$/.test(cleanPhone)) cleanPhone = '+233' + cleanPhone.slice(1);
  else if (/^233\d{9}$/.test(cleanPhone)) cleanPhone = '+' + cleanPhone;
  // Email is COMPULSORY for every sign-up (Prince's call, 2026-11-03):
  // no account is created without a valid, unique email address.
  // Players must also give a phone; admin-tier accounts (created
  // through an invite) may register with email alone — either
  // identifier then works at login.
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail) return send(res, 400, { error: 'email_required', detail: 'An email address is required to create an account.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return send(res, 400, { error: 'invalid_email' });
  const hasPhone = /^\+?\d{9,15}$/.test(cleanPhone);
  if (cleanPhone && !hasPhone) return send(res, 400, { error: 'invalid_phone' });
  if (!password || String(password).length < 6) return send(res, 400, { error: 'password_too_short' });
  if (hasPhone) {
    const existing = await sql('select id from users where phone = $1', [cleanPhone]);
    if (existing.length) return send(res, 409, { error: 'phone_already_registered' });
  }
  const existingMail = await sql('select id from users where lower(email) = $1', [cleanEmail]);
  if (existingMail.length) return send(res, 409, { error: 'email_already_registered' });
  await ensureAdminTables();

  let role = 'player', status = 'active', invitedBy = null, inviteRow = null;
  if (admin_invite) {
    const inv = await sql(
      `select id, kind, created_by from invites where token = $1 and kind in ('admin', 'super_admin') and used_by is null and expires_at > now()`,
      [String(admin_invite)]
    );
    if (!inv.length) return send(res, 400, { error: 'invalid_invite', detail: 'That invite link is invalid or has expired. Ask the super admin for a fresh one.' });
    inviteRow = inv[0];
    invitedBy = inv[0].created_by || null;
    if (inv[0].kind === 'super_admin') {
      // A super-admin invite is itself the authorisation: the account
      // is active immediately (there is no higher tier to verify it).
      role = 'super_admin';
      status = 'active';
    } else {
      role = 'admin';
      status = 'pending';
    }
  } else if (ref) {
    const inv = await sql(
      `select id from users where invite_code = $1 and status = 'active' and role in ('admin', 'super_admin')`,
      [String(ref).trim().toUpperCase()]
    );
    if (inv.length) invitedBy = inv[0].id;
  }

  // Whoever registers needs at least one login identifier: players
  // must give a phone; admin-tier invites may give phone OR email.
  if (!hasPhone && !cleanEmail) return send(res, 400, { error: 'invalid_phone' });
  if (!hasPhone && role === 'player') return send(res, 400, { error: 'invalid_phone', detail: 'Players register with a phone number.' });

  const rows = await sql(
    'insert into users (phone, email, password_hash, display_name, role, status, invited_by) values ($1, $2, $3, $4, $5, $6, $7) returning *',
    [hasPhone ? cleanPhone : null, cleanEmail, hashPassword(String(password)), display_name ? String(display_name).slice(0, 60) : null, role, status, invitedBy]
  );
  const user = rows[0];
  // Admin-tier accounts own a referral link from birth (Prince's
  // rules, 2026-11-03: every admin/super admin has one; players
  // do not have referral links at all).
  if (role !== 'player') await ensureInviteCode(user.id);
  if (inviteRow) {
    await sql('update invites set used_by = $1, used_at = now() where id = $2', [user.id, inviteRow.id]);
    if (status === 'pending') return send(res, 201, { pending: true, user: publicUser(user) });
  }
  send(res, 201, { user: publicUser(user), token: issueToken(user) });
});
