const { issueToken } = require('../_lib');

// Run an existing engine handler in-process with a synthetic request
// and capture what it sends. This is how the adapter reuses the
// PrimeStake/Oddaroa logic (validation, throttles, money rules)
// instead of duplicating it: the engine stays the single source of
// truth, the adapter only translates protocols.
// - body lands on req.body, which _lib.readBody returns as-is.
// - when a user is given, the request carries a freshly minted
//   engine token, so requireAuth/requireAdmin inside the handler
//   see exactly the session a native client would present.
async function invoke(handler, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const req = {
      method: o.method || 'POST',
      headers: {},
      body: o.body || {},
      query: o.query || {},
      url: o.url || '/adapter',
    };
    if (o.user) req.headers.authorization = 'Bearer ' + issueToken(o.user);
    if (o.headers) Object.assign(req.headers, o.headers);
    let settled = false;
    const res = {
      statusCode: 200,
      headers: {},
      writableEnded: false,
      setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
      getHeader(k) { return this.headers[String(k).toLowerCase()]; },
      end(data) {
        if (settled) return;
        settled = true;
        this.writableEnded = true;
        let json = null;
        try { json = JSON.parse(data || 'null'); } catch (e) { /* non-JSON body */ }
        resolve({ status: this.statusCode, json, raw: data });
      },
    };
    Promise.resolve()
      .then(() => handler(req, res))
      .catch(() => { if (!settled) { settled = true; resolve({ status: 500, json: null }); } });
  });
}

module.exports = { invoke };
