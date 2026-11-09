const { sql, readBody, send, guard, getSettings, ensureMatchColumns, ensureBetColumns, keyFor } = require('../_lib');
const { caller, isAdmin } = require('./caller');
const { toEnginePick } = require('./markets');
const R = require('./rows');

// Translate a UI markets object back into engine storage: classic
// markets land in the odds jsonb via the engine's own keyFor;
// everything else assembles into an odds_full book.
function uiMarketsToEngine(markets) {
  const odds = {};
  const fullByName = new Map();
  for (const [market, options] of Object.entries(markets || {})) {
    if (!options || typeof options !== 'object') continue;
    for (const [option, price] of Object.entries(options)) {
      const p = Number(price);
      if (!(p > 1)) continue;
      const eng = toEnginePick(market, option);
      if (!eng) continue;
      const key = keyFor(eng.market, eng.pick);
      if (key) { odds[key] = p; continue; }
      if (!fullByName.has(eng.market)) fullByName.set(eng.market, []);
      fullByName.get(eng.market).push({ value: eng.pick, odd: p });
    }
  }
  const odds_full = [...fullByName.entries()].map(([name, values], i) => ({ id: 900 + i, name, values }));
  return { odds, odds_full };
}
function uiMatchToEngine(row) {
  const out = {};
  if (row.league !== undefined) out.league = String(row.league).slice(0, 120);
  if (row.home_team !== undefined) out.home_team = String(row.home_team).slice(0, 120);
  if (row.away_team !== undefined) out.away_team = String(row.away_team).slice(0, 120);
  if (row.start_time !== undefined) out.starts_at = new Date(row.start_time).toISOString();
  if (row.status !== undefined && ['upcoming', 'live', 'finished'].includes(row.status)) out.status = row.status;
  if (row.minute !== undefined) out.minute = row.minute === null ? null : Number(row.minute);
  if (row.home_score !== undefined) out.score_home = Number(row.home_score) || 0;
  if (row.away_score !== undefined) out.score_away = Number(row.away_score) || 0;
  if (row.home_crest !== undefined) out.home_logo = row.home_crest || null;
  if (row.away_crest !== undefined) out.away_logo = row.away_crest || null;
  const hasOddsCols = row.odds_home !== undefined || row.odds_draw !== undefined || row.odds_away !== undefined;
  if (hasOddsCols || row.markets !== undefined) {
    const fromMarkets = uiMarketsToEngine(row.markets || {});
    const odds = { ...fromMarkets.odds };
    if (Number(row.odds_home) > 1) odds.o1 = Number(row.odds_home);
    if (Number(row.odds_draw) > 1) odds.ox = Number(row.odds_draw);
    if (Number(row.odds_away) > 1) odds.o2 = Number(row.odds_away);
    out.odds = odds;
    out.odds_full = fromMarkets.odds_full.length ? fromMarkets.odds_full : null;
  }
  return out;
}

// PostgREST-compatible table surface for the StakeKing frontend.
// Implements exactly the subset the app uses: select projection,
// eq/neq/gt/gte/lt/lte/in/is filters, order, limit/offset,
// single-object Accept, count=exact, and insert/update/upsert/delete
// on the tables that allow it. Money tables are read-only here;
// every money move goes through rpc.js to the engine handlers.


// ---------- generic filter / order / paging over mapped rows ----------
function coerce(raw, sample) {
  if (raw === 'null') return null;
  if (typeof sample === 'boolean') return raw === 'true';
  if (typeof sample === 'number') { const n = Number(raw); return Number.isNaN(n) ? raw : n; }
  return raw;
}
function parseFilters(query, sampleRow) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict']);
  const filters = [];
  for (const [key, value] of Object.entries(query || {})) {
    if (reserved.has(key)) continue;
    const v = String(value);
    const dot = v.indexOf('.');
    if (dot < 0) continue;
    const op = v.slice(0, dot);
    let raw = v.slice(dot + 1);
    const sample = sampleRow ? sampleRow[key] : undefined;
    if (op === 'in') {
      raw = raw.replace(/^\(|\)$/g, '').split(',').map((s) => coerce(s.trim(), sample));
    } else if (op === 'is') {
      raw = raw === 'null' ? null : raw === 'true' ? true : raw === 'false' ? false : raw;
    } else {
      raw = coerce(raw, sample);
    }
    filters.push({ key, op, raw });
  }
  return filters;
}
function applyFilters(rows, filters) {
  return rows.filter((row) => filters.every(({ key, op, raw }) => {
    const val = row[key];
    switch (op) {
      case 'eq': return val === raw;
      case 'neq': return val !== raw;
      case 'gt': return val > raw;
      case 'gte': return val >= raw;
      case 'lt': return val < raw;
      case 'lte': return val <= raw;
      case 'in': return raw.includes(val);
      case 'is': return val === raw || (raw === null && val == null);
      default: return true;
    }
  }));
}
function applyOrder(rows, orderParam) {
  if (!orderParam) return rows;
  const specs = String(orderParam).split(',').map((s) => {
    const [col, dir] = s.split('.');
    return { col, desc: dir === 'desc' };
  }).filter((s) => s.col);
  const sorted = [...rows];
  sorted.sort((a, b) => {
    for (const { col, desc } of specs) {
      const x = a[col], y = b[col];
      if (x === y) continue;
      if (x == null) return desc ? -1 : 1;
      if (y == null) return desc ? 1 : -1;
      return (x < y ? -1 : 1) * (desc ? -1 : 1);
    }
    return 0;
  });
  return sorted;
}
function project(rows, selectParam) {
  if (!selectParam || selectParam.trim() === '*') return rows;
  const cols = selectParam.split(',').map((s) => s.trim()).filter(Boolean);
  return rows.map((row) => {
    const out = {};
    for (const c of cols) if (c in row) out[c] = row[c];
    return out;
  });
}

// ---------- fetchers: full UI row sets, scoped to the caller ----------
const fetchers = {
  async matches() {
    await ensureMatchColumns();
    const rows = await sql('select * from matches order by starts_at asc limit 2000');
    // Every engine match is football; the UI groups by category_id,
    // so stamp the Football category's id (looked up, never assumed).
    let footballId = null;
    try {
      const cats = await sql("select id from sports_categories where slug = 'football' limit 1");
      if (cats.length) footballId = cats[0].id;
    } catch (e) { /* categories table is adapter-side; absence is fine */ }
    return rows.map((m) => R.matchRow(m, footballId));
  },
  async profiles(c) {
    let users;
    if (c.service) users = await sql('select * from users order by created_at desc limit 2000');
    else if (!c.user) return [];
    else if (isAdmin(c)) users = await sql('select * from users order by created_at desc limit 2000');
    else users = [c.user];
    const ids = users.map((u) => u.id);
    const metas = ids.length ? await sql('select user_id, meta from adapter_user_meta where user_id = any($1)', [ids]) : [];
    const counts = ids.length ? await sql(
      `select user_id, count(*)::int as n from wallet_transactions where kind = 'deposit' and status = 'completed' and user_id = any($1) group by user_id`, [ids]) : [];
    const settings = await getSettings().catch(() => ({}));
    const required = Number((settings && settings.withdraw_deposits_required) || 6);
    const metaBy = Object.fromEntries(metas.map((m) => [m.user_id, m.meta || {}]));
    const countBy = Object.fromEntries(counts.map((r) => [r.user_id, r.n]));
    return users.map((u) => R.profileRow(u, metaBy[u.id], { progress: countBy[u.id] || 0, required }));
  },
  async user_roles(c) {
    let users;
    if (isAdmin(c)) users = await sql("select * from users where role in ('admin', 'super_admin') order by created_at asc limit 2000");
    else if (c.user) users = [c.user];
    else return [];
    return users.map(R.userRoleRow);
  },
  async bets(c) {
    if (!c.user && !c.service) return [];
    await ensureBetColumns();
    const bets = isAdmin(c)
      ? await sql('select b.* from bets b left join adapter_hidden_bets h on h.bet_id = b.id where h.bet_id is null order by b.placed_at desc limit 1000')
      : await sql('select b.* from bets b left join adapter_hidden_bets h on h.bet_id = b.id where b.user_id = $1 and h.bet_id is null order by b.placed_at desc limit 500', [c.user.id]);
    if (!bets.length) return [];
    const betIds = bets.map((b) => b.id);
    const sels = await sql('select * from bet_selections where bet_id = any($1)', [betIds]);
    const matchIds = [...new Set(sels.map((s) => s.match_id))];
    const matches = matchIds.length ? await sql('select * from matches where id = any($1)', [matchIds]) : [];
    const matchBy = Object.fromEntries(matches.map((m) => [m.id, m]));
    const selBy = {};
    for (const s of sels) (selBy[s.bet_id] = selBy[s.bet_id] || []).push(R.selectionUi(s, matchBy[s.match_id]));
    const userIds = [...new Set(bets.map((b) => b.user_id))];
    const codes = userIds.length ? await sql('select * from booking_codes where user_id = any($1)', [userIds]) : [];
    const codeFor = (bet) => {
      const mine = (selBy[bet.id] || []).map((s) => s.matchId + '|' + s.market + '|' + s.option).sort().join(';');
      const hit = codes.find((bc) => bc.user_id === bet.user_id && Array.isArray(bc.selections)
        && bc.selections.map((s) => (s.matchId || s.match_id) + '|' + s.market + '|' + s.option).sort().join(';') === mine);
      return hit ? hit.code : null;
    };
    return bets.map((b) => R.betRow(b, selBy[b.id] || [], codeFor(b)));
  },
  async transactions(c) {
    if (!c.user && !c.service) return [];
    const rows = isAdmin(c)
      ? await sql('select * from wallet_transactions order by created_at desc limit 1000')
      : await sql('select * from wallet_transactions where user_id = $1 order by created_at desc limit 500', [c.user.id]);
    return rows.map(R.transactionRow);
  },
  async booking_codes(c, req) {
    if (!c.user && !c.service) return [];
    const rows = isAdmin(c)
      ? await sql('select * from booking_codes order by created_at desc limit 1000')
      : await sql('select * from booking_codes where user_id = $1 order by created_at desc limit 200', [c.user.id]);
    // Booking codes are shareable: an exact-code lookup by any
    // signed-in user returns that code's row, like the old app.
    const codeFilter = req && req.query && /^eq\.(.+)$/.exec(String(req.query.code || ''));
    if (codeFilter && !rows.some((r) => r.code === codeFilter[1])) {
      const hit = await sql('select * from booking_codes where code = $1', [codeFilter[1]]);
      rows.push(...hit);
    }
    return rows.map(R.bookingCodeRow);
  },
  async shinobipay_deposits(c) {
    if (!c.user && !c.service) return [];
    const settings = await getSettings().catch(() => ({}));
    const mode = (settings && settings.shinobipay_mode) || 'live';
    const real = isAdmin(c)
      ? await sql("select * from wallet_transactions where kind = 'deposit' and method in ('shinobipay', 'momo') order by created_at desc limit 500")
      : await sql("select * from wallet_transactions where kind = 'deposit' and method in ('shinobipay', 'momo') and user_id = $1 order by created_at desc limit 100", [c.user.id]);
    const seen = new Set(real.map((wt) => wt.external_ref).filter(Boolean));
    const book = isAdmin(c)
      ? await sql('select * from adapter_shinobipay_deposits order by created_at desc limit 500')
      : await sql('select * from adapter_shinobipay_deposits where user_id = $1 order by created_at desc limit 100', [c.user.id]);
    const extra = book.filter((b) => !seen.has(b.reference)).map((b) => ({ ...b, mode }));
    return [...real.map((wt) => R.shinobiDepositRow(wt, mode)), ...extra];
  },
};

// ---------- adapter-native tables (plain SQL passthrough) ----------
const NATIVE = {
  site_content: { cols: ['key', 'value'], pk: 'key', read: 'public', write: 'admin' },
  promotions: { cols: ['id', 'title', 'description', 'active', 'created_at'], pk: 'id', read: 'public', write: 'admin' },
  sports_categories: { cols: ['id', 'name', 'slug', 'icon', 'sort_order', 'active'], pk: 'id', read: 'public', write: 'admin' },
  referral_codes: { cols: ['id', 'code', 'bonus', 'uses', 'active', 'created_at'], pk: 'id', read: 'admin', write: 'admin' },
  odds_sync_state: { cols: ['sport_key', 'requests_remaining', 'synced_at'], pk: 'sport_key', read: 'admin', write: 'service' },
  user_feedback: { cols: ['id', 'user_id', 'kind', 'message', 'rating', 'created_at'], pk: 'id', read: 'own', write: 'own' },
  adapter_shinobipay_deposits: {
    cols: ['id', 'user_id', 'intent_id', 'reference', 'amount_minor', 'status', 'mode', 'network', 'payment_method', 'last_sequence', 'webhook_verified_at', 'credited_at', 'created_at'],
    pk: 'id', read: 'own', write: 'own', hidden: true,
  },
};

function pgrstError(res, status, code, message) {
  return send(res, status, { code, details: null, hint: null, message });
}

async function handleGet(req, res, table, c) {
  let rows;
  if (fetchers[table]) {
    rows = await fetchers[table](c, req);
  } else if (NATIVE[table]) {
    const cfg = NATIVE[table];
    if (cfg.read === 'admin' && !isAdmin(c)) return pgrstError(res, 403, '42501', 'permission denied');
    rows = await sql(`select * from ${table} order by 1 asc limit 2000`);
    if (cfg.read === 'own') {
      if (!c.user && !c.service) return pgrstError(res, 401, '42501', 'not logged in');
      if (!isAdmin(c)) rows = rows.filter((r) => r.user_id === c.user.id);
    }
  } else {
    return pgrstError(res, 404, 'PGRST205', 'Unknown table: ' + table);
  }
  const filters = parseFilters(req.query, rows[0]);
  let out = applyFilters(rows, filters);
  const total = out.length;
  out = applyOrder(out, req.query.order);
  const offset = Math.max(0, Number(req.query.offset || 0));
  const limit = Math.min(2000, Math.max(0, Number(req.query.limit || 1000)));
  out = out.slice(offset, offset + limit);
  out = project(out, req.query.select);
  const accept = (req.headers && req.headers.accept) || '';
  const preferences = ((req.headers && req.headers.prefer) || '').toLowerCase();
  if (preferences.includes('count=exact')) {
    res.setHeader('Content-Range', total === 0 ? `*/0` : `${offset}-${offset + out.length - 1}/${total}`);
  }
  if (accept.includes('application/vnd.pgrst.object+json')) {
    if (out.length !== 1) return pgrstError(res, 406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned');
    return send(res, 200, out[0]);
  }
  if (req.method === 'HEAD') { res.statusCode = 200; return res.end(); }
  return send(res, 200, out);
}

async function handleWrite(req, res, table, c) {
  const body = await readBody(req);
  const items = Array.isArray(body) ? body : [body];
  const preferences = ((req.headers && req.headers.prefer) || '').toLowerCase();
  const wantReturn = preferences.includes('return=representation');

  // profiles: display fields + adapter metadata only.
  if (table === 'profiles') {
    if (req.method !== 'PATCH') return pgrstError(res, 405, 'PGRST', 'method not allowed');
    if (!c.user && !c.service) return pgrstError(res, 401, '42501', 'not logged in');
    const targetId = (parseFilters(req.query, { id: '' }).find((f) => f.key === 'id') || {}).raw || (c.user && c.user.id);
    if (!isAdmin(c) && targetId !== c.user.id) return pgrstError(res, 403, '42501', 'permission denied');
    const patch = items[0] || {};
    if (patch.full_name) await sql('update users set display_name = $1 where id = $2', [String(patch.full_name).slice(0, 80), targetId]);
    const meta = {};
    if (patch.country) meta.country = String(patch.country).slice(0, 60);
    if (patch.full_name) meta.full_name = String(patch.full_name).slice(0, 80);
    if (Object.keys(meta).length) {
      await sql(`insert into adapter_user_meta (user_id, meta) values ($1, $2::jsonb)
        on conflict (user_id) do update set meta = adapter_user_meta.meta || excluded.meta`,
        [targetId, JSON.stringify(meta)]);
    }
    const rows = await fetchers.profiles({ ...c, user: isAdmin(c) ? c.user : (await sql('select * from users where id = $1', [targetId]))[0] });
    const mine = rows.filter((r) => r.id === targetId);
    return send(res, 200, wantReturn ? mine : []);
  }

  // matches: admin fixture management, translated both ways. The
  // engine's own create-match (goal scripts, featured matches) stays
  // available through the Super Portal; this covers the admin page's
  // simpler fixture form.
  if (table === 'matches') {
    if (!isAdmin(c)) return pgrstError(res, 403, '42501', 'permission denied');
    await ensureMatchColumns();
    if (req.method === 'POST') {
      const out = [];
      for (const item of items) {
        const e = uiMatchToEngine(item);
        const cols = Object.keys(e);
        if (!cols.length) continue;
        const stmt = `insert into matches (${cols.join(', ')}) values (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) returning *`;
        const vals = cols.map((col) => (col === 'odds' || col === 'odds_full') && e[col] !== null ? JSON.stringify(e[col]) : e[col]);
        const inserted = await sql(stmt, vals);
        out.push(...inserted.map((m) => R.matchRow(m)));
      }
      return send(res, 201, wantReturn ? out : []);
    }
    const all = await sql('select * from matches limit 2000');
    const filters = parseFilters(req.query, all[0] ? R.matchRow(all[0]) : {});
    const hits = applyFilters(all.map((m) => R.matchRow(m)), filters);
    const engineById = Object.fromEntries(all.map((m) => [m.id, m]));
    if (req.method === 'DELETE') {
      for (const hit of hits) {
        const bets = await sql('select id from bet_selections where match_id = $1 limit 1', [hit.id]);
        if (bets.length) return pgrstError(res, 409, 'PGRST', 'This match has bets on it and cannot be deleted.');
        await sql('delete from matches where id = $1', [hit.id]);
      }
      return send(res, 200, wantReturn ? hits : []);
    }
    if (req.method === 'PATCH') {
      const patch = uiMatchToEngine(items[0] || {});
      const cols = Object.keys(patch);
      const done = [];
      for (const hit of hits) {
        if (!cols.length) { done.push(hit); continue; }
        const merged = { ...(engineById[hit.id] || {}) };
        const finalPatch = { ...patch };
        if (patch.odds) finalPatch.odds = { ...(merged.odds || {}), ...patch.odds };
        const set = cols.map((col, i) => `${col} = $${i + 2}`).join(', ');
        const vals = cols.map((col) => (col === 'odds' || col === 'odds_full') && finalPatch[col] !== null ? JSON.stringify(finalPatch[col]) : finalPatch[col]);
        const updated = await sql(`update matches set ${set} where id = $1 returning *`, [hit.id, ...vals]);
        done.push(...updated.map((m) => R.matchRow(m)));
      }
      return send(res, 200, wantReturn ? done : []);
    }
    return pgrstError(res, 405, 'PGRST', 'method not allowed');
  }

  if (NATIVE[table]) {
    const cfg = NATIVE[table];
    const gate = cfg.write === 'admin' ? isAdmin(c) : cfg.write === 'service' ? (c.service || isAdmin(c)) : (!!c.user || c.service);
    if (!gate) return pgrstError(res, 403, '42501', 'permission denied');
    if (req.method === 'POST') {
      const onConflict = req.query.on_conflict
        || (((req.headers && req.headers.prefer) || '').includes('resolution=merge-duplicates') ? cfg.pk : null);
      const out = [];
      for (const item of items) {
        const cols = cfg.cols.filter((col) => item[col] !== undefined);
        const vals = cols.map((col) => item[col]);
        if (table === 'user_feedback' && c.user) {
          const i = cols.indexOf('user_id');
          if (i >= 0) vals[i] = c.user.id; else { cols.push('user_id'); vals.push(c.user.id); }
        }
        const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
        let stmt = `insert into ${table} (${cols.join(', ')}) values (${placeholders})`;
        if (onConflict) {
          const updates = cols.filter((col) => col !== cfg.pk).map((col) => `${col} = excluded.${col}`).join(', ');
          stmt += ` on conflict (${cfg.pk}) do update set ${updates}`;
        }
        stmt += ' returning *';
        const inserted = await sql(stmt, vals);
        out.push(...inserted);
      }
      return send(res, 201, wantReturn ? out : []);
    }
    if (req.method === 'PATCH' || req.method === 'DELETE') {
      const all = await sql(`select * from ${table} limit 2000`);
      const filters = parseFilters(req.query, all[0]);
      const hits = applyFilters(all, filters);
      if (req.method === 'DELETE') {
        for (const hit of hits) await sql(`delete from ${table} where ${cfg.pk} = $1`, [hit[cfg.pk]]);
        return send(res, 200, wantReturn ? hits : []);
      }
      const patch = items[0] || {};
      const cols = cfg.cols.filter((col) => patch[col] !== undefined && col !== cfg.pk);
      const done = [];
      for (const hit of hits) {
        if (!cols.length) { done.push(hit); continue; }
        const set = cols.map((col, i) => `${col} = $${i + 2}`).join(', ');
        const updated = await sql(`update ${table} set ${set} where ${cfg.pk} = $1 returning *`, [hit[cfg.pk], ...cols.map((col) => patch[col])]);
        done.push(...updated);
      }
      return send(res, 200, wantReturn ? done : []);
    }
    return pgrstError(res, 405, 'PGRST', 'method not allowed');
  }

  return pgrstError(res, 405, 'PGRST', 'writes to this table go through RPC');
}

module.exports = guard(async (req, res) => {
  const path = String((req.url || '').split('?')[0]);
  const table = decodeURIComponent(path.replace('/rest/v1/', ''));
  const c = await caller(req);
  if (req.method === 'GET' || req.method === 'HEAD') return handleGet(req, res, table, c);
  return handleWrite(req, res, table, c);
});
