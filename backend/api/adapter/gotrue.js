const { sql, readBody, send, guard } = require('../_lib');
const { invoke } = require('./invoke');
const { mintPair, verify } = require('./tokens');
const registerHandler = require('../_handlers/auth/register');
const loginHandler = require('../_handlers/auth/login');

// GoTrue-shaped auth for the StakeKing frontend. The app's Supabase
// client talks to /auth/v1/*; this module answers in GoTrue's shapes
// while every rule (email compulsory, phone canonicalisation,
// password length, duplicate checks, login throttle, invite and
// referral attribution) stays inside the engine handlers, reached
// through invoke().

function gotrueUser(u, meta) {
  const m = meta || {};
  return {
    id: u.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: u.email || '',
    phone: u.phone || '',
    email_confirmed_at: u.created_at || new Date().toISOString(),
    phone_confirmed_at: u.created_at || new Date().toISOString(),
    confirmed_at: u.created_at || new Date().toISOString(),
    last_sign_in_at: new Date().toISOString(),
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {
      full_name: u.display_name || m.full_name || '',
      phone: u.phone || m.phone || '',
      country: m.country || 'Ghana',
      date_of_birth: m.date_of_birth || '',
      referral_code: m.referral_code || '',
    },
    created_at: u.created_at || new Date().toISOString(),
    updated_at: u.updated_at || u.created_at || new Date().toISOString(),
  };
}

async function loadMeta(userId) {
  try {
    const rows = await sql('select meta from adapter_user_meta where user_id = $1', [userId]);
    return rows.length ? (rows[0].meta || {}) : {};
  } catch (e) { return {}; }
}
async function saveMeta(userId, meta) {
  try {
    await sql(
      `insert into adapter_user_meta (user_id, meta) values ($1, $2::jsonb)
       on conflict (user_id) do update set meta = adapter_user_meta.meta || excluded.meta`,
      [userId, JSON.stringify(meta || {})]
    );
  } catch (e) { /* metadata is decorative; never fail auth over it */ }
}

function sessionFor(user, meta) {
  const pair = mintPair(user);
  return {
    access_token: pair.access_token,
    token_type: 'bearer',
    expires_in: pair.expires_in,
    expires_at: Math.floor(Date.now() / 1000) + pair.expires_in,
    refresh_token: pair.refresh_token,
    user: gotrueUser(user, meta),
  };
}

function authError(res, status, msg) {
  return send(res, status, { code: status, error_code: 'adapter_auth', msg, error: msg });
}

async function bearerUser(req) {
  const header = (req.headers && req.headers.authorization) || '';
  const payload = verify(header.replace(/^Bearer\s+/i, ''));
  if (!payload) return null;
  const rows = await sql('select * from users where id = $1', [payload.sub]);
  if (!rows.length || rows[0].status === 'blocked') return null;
  return rows[0];
}

module.exports = guard(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;

  // POST /auth/v1/signup {email, password, data:{phone, full_name, ...}}
  if (path === '/auth/v1/signup' && req.method === 'POST') {
    const body = await readBody(req);
    const data = body.data || {};
    const out = await invoke(registerHandler, {
      body: {
        email: body.email || '',
        phone: data.phone || body.phone || '',
        password: body.password || '',
        display_name: data.full_name || data.display_name || '',
        ref: data.referral_code || undefined,
      },
    });
    if (!out.json || !out.json.user) {
      const detail = (out.json && (out.json.detail || out.json.error)) || 'signup_failed';
      return authError(res, out.status || 400, String(detail));
    }
    const user = out.json.user;
    const full = (await sql('select * from users where id = $1', [user.id]))[0] || user;
    const meta = {
      full_name: data.full_name || full.display_name || '',
      phone: full.phone || '',
      country: data.country || 'Ghana',
      date_of_birth: data.date_of_birth || '',
      referral_code: data.referral_code || '',
    };
    await saveMeta(full.id, meta);
    // Pending admin invites get no session until verified (engine rule).
    if (full.status !== 'active') return send(res, 200, { user: gotrueUser(full, meta), session: null });
    return send(res, 200, sessionFor(full, meta));
  }

  // POST /auth/v1/token?grant_type=password | refresh_token
  if (path === '/auth/v1/token' && req.method === 'POST') {
    const grant = url.searchParams.get('grant_type') || 'password';
    const body = await readBody(req);
    if (grant === 'refresh_token') {
      const payload = verify(String(body.refresh_token || ''));
      if (!payload || payload.token_type !== 'refresh') return authError(res, 401, 'Invalid refresh token');
      const rows = await sql('select * from users where id = $1', [payload.sub]);
      if (!rows.length || rows[0].status !== 'active') return authError(res, 401, 'Invalid refresh token');
      return send(res, 200, sessionFor(rows[0], await loadMeta(rows[0].id)));
    }
    const identifier = body.email || body.phone || '';
    const out = await invoke(loginHandler, { body: { identifier, password: body.password || '' } });
    if (!out.json || !out.json.user) {
      const detail = (out.json && (out.json.detail || out.json.error)) || 'Invalid login credentials';
      return authError(res, out.status === 429 ? 429 : 400, String(detail));
    }
    const user = (await sql('select * from users where id = $1', [out.json.user.id]))[0] || out.json.user;
    return send(res, 200, sessionFor(user, await loadMeta(user.id)));
  }

  // GET /auth/v1/user
  if (path === '/auth/v1/user' && req.method === 'GET') {
    const user = await bearerUser(req);
    if (!user) return authError(res, 401, 'Invalid or expired token');
    return send(res, 200, gotrueUser(user, await loadMeta(user.id)));
  }

  // PUT /auth/v1/user (profile metadata / password / phone changes)
  if (path === '/auth/v1/user' && req.method === 'PUT') {
    const user = await bearerUser(req);
    if (!user) return authError(res, 401, 'Invalid or expired token');
    const body = await readBody(req);
    if (body.password) {
      const pwHandler = require('../_handlers/auth/password');
      const out = await invoke(pwHandler, { user, body: { new_password: body.password } });
      if (out.status >= 400) return authError(res, out.status, String((out.json && (out.json.detail || out.json.error)) || 'password_change_failed'));
    }
    if (body.phone) {
      // The engine has no SMS rail, so a phone change is applied
      // directly under the protection of the signed-in session
      // (the same trust the password change above runs on), after
      // the usual canonicalisation and uniqueness checks.
      let cleanPhone = String(body.phone).replace(/\s+/g, '');
      if (/^0\d{9}$/.test(cleanPhone)) cleanPhone = '+233' + cleanPhone.slice(1);
      else if (/^233\d{9}$/.test(cleanPhone)) cleanPhone = '+' + cleanPhone;
      if (!/^\+?\d{9,15}$/.test(cleanPhone)) return authError(res, 400, 'Enter a valid phone number.');
      const taken = await sql('select id from users where phone = $1 and id <> $2', [cleanPhone, user.id]);
      if (taken.length) return authError(res, 409, 'That number is already registered to another account.');
      await sql('update users set phone = $1 where id = $2', [cleanPhone, user.id]);
      await saveMeta(user.id, { phone: cleanPhone });
    }
    if (body.data && typeof body.data === 'object') await saveMeta(user.id, body.data);
    const fresh = (await sql('select * from users where id = $1', [user.id]))[0] || user;
    return send(res, 200, gotrueUser(fresh, await loadMeta(user.id)));
  }

  // POST /auth/v1/verify (phone_change confirmation)
  if (path === '/auth/v1/verify' && req.method === 'POST') {
    const user = await bearerUser(req);
    if (!user) return authError(res, 401, 'Invalid or expired token');
    const body = await readBody(req);
    if (body.type === 'phone_change') {
      // The change itself already happened at updateUser time (see
      // above); this step confirms the account now carries the
      // number the user asked for.
      let want = String(body.phone || '').replace(/\s+/g, '');
      if (/^0\d{9}$/.test(want)) want = '+233' + want.slice(1);
      else if (/^233\d{9}$/.test(want)) want = '+' + want;
      if (user.phone === want || user.phone === body.phone) {
        return send(res, 200, sessionFor(user, await loadMeta(user.id)));
      }
      return authError(res, 400, 'That number is not linked to this account.');
    }
    return authError(res, 400, 'Unsupported verification type.');
  }

  // POST /auth/v1/logout
  if (path === '/auth/v1/logout' && req.method === 'POST') {
    res.statusCode = 204;
    return res.end();
  }

  return authError(res, 404, 'Unknown auth endpoint');
});
