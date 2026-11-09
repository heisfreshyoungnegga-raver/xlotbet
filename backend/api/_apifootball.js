const { msql: sql } = require('./_lib'); // catalog DB only: matches + operator_settings gates

// API-Football (API-Sports) fixture + odds sync — the site's primary
// data source once API_FOOTBALL_KEY is set in the environment
// (Prince's subscription, 2026-11-04). While the key is absent the
// site keeps running on the ESPN feed untouched; the moment the key
// appears, /api/matches flips to this module: same matches table,
// same odds keys, same read-time market fill — only the source
// changes. Team crests are API-Football's media URLs, the same ones
// GoalsVault serves.
//
// Quota care: fixtures come one call per day (all leagues in a
// single response) — 3 calls per gated refresh for yesterday /
// today / tomorrow. Odds are fetched per fixture only while a shown
// match still lacks a 1X2 line, capped per refresh, live matches
// first. A full day of constant traffic stays far under the Pro
// plan's 7,500 requests/day.
const BASE = 'https://v3.football.api-sports.io';

function afEnabled() {
  return !!process.env.API_FOOTBALL_KEY;
}

async function afFetch(path) {
  const r = await fetch(BASE + path, {
    headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('af_' + r.status);
  const j = await r.json();
  if (j.errors && Object.keys(j.errors).length) throw new Error('af_api_' + Object.values(j.errors)[0]);
  return j.response || [];
}

// API-Football league ids -> the labels the site already uses.
const LEAGUES = {
  39: 'England Premier League',
  140: 'Spain LaLiga',
  135: 'Italy Serie A',
  78: 'Germany Bundesliga',
  61: 'France Ligue 1',
  94: 'Portugal Primeira Liga',
  88: 'Netherlands Eredivisie',
  2: 'UEFA Champions League',
  3: 'UEFA Europa League',
  253: 'MLS',
  570: 'Ghana Premier League',
};
function leagueLabel(lg) {
  if (!lg) return null;
  if (LEAGUES[lg.id]) return LEAGUES[lg.id];
  // Ghana's top flight has carried more than one id over seasons;
  // recognise it by country + name so it never silently drops out.
  if (lg.country === 'Ghana' && /premier/i.test(lg.name || '')) return 'Ghana Premier League';
  // International competitions arrive with country "World"
  // (UEFA Nations League, World Cup / AFCON / Euro qualifiers,
  // friendlies). Dropping them emptied the upcoming board for the
  // whole international break (2026-11-08: club leagues dark
  // 9-17 Nov, only internationals playing, none imported).
  if (lg.country === 'World' && lg.name) return lg.name;
  return null;
}
// Permissive label for the live sweep: any league in the world gets
// a readable "Country League" name (Prince, 2026-11-04: every live
// match belongs on the site, not just the core leagues).
function leagueLabelAny(lg) {
  const strict = leagueLabel(lg);
  if (strict) return strict;
  if (!lg || !lg.name) return null;
  if (lg.country && lg.country !== 'World') return lg.country + ' ' + lg.name;
  return lg.name;
}

const LIVE_CODES = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT', 'SUSP'];
const DONE_CODES = ['FT', 'AET', 'PEN'];
const SKIP_CODES = ['PST', 'CANC', 'ABD', 'AWD', 'WO'];

function mapFixture(fx, anyLeague) {
  const label = anyLeague ? leagueLabelAny(fx.league) : leagueLabel(fx.league);
  if (!label) return null;
  const st = fx.fixture && fx.fixture.status && fx.fixture.status.short;
  if (SKIP_CODES.includes(st)) return null;
  const status = DONE_CODES.includes(st) ? 'finished'
    : LIVE_CODES.includes(st) ? 'live' : 'upcoming';
  return {
    external_ref: 'af:' + fx.fixture.id,
    league: label,
    home_team: fx.teams.home.name,
    away_team: fx.teams.away.name,
    home_logo: fx.teams.home.logo || null,
    away_logo: fx.teams.away.logo || null,
    starts_at: fx.fixture.date,
    status,
    minute: status === 'live' ? (fx.fixture.status.elapsed || null) : null,
    score_home: fx.goals.home || 0,
    score_away: fx.goals.away || 0,
    // Half-time score feeds the half-market settlements. It stays
    // null until the match reaches half time.
    score_home_ht: fx.score && fx.score.halftime ? fx.score.halftime.home : null,
    score_away_ht: fx.score && fx.score.halftime ? fx.score.halftime.away : null,
    odds: {},
  };
}

async function upsertMatch(m) {
  await sql(
    `insert into matches (league, home_team, away_team, starts_at, status, minute, score_home, score_away, odds, external_ref, home_logo, away_logo, score_home_ht, score_away_ht)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14)
     on conflict (external_ref) where external_ref is not null
     do update set league = excluded.league, home_team = excluded.home_team, away_team = excluded.away_team,
       starts_at = excluded.starts_at, status = excluded.status, minute = excluded.minute,
       score_home = excluded.score_home, score_away = excluded.score_away,
       home_logo = excluded.home_logo, away_logo = excluded.away_logo,
       score_home_ht = coalesce(excluded.score_home_ht, matches.score_home_ht),
       score_away_ht = coalesce(excluded.score_away_ht, matches.score_away_ht),
       odds = case when excluded.odds::text = '{}' then matches.odds else excluded.odds end`,
    [m.league, m.home_team, m.away_team, m.starts_at, m.status, m.minute, m.score_home, m.score_away,
     JSON.stringify(m.odds), m.external_ref, m.home_logo, m.away_logo, m.score_home_ht, m.score_away_ht]
  );
}

// Bookmaker odds -> the site's odds keys. Prefer Bet365 (bookmaker
// id 8, per the docs' bookmaker list); otherwise the first
// bookmaker that prices the match winner. Markets are matched by
// their DOCUMENTED bet ids — 1 Match Winner, 5 Goals Over/Under,
// 12 Double Chance, 8 Both Teams Score — because the names are not
// stable: the official spec's own odds example spells bet 8
// "Both Teams Score", not "Both Teams To Score". Names stay as a
// fallback for feeds that omit ids.
const BET = { WINNER: 1, OU: 5, BTTS: 8, DC: 12 };
// The full-book markets the site offers beyond the classic four.
// Every one of these settles from the full-time and half-time
// scores alone (see afPickWon in api/_lib.js). Deliberately absent:
// quarter-line Asian handicaps and Goal Line (split payouts the
// engine cannot express), Draw No Bet (push refunds), and the
// stat, event and player markets (corners, cards, scorers, shots),
// which a score feed cannot settle.
const FULL_IDS = new Set([3, 6, 7, 9, 10, 11, 13, 16, 17, 18, 20, 21, 22, 23, 24, 25, 26, 27, 28,
  31, 32, 34, 35, 36, 38, 39, 40, 41, 42, 46, 47, 48, 49, 60, 63, 192, 193, 349]);
function pickBookmaker(bookmakers) {
  if (!Array.isArray(bookmakers) || !bookmakers.length) return null;
  const usable = bookmakers.filter(b => (b.bets || []).some(x => x.id === BET.WINNER || x.name === 'Match Winner'));
  if (!usable.length) return null;
  return usable.find(b => b.id === 8) || usable[0];
}
// The chosen bookmaker's complete offer for the whitelisted
// markets: [{id, name, values: [{value, odd}]}], values as strings.
function fullFromAf(bm) {
  if (!bm) return [];
  const full = [];
  for (const bet of bm.bets || []) {
    if (!FULL_IDS.has(bet.id)) continue;
    const values = (bet.values || [])
      .map(v => ({ value: String(v.value), odd: Math.round(Number(v.odd) * 100) / 100 }))
      .filter(v => Number.isFinite(v.odd) && v.odd > 1);
    if (values.length) full.push({ id: bet.id, name: bet.name === 'Exact Score' ? 'Correct Score' : bet.name, values });
  }
  return full;
}
function oddsFromAf(bookmakers) {
  const bm = pickBookmaker(bookmakers);
  if (!bm) return {};
  const odds = {};
  const put = (key, raw) => {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 1) odds[key] = Math.round(n * 100) / 100;
  };
  for (const bet of bm.bets || []) {
    const v = {};
    for (const val of bet.values || []) v[val.value] = val.odd;
    if (bet.id === BET.WINNER || bet.name === 'Match Winner') {
      put('o1', v.Home); put('ox', v.Draw); put('o2', v.Away);
    } else if (bet.id === BET.OU || bet.name === 'Goals Over/Under') {
      for (const line of ['0.5', '1.5', '2.5', '3.5', '4.5']) {
        const suffix = line.replace('.', '');
        put('over' + suffix, v['Over ' + line]);
        put('under' + suffix, v['Under ' + line]);
      }
    } else if (bet.id === BET.DC || bet.name === 'Double Chance') {
      put('dc1x', v['Home/Draw']); put('dc12', v['Home/Away']); put('dcx2', v['Draw/Away']);
    } else if (bet.id === BET.BTTS || /^both teams( to)? score$/i.test(bet.name || '')) {
      put('gg', v.Yes); put('ng', v.No);
    }
  }
  return odds;
}

function ymdOf(offsetDays) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

const ODDS_CAP_PER_REFRESH = 10;

// Fixtures sweep: a full week of the core leagues (yesterday for
// settlements, today, and five days ahead so the upcoming list
// stays deep — Prince, 2026-11-04: he expects 100+ upcoming from
// the two feeds together). One call per day, on the slow gate.
async function refreshAfFixtures() {
  let imported = 0;
  for (const offset of [-1, 0, 1, 2, 3, 4, 5]) {
    let fixtures = [];
    try { fixtures = await afFetch('/fixtures?date=' + ymdOf(offset)); } catch (e) { continue; }
    for (const fx of fixtures) {
      const m = mapFixture(fx);
      if (!m) continue;
      await upsertMatch(m);
      imported++;
    }
  }
  return imported;
}

async function refreshAfLive() {
  let imported = 0;
  // Live sweep: EVERY match in play anywhere in the world joins the
  // list while it is live, whatever its league (one call). Rows that
  // were live but have dropped out of the live feed are reconciled
  // with one batched id lookup so they finish properly instead of
  // sitting at "live" forever (their bets need the final score).
  let liveImported = 0;
  try {
    const live = await afFetch('/fixtures?live=all');
    const liveIds = new Set();
    for (const fx of live) {
      if (fx.fixture && fx.fixture.id) liveIds.add('af:' + fx.fixture.id);
      const m = mapFixture(fx, true);
      if (!m) continue;
      await upsertMatch(m);
      liveImported++;
    }
    const stale = await sql(
      `select external_ref from matches
       where external_ref like 'af:%' and status = 'live'
         and starts_at < now() - interval '10 minutes'
       order by starts_at asc
       limit 100`
    );
    const missing = stale.filter(r => !liveIds.has(r.external_ref)).map(r => r.external_ref.slice(3));
    for (let i = 0; i < missing.length; i += 20) {
      const final = await afFetch('/fixtures?ids=' + missing.slice(i, i + 20).join('-'));
      for (const fx of final) {
        const m = mapFixture(fx, true);
        if (m) await upsertMatch(m);
      }
    }
  } catch (e) { /* live sweep is best-effort; the date sweep already ran */ }
  // Odds pass: every shown match that still lacks a 1X2 line OR
  // its full market book gets one odds call each, live first, then
  // nearest kickoff. The window covers the whole fixture sweep
  // (the API publishes odds up to 14 days ahead), so a match five
  // days out is priced just like tonight's — Prince, 2026-11-04:
  // a bare match page with no odds at all is not acceptable.
  const needy = await sql(
    `select id, external_ref, odds, odds_full from matches
     where external_ref like 'af:%' and status in ('live', 'upcoming')
       and starts_at < now() + interval '6 days'
       and (not (odds ? 'o1') or odds_full is null)
     order by (status = 'upcoming') desc, odds_attempt_at asc nulls first, starts_at asc
     limit $1`,
    [ODDS_CAP_PER_REFRESH]
  );
  let priced = 0;
  for (const row of needy) {
    const fixtureId = row.external_ref.slice(3);
    let resp = [];
    try { resp = await afFetch('/odds?fixture=' + fixtureId); } catch (e) {
      await sql('update matches set odds_attempt_at = now() where id = $1', [row.id]).catch(() => {});
      continue;
    }
    const bookmakers = resp[0] && resp[0].bookmakers;
    const bm = pickBookmaker(bookmakers);
    // Every attempt is stamped, priced or not: an unpriceable fixture
    // (a youth game the API never books) used to sit at the head of
    // the queue and starve every match behind it (2026-11-08).
    if (!bm) {
      await sql('update matches set odds_attempt_at = now() where id = $1', [row.id]).catch(() => {});
      continue;
    }
    const fresh = oddsFromAf(bookmakers);
    const full = fullFromAf(bm);
    if (!fresh.o1 && !full.length) {
      await sql('update matches set odds_attempt_at = now() where id = $1', [row.id]).catch(() => {});
      continue;
    }
    const merged = { ...(row.odds || {}), ...fresh };
    await sql(
      'update matches set odds = $1::jsonb, odds_full = coalesce($2::jsonb, odds_full), odds_attempt_at = now() where id = $3',
      [JSON.stringify(merged), full.length ? JSON.stringify(full) : null, row.id]
    );
    priced++;
  }
  return { liveImported, priced };
}

// Admin Sync runs the whole programme at once, ungated.
async function refreshAf() {
  const imported = await refreshAfFixtures();
  const { liveImported, priced } = await refreshAfLive();
  return { imported, priced, liveImported };
}

// Same anti-stampede gate as the ESPN refresh, separate clock.
const REFRESH_MS = 120000;
const FIXTURES_MS = 600000; // the week-ahead sweep runs at most every 10 minutes
async function claimGate(key, ms) {
  const now = Date.now();
  const claimed = await sql(
    `insert into operator_settings (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value
       where operator_settings.value ~ '^[0-9]+$' and operator_settings.value::bigint <= $3
     returning key`,
    [key, String(now), String(now - ms)]
  );
  return claimed.length > 0;
}
async function maybeRefreshAf() {
  let ran = false;
  if (await claimGate('af_fixtures_at', FIXTURES_MS)) { await refreshAfFixtures(); ran = true; }
  if (await claimGate('af_refresh_at', REFRESH_MS)) { await refreshAfLive(); ran = true; }
  return ran;
}

module.exports = { afEnabled, maybeRefreshAf, refreshAf, mapFixture, oddsFromAf, fullFromAf, pickBookmaker, FULL_IDS, LEAGUES };
