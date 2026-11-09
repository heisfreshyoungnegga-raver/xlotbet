// Router for /api/games/* — one Vercel function for the whole group.
const handlers = {
  start: require('../_handlers/games/start'),
  act: require('../_handlers/games/act'),
  cashout: require('../_handlers/games/cashout'),
  status: require('../_handlers/games/status'),
  history: require('../_handlers/games/history'),
};
module.exports = (req, res) => {
  const action = (req.query && req.query.action) || String(req.url || '').split('?')[0].split('/').pop();
  const handler = handlers[action];
  if (!handler) { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ error: 'not_found' })); }
  return handler(req, res);
};
