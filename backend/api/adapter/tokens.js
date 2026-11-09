const crypto = require('crypto');

// GoTrue-compatible JWTs for the StakeKing adapter. The frontend's
// Supabase client only ever DECODES these in the browser (expiry and
// claims) and validates them through GET /auth/v1/user, so an HS256
// token signed with the platform SESSION_SECRET is all it needs.
// Access tokens live 7 days, matching the backend's own session
// lifetime (see issueToken in ../_lib.js); refresh tokens 30 days.

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(obj) { return b64url(JSON.stringify(obj)); }

function sign(payload) {
  const secret = process.env.SESSION_SECRET || '';
  const head = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const body = b64urlJson(payload);
  const sig = crypto.createHmac('sha256', secret).update(head + '.' + body).digest();
  return head + '.' + body + '.' + b64url(sig);
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const secret = process.env.SESSION_SECRET || '';
  const expect = b64url(crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest());
  const got = Buffer.from(parts[2]);
  const want = Buffer.from(expect);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (e) { return null; }
  if (!payload || !payload.sub) return null;
  if (payload.exp && payload.exp * 1000 <= Date.now()) return null;
  return payload;
}

const ACCESS_TTL_S = 7 * 24 * 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;

function mintPair(user) {
  const now = Math.floor(Date.now() / 1000);
  const access = sign({
    sub: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email || '',
    phone: user.phone || '',
    token_type: 'access',
    iat: now,
    exp: now + ACCESS_TTL_S,
  });
  const refresh = sign({
    sub: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    token_type: 'refresh',
    iat: now,
    exp: now + REFRESH_TTL_S,
  });
  return { access_token: access, refresh_token: refresh, expires_in: ACCESS_TTL_S };
}

module.exports = { sign, verify, mintPair, ACCESS_TTL_S };
