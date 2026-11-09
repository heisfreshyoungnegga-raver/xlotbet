const { sql } = require('../_lib');
const { verify } = require('./tokens');

// Who is calling the adapter: a service client (server functions
// holding ADAPTER_SERVICE_KEY), a signed-in user (adapter JWT), or
// an anonymous visitor (publishable key only).
async function caller(req) {
  const header = (req.headers && req.headers.authorization) || '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (process.env.ADAPTER_SERVICE_KEY && token && token === process.env.ADAPTER_SERVICE_KEY) {
    return { service: true, user: null };
  }
  const payload = verify(token);
  if (!payload) return { service: false, user: null };
  const rows = await sql('select * from users where id = $1', [payload.sub]);
  if (!rows.length || rows[0].status === 'blocked') return { service: false, user: null };
  return { service: false, user: rows[0] };
}
const isAdmin = (c) => c.service || (c.user && (c.user.role === 'admin' || c.user.role === 'super_admin'));

module.exports = { caller, isAdmin };
