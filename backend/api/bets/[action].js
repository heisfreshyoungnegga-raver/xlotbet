// Router for /api/bets/* — one Vercel function for the whole group.
const handlers = {
  place: require('../_handlers/bets/place'),
  cashout: require('../_handlers/bets/cashout'),
  mine: require('../_handlers/bets/mine'),
  verify: require('../_handlers/bets/verify'),
  winners: require('../_handlers/bets/winners'),
  book: require('../_handlers/bets/book'),
  'load-code': require('../_handlers/bets/load-code'),
};
module.exports = (req, res) => {
  const action = (req.query && req.query.action) || String(req.url || '').split('?')[0].split('/').pop();
  const handler = handlers[action];
  if (!handler) { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ error: 'not_found' })); }
  return handler(req, res);
};
