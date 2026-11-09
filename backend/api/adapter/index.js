const { send } = require('../_lib');
const gotrue = require('./gotrue');
const postgrest = require('./postgrest');
const rpc = require('./rpc');

// Adapter entry point. Mounted by server.js for /auth/v1/* and
// /rest/v1/* — the two surfaces the frontend's Supabase client uses.
// Auth (gotrue.js), the table surface (postgrest.js) and the RPC
// dispatcher (rpc.js) are all live.

// CORS for the per-file Vercel mount, where server.js (which carries
// the same logic for the Railway / single-function mounts) is
// bypassed: the frontend's browser calls need the headers and a
// preflight answer or every response is blocked client-side.
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, apikey, content-type, prefer, x-client-info, x-supabase-api-version');
  res.setHeader('Access-Control-Expose-Headers', 'content-range, content-profile, www-authenticate');
  res.setHeader('Access-Control-Max-Age', '86400');
}

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  let path = String((req.url || '').split('?')[0]);
  // On Vercel the /auth/v1/* and /rest/v1/* surfaces reach this handler
  // either through catch-all route files (req.url stays original) or
  // through vercel.json rewrites that carry the original path in the
  // __sk query param. Normalise both; downstream handlers then see the
  // original path + query exactly as the Railway mount presents them.
  try {
    const raw = String(req.url || '');
    const qs = new URLSearchParams(raw.split('?')[1] || '');
    const sk = qs.get('__sk');
    if (sk) {
      path = sk;
      qs.delete('__sk');
      const rest = qs.toString();
      req.url = sk + (rest ? '?' + rest : '');
    }
  } catch (_) { /* keep the raw path */ }
  if (path.startsWith('/auth/v1/')) return gotrue(req, res);
  if (path.startsWith('/rest/v1/rpc/')) return rpc(req, res);
  if (path.startsWith('/rest/v1/')) return postgrest(req, res);
  return send(res, 404, { error: 'not_found' });
};
