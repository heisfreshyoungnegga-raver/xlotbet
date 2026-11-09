const { sql, verifyPassword, issueToken, readBody, send, guard, publicUser } = require('../../_lib');

// Brute-force brake: 10 failed attempts against one identifier
// locks that identifier for 15 minutes. In-memory per instance —
// it resets on deploy and does not coordinate across instances,
// which is proportionate cover for a small platform (forensic
// finding, 2026-11-05: login previously had no throttle at all).
const loginFails = new Map();
function loginLocked(key) {
  const e = loginFails.get(key);
  return !!(e && e.lockedUntil > Date.now());
}
function noteLoginFail(key) {
  const e = loginFails.get(key) || { fails: 0, lockedUntil: 0 };
  e.fails += 1;
  if (e.fails >= 10) { e.lockedUntil = Date.now() + 15 * 60000; e.fails = 0; }
  if (loginFails.size > 10000) loginFails.clear();
  loginFails.set(key, e);
}

module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const { phone, password, identifier } = await readBody(req);
  // Login accepts the phone number OR the account email (admin-tier
  // accounts may be created with either — see auth/register). Numbers
  // are matched in every form a person might type or be stored in:
  // international (+233…), trunk (0…) and bare country code (233…).
  const ident = String(identifier || phone || '').replace(/\s+/g, '');
  const lockKey = ident.toLowerCase();
  if (loginLocked(lockKey)) {
    return send(res, 429, { error: 'too_many_attempts', detail: 'Too many failed attempts. Wait 15 minutes and try again.' });
  }
  const variants = [ident];
  if (/^\+233\d{9}$/.test(ident)) variants.push('0' + ident.slice(4));
  if (/^0\d{9}$/.test(ident)) variants.push('+233' + ident.slice(1));
  if (/^233\d{9}$/.test(ident)) variants.push('+' + ident, '0' + ident.slice(3));
  const rows = await sql('select * from users where phone = any($1) or lower(email) = lower($2)', [variants, ident]);
  if (!rows.length || !verifyPassword(String(password || ''), rows[0].password_hash)) {
    noteLoginFail(lockKey);
    return send(res, 401, { error: 'wrong_phone_or_password' });
  }
  loginFails.delete(lockKey);
  if (rows[0].status === 'blocked') return send(res, 403, { error: 'account_blocked' });
  if (rows[0].status === 'pending') return send(res, 403, { error: 'account_pending', detail: 'Your admin account is waiting for verification by the super admin.' });
  const user = publicUser(rows[0]);
  send(res, 200, { user, token: issueToken(rows[0]) });
});
