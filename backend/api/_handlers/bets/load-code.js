const { sql, readBody, send, guard } = require('../../_lib');

// Load a 5-character booking code back into its selections. Prices are
// NOT stored with the code — the client re-prices every pick against
// the current book, exactly as the old base64 loader did.
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const body = await readBody(req);
  const code = String(body.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(code)) return send(res, 400, { error: 'invalid_code' });
  const rows = await sql('select selections from booking_codes where code = $1', [code]);
  if (!rows.length) return send(res, 404, { error: 'code_not_found' });
  return send(res, 200, { selections: rows[0].selections });
});
