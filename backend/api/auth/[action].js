// Router for /api/auth/* — one Vercel function for the whole group.
const handlers = {
  register: require('../_handlers/auth/register'),
  login: require('../_handlers/auth/login'),
  me: require('../_handlers/auth/me'),
  referrals: require('../_handlers/auth/referrals'),
  password: require('../_handlers/auth/password'),
};
module.exports = (req, res) => {
  const action = (req.query && req.query.action) || String(req.url || '').split('?')[0].split('/').pop();
  const handler = handlers[action];
  if (!handler) { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ error: 'not_found' })); }
  return handler(req, res);
};
