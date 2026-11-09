const { msql, send, guard, isCustomMatch, customMatchState, fillOdds, maybeAutoSettle, ensureMatchColumns } = require('./_lib');
const singleMatch = require('./_handlers/match-single');
const { maybeRefreshLive } = require('./_espn');
const { afEnabled, maybeRefreshAf } = require('./_apifootball');

// Cross-feed duplicate detection. The two feeds spell team names
// differently (Stade Rennais vs Rennes, Olympiacos vs Olympiakos
// Piraeus), so names are compared token by token: accents and
// punctuation stripped, club filler words and year numbers dropped,
// and every token of the shorter name must have a near-twin in the
// longer one (equality, prefix, or a small edit distance for
// spelling variants). Manchester City vs Manchester United and
// Real Madrid vs Real Betis correctly fail, because their second
// tokens have no near-twin. Known accepted edge: Athletic Club and
// Atletico Madrid are near-names token-wise, but a wrong merge also
// needs the other team to match and kickoffs within 45 minutes.
const TEAM_FILLER = new Set(['fc', 'afc', 'cf', 'sc', 'fk', 'ac', 'as', 'club', 'de', 'the', 'stade', 'us', 'cd', 'sd', 'bk']);
// City exonyms: the feeds disagree on local vs English place names
// (Slavia Praha vs Slavia Prague is the pair that proved the need).
const TOKEN_ALIAS = {
  prague: 'praha', munich: 'munchen', moscow: 'moskva', warsaw: 'warszawa',
  lisbon: 'lisboa', seville: 'sevilla', turin: 'torino', naples: 'napoli',
  milan: 'milano', rome: 'roma', athens: 'athina', vienna: 'wien',
  cologne: 'koln', brussels: 'bruxelles', antwerp: 'antwerpen', ghent: 'gent',
  copenhagen: 'kobenhavn', gothenburg: 'goteborg', salonika: 'thessaloniki',
};
function teamTokens(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(t => t && !/^\d+$/.test(t) && !TEAM_FILLER.has(t))
    .map(t => TOKEN_ALIAS[t] || t);
}
function lev(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}
function tokenSimilar(a, b) {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  return Math.abs(a.length - b.length) <= 2 && lev(a, b) <= 2;
}
function teamSimilar(a, b) {
  const A = teamTokens(a), B = teamTokens(b);
  if (!A.length || !B.length) return false;
  const [short, long] = A.length <= B.length ? [A, B] : [B, A];
  return short.every(t => long.some(u => tokenSimilar(t, u)));
}
function sameMatch(p, e) {
  const dt = Math.abs(new Date(p.starts_at) - new Date(e.starts_at));
  if (!(dt <= 45 * 60000)) return false;
  return teamSimilar(p.home_team, e.home_team) && teamSimilar(p.away_team, e.away_team);
}

// Public match list: live matches first, then upcoming by start time.
// Super-admin "featured" matches (external_ref custom:...) carry a goal
// schedule instead of a feed: their clock, score and status are derived
// from kickoff time on every read, so they play like real matches with
// no one touching them. A featured match that has run its 95 minutes
// stays visible as a result for 3 hours, then drops off.
// 20-second response cache: the catalog is identical for every
// visitor, so repeat views inside the window cost no database
// transfer at all. The feed refreshes above still run on their own
// gates, so the cache never delays a score by more than its window.
let listCache = { at: 0, body: null };
module.exports = guard(async (req, res) => {
  // An id query means the details page wants ONE match's full book:
  // /api/match rewrites here (vercel.json) and Railway mounts this
  // file for /api/match too, so delegate to the single-match handler.
  if (req.query && req.query.id) return singleMatch(req, res);
  // Live matches keep themselves current: the first list request after
  // a quiet couple of minutes refreshes statuses, scores and minutes
  // before answering. Both feeds run (Prince, 2026-11-04): API-Football
  // is the primary source and its matches list first; ESPN stays on as
  // the secondary source and its matches follow below. The merge is
  // seamless — nothing in the response names a provider, and when
  // both feeds carry the same real match only the API-Football copy
  // shows. A feed failure must never break the list, so errors are
  // swallowed. While no API-Football key is configured the list is
  // simply the ESPN block, exactly as before.
  const af = afEnabled();
  if (af) await maybeRefreshAf().catch(() => {});
  await ensureMatchColumns().catch(() => {});
  await maybeRefreshLive().catch(() => {});
  if (listCache.body && Date.now() - listCache.at < 20000) return send(res, 200, listCache.body);
  // Settle bets on matches the feeds have just finished (throttled
  // inside; a failure here must never break the list either).
  await maybeAutoSettle().catch(() => {});
  // The list must NOT pull odds_full: the ~38-market book of every
  // match crossed the database wire on every page view and was then
  // thrown away before responding — that firehose is what exhausted
  // the Free plan's transfer allowance (2026-11-07). A boolean says
  // whether a book exists; the detail endpoint fetches it on demand.
  const LIST_COLS = `id, league, home_team, away_team, starts_at, status, minute,
            score_home, score_away, odds, (odds_full is not null) as has_full, home_logo, away_logo, external_ref, goal_events,
            ht_stoppage, ft_stoppage, betting_locked`;
  const liveRows = await msql(`select ${LIST_COLS} from matches where status = 'live' order by starts_at asc limit 300`);
  // Yesterday's dead fixtures never show (Prince, 2026-11-09): a feed
  // match still marked upcoming 3+ hours after its kickoff never got
  // covered — it sits on Home forever with 'Odds soon'. Custom games
  // derive their own state and burn down inside that window anyway.
  const upRows = await msql(`select ${LIST_COLS} from matches where status = 'upcoming' and starts_at > now() - interval '3 hours' order by starts_at asc limit 300`);
  const rows = liveRows.concat(upRows);
  const now = new Date();
  // Group 0 is the primary block (API-Football rows, admin manual
  // matches and the featured matches); group 1 is the ESPN block.
  const entries = [];
  for (const m of rows) {
    const grp = m.external_ref && m.external_ref.startsWith('espn:') ? 1 : 0;
    if (isCustomMatch(m)) {
      const st = customMatchState(m, now);
      if (st.status === 'finished' && now - new Date(m.starts_at) > (105 + (m.ht_stoppage || 0) + (m.ft_stoppage || 0) + 180) * 60000) continue;
      entries.push({ grp, row: { ...m, odds: fillOdds(m.odds), status: st.status, minute: st.minute, minute_label: st.minute_label, score_home: st.score_home, score_away: st.score_away, goal_events: undefined, has_full: !!m.has_full } });
    } else {
      entries.push({ grp, row: { ...m, odds: fillOdds(m.odds), goal_events: undefined, has_full: !!m.has_full } });
    }
  }
  // De-duplicate across feeds: an ESPN row that is the same real
  // match as a primary row (kickoff within 45 minutes and both team
  // names alike) drops out, so no match ever appears twice.
  const primaries = entries.filter(e => e.grp === 0).map(e => e.row);
  const visible = entries.filter(e => {
    if (e.grp === 0) return true;
    return !primaries.some(p => sameMatch(p, e.row));
  });
  visible.sort((a, b) => {
    const rank = (x) => x.status === 'live' ? 0 : x.status === 'upcoming' ? 1 : 2;
    return a.grp - b.grp
      || rank(a.row) - rank(b.row)
      || new Date(a.row.starts_at) - new Date(b.row.starts_at);
  });
  listCache = { at: Date.now(), body: { matches: visible.map(e => e.row) } };
  send(res, 200, listCache.body);
});
