// Router for /api/admin/* — one Vercel function for the whole group.
const handlers = {
  stats: require('../_handlers/admin/stats'),
  queue: require('../_handlers/admin/queue'),
  confirm: require('../_handlers/admin/confirm'),
  reject: require('../_handlers/admin/reject'),
  users: require('../_handlers/admin/users'),
  block: require('../_handlers/admin/block'),
  matches: require('../_handlers/admin/matches'),
  settle: require('../_handlers/admin/settle'),
  support: require('../_handlers/admin/support'),
  'espn-sync': require('../_handlers/admin/espn-sync'),
  promote: require('../_handlers/admin/promote'),
  settings: require('../_handlers/admin/settings'),
  'create-match': require('../_handlers/admin/create-match'),
  'odds-preview': require('../_handlers/admin/odds-preview'),
  'edit-match': require('../_handlers/admin/edit-match'),
  'lock-match': require('../_handlers/admin/lock-match'),
  'invite-admin': require('../_handlers/admin/invite-admin'),
  'verify-admin': require('../_handlers/admin/verify-admin'),
  'balance-edit': require('../_handlers/admin/balance-edit'),
  bonus: require('../_handlers/admin/bonus'),
  'my-dashboard': require('../_handlers/admin/my-dashboard'),
  worklog: require('../_handlers/admin/worklog'),
  payout: require('../_handlers/admin/payout'),
  'payout-request': require('../_handlers/admin/payout-request'),
  'delete-user': require('../_handlers/admin/delete-user'),
  'deposit-proof': require('../_handlers/admin/deposit-proof'),
};
module.exports = (req, res) => {
  const action = (req.query && req.query.action) || String(req.url || '').split('?')[0].split('/').pop();
  const handler = handlers[action];
  if (!handler) { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ error: 'not_found' })); }
  return handler(req, res);
};
