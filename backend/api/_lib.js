// Oddaroa API shared library. Zero dependencies: Node built-ins plus
// Neon's HTTP SQL endpoint, so Vercel runs these functions as-is.
const crypto = require('crypto');

function config() {
  return {
    databaseUrl: process.env.DATABASE_URL || '',
    sessionSecret: process.env.SESSION_SECRET || ''
  };
}
function missingConfig() {
  const c = config();
  const missing = [];
  if (!c.databaseUrl) missing.push('DATABASE_URL');
  if (!c.sessionSecret) missing.push('SESSION_SECRET');
  return missing;
}

// Run one SQL statement against Neon over HTTPS. The connection string
// (which carries the DB password) is sent as a header to the database
// host only, and never logged.
async function sql(query, params = []) {
  return runSql(config().databaseUrl, query, params);
}
// Matches live in their OWN Neon project (Prince, 2026-11-07): the
// Free plan's 5 GB monthly transfer allowance is PER PROJECT, and
// the match catalog — hundreds of rows with full odds books, swept
// every two minutes and read by every visitor — burned the core
// project's whole allowance in four days and got its compute
// suspended. The catalog is ephemeral feed data, so it moved to a
// fresh project (MATCHES_DATABASE_URL) with its own allowance,
// while users, wallets and bets stay on the core project. Until the
// variable is set, msql IS sql and nothing changes.
async function msql(query, params = []) {
  return runSql(process.env.MATCHES_DATABASE_URL || config().databaseUrl, query, params);
}
async function runSql(databaseUrl, query, params = []) {
  const host = new URL(databaseUrl.replace(/^postgres(ql)?:\/\//, 'https://')).host;
  const res = await fetch(`https://${host}/sql`, {
    method: 'POST',
    headers: {
      'Neon-Connection-String': databaseUrl,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, params })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `database error (${res.status})`);
    err.dbMessage = data.message || '';
    throw err;
  }
  return data.rows || [];
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}

function signToken(payload) {
  const { sessionSecret } = config();
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  const { sessionSecret } = config();
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', sessionSecret).update(body).digest('base64url');
  // timingSafeEqual throws on a length mismatch — a garbage token
  // must read as "not logged in" (401), never as a server error.
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch (e) { return null; }
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}
function issueToken(user) {
  return signToken({ uid: user.id, role: user.role, exp: Date.now() + 7 * 24 * 3600 * 1000 });
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}
function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

// Returns the session payload or sends 401 and returns null.
function requireAuth(req, res) {
  const header = req.headers.authorization || '';
  const payload = verifyToken(header.replace(/^Bearer\s+/i, ''));
  if (!payload) { send(res, 401, { error: 'not_logged_in' }); return null; }
  return payload;
}
function requireAdmin(req, res) {
  const payload = requireAuth(req, res);
  if (!payload) return null;
  if (payload.role !== 'admin' && payload.role !== 'super_admin') { send(res, 403, { error: 'admin_only' }); return null; }
  return payload;
}
function requireSuperAdmin(req, res) {
  const payload = requireAuth(req, res);
  if (!payload) return null;
  if (payload.role !== 'super_admin') { send(res, 403, { error: 'super_admin_only' }); return null; }
  return payload;
}

// Wrap a handler with the config check and a uniform error shape.
function guard(handler) {
  return async (req, res) => {
    const missing = missingConfig();
    if (missing.length) return send(res, 503, { error: 'backend_not_configured', missing });
    try {
      await handler(req, res);
    } catch (e) {
      // Full error goes to the server log only — clients get a
      // generic detail so internals (table names, SQL text) never leak.
      console.error('[guard]', e && e.dbMessage ? e.dbMessage : e);
      if (!res.writableEnded) send(res, 500, { error: 'server_error', detail: 'Something went wrong on our side. Please try again.' });
    }
  };
}

// One wallet currency per account, fixed by the phone's country code
// (Prince, 2026-11-07: Nigeria goes fully live on Flutterwave). The
// stored balance number is denominated in the account's own currency;
// GHS remains the default for Ghana numbers.
function currencyOfPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('234')) return 'NGN';
  if (d.startsWith('254')) return 'KES';
  if (d.startsWith('256')) return 'UGX';
  if (d.startsWith('255')) return 'TZS';
  return 'GHS';
}
// Per-currency money rules: deposit floors/ceilings, the verification
// deposit ask, game stake bounds and where the referral bonus setting
// lives. NGN figures are the platform equivalents of the GHS ones.
const CURRENCY_RULES = {
  GHS: { symbol: 'GHS ', minDeposit: 120, maxDeposit: 5000, verifyAmount: 300, minStake: 1, maxStake: 1000, bonusKey: 'referral_deposit_bonus_ghs', bonusDefault: 0 },
  NGN: { symbol: '\u20a6', minDeposit: 25000, maxDeposit: 2000000, verifyAmount: 10000, minStake: 100, maxStake: 500000, bonusKey: 'referral_deposit_bonus_ngn', bonusDefault: 5000 }
};
function moneyRules(currency) { return CURRENCY_RULES[currency] || CURRENCY_RULES.GHS; }

// Deposit floor for an account: players use the currency's minDeposit;
// admin-tier accounts in Nigeria may deposit from ₦10 to test the
// system (Prince's order, 2026-11-07).
function depositFloorFor(user, currency) {
  if (currency === 'NGN' && user && (user.role === 'admin' || user.role === 'super_admin')) return 10;
  return moneyRules(currency).minDeposit;
}

function publicUser(u) {
  return { id: u.id, phone: u.phone, email: u.email || null, display_name: u.display_name, role: u.role, status: u.status, balance_ghs: Number(u.balance_ghs), bonus_ghs: Number(u.bonus_ghs || 0), currency: currencyOfPhone(u.phone) };
}
function betCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
  return 'PB-' + code;
}

// Market catalogue shared by bet placement and settlement. Keys match
// the odds jsonb stored on each match row.
const MARKETS = {
  '1X2': { '1': 'o1', 'X': 'ox', '2': 'o2' },
  'Double Chance': { '12': 'dc12', '1X': 'dc1x', 'X2': 'dcx2' },
  // Over/Under markets are handled dynamically by line (see keyFor/pickWon).
  'Both Teams To Score': { 'Yes': 'gg', 'No': 'ng' }
};
// Map a (market, pick) pair to its key inside the match odds jsonb.
// Over/Under works for any half-goal line: 'Over/Under 1.5' + 'Over 1.5'
// resolves to 'over15'.
function fmtLine(x) { return (x > 0 ? '+' : '') + Number(x).toFixed(1); }
function keyFor(market, pick) {
  if (MARKETS[market]) return MARKETS[market][pick] || null;
  const ou = /^Over\/Under (\d+\.\d)$/.exec(market);
  if (ou) {
    const suffix = ou[1].replace('.', '');
    if (pick === 'Over ' + ou[1]) return 'over' + suffix;
    if (pick === 'Under ' + ou[1]) return 'under' + suffix;
  }
  // Handicap markets carry the home team's spread line in the name
  // ('Handicap +0.5'); picks are 'Home +0.5' / 'Away -0.5'.
  const hc = /^Handicap ([+-]?\d+\.\d)$/.exec(market);
  if (hc) {
    const line = parseFloat(hc[1]);
    if (pick === 'Home ' + fmtLine(line)) return 'sph';
    if (pick === 'Away ' + fmtLine(-line)) return 'spa';
  }
  return null;
}
function pickWon(market, pick, home, away) {
  const total = home + away;
  const ou = /^Over\/Under (\d+\.\d)$/.exec(market);
  if (ou) {
    const line = parseFloat(ou[1]);
    return pick === 'Over ' + ou[1] ? total > line : total < line;
  }
  const hc = /^Handicap ([+-]?\d+\.\d)$/.exec(market);
  if (hc) {
    const line = parseFloat(hc[1]);
    // The home pick applies the line to the home score; the away
    // pick carries the mirrored line. A level adjusted score (only
    // possible on whole lines) loses — ESPN soccer spreads are
    // half-goal lines, so this does not arise in practice.
    return pick.indexOf('Home ') === 0 ? (home + line) > away : (away - line) > home;
  }
  switch (market) {
    case '1X2': return pick === '1' ? home > away : pick === 'X' ? home === away : away > home;
    case 'Double Chance': return pick === '12' ? home !== away : pick === '1X' ? home >= away : away >= home;
    case 'Both Teams To Score': return pick === 'Yes' ? (home > 0 && away > 0) : (home === 0 || away === 0);
    default: return false;
  }
}

// Settlement for the API-Football full-book markets. Every market
// here is a pure function of the full-time score (H, A) and, for the
// half markets, the half-time score (hH, hA); second-half goals are
// the difference. Returns true/false, or null when the pick cannot
// be decided yet (a half market whose half-time score is unknown,
// or a pick format this evaluator does not recognise — those stay
// pending rather than being guessed at).
function afPickWon(market, pick, H, A, hH, hA) {
  const p = String(pick);
  const res = (h, a) => (h > a ? 'Home' : h < a ? 'Away' : 'Draw');
  const ou = (total, pk) => {
    const m = /^(Over|Under) ([\d.]+)$/.exec(pk);
    if (!m) return null;
    const line = parseFloat(m[2]);
    return m[1] === 'Over' ? total > line : total < line;
  };
  const exactGoals = (n, pk) => {
    if (/^\d+$/.test(pk)) return n === Number(pk);
    const more = /^more (\d+)$/.exec(pk) || /^(\d+)\+$/.exec(pk);
    if (more) return n >= Number(more[1]);
    return null;
  };
  const handicap = (h, a, pk) => {
    const m = /^(Home|Draw|Away) ([+-]?[\d.]+)$/.exec(pk);
    if (!m) return null;
    return res(h + parseFloat(m[2]), a) === m[1];
  };
  const needHt = [hH, hA].some(v => v === null || v === undefined);
  const H2 = needHt ? null : { h: H - hH, a: A - hA };
  switch (market) {
    case 'Match Winner': return res(H, A) === p;
    case 'Double Chance':
      return p === 'Home/Draw' ? H >= A : p === 'Home/Away' ? H !== A : p === 'Draw/Away' ? A >= H : null;
    case 'Both Teams Score': case 'Both Teams To Score':
      return p === 'Yes' ? (H > 0 && A > 0) : p === 'No' ? (H === 0 || A === 0) : null;
    case 'Goals Over/Under': return ou(H + A, p);
    case 'Clean Sheet - Home': return p === 'Yes' ? A === 0 : p === 'No' ? A > 0 : null;
    case 'Clean Sheet - Away': return p === 'Yes' ? H === 0 : p === 'No' ? H > 0 : null;
    case 'Handicap Result': return handicap(H, A, p);
    case 'Exact Score': case 'Correct Score': {
      const m = /^(\d+):(\d+)$/.exec(p);
      return m ? (H === Number(m[1]) && A === Number(m[2])) : null;
    }
    case 'Total - Home': return ou(H, p);
    case 'Total - Away': return ou(A, p);
    case 'Win To Nil':
      return p === 'Home' ? (H > A && A === 0) : p === 'Away' ? (A > H && H === 0) : null;
    case 'Odd/Even': return p === 'Odd' ? (H + A) % 2 === 1 : p === 'Even' ? (H + A) % 2 === 0 : null;
    case 'Home Odd/Even': return p === 'Odd' ? H % 2 === 1 : p === 'Even' ? H % 2 === 0 : null;
    case 'Away Odd/Even': return p === 'Odd' ? A % 2 === 1 : p === 'Even' ? A % 2 === 0 : null;
    case 'Exact Goals Number': return exactGoals(H + A, p);
    case 'Home Team Exact Goals Number': return exactGoals(H, p);
    case 'Away Team Exact Goals Number': return exactGoals(A, p);
    case 'Winning Margin': {
      if (p === 'Score Draw') return H === A && H > 0;
      if (p === 'Draw') return H === 0 && A === 0;
      const m = /^([12]) by (\d+)(\+?)$/.exec(p);
      if (!m) return null;
      const margin = m[1] === '1' ? H - A : A - H;
      return m[3] === '+' ? margin >= Number(m[2]) : margin === Number(m[2]);
    }
    case 'Results/Both Teams Score': {
      const m = /^(Home|Draw|Away)\/(Yes|No)$/.exec(p);
      if (!m) return null;
      const btts = H > 0 && A > 0;
      return res(H, A) === m[1] && (m[2] === 'Yes' ? btts : !btts);
    }
    case 'Result/Total Goals': {
      const m = /^(Home|Draw|Away)\/(Over|Under) ([\d.]+)$/.exec(p);
      if (!m) return null;
      return res(H, A) === m[1] && ou(H + A, m[2] + ' ' + m[3]);
    }
    case 'Total Goals/Both Teams To Score': {
      const m = /^([ou])\/(yes|no) ([\d.]+)$/.exec(p);
      if (!m) return null;
      const over = H + A > parseFloat(m[3]);
      const btts = H > 0 && A > 0;
      return (m[1] === 'o' ? over : !over) && (m[2] === 'yes' ? btts : !btts);
    }
    case 'Number Of Goals In Match':
      return p === 'Under 2 goals' ? H + A <= 1
        : p === '2 or 3 goals' ? (H + A === 2 || H + A === 3)
        : p === 'Over 3 goals' ? H + A >= 4 : null;
  }
  // Half markets: undecidable until the half-time score is known.
  if (needHt) return null;
  const htTotal = hH + hA, shTotal = H2.h + H2.a;
  switch (market) {
    case 'First Half Winner': return res(hH, hA) === p;
    case 'Second Half Winner': return res(H2.h, H2.a) === p;
    case 'Goals Over/Under First Half': return ou(htTotal, p);
    case 'Goals Over/Under - Second Half': return ou(shTotal, p);
    case 'HT/FT Double': {
      const parts = p.split('/');
      return parts.length === 2 && res(hH, hA) === parts[0] && res(H, A) === parts[1];
    }
    case 'Handicap Result - First Half': return handicap(hH, hA, p);
    case 'Correct Score - First Half': {
      const m = /^(\d+):(\d+)$/.exec(p);
      return m ? (hH === Number(m[1]) && hA === Number(m[2])) : null;
    }
    case 'Double Chance - First Half':
      return p === 'Home/Draw' ? hH >= hA : p === 'Home/Away' ? hH !== hA : p === 'Draw/Away' ? hA >= hH : null;
    case 'Both Teams Score - First Half':
      return p === 'Yes' ? (hH > 0 && hA > 0) : p === 'No' ? (hH === 0 || hA === 0) : null;
    case 'Both Teams To Score - Second Half':
      return p === 'Yes' ? (H2.h > 0 && H2.a > 0) : p === 'No' ? (H2.h === 0 || H2.a === 0) : null;
    case 'Win Both Halves':
      return p === 'Home' ? (hH > hA && H2.h > H2.a) : p === 'Away' ? (hA > hH && H2.a > H2.h) : null;
    case 'To Win Either Half':
      return p === 'Home' ? (hH > hA || H2.h > H2.a) : p === 'Away' ? (hA > hH || H2.a > H2.h) : null;
    case 'To Score In Both Halves By Teams':
      return p === 'Home' ? (hH > 0 && H2.h > 0) : p === 'Away' ? (hA > 0 && H2.a > 0) : null;
    case 'Odd/Even - First Half': return p === 'Odd' ? htTotal % 2 === 1 : p === 'Even' ? htTotal % 2 === 0 : null;
    case 'Odd/Even - Second Half': return p === 'Odd' ? shTotal % 2 === 1 : p === 'Even' ? shTotal % 2 === 0 : null;
    case 'Exact Goals Number - First Half': return exactGoals(htTotal, p);
    case 'Second Half Exact Goals Number': return exactGoals(shTotal, p);
    case 'Highest Scoring Half':
      return p === '1st Half' ? htTotal > shTotal : p === '2nd Half' ? shTotal > htTotal : p === 'Draw' ? htTotal === shTotal : null;
    case 'Home Highest Scoring Half':
      return p === '1st Half' ? hH > H2.h : p === '2nd Half' ? H2.h > hH : p === 'Draw' ? hH === H2.h : null;
    case 'Away Highest Scoring Half':
      return p === '1st Half' ? hA > H2.a : p === '2nd Half' ? H2.a > hA : p === 'Draw' ? hA === H2.a : null;
    default: return null;
  }
}

// ---- ShinobiPay (direct MoMo push deposits) --------------------------
// The secret key lives ONLY in server env (SHINOBIPAY_SECRET_KEY); it is
// never sent to the browser and never logged. The webhook signing secret
// is SHINOBIPAY_WEBHOOK_SECRET. Without the key, deposit endpoints answer
// 503 provider_not_configured and the wallet falls back to manual transfer.
function shinobiConfig() {
  return {
    apiBase: (process.env.SHINOBIPAY_API_BASE || 'https://akwapayapi.onrender.com/v1').replace(/\/$/, ''),
    secretKey: process.env.SHINOBIPAY_SECRET_KEY || '',
    webhookSecret: process.env.SHINOBIPAY_WEBHOOK_SECRET || ''
  };
}

// One JSON call to the ShinobiPay API. Returns { status, data } and never
// throws on an HTTP error status (callers branch on it); it throws only
// when the network itself failed, which callers must treat as "unknown".
async function shinobiFetch(path, { method = 'GET', body, idempotencyKey } = {}) {
  const { apiBase, secretKey } = shinobiConfig();
  const headers = { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(apiBase + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// Flutterwave (Nigeria, Prince 2026-11-07): hosted-checkout deposits in
// NGN and bank-transfer payouts. Keys arrive via env only — Prince
// pastes FLUTTERWAVE_SECRET_KEY + FLUTTERWAVE_WEBHOOK_HASH into Vercel
// and Railway; without them every Flutterwave surface answers
// provider_not_configured and the Nigerian UI shows a switching-on note.
function flwConfig() {
  return {
    apiBase: 'https://api.flutterwave.com/v3',
    secretKey: process.env.FLUTTERWAVE_SECRET_KEY || '',
    webhookHash: process.env.FLUTTERWAVE_WEBHOOK_HASH || ''
  };
}
async function flwFetch(path, { method = 'GET', body } = {}) {
  const { apiBase, secretKey } = flwConfig();
  const res = await fetch(apiBase + path, {
    method,
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ShinobiPay intent status -> our attempt status vocabulary.
function mapIntentStatus(s) {
  switch (s) {
    case 'succeeded': return 'succeeded';
    case 'failed': return 'failed';
    case 'processing': return 'processing';
    case 'requires_action': return 'awaiting';
    case 'unknown': return 'unknown';
    default: return 'processing';
  }
}

// Guess the MoMo network from a local Ghana number's prefix. Portability
// means this is only a default: the customer confirms the network in the
// UI, and ShinobiPay warns on a mismatch rather than rerouting.
function detectNetwork(localPhone) {
  const p = String(localPhone || '').slice(0, 3);
  if (['024', '025', '053', '054', '055', '059'].includes(p)) return 'MTN';
  if (['020', '050'].includes(p)) return 'TELECEL';
  if (['026', '027', '056', '057'].includes(p)) return 'AIRTELTIGO';
  return null;
}

// Tables for payment attempts + webhook idempotency. Created lazily so
// the integration self-installs on first use (no console access needed);
// backend/schema.sql carries the same definitions for the record.
let tablesReady = null;
function ensurePaymentTables() {
  if (!tablesReady) {
    tablesReady = (async () => {
      await sql(`create table if not exists payment_attempts (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users (id),
        provider text not null default 'shinobipay',
        reference text not null unique,
        intent_id text,
        client_secret text,
        amount_ghs numeric(12, 2) not null,
        amount_minor integer not null,
        phone text,
        network text,
        status text not null default 'created',
        fail_reason text,
        last_sequence integer not null default 0,
        created_at timestamptz not null default now(),
        settled_at timestamptz
      )`);
      await sql(`alter table payment_attempts add column if not exists currency text not null default 'GHS'`);
      await sql(`alter table wallet_transactions add column if not exists payout_meta jsonb`);
      await sql(`create table if not exists webhook_events (
        event_id text primary key,
        received_at timestamptz not null default now()
      )`);
    })().catch(e => { tablesReady = null; throw e; });
  }
  return tablesReady;
}

// ---- Admin platform: invites, commissions, settings, custom matches --
// Lazy self-migration (same pattern as the payment tables): invite
// attribution columns on users, one-time admin invite tokens, the
// commission ledger, goal schedules on matches, and the operator
// settings the super-admin dashboard controls.
let adminTablesReady = null;
function ensureAdminTables() {
  if (!adminTablesReady) {
    adminTablesReady = (async () => {
      await sql(`alter table users add column if not exists invite_code text`);
      await sql(`alter table users add column if not exists bonus_ghs numeric(12,2) not null default 0`);
      await sql(`create unique index if not exists users_invite_code_idx on users (invite_code) where invite_code is not null`);
      await sql(`alter table users add column if not exists invited_by uuid references users (id)`);
      // Widen the status check so invited admins can sit in 'pending'
      // until the super admin verifies them.
      await sql(`do $$ declare c text; begin
        select conname into c from pg_constraint
        where conrelid = 'users'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%status%';
        if c is not null then execute 'alter table users drop constraint ' || quote_ident(c); end if;
        alter table users add constraint users_status_check check (status in ('active', 'blocked', 'pending'));
      end $$`);
      await sql(`create table if not exists invites (
        id uuid primary key default gen_random_uuid(),
        token text not null unique,
        kind text not null default 'admin',
        created_by uuid references users (id),
        expires_at timestamptz not null,
        used_by uuid references users (id),
        used_at timestamptz,
        created_at timestamptz not null default now()
      )`);
      await sql(`create table if not exists commissions (
        id uuid primary key default gen_random_uuid(),
        earner_id uuid not null references users (id),
        source_user_id uuid not null references users (id),
        source_txn_id uuid references wallet_transactions (id),
        basis_ghs numeric(12, 2) not null,
        pct numeric(6, 2) not null,
        amount_ghs numeric(12, 2) not null,
        paid_at timestamptz,
        created_at timestamptz not null default now()
      )`);
      // A deposit books TWO commission rows now (admin + super), so the
      // old one-row-per-deposit index must not exist. Drop it on every
      // cold start: a stale pre-split instance once resurrected it
      // during a deploy rollout and first-deposit confirms began
      // failing on the duplicate key (2026-11-09).
      await sql(`drop index if exists commissions_source_idx`);
      await sql(`create unique index if not exists commissions_source_earner_idx on commissions (earner_id, source_txn_id) where source_txn_id is not null`);
      // An earner's ask for the super admin to settle their pending
      // commissions (the Pay Out button in Platform Control settles
      // it). One open request per earner at a time.
      await sql(`create table if not exists commission_payout_requests (
        id uuid primary key default gen_random_uuid(),
        earner_id uuid not null references users (id),
        amount_ghs numeric(12, 2) not null,
        status text not null default 'pending',
        created_at timestamptz not null default now(),
        decided_at timestamptz,
        decided_by uuid references users (id)
      )`);
      await sql(`create unique index if not exists cpr_open_idx on commission_payout_requests (earner_id) where status = 'pending'`);
      await msql(`alter table matches add column if not exists goal_events jsonb not null default '[]'::jsonb`);
      await sql(`insert into operator_settings (key, value) values
        ('gateway_enabled', '1'), ('payouts_frozen', '0'),
        ('admin_commission_pct', '0'), ('user_cashback_pct', '0'),
        ('referral_deposit_bonus_ghs', '100'), ('cashout_margin_pct', '10')
        on conflict (key) do nothing`);
    })().catch(e => { adminTablesReady = null; throw e; });
  }
  return adminTablesReady;
}

async function getSettings(keys) {
  const rows = await sql('select key, value from operator_settings where key = any($1::text[])', [keys]);
  const out = {};
  rows.forEach(r => { out[r.key] = r.value; });
  return out;
}

// Rewards that hang off a completed deposit, run once per deposit txn:
//  - user cashback: user_cashback_pct of the deposit, credited straight
//    back to the depositor's balance as an adjustment ledger row.
//  - referral commission: admin_commission_pct of the deposit, recorded
//    in the commission ledger for whoever invited the depositor — any
//    account can refer, players included — to be paid out later from
//    the super-admin dashboard.
// Idempotent per source txn, so a retried call can never double-pay.
// Cross-currency conversion for commissions (Prince, 2026-11-08:
// "make the naira different currency"). One platform rate — naira per
// 1 cedi, editable in Platform Control (fx_ngn_per_ghs, default 140).
// Only GHS<->NGN has a live rate; every other pair is 1:1 because no
// other currency has a working deposit rail yet.
function convertAmount(amount, fromCur, toCur, fxNgnPerGhs) {
  const a = Number(amount) || 0;
  if (fromCur === toCur) return a;
  const fx = Number(fxNgnPerGhs) > 0 ? Number(fxNgnPerGhs) : 140;
  if (fromCur === 'NGN' && toCur === 'GHS') return Math.round((a / fx) * 100) / 100;
  if (fromCur === 'GHS' && toCur === 'NGN') return Math.round(a * fx * 100) / 100;
  return a;
}
// First-deposit bonus (Prince, 2026-11-09): Ghana pays 100 on a 120
// deposit — a ratio of 100/120 of the amount, tunable in Platform
// Control (deposit_bonus_ghs_ratio). Nigeria pays half of 25,000
// rounded DOWN to the nearest 1,000 = 12,000 (deposit_bonus_ngn_ratio,
// floor is a constant). Any other currency: no bonus (no rails yet).
function firstDepositBonus(amount, currency, s) {
  const a = Number(amount) || 0;
  if (a <= 0) return 0;
  if (currency === 'GHS') {
    const r = s && s.deposit_bonus_ghs_ratio !== undefined ? Number(s.deposit_bonus_ghs_ratio) : 100 / 120;
    return Math.round(a * r * 100) / 100;
  }
  if (currency === 'NGN') {
    const r = s && s.deposit_bonus_ngn_ratio !== undefined ? Number(s.deposit_bonus_ngn_ratio) : 0.5;
    return Math.floor((a * r) / 1000) * 1000;
  }
  return 0;
}
// Commission split (Prince, 2026-11-09): the referring admin's take
// is CONSTANT — 70% of the 100 fare amount = GH₵70 flat (converted
// into the earner's currency), whatever the deposit size; gateway
// charges and size stop mattering. Everything else in the commission
// pot goes to the super admin. 'Rounded up to the 70%' — the admin
// always sees the full flat 70, never a pesewa less.
function splitCommission(earnPot, earnCur, fxNgnPerGhs) {
  const pot = Math.round((Number(earnPot) || 0) * 100) / 100;
  const flat = convertAmount(70, 'GHS', earnCur, fxNgnPerGhs);
  const admin = Math.min(flat, pot);
  return { admin: Math.round(admin * 100) / 100, super: Math.round((pot - admin) * 100) / 100 };
}
async function applyDepositRewards(userId, txnId, amountGhs, currency) {
  const amount = Number(amountGhs);
  if (!(amount > 0)) return;
  const s = await getSettings(['admin_commission_pct', 'user_cashback_pct', 'fx_ngn_per_ghs', 'deposit_bonus_ghs_ratio', 'deposit_bonus_ngn_ratio']);
  const cashPct = Number(s.user_cashback_pct || 0);
  const commPct = Number(s.admin_commission_pct || 0);
  if (cashPct > 0) {
    const cash = Math.round(amount * cashPct) / 100;
    if (cash > 0) {
      const dupe = await sql('select id from wallet_transactions where external_ref = $1', ['cashback:' + txnId]);
      if (!dupe.length) {
        await sql(
          `with ins as (
             insert into wallet_transactions (user_id, kind, method, amount_ghs, status, external_ref, note)
             values ($1, 'adjustment', 'Deposit cashback', $2, 'completed', $3, $4) returning id
           )
           update users set balance_ghs = balance_ghs + $2 where id = $1`,
          [userId, cash, 'cashback:' + txnId, cashPct + '% cashback on deposit']
        );
      }
    }
  }
  // FIRST-DEPOSIT BONUS (Prince, 2026-11-09): only the first
  // completed deposit a user ever makes earns it ('only first
  // deposit — the others no'). It replaces the old flat referral
  // bonus that paid on every deposit. The money is STAKE-ONLY: it
  // lands in the balance AND in the bonus_ghs bucket; staking spends
  // the bucket down and withdrawals can never touch it.
  const priorDeps = await sql(
    `select count(*)::int as n from wallet_transactions
     where user_id = $1 and kind = 'deposit' and status = 'completed' and id <> $2`,
    [userId, txnId]
  );
  if (priorDeps[0].n === 0) {
    const bonus = firstDepositBonus(amount, currency || 'GHS', s);
    if (bonus > 0) {
      const dupe = await sql('select id from wallet_transactions where external_ref = $1', ['firstbonus:' + txnId]);
      if (!dupe.length) {
        await sql(
          `with ins as (
             insert into wallet_transactions (user_id, kind, method, amount_ghs, status, external_ref, note)
             values ($1, 'adjustment', 'First deposit bonus', $2, 'completed', $3, $4) returning id
           )
           update users set balance_ghs = balance_ghs + $2, bonus_ghs = bonus_ghs + $2 where id = $1`,
          [userId, bonus, 'firstbonus:' + txnId, 'First deposit bonus (stakes only)']
        );
      }
    }
  }
  if (commPct > 0) {
    const inv = await sql(
      `select i.id, i.phone, i.role from users u join users i on i.id = u.invited_by
       where u.id = $1 and i.status = 'active' and i.role in ('admin', 'super_admin')`,
      [userId]
    );
    if (inv.length) {
      if (commPct > 0) {
        // Commission is earned in the EARNER's currency: convert the
        // deposit amount first. Booking a naira deposit's raw number
        // into a cedi admin's earnings paid out ~100x too much
        // (GH₵21,000 booked on a ₦30,000 deposit, 2026-11-08).
        const depCur = currency || 'GHS';
        const earnCur = currencyOfPhone(inv[0].phone);
        const basis = convertAmount(amount, depCur, earnCur, s.fx_ngn_per_ghs);
        const earn = Math.round(basis * commPct) / 100;
        if (earn > 0) {
          // Split the pot on the FIRST deposit only (Prince,
          // 2026-11-09, corrected same day): the referring admin's
          // share is the constant flat 70 (see splitCommission); the
          // remainder is the super admin's, booked as his own row in
          // HIS currency. On every LATER deposit the admin simply
          // gets the full 70% pot, the way it always was. If the
          // referrer IS the super admin, or no distinct super admin
          // exists, he simply keeps the whole pot.
          const parts = splitCommission(earn, earnCur, s.fx_ngn_per_ghs);
          let sup = null;
          if (priorDeps[0].n === 0 && inv[0].role !== 'super_admin' && parts.super > 0) {
            const supRows = await sql(
              `select id, phone from users where role = 'super_admin' and status = 'active' order by created_at asc limit 1`
            );
            if (supRows.length && supRows[0].id !== inv[0].id) sup = supRows[0];
          }
          if (!sup) {
            await sql(
              `insert into commissions (earner_id, source_user_id, source_txn_id, basis_ghs, pct, amount_ghs)
               values ($1, $2, $3, $4, $5, $6) on conflict (earner_id, source_txn_id) where source_txn_id is not null do nothing`,
              [inv[0].id, userId, txnId, basis, commPct, earn]
            );
          } else {
            await sql(
              `insert into commissions (earner_id, source_user_id, source_txn_id, basis_ghs, pct, amount_ghs)
               values ($1, $2, $3, $4, $5, $6) on conflict (earner_id, source_txn_id) where source_txn_id is not null do nothing`,
              [inv[0].id, userId, txnId, basis, commPct, parts.admin]
            );
            const supCur = currencyOfPhone(sup.phone);
            const supBasis = convertAmount(basis, earnCur, supCur, s.fx_ngn_per_ghs);
            const supAmt = Math.round(convertAmount(parts.super, earnCur, supCur, s.fx_ngn_per_ghs) * 100) / 100;
            if (supAmt > 0) {
              const supPct = supBasis > 0 ? Math.round((supAmt / supBasis) * 10000) / 100 : commPct;
              await sql(
                `insert into commissions (earner_id, source_user_id, source_txn_id, basis_ghs, pct, amount_ghs)
                 values ($1, $2, $3, $4, $5, $6) on conflict (earner_id, source_txn_id) where source_txn_id is not null do nothing`,
                [sup.id, userId, txnId, supBasis, supPct, supAmt]
              );
            }
          }
        }
      }
    }
  }
}

// A super-admin "featured" match carries a goal schedule. Its displayed
// state is derived from the clock: before kickoff it is upcoming; from
// kickoff the match clock counts up (pausing for half time) and each
// scheduled goal lands at its minute; at full time it is finished
// with the full scheduled score.
// A goal may carry stoppage time (Prince, 2026-11-05): {minute: 45,
// extra: 2} is a 45+2' goal — `minute` stays the regulation minute (so
// half-time derivation from minute <= 45 stays right) and the goal
// lands at minute + extra on the live clock.
function goalEff(g) { return Number(g.minute) + (Number(g.extra) || 0); }
// Shared by match creation and editing: validate a goal schedule
// into [{minute, side, extra?}] sorted by effective minute.
function cleanGoalSchedule(goals) {
  const out = [];
  if (Array.isArray(goals)) {
    for (const g of goals.slice(0, 14)) {
      const minute = Math.round(Number(g && g.minute));
      const side = g && g.side;
      let extra = Math.round(Number(g && g.extra) || 0);
      if (minute !== 45 && minute !== 90) extra = 0;
      extra = Math.min(15, Math.max(0, extra));
      if (minute >= 1 && minute <= 90 && (side === 'home' || side === 'away')) {
        const goal = { minute, side };
        if (extra) goal.extra = extra;
        out.push(goal);
      }
    }
    out.sort((a, b) => goalEff(a) - goalEff(b));
  }
  return out;
}
// A team crest ("flag"): an https URL, or a small data image the
// portal downscaled before sending. Anything else is rejected.
function cleanCrestUrl(v) {
  const s = String(v || '').trim();
  if (/^https:\/\/\S+$/i.test(s) && s.length <= 500) return s;
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length <= 160000) return s;
  return null;
}
function isCustomMatch(m) {
  return m && typeof m.external_ref === 'string' && m.external_ref.startsWith('custom:');
}
function customMatchState(m, now = new Date()) {
  const goals = Array.isArray(m.goal_events) ? m.goal_events : [];
  const finH = goals.filter(g => g.side === 'home').length;
  const finA = goals.filter(g => g.side === 'away').length;
  if (m.status === 'finished') return { status: 'finished', minute: null, score_home: m.score_home, score_away: m.score_away, final_home: m.score_home, final_away: m.score_away };
  // A postponed custom match freezes: the stored status wins over
  // the clock, and the score snapshotted at postpone time is shown.
  if (m.status === 'postponed') return { status: 'postponed', minute: null, score_home: m.score_home || 0, score_away: m.score_away || 0, final_home: finH, final_away: finA };
  const elapsed = Math.floor((now - new Date(m.starts_at)) / 60000);
  if (elapsed < 0) return { status: 'upcoming', minute: null, score_home: 0, score_away: 0, final_home: finH, final_away: finA };
  // Real football timing (Prince, 2026-11-05, from his reference):
  // 45 minutes + 1st-half stoppage, a 15-minute half-time break,
  // then 45 minutes + 2nd-half stoppage. The match clock pauses at
  // half time; the returned `minute` is the match clock and
  // `minute_label` is what the site displays (45+2′, HT, 90+3′).
  const s1 = Math.min(15, Math.max(0, Number(m.ht_stoppage) || 0));
  const s2 = Math.min(15, Math.max(0, Number(m.ft_stoppage) || 0));
  const halfEnd = 45 + s1;
  const secondStart = halfEnd + 15;
  const fullEnd = secondStart + 45 + s2;
  if (elapsed > fullEnd) return { status: 'finished', minute: null, score_home: finH, score_away: finA, final_home: finH, final_away: finA };
  let clock, phase, label;
  if (elapsed <= halfEnd) { phase = '1H'; clock = elapsed; }
  else if (elapsed < secondStart) { phase = 'HT'; clock = halfEnd; }
  else { phase = '2H'; clock = 45 + (elapsed - secondStart); }
  if (phase === 'HT') label = 'HT';
  else if (phase === '1H' && clock > 45) label = '45+' + (clock - 45) + '′';
  else if (phase === '2H' && clock > 90) label = '90+' + (clock - 90) + '′';
  else label = clock + '′';
  const shown = goals.filter(g => goalEff(g) <= clock);
  return {
    status: 'live', minute: clock, minute_label: label, phase,
    score_home: shown.filter(g => g.side === 'home').length,
    score_away: shown.filter(g => g.side === 'away').length,
    final_home: finH, final_away: finA
  };
}

// Build a full odds book from a 1X2 line for a custom match: Double
// Chance from the 1X2 prices (same maths as the ESPN sync), the
// Over/Under ladder and BTTS from a Poisson goal model whose total is
// split between the teams by their implied win strengths.
function poissonCdf(k, mu) {
  let term = Math.exp(-mu), sum = term;
  for (let i = 1; i <= k; i++) { term *= mu / i; sum += term; }
  return sum;
}
function expandOdds(o1, ox, o2) {
  const odds = {};
  if (!(o1 > 1 && ox > 1 && o2 > 1)) return odds;
  odds.o1 = o1; odds.ox = ox; odds.o2 = o2;
  odds.dc1x = Math.round((o1 * ox) / (o1 + ox) * 100) / 100;
  odds.dc12 = Math.round((o1 * o2) / (o1 + o2) * 100) / 100;
  odds.dcx2 = Math.round((ox * o2) / (ox + o2) * 100) / 100;
  const raw = [1 / o1, 1 / ox, 1 / o2];
  const margin = raw[0] + raw[1] + raw[2];
  const pH = raw[0] / margin, pA = raw[2] / margin;
  const mu = 2.7;
  const muH = mu * (pH / (pH + pA || 1)) || mu / 2;
  const muA = Math.max(mu - muH, 0.15);
  const pHomeScores = 1 - Math.exp(-muH), pAwayScores = 1 - Math.exp(-muA);
  const fair = (p) => (p > 0.02 && p < 0.98) ? Math.round((1 / p) / (margin > 1 ? 1.05 : 1) * 100) / 100 : null;
  [0.5, 1.5, 2.5, 3.5, 4.5].forEach(line => {
    const suffix = String(line).replace('.', '');
    const pOver = 1 - poissonCdf(Math.floor(line), mu);
    const o = fair(pOver), u = fair(1 - pOver);
    if (o && o > 1.01) odds['over' + suffix] = o;
    if (u && u > 1.01) odds['under' + suffix] = u;
  });
  const gg = fair(pHomeScores * pAwayScores);
  const ng = fair(1 - pHomeScores * pAwayScores);
  if (gg && gg > 1.01) odds.gg = gg;
  if (ng && ng > 1.01) odds.ng = ng;
  Object.keys(odds).forEach(k => { if (!(odds[k] > 1)) delete odds[k]; });
  return odds;
}

// Complete a partial odds book from its 1X2 line: any key the book
// lacks (totals lines ESPN did not publish, BTTS it never carries)
// is priced by expandOdds; keys already present are never touched.
// Deterministic — the match list, the details page and bet
// placement all see the same completed book.
function fillOdds(odds) {
  if (!odds) return {};
  const have = ['o1', 'ox', 'o2'].filter(k => odds[k] > 1);
  if (have.length === 2) {
    // Exactly one 1X2 price missing from the feed (ESPN sometimes
    // sends draw + away only — the Monza hole on PrimeStake,
    // 2026-11-05): derive the missing price from the other two at
    // the house margin, the same per-field completion the featured-
    // match creator uses, so the 1 X 2 row never shows a hole.
    const missing = ['o1', 'ox', 'o2'].find(k => !have.includes(k));
    let usedFair = 0;
    for (const k of have) usedFair += 0.94 / odds[k];
    const rest = Math.max(1 - usedFair, 0.02);
    const derived = Math.min(51, Math.max(1.02, Math.round((0.94 / rest) * 100) / 100));
    odds = { ...odds, [missing]: derived };
  }
  if (!(odds.o1 > 1 && odds.ox > 1 && odds.o2 > 1)) return odds;
  return { ...expandOdds(odds.o1, odds.ox, odds.o2), ...odds };
}

// Full market book for operator-created matches (Prince, 2026-11-05:
// created games should carry the same markets as the API-Football
// ones — "correct score etc ... like the ones from api football").
// Derived from the match's own 1X2 line with the same Poisson split
// expandOdds uses for the classic ladder (mu = 2.7 total goals), so
// the whole page prices coherently and the create-match autofill /
// randomizer produces the full book automatically. Market names,
// ids and pick labels mirror API-Football's exactly, and every
// market emitted is one afPickWon can settle — the unit test sweeps
// every pick over the score matrix and asserts none is undecidable.
// Half markets price off a 45/55 goal split between the halves.
function fullBookFromOdds(odds) {
  if (!odds || !(odds.o1 > 1 && odds.ox > 1 && odds.o2 > 1)) return [];
  const raw = [1 / odds.o1, 1 / odds.ox, 1 / odds.o2];
  const margin = raw[0] + raw[1] + raw[2];
  const pH = raw[0] / margin, pA = raw[2] / margin;
  const mu = 2.7;
  const muH = mu * (pH / (pH + pA || 1)) || mu / 2;
  const muA = Math.max(mu - muH, 0.15);
  const MAXG = 12;
  const pmf = (lambda) => {
    const arr = [Math.exp(-lambda)];
    for (let k = 1; k <= MAXG; k++) arr.push(arr[k - 1] * lambda / k);
    return arr;
  };
  const PH = pmf(muH), PA = pmf(muA);
  const H1 = pmf(muH * 0.45), A1 = pmf(muA * 0.45);
  const H2 = pmf(muH * 0.55), A2 = pmf(muA * 0.55);
  const price = (p) => {
    if (!(p >= 0.002)) return null;
    const v = Math.round(((1 / p) / (margin > 1 ? 1.05 : 1)) * 100) / 100;
    return v >= 1.02 && v <= 500 ? v : null;
  };
  const book = [];
  const add = (id, name, pairs) => {
    const values = [];
    for (const [label, p] of pairs) {
      const odd = price(p);
      if (odd) values.push({ value: label, odd });
    }
    if (values.length >= 2) book.push({ id, name, values });
  };
  const gridP = (G1, G2, fn) => {
    let s = 0;
    for (let h = 0; h <= MAXG; h++) for (let a = 0; a <= MAXG; a++) if (fn(h, a)) s += G1[h] * G2[a];
    return s;
  };
  const teamP = (G, fn) => { let s = 0; for (let k = 0; k <= MAXG; k++) if (fn(k)) s += G[k]; return s; };
  const jointP = (fn) => {
    let s = 0;
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++)
      for (let d1 = 0; d1 <= 8; d1++) for (let d2 = 0; d2 <= 8; d2++)
        if (fn(i + d1, j + d2, i, j, d1, d2)) s += H1[i] * A1[j] * H2[d1] * A2[d2];
    return s;
  };
  const res = (h, a) => (h > a ? 'Home' : h < a ? 'Away' : 'Draw');
  const ouPairs = (G1, G2, lines) => {
    const pairs = [];
    for (const line of lines) {
      pairs.push(['Over ' + line, gridP(G1, G2, (h, a) => h + a > line)]);
      pairs.push(['Under ' + line, gridP(G1, G2, (h, a) => h + a < line)]);
    }
    return pairs;
  };
  const handicapPairs = (G1, G2, lines) => {
    // A line only joins the book complete (all three results priced):
    // a partial handicap trio would look broken on the page.
    const pairs = [];
    for (const line of lines) {
      const lbl = line > 0 ? '+' + line : String(line);
      const trio = ['Home', 'Draw', 'Away'].map(r => [r + ' ' + lbl, gridP(G1, G2, (h, a) => res(h + line, a) === r)]);
      if (trio.every(([, p]) => price(p))) pairs.push(...trio);
    }
    return pairs;
  };

  // Correct Score (full time + first half)
  const csPairs = [];
  for (let h = 0; h <= 5; h++) for (let a = 0; a <= 5; a++) csPairs.push([h + ':' + a, PH[h] * PA[a]]);
  add(10, 'Correct Score', csPairs);
  const csHtPairs = [];
  for (let h = 0; h <= 3; h++) for (let a = 0; a <= 3; a++) csHtPairs.push([h + ':' + a, H1[h] * A1[a]]);
  add(31, 'Correct Score - First Half', csHtPairs);
  // HT/FT + half winners
  add(7, 'HT/FT Double', ['Home', 'Draw', 'Away'].flatMap(r1 =>
    ['Home', 'Draw', 'Away'].map(r2 => [r1 + '/' + r2, jointP((h, a, i, j) => res(i, j) === r1 && res(h, a) === r2)])));
  add(13, 'First Half Winner', ['Home', 'Draw', 'Away'].map(r => [r, gridP(H1, A1, (h, a) => res(h, a) === r)]));
  add(3, 'Second Half Winner', ['Home', 'Draw', 'Away'].map(r => [r, gridP(H2, A2, (h, a) => res(h, a) === r)]));
  add(20, 'Double Chance - First Half', [
    ['Home/Draw', gridP(H1, A1, (h, a) => h >= a)],
    ['Home/Away', gridP(H1, A1, (h, a) => h !== a)],
    ['Draw/Away', gridP(H1, A1, (h, a) => a >= h)],
  ]);
  add(6, 'Goals Over/Under First Half', ouPairs(H1, A1, [0.5, 1.5, 2.5]));
  add(26, 'Goals Over/Under - Second Half', ouPairs(H2, A2, [0.5, 1.5, 2.5]));
  add(34, 'Both Teams Score - First Half', [
    ['Yes', gridP(H1, A1, (h, a) => h > 0 && a > 0)],
    ['No', gridP(H1, A1, (h, a) => h === 0 || a === 0)],
  ]);
  add(35, 'Both Teams To Score - Second Half', [
    ['Yes', gridP(H2, A2, (h, a) => h > 0 && a > 0)],
    ['No', gridP(H2, A2, (h, a) => h === 0 || a === 0)],
  ]);
  // Handicaps + team totals + clean sheets + win to nil
  add(9, 'Handicap Result', handicapPairs(PH, PA, [-2, -1, 1, 2]));
  add(18, 'Handicap Result - First Half', handicapPairs(H1, A1, [-1, 1]));
  add(16, 'Total - Home', [0.5, 1.5, 2.5].flatMap(line => [
    ['Over ' + line, teamP(PH, k => k > line)], ['Under ' + line, teamP(PH, k => k < line)],
  ]));
  add(17, 'Total - Away', [0.5, 1.5, 2.5].flatMap(line => [
    ['Over ' + line, teamP(PA, k => k > line)], ['Under ' + line, teamP(PA, k => k < line)],
  ]));
  add(27, 'Clean Sheet - Home', [['Yes', PA[0]], ['No', 1 - PA[0]]]);
  add(28, 'Clean Sheet - Away', [['Yes', PH[0]], ['No', 1 - PH[0]]]);
  add(36, 'Win To Nil', [
    ['Home', gridP(PH, PA, (h, a) => h > a && a === 0)],
    ['Away', gridP(PH, PA, (h, a) => a > h && h === 0)],
  ]);
  // Odd/even + exact goals
  add(21, 'Odd/Even', [
    ['Odd', gridP(PH, PA, (h, a) => (h + a) % 2 === 1)],
    ['Even', gridP(PH, PA, (h, a) => (h + a) % 2 === 0)],
  ]);
  add(23, 'Home Odd/Even', [['Odd', teamP(PH, k => k % 2 === 1)], ['Even', teamP(PH, k => k % 2 === 0)]]);
  add(60, 'Away Odd/Even', [['Odd', teamP(PA, k => k % 2 === 1)], ['Even', teamP(PA, k => k % 2 === 0)]]);
  add(38, 'Exact Goals Number', [0, 1, 2, 3, 4, 5, 6].map(n => [String(n), gridP(PH, PA, (h, a) => h + a === n)])
    .concat([['more 7', gridP(PH, PA, (h, a) => h + a >= 7)]]));
  add(40, 'Home Team Exact Goals Number', [0, 1, 2].map(n => [String(n), PH[n]])
    .concat([['more 3', teamP(PH, k => k >= 3)]]));
  add(41, 'Away Team Exact Goals Number', [0, 1, 2].map(n => [String(n), PA[n]])
    .concat([['more 3', teamP(PA, k => k >= 3)]]));
  // Winning margin + result combos
  add(47, 'Winning Margin', [
    ['1 by 1', gridP(PH, PA, (h, a) => h - a === 1)], ['1 by 2', gridP(PH, PA, (h, a) => h - a === 2)],
    ['1 by 3', gridP(PH, PA, (h, a) => h - a === 3)], ['1 by 4+', gridP(PH, PA, (h, a) => h - a >= 4)],
    ['2 by 1', gridP(PH, PA, (h, a) => a - h === 1)], ['2 by 2', gridP(PH, PA, (h, a) => a - h === 2)],
    ['2 by 3', gridP(PH, PA, (h, a) => a - h === 3)], ['2 by 4+', gridP(PH, PA, (h, a) => a - h >= 4)],
    ['Score Draw', gridP(PH, PA, (h, a) => h === a && h > 0)], ['Draw', PH[0] * PA[0]],
  ]);
  add(24, 'Results/Both Teams Score', ['Home', 'Draw', 'Away'].flatMap(r => [
    [r + '/Yes', gridP(PH, PA, (h, a) => res(h, a) === r && h > 0 && a > 0)],
    [r + '/No', gridP(PH, PA, (h, a) => res(h, a) === r && (h === 0 || a === 0))],
  ]));
  add(25, 'Result/Total Goals', ['Home', 'Draw', 'Away'].flatMap(r => [
    [r + '/Over 2.5', gridP(PH, PA, (h, a) => res(h, a) === r && h + a > 2.5)],
    [r + '/Under 2.5', gridP(PH, PA, (h, a) => res(h, a) === r && h + a < 2.5)],
  ]));
  add(49, 'Total Goals/Both Teams To Score', [
    ['o/yes 2.5', gridP(PH, PA, (h, a) => h + a > 2.5 && h > 0 && a > 0)],
    ['o/no 2.5', gridP(PH, PA, (h, a) => h + a > 2.5 && (h === 0 || a === 0))],
    ['u/yes 2.5', gridP(PH, PA, (h, a) => h + a <= 2.5 && h > 0 && a > 0)],
    ['u/no 2.5', gridP(PH, PA, (h, a) => h + a <= 2.5 && (h === 0 || a === 0))],
  ]);
  add(349, 'Number Of Goals In Match', [
    ['Under 2 goals', gridP(PH, PA, (h, a) => h + a <= 1)],
    ['2 or 3 goals', gridP(PH, PA, (h, a) => h + a === 2 || h + a === 3)],
    ['Over 3 goals', gridP(PH, PA, (h, a) => h + a >= 4)],
  ]);
  add(32, 'Win Both Halves', [
    ['Home', jointP((h, a, i, j, d1, d2) => i > j && d1 > d2)],
    ['Away', jointP((h, a, i, j, d1, d2) => j > i && d2 > d1)],
  ]);
  add(39, 'To Win Either Half', [
    ['Home', jointP((h, a, i, j, d1, d2) => i > j || d1 > d2)],
    ['Away', jointP((h, a, i, j, d1, d2) => j > i || d2 > d1)],
  ]);
  return book;
}

function inviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'OD';
  const buf = require('crypto').randomBytes(8);
  for (let i = 0; i < 8; i++) code += chars[buf[i] % chars.length];
  return code;
}

// Every account — player, admin or super admin — owns one permanent
// referral code. Mint it lazily on first use and return it.
async function ensureInviteCode(userId) {
  const rows = await sql('select invite_code from users where id = $1', [userId]);
  if (!rows.length) return null;
  if (rows[0].invite_code) return rows[0].invite_code;
  for (let i = 0; i < 5; i++) {
    const upd = await sql('update users set invite_code = $2 where id = $1 and invite_code is null returning invite_code', [userId, inviteCode()]);
    if (upd.length) return upd[0].invite_code;
    const again = await sql('select invite_code from users where id = $1', [userId]);
    if (again.length && again[0].invite_code) return again[0].invite_code;
  }
  return null;
}

// Settle one MoMo deposit attempt (settlement safety net, 2026-11-04):
// re-verify the intent with ShinobiPay and, only if it truly succeeded
// for exactly the attempt's amount and reference, credit the wallet
// exactly once — attempt flip, ledger deposit row and balance move in
// a single statement, and the status guard makes a second call a
// no-op. Shared by the webhook (primary) and the deposit-status poll
// (reconciler), so a lost or unverifiable webhook can never strand a
// paid deposit at "awaiting" forever — the player's own waiting
// screen heals it. `attempt` needs id, user_id, reference, intent_id,
// amount_ghs, amount_minor, network, status.
// Returns 'credited' | 'already' | 'unverified' | 'not_succeeded'.
async function settleAttempt(attempt) {
  if (attempt.status === 'succeeded') return 'already';
  if (!attempt.intent_id) return 'not_succeeded';
  const got = await shinobiFetch(`/payment_intents/${encodeURIComponent(attempt.intent_id)}`);
  const intent = got.data || {};
  if (got.status !== 200 || intent.status !== 'succeeded') return 'not_succeeded';
  const verified = Number(intent.merchant_amount) === Number(attempt.amount_minor)
    && (!intent.reference || intent.reference === attempt.reference);
  if (!verified) {
    // Leave the status untouched but record why, so support can see
    // the mismatch instead of a silent strand.
    try {
      await sql(
        `update payment_attempts set fail_reason = $2 where id = $1 and status <> 'succeeded'`,
        [attempt.id, `verify_mismatch merchant_amount=${intent.merchant_amount} amount_minor=${attempt.amount_minor} ref=${intent.reference || ''}`]
      );
    } catch (e) { /* diagnostics only */ }
    return 'unverified';
  }
  const out = await sql(
    `with a as (
       update payment_attempts set status = 'succeeded', settled_at = now()
       where id = $1 and status <> 'succeeded'
       returning user_id, amount_ghs, network, intent_id
     ),
     ins as (
       insert into wallet_transactions (user_id, kind, method, amount_ghs, status, external_ref, note)
       select user_id, 'deposit', network || ' MoMo (ShinobiPay)', amount_ghs, 'completed', intent_id, 'ShinobiPay direct push deposit'
       from a returning id
     ),
     cred as (
       update users set balance_ghs = balance_ghs + (select amount_ghs from a)
       where id = (select user_id from a) returning id
     )
     select (select count(*) from a) as settled, (select id from ins) as txn_id`,
    [attempt.id]
  );
  if (Number(out[0].settled) === 1 && out[0].txn_id) {
    await ensureAdminTables();
    await applyDepositRewards(attempt.user_id, out[0].txn_id, Number(attempt.amount_ghs));
    return 'credited';
  }
  return 'already';
}

// Flutterwave twin of settleAttempt: re-verify the transaction with
// Flutterwave and credit exactly once, for exactly the attempt amount,
// only when the verify says successful AND the amount, currency and
// tx_ref all match the attempt. Driven by the webhook first and by the
// deposit-flw-status reconciler when the payer returns to the site.
async function settleFlwAttempt(attempt) {
  if (attempt.status === 'succeeded') return 'already';
  if (!attempt.intent_id) return 'not_succeeded';
  const got = await flwFetch(`/transactions/${encodeURIComponent(attempt.intent_id)}/verify`);
  const d = (got.data && got.data.data) || {};
  if (got.status !== 200 || d.status !== 'successful') return 'not_succeeded';
  const verified = Number(d.amount) === Number(attempt.amount_ghs)
    && d.currency === (attempt.currency || 'NGN')
    && String(d.tx_ref || '') === String(attempt.reference);
  if (!verified) {
    try {
      await sql(
        `update payment_attempts set fail_reason = $2 where id = $1 and status <> 'succeeded'`,
        [attempt.id, `verify_mismatch amount=${d.amount} currency=${d.currency || ''} tx_ref=${d.tx_ref || ''}`]
      );
    } catch (e) { /* diagnostics only */ }
    return 'unverified';
  }
  const out = await sql(
    `with a as (
       update payment_attempts set status = 'succeeded', settled_at = now()
       where id = $1 and status <> 'succeeded'
       returning user_id, amount_ghs
     ),
     ins as (
       insert into wallet_transactions (user_id, kind, method, amount_ghs, status, external_ref, note)
       select user_id, 'deposit', 'Flutterwave', amount_ghs, 'completed', $2, 'Flutterwave deposit'
       from a returning id
     ),
     cred as (
       update users set balance_ghs = balance_ghs + (select amount_ghs from a)
       where id = (select user_id from a) returning id
     )
     select (select count(*) from a) as settled, (select id from ins) as txn_id`,
    [attempt.id, 'flw:' + attempt.intent_id]
  );
  if (Number(out[0].settled) === 1 && out[0].txn_id) {
    await ensureAdminTables();
    await applyDepositRewards(attempt.user_id, out[0].txn_id, Number(attempt.amount_ghs), attempt.currency || 'NGN');
    return 'credited';
  }
  return 'already';
}

// Winnings bonus (Prince, 2026-11-05, from the GoalsVault slip he
// shared): multiples and system combinations earn a percentage bonus
// on top of their full potential win, scaled by the number of legs in
// the ticket. Singles earn none. The server is authoritative — the
// client mirrors this table only so the slip displays the same
// numbers before placing.
// Flat 8% on multiples (Prince, 2026-11-09 — replaces the old leg ladder):
// any ticket with 2+ legs earns 8% on its potential win; singles earn none.
const WIN_BONUS = [[2, 8]];
function winBonusPct(legs) {
  let pct = 0;
  for (const [n, p] of WIN_BONUS) if (legs >= n) pct = p;
  return pct;
}
// All k-combinations of arr, order-stable.
function combinations(arr, k) {
  const out = [];
  if (k < 1 || k > arr.length) return out;
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    out.push(idx.map(i => arr[i]));
    let i = k - 1;
    while (i >= 0 && idx[i] === arr.length - k + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return out;
}
// Bet-type columns (kind / bonus_pct / system_label) for the
// Single-Multiple-System slip. Added lazily like the payment tables.
let betColsReady = null;
function ensureBetColumns() {
  if (!betColsReady) {
    betColsReady = (async () => {
      await sql(`alter table bets add column if not exists kind text not null default 'multiple'`);
      await sql(`alter table bets add column if not exists bonus_pct numeric not null default 0`);
      await sql(`alter table bets add column if not exists system_label text`);
      await sql(`alter table bets add column if not exists payout_ghs numeric`);
    })().catch(e => { betColsReady = null; throw e; });
  }
  return betColsReady;
}
// Support chat columns (Prince, 2026-11-08): support_messages becomes a
// two-way chat — sender marks who wrote ('user' | 'admin'), admin_id the
// replying admin, read_at when the other side has seen the message.
let supportColsReady = null;
function ensureSupportColumns() {
  if (!supportColsReady) {
    supportColsReady = (async () => {
      await sql(`alter table support_messages add column if not exists sender text not null default 'user'`);
      await sql(`alter table support_messages add column if not exists admin_id uuid`);
      await sql(`alter table support_messages add column if not exists read_at timestamptz`);
      await sql(`create index if not exists support_messages_user_created_idx on support_messages (user_id, created_at)`);
    })().catch(e => { supportColsReady = null; throw e; });
  }
  return supportColsReady;
}
// Custom-match stoppage columns (Prince, 2026-11-05): how many
// stoppage minutes the super admin added to each half of a featured
// match. The match clock is 45 + stoppage, a 15-minute half-time,
// then 45 + stoppage.
let matchColsReady = null;
function ensureMatchColumns() {
  if (!matchColsReady) {
    matchColsReady = (async () => {
      await msql(`alter table matches add column if not exists ht_stoppage int not null default 0`);
      await msql(`alter table matches add column if not exists ft_stoppage int not null default 0`);
      await msql(`alter table matches add column if not exists betting_locked boolean not null default false`);
      await msql(`alter table matches add column if not exists odds_attempt_at timestamptz`);
      // odds_full (the full market book) is read by the match list and
      // the single-match view; the StakeKing schema was applied without
      // it and /api/matches 500'd until it was added by hand on
      // 2026-11-09. Self-heal it here like the others.
      await msql(`alter table matches add column if not exists odds_full jsonb`);
      // 'postponed' joined the status vocabulary with the created-
      // games lifecycle (2026-11-05); the original CHECK only knew
      // upcoming/live/finished and rejected postponed games. The swap
      // runs ONLY when the live definition lacks 'postponed': a blind
      // drop+add on every cold start raced between server instances,
      // and the losing instance cached the failure and served 500s
      // until it was recycled (the /api/match outage, 2026-11-08).
      const cons = await msql(
        `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'matches_status_check'`
      );
      if (!cons.length || !/postponed/.test(cons[0].def || '')) {
        await msql(`alter table matches drop constraint if exists matches_status_check`);
        await msql(`alter table matches add constraint matches_status_check check (status in ('upcoming', 'live', 'finished', 'postponed'))`);
      }
    })().catch(e => { matchColsReady = null; throw e; });
  }
  return matchColsReady;
}

/* Fetch match rows by id from the catalog DB. Ids the catalog does
   not know yet (open bets placed before the 2026-11-07 split, whose
   matches still live in the core project until the December bridge
   copies them over) fall back to the core table, whose static facts
   for those matches are correct; the fallback is skipped while the
   core is suspended. */
async function matchesById(ids) {
  const map = new Map();
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length) return map;
  const rows = await msql('select * from matches where id = any($1::uuid[])', [uniq]);
  for (const r of rows) map.set(r.id, r);
  const missing = uniq.filter(id => !map.has(id));
  if (missing.length && process.env.MATCHES_DATABASE_URL) {
    try {
      const old = await sql('select * from matches where id = any($1::uuid[])', [missing]);
      for (const r of old) if (!map.has(r.id)) map.set(r.id, r);
    } catch (e) { /* core suspended: those legs hydrate after the bridge */ }
  }
  return map;
}

/* ---------------- Bet settlement (shared) ----------------
   Scores every pending selection on one finished match and settles
   any bet whose selections are then all decided. Used by the admin
   settle endpoint AND by maybeAutoSettle below — before this existed
   a bet only settled when an admin settled its match by hand, so
   winners waited on a person (forensic finding, 2026-11-05). */
async function settleMatch(matchId, home, away) {
  // Half-time score decides the full-book half markets; without it
  // those selections stay pending instead of being guessed.
  const htRow = await msql('select score_home_ht, score_away_ht, external_ref, goal_events from matches where id = $1', [matchId]);
  let htH = htRow.length ? htRow[0].score_home_ht : null;
  let htA = htRow.length ? htRow[0].score_away_ht : null;
  if ((htH === null || htH === undefined) && htRow.length && isCustomMatch(htRow[0])) {
    // Created matches carry no feed half-time score — theirs is in
    // the goal schedule: everything at minute 45 or earlier (45+2
    // stoppage goals store minute 45) belongs to the first half.
    const goals = Array.isArray(htRow[0].goal_events) ? htRow[0].goal_events : [];
    htH = goals.filter(g => g.side === 'home' && Number(g.minute) <= 45).length;
    htA = goals.filter(g => g.side === 'away' && Number(g.minute) <= 45).length;
  }
  const sels = await sql(
    "select id, bet_id, market, pick from bet_selections where match_id = $1 and result = 'pending'",
    [matchId]
  );
  for (const s of sels) {
    let won;
    if (keyFor(s.market, s.pick)) {
      won = pickWon(s.market, s.pick, home, away);
    } else {
      won = afPickWon(s.market, s.pick, home, away, htH, htA);
      if (won === null) continue; // undecidable yet — leave pending
    }
    await sql('update bet_selections set result = $2 where id = $1', [s.id, won ? 'won' : 'lost']);
  }
  const affected = [...new Set(sels.map(s => s.bet_id))];
  let settledWon = 0, settledLost = 0;
  for (const betId of affected) {
    const rows = await sql(
      `select b.id, b.user_id, b.potential_ghs, b.status,
              count(*) filter (where s.result = 'pending') as pending,
              count(*) filter (where s.result = 'lost') as lost
       from bets b join bet_selections s on s.bet_id = b.id
       where b.id = $1 group by b.id`,
      [betId]
    );
    if (!rows.length) continue;
    const b = rows[0];
    if (b.status !== 'open' || Number(b.pending) > 0) continue;
    if (Number(b.lost) > 0) {
      await sql("update bets set status = 'lost', settled_at = now(), payout_ghs = 0 where id = $1", [betId]);
      settledLost++;
    } else {
      await sql(
        `with upd as (update bets set status = 'won', settled_at = now(), payout_ghs = potential_ghs where id = $1 returning user_id, potential_ghs),
              led as (insert into wallet_transactions (user_id, kind, method, amount_ghs, status)
                      select user_id, 'bet_win', 'Balance', potential_ghs, 'completed' from upd returning id)
         update users set balance_ghs = balance_ghs + (select potential_ghs from upd)
         where id = (select user_id from upd)`,
        [betId]
      );
      settledWon++;
    }
  }
  return { selections_scored: sels.length, bets_won: settledWon, bets_lost: settledLost };
}

// Auto-settle pass: finished matches (feed-scored, or featured
// matches past their derived full time) that still hold pending
// selections get settled from their stored scores. Throttled to
// one pass a minute per instance and a few matches per pass; the
// admin endpoint remains as the manual override.
let lastAutoSettle = 0;
async function maybeAutoSettle() {
  const nowMs = Date.now();
  if (nowMs - lastAutoSettle < 60000) return;
  lastAutoSettle = nowMs;
  // Split-DB form (2026-11-07): pending selections live in the core
  // project, match rows in the catalog project — fetch each side
  // from its own database and join in memory.
  // Janitor: a feed match still marked live 4+ hours after kickoff
  // and already showing 88+ minutes is over — the feeds dropped it
  // (an exhausted API quota leaves rows frozen mid-match). Finish it
  // on its last known score so its bets settle below instead of
  // locking open forever, and so stale rows stop crowding the list.
  // Suspended early-minute matches are spared: they may resume, and
  // the live sweep would re-import them as live anyway.
  await msql(
    `update matches set status = 'finished', minute = null
     where status = 'live' and external_ref not like 'custom:%'
       and starts_at < now() - interval '4 hours'
       and (minute >= 88 or (minute is null and starts_at < now() - interval '6 hours'))`
  ).catch(() => {});
  const pend = await sql("select distinct match_id from bet_selections where result = 'pending' limit 200");
  const pendIds = pend.map(r => r.match_id);
  let rows = [];
  if (pendIds.length) {
    rows = await msql(
      `select id, score_home, score_away, external_ref, starts_at, status, goal_events, ht_stoppage, ft_stoppage
       from matches
       where id = any($1::uuid[]) and status = 'finished' and score_home is not null and score_away is not null
       limit 5`,
      [pendIds]
    );
  }
  const customs = await msql(
    `select id, score_home, score_away, external_ref, starts_at, status, goal_events, ht_stoppage, ft_stoppage
     from matches
     where external_ref like 'custom:%' and status <> 'finished'
       and starts_at + make_interval(mins => 106 + coalesce(ht_stoppage, 0) + coalesce(ft_stoppage, 0)) < now()
     limit 5`
  );
  rows = rows.concat(customs);
  for (const m of rows) {
    try {
      if (isCustomMatch(m)) {
        const st = customMatchState(m);
        if (st.status !== 'finished') continue;
        await settleMatch(m.id, st.final_home, st.final_away);
        // Stamp the row so a created match formally ends with the
        // exact score the super admin scripted — including matches
        // nobody bet on, which the old exists() filter skipped
        // forever (same fix as PrimeStake, 2026-11-05).
        await msql("update matches set status = 'finished', score_home = $2, score_away = $3 where id = $1",
          [m.id, st.final_home, st.final_away]);
      } else {
        await settleMatch(m.id, Number(m.score_home), Number(m.score_away));
      }
    } catch (e) { /* one bad match must not stop the pass */ }
  }
}

// ---- Cashout valuation (Prince, 2026-11-05) -----------------------
// A ticket's fair cashout value is its potential payout discounted by
// the CURRENT probability of its still-pending legs winning, then by
// the operator's cashout margin, so the house never pays more than
// the ticket is mathematically worth:
//   value = potential × Π (1 / current_odds_i) × (1 − margin%)
// rounded DOWN to the pesewa. Won legs count at full value. The quote
// is null — no cashout offered at all — when any pending leg's match
// is LIVE (the button stays hidden until that game is settled at full
// time), postponed, already finished-but-unsettled, or its current
// price can no longer be read.
function legDerivedStatus(m) {
  if (!m) return 'finished';
  return isCustomMatch(m) ? customMatchState(m).status : m.status;
}
function currentPickOdds(m, market, pick) {
  const key = keyFor(market, pick);
  let odds = key ? Number(fillOdds(m.odds)[key]) : NaN;
  if (!(odds > 1)) {
    const book = Array.isArray(m.odds_full) ? m.odds_full.find(b => b.name === market) : null;
    const v = book ? book.values.find(x => String(x.value) === String(pick)) : null;
    odds = v ? Number(v.odd) : NaN;
  }
  return odds > 1 ? odds : null;
}
// Translate classic slip labels ('1X2' pick '1', 'Over/Under 2.5',
// 'Handicap +0.5') into the API-Football names afPickWon speaks, so
// one evaluator settles and reprices both books.
function afEquivalent(market, pick) {
  if (market === '1X2') {
    const p = { '1': 'Home', 'X': 'Draw', '2': 'Away' }[pick];
    return p ? ['Match Winner', p] : null;
  }
  if (market === 'Double Chance') {
    const p = { '1X': 'Home/Draw', '12': 'Home/Away', 'X2': 'Draw/Away' }[pick];
    return p ? ['Double Chance', p] : null;
  }
  if (/^Over\/Under \d+\.\d$/.test(market)) return ['Goals Over/Under', pick];
  if (/^Handicap [+-]?\d+\.\d$/.test(market)) return ['Handicap Result', pick];
  return [market, pick];
}

// Live in-play reprice (Prince, 2026-11-06): while a match is live,
// a pending pick's price must MOVE with the score and the clock —
// reducing or adding as the game turns. The feed carries pre-match
// prices only, so the live price is modelled with the same Poisson
// goal model the house builds its books with (total mu 2.7 split by
// implied win strength, see expandOdds), re-based on the goals
// already scored and the fraction of the match remaining, then
// priced with the house margin convention ((1/p) / 1.05). Returns
// null when the pick cannot be decided from the final score alone,
// and the client then simply shows no live price.
function livePriceFor(match, market, pick) {
  if (!match || match.status !== 'live') return null;
  const odds = fillOdds(match.odds || {});
  if (!(odds.o1 > 1 && odds.ox > 1 && odds.o2 > 1)) return null;
  const eq = afEquivalent(market, pick);
  if (!eq) return null;
  // Fit the goal means so the full-time Poisson grid reproduces
  // the market's own implied 1X2 probabilities — the now price
  // then starts at the placed price and moves only because the
  // score and the clock moved it.
  const raw = [1 / odds.o1, 1 / odds.ox, 1 / odds.o2];
  const margin = raw[0] + raw[1] + raw[2];
  const tH = raw[0] / margin, tD = raw[1] / margin, tA = raw[2] / margin;
  const gridProbs = (lh, la) => {
    const g = (lambda) => {
      const arr = [Math.exp(-lambda)];
      for (let k = 1; k <= 10; k++) arr.push(arr[k - 1] * lambda / k);
      return arr;
    };
    const PH = g(lh), PA = g(la);
    let h = 0, d = 0, a = 0;
    for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
      const w = PH[i] * PA[j];
      if (i > j) h += w; else if (i === j) d += w; else a += w;
    }
    return [h, d, a];
  };
  let muH = 1.35, muA = 1.35, bestErr = Infinity;
  for (let muT = 1.9; muT <= 3.9; muT += 0.1) {
    for (let share = 0.3; share <= 0.78; share += 0.02) {
      const [h, d, a] = gridProbs(muT * share, muT * (1 - share));
      const err = (h - tH) ** 2 + (d - tD) ** 2 + (a - tA) ** 2;
      if (err < bestErr) { bestErr = err; muH = muT * share; muA = muT * (1 - share); }
    }
  }
  let minute = match.minute != null ? Number(match.minute) : NaN;
  if (!Number.isFinite(minute) && match.starts_at) minute = Math.floor((Date.now() - new Date(match.starts_at).getTime()) / 60000);
  if (!Number.isFinite(minute)) minute = 45;
  const r = Math.min(1, Math.max(0.01, (95 - minute) / 95));
  const MAXG = 10;
  const pmf = (lambda) => {
    const arr = [Math.exp(-lambda)];
    for (let k = 1; k <= MAXG; k++) arr.push(arr[k - 1] * lambda / k);
    return arr;
  };
  const PH = pmf(muH * r), PA = pmf(muA * r);
  const sh = Number(match.score_home) || 0, sa = Number(match.score_away) || 0;
  const hH = match.score_home_ht != null ? Number(match.score_home_ht) : null;
  const hA = match.score_away_ht != null ? Number(match.score_away_ht) : null;
  let p = 0;
  for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) {
    const w = afPickWon(eq[0], eq[1], sh + i, sa + j, hH, hA);
    if (w === null) return null;
    if (w) p += PH[i] * PA[j];
  }
  if (!(p > 0)) return null;
  if (p <= 0.0002) return 500;
  if (p > 0.995) return 1.01;
  const v = Math.round(((1 / p) / 1.05) * 100) / 100;
  return Math.min(500, Math.max(1.01, v));
}

function cashoutQuoteFor(bet, legs, marginPct) {
  if (!bet || bet.status !== 'open' || !Array.isArray(legs) || !legs.length) return null;
  let p = 1;
  for (const leg of legs) {
    if (leg.result === 'lost') return null;
    if (leg.result === 'won') continue;
    if (legDerivedStatus(leg.match) !== 'upcoming') return null;
    const cur = currentPickOdds(leg.match, leg.market, leg.pick);
    if (!cur) return null;
    p *= 1 / cur;
  }
  const margin = Math.min(50, Math.max(0, Number(marginPct) || 0));
  const value = Math.floor(Number(bet.potential_ghs) * p * (1 - margin / 100) * 100) / 100;
  return value >= 0.10 ? value : null;
}

// Booking codes (Prince, 2026-11-06): 5-character mixed codes
// (letters + digits, confusables 0/O and 1/I left out). ONE unique
// code per account + set of games: the dedupe hash makes repeat
// bookings and repeat stakes of the same games return the SAME
// code — a code never changes under its owner.
const BOOKING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genBookingCode() {
  let code = '';
  do {
    code = Array.from({ length: 5 }, () => BOOKING_ALPHABET[Math.floor(Math.random() * BOOKING_ALPHABET.length)]).join('');
  } while (!/[A-Z]/.test(code) || !/[0-9]/.test(code));
  return code;
}
function canonicalSelections(sels) {
  return (sels || [])
    .map(x => ({ match_id: String(x.match_id), market: String(x.market), pick: String(x.pick) }))
    .sort((a, b) => (a.match_id + '|' + a.market + '|' + a.pick).localeCompare(b.match_id + '|' + b.market + '|' + b.pick));
}
async function ensureBookingCode(userId, selections) {
  const clean = canonicalSelections(selections);
  if (!clean.length) return null;
  const dedupe = crypto.createHash('sha256').update((userId || 'anon') + '|' + JSON.stringify(clean)).digest('hex');
  const found = await sql('select code from booking_codes where dedupe = $1', [dedupe]);
  if (found.length) return found[0].code;
  for (let i = 0; i < 10; i++) {
    const code = genBookingCode();
    const rows = await sql(
      'insert into booking_codes (code, selections, user_id, dedupe) values ($1, $2::jsonb, $3, $4) on conflict do nothing returning code',
      [code, JSON.stringify(clean), userId || null, dedupe]
    );
    if (rows.length) return code;
    const again = await sql('select code from booking_codes where dedupe = $1', [dedupe]);
    if (again.length) return again[0].code;
  }
  return null;
}

module.exports = { sql, msql, matchesById, hashPassword, verifyPassword, verifyToken, issueToken, readBody, send, requireAuth, requireAdmin, requireSuperAdmin, guard, publicUser, betCode, MARKETS, keyFor, pickWon, afPickWon, shinobiConfig, shinobiFetch, mapIntentStatus, detectNetwork, ensurePaymentTables, ensureAdminTables, getSettings, applyDepositRewards, settleAttempt, settleFlwAttempt, currencyOfPhone, moneyRules, depositFloorFor, flwConfig, flwFetch, settleMatch, maybeAutoSettle, isCustomMatch, customMatchState, expandOdds, fillOdds, inviteCode, ensureInviteCode, WIN_BONUS, winBonusPct, combinations, ensureBetColumns, ensureMatchColumns, ensureSupportColumns, cleanGoalSchedule, cleanCrestUrl, fullBookFromOdds, cashoutQuoteFor, ensureBookingCode, genBookingCode, livePriceFor, currentPickOdds, convertAmount, firstDepositBonus, splitCommission };
