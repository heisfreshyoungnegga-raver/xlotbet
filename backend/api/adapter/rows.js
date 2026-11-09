const { toUiMarkets, toUiPick } = require('./markets');
const { currencyOfPhone } = require('../_lib');

// Row mappers: engine rows -> the exact shapes the StakeKing UI's
// generated types describe (src/integrations/supabase/types.ts).

const FD_CODES = {
  'Premier League': 'PL', 'La Liga': 'PD', 'Serie A': 'SA', 'Bundesliga': 'BL1',
  'Ligue 1': 'FL1', 'Primeira Liga': 'PPL', 'Eredivisie': 'DED',
  'UEFA Champions League': 'CL', 'UEFA Europa League': 'EL', 'MLS': 'MLS',
  'Ghana Premier League': 'GPL',
};
const COUNTRY_BY_CURRENCY = { GHS: 'Ghana', NGN: 'Nigeria', KES: 'Kenya', UGX: 'Uganda', TZS: 'Tanzania' };

function iso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function extId(ref) {
  const m = /^af:(\d+)$/.exec(String(ref || ''));
  return m ? Number(m[1]) : null;
}
function sourceOf(ref) {
  const r = String(ref || '');
  if (r.startsWith('af:')) return 'api-football';
  if (r.startsWith('espn:')) return 'espn';
  return 'custom';
}

function matchRow(m, footballCategoryId) {
  const odds = m.odds || {};
  return {
    id: m.id,
    league: m.league,
    home_team: m.home_team,
    away_team: m.away_team,
    home_team_full: m.home_team,
    away_team_full: m.away_team,
    home_team_id: null,
    away_team_id: null,
    home_crest: m.home_logo || null,
    away_crest: m.away_logo || null,
    start_time: iso(m.starts_at),
    status: m.status,
    minute: m.minute == null ? null : Number(m.minute),
    home_score: Number(m.score_home || 0),
    away_score: Number(m.score_away || 0),
    odds_home: Number(odds.o1 || 0),
    odds_draw: Number(odds.ox || 0),
    odds_away: Number(odds.o2 || 0),
    odds_available: !!(Number(odds.o1) > 1 && Number(odds.ox) > 1 && Number(odds.o2) > 1),
    odds_bookmaker: m.odds_full ? 'Bet365' : null,
    odds_event_id: null,
    odds_updated_at: iso(m.odds_attempt_at) || iso(m.created_at),
    markets: toUiMarkets(m),
    external_id: extId(m.external_ref),
    competition_code: FD_CODES[m.league] || null,
    category_id: footballCategoryId || null,
    source: sourceOf(m.external_ref),
    api_status: null,
    second_half_at: null,
    visible: true,
    created_at: iso(m.created_at),
    synced_at: iso(m.odds_attempt_at) || iso(m.created_at),
  };
}

function profileRow(user, meta, wager) {
  const m = meta || {};
  const w = wager || {};
  return {
    id: user.id,
    phone: user.phone || '',
    email: user.email || '',
    full_name: user.display_name || m.full_name || '',
    balance: Number(user.balance_ghs || 0),
    country: m.country || COUNTRY_BY_CURRENCY[currencyOfPhone(user.phone)] || 'Ghana',
    referral_code: user.invite_code || null,
    wager_progress: Number(w.progress || 0),
    wager_required: Number(w.required || 0),
    created_at: iso(user.created_at),
  };
}

function userRoleRow(user) {
  return { id: user.id, user_id: user.id, role: user.role === 'player' ? 'user' : 'admin' };
}

function selectionUi(sel, match) {
  const ui = toUiPick(sel.market, sel.pick);
  return {
    matchId: sel.match_id,
    label: match ? match.home_team + ' vs ' + match.away_team : '',
    market: ui.market,
    option: ui.option,
    optionLabel: ui.optionLabel,
    odds: Number(sel.odds || 0),
    // Extra context the ticket page renders when present.
    home_team: match ? match.home_team : undefined,
    away_team: match ? match.away_team : undefined,
    league: match ? match.league : undefined,
    start_time: match ? iso(match.starts_at) : undefined,
    status: sel.result || 'pending',
    score_home: match ? Number(match.score_home || 0) : undefined,
    score_away: match ? Number(match.score_away || 0) : undefined,
    match_status: match ? match.status : undefined,
  };
}

function betRow(bet, selections, bookingCode) {
  const stake = Number(bet.stake_ghs || 0);
  const totalOdds = Number(bet.total_odds || 0);
  const potential = Number(bet.potential_ghs || 0);
  const bonus = Math.max(0, Math.round((potential - stake * totalOdds) * 100) / 100);
  return {
    id: bet.id,
    user_id: bet.user_id,
    stake,
    total_odds: totalOdds,
    potential_win: potential,
    bonus_amount: bonus,
    bonus_rate: stake * totalOdds > 0 ? Math.round((bonus / (stake * totalOdds)) * 10000) / 10000 : 0,
    cashed_out: bet.status === 'cashed_out' ? Number(bet.payout_ghs || 0) : 0,
    booking_code: bookingCode || null,
    selections: selections || [],
    status: bet.status,
    created_at: iso(bet.placed_at),
  };
}

const TX_TYPE = {
  deposit: 'deposit', withdrawal: 'withdrawal', bet: 'bet', win: 'win',
  cashout: 'cashout', bonus: 'bonus', commission: 'commission', refund: 'refund',
  game: 'game', adjustment: 'adjustment',
};
function transactionRow(wt) {
  return {
    id: wt.id,
    user_id: wt.user_id,
    type: TX_TYPE[wt.kind] || wt.kind,
    amount: Number(wt.amount_ghs || 0),
    status: wt.status,
    note: wt.note || wt.method || '',
    created_at: iso(wt.created_at),
  };
}

function shinobiDepositRow(wt, mode) {
  const done = wt.status === 'completed';
  return {
    id: wt.id,
    user_id: wt.user_id,
    intent_id: wt.external_ref || null,
    reference: wt.external_ref || '',
    amount_minor: Math.round(Number(wt.amount_ghs || 0) * 100),
    status: done ? 'succeeded' : wt.status === 'failed' ? 'failed' : 'pending',
    mode: mode || 'live',
    network: (wt.payout_meta && wt.payout_meta.network) || null,
    payment_method: 'mobile_money',
    last_sequence: 0,
    webhook_verified_at: done ? iso(wt.confirmed_at) || iso(wt.created_at) : null,
    credited_at: done ? iso(wt.confirmed_at) || iso(wt.created_at) : null,
    created_at: iso(wt.created_at),
  };
}

function bookingCodeRow(bc) {
  return {
    code: bc.code,
    selections: bc.selections || [],
    created_by: bc.user_id || null,
    created_at: iso(bc.created_at),
  };
}

module.exports = { matchRow, profileRow, userRoleRow, selectionUi, betRow, transactionRow, shinobiDepositRow, bookingCodeRow, iso };
