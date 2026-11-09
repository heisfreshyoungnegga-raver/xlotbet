// Router for /api/payments/* — one Vercel function for the whole group
// (Railway's server.js mounts this same router). The webhook also has
// its own exact route file beside this one for Vercel's raw-body config.
const handlers = {};
// 'vip-buy' is deliberately NOT routed: the handler is PrimeStake
// debris (it imports a helper that no longer exists and 500s) and
// VIP is not a live Oddaroa product. The file stays on disk, dead.
for (const name of ['status', 'otp', 'shinobipay-webhook']) handlers[name] = require('../_handlers/payments/' + name);
module.exports = (req, res) => {
  const action = (req.query && req.query.action) || String(req.url || '').split('?')[0].split('/').pop();
  const handler = handlers[action];
  if (!handler) { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ error: 'not_found' })); }
  return handler(req, res);
};
