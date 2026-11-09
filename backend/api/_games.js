const crypto = require('crypto');
const { sql } = require('./_lib');

// Casino games, server-authoritative: every outcome is decided here
// with crypto RNG, money moves in single SQL statements alongside
// ledger rows, and a round can pay out exactly once because the
// credit only happens inside the statement that closes it.

const GAME_NAMES = {
  aviator: 'Aviator', plinko: 'Plinko X', dice: 'Lucky Dice',
  coinflip: 'Coin Flip', shootout: 'Penalty Shootout', penalty: 'Football Penalty',
};
const MIN_STAKE = 1, MAX_STAKE = 1000;
const money2 = (n) => Math.round(Number(n) * 100) / 100;

async function ensureGameTables() {
  await sql(`create table if not exists game_rounds (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users (id),
    game text not null check (game in ('aviator','plinko','dice','coinflip','shootout','penalty')),
    stake_ghs numeric(12,2) not null check (stake_ghs > 0),
    payout_ghs numeric(12,2) not null default 0,
    status text not null default 'open' check (status in ('open','won','lost','cashed')),
    state jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    settled_at timestamptz)`);
}

const randInt = (n) => crypto.randomInt(n);
const randUnit = () => crypto.randomBytes(4).readUInt32BE(0) / 4294967296;

/* ---------------- Aviator (crash) ---------------- */
// Provably-fair style: the seed is fixed at launch, its sha256 is
// shown to the player up front, and the seed is revealed when the
// flight ends so the crash point can be re-derived and checked.
function crashFromSeed(seed) {
  const hs = parseInt(seed.slice(0, 13), 16); // 52 bits
  const h = hs / Math.pow(2, 52);
  // The 0.97 numerator IS the house edge: it puts ~3% of flights at
  // the 1.00 floor (instant bust) and makes every fixed cash-out
  // point return ~97%. (An extra modulo bust rule on top of this
  // double-counts the edge — the distribution test caught that.)
  return Math.min(500, Math.max(1, Math.floor(100 * 0.97 / (1 - h)) / 100));
}
const GROWTH_PER_MS = 0.1 / 1000; // multiplier = e^(0.1 * seconds)
const multiplierAt = (elapsedMs) => Math.exp(GROWTH_PER_MS * Math.max(0, elapsedMs));
const msToMultiplier = (m) => Math.log(m) / GROWTH_PER_MS;

/* ---------------- Plinko ---------------- */
// Slot multipliers by rows and risk. The unit test proves every
// table returns between 95% and 99.5% over the binomial path
// distribution, so no row/risk combination can bleed the house.
const PLINKO = {
  8: {
    low: [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6],
    medium: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
    high: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29],
  },
  12: {
    low: [10, 3, 1.6, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 1.6, 3, 10],
    medium: [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33],
    high: [170, 24, 8.1, 2, 0.7, 0.2, 0.2, 0.2, 0.7, 2, 8.1, 24, 170],
  },
  16: {
    low: [16, 9, 2, 1.4, 1.4, 1.2, 1.1, 1, 0.5, 1, 1.1, 1.2, 1.4, 1.4, 2, 9, 16],
    medium: [110, 41, 10, 5, 3, 1.5, 1, 0.5, 0.3, 0.5, 1, 1.5, 3, 5, 10, 41, 110],
    high: [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000],
  },
};
function plinkoDrop(rows) {
  const path = [];
  let rights = 0;
  for (let i = 0; i < rows; i++) { const r = randInt(2); path.push(r); rights += r; }
  return { path, slot: rights };
}

/* ---------------- Instant games ---------------- */
const DICE_PRICES = { under: 2.33, seven: 5.82, over: 2.33 }; // 15/36, 6/36, 15/36 at ~97%
const COIN_PRICE = 1.94;
// Football Penalty: six zones (0-2 top row, 3-5 bottom row). The
// keeper dives with a human bias toward the low corners; glamour
// zones carry a miss chance. price = 0.97 / P(goal) per zone.
const PENALTY_KEEPER_P = [0.10, 0.12, 0.10, 0.24, 0.20, 0.24];
const PENALTY_MISS_P = [0.25, 0.15, 0.25, 0.12, 0.05, 0.12];
const PENALTY_PRICES = PENALTY_KEEPER_P.map((kp, i) => money2(0.97 / ((1 - PENALTY_MISS_P[i]) * (1 - kp))));
// Penalty Shootout ladder: cash-out value after n goals. Each kick
// survives at 5/6 (keeper picks one of six zones), so the fair
// ladder is (6/5)^n and every rung is priced at 97% of fair.
const SHOOTOUT_LADDER = [1, 2, 3, 4, 5].map(n => money2(0.97 * Math.pow(6 / 5, n)));

function resolveInstant(game, cfg) {
  switch (game) {
    case 'plinko': {
      const rows = cfg.rows, table = PLINKO[rows][cfg.risk];
      const { path, slot } = plinkoDrop(rows);
      const mult = table[slot];
      return { mult, result: { path, slot, rows, risk: cfg.risk } };
    }
    case 'dice': {
      const d1 = randInt(6) + 1, d2 = randInt(6) + 1, total = d1 + d2;
      const won = cfg.pick === 'under' ? total < 7 : cfg.pick === 'seven' ? total === 7 : total > 7;
      return { mult: won ? DICE_PRICES[cfg.pick] : 0, result: { d1, d2, total, pick: cfg.pick } };
    }
    case 'coinflip': {
      const face = randInt(2) === 0 ? 'crest' : 'coin';
      return { mult: face === cfg.pick ? COIN_PRICE : 0, result: { face, pick: cfg.pick } };
    }
    case 'penalty': {
      const zone = cfg.zone;
      const roll = randUnit();
      let keeperCum = 0, keeper = 5;
      for (let i = 0; i < 6; i++) { keeperCum += PENALTY_KEEPER_P[i]; if (roll < keeperCum) { keeper = i; break; } }
      const missed = randUnit() < PENALTY_MISS_P[zone];
      const saved = !missed && keeper === zone;
      const goal = !missed && !saved;
      return { mult: goal ? PENALTY_PRICES[zone] : 0, result: { zone, keeper, missed, saved, goal } };
    }
    default: return null;
  }
}

function validateConfig(game, cfg) {
  cfg = cfg && typeof cfg === 'object' ? cfg : {};
  switch (game) {
    case 'aviator': {
      const auto = cfg.auto_cashout == null ? null : Number(cfg.auto_cashout);
      if (auto != null && (!(auto >= 1.01) || auto > 500)) return null;
      return { auto_cashout: auto };
    }
    case 'plinko':
      return (PLINKO[cfg.rows] && PLINKO[cfg.rows][cfg.risk]) ? { rows: Number(cfg.rows), risk: cfg.risk } : null;
    case 'dice':
      return DICE_PRICES[cfg.pick] ? { pick: cfg.pick } : null;
    case 'coinflip':
      return (cfg.pick === 'crest' || cfg.pick === 'coin') ? { pick: cfg.pick } : null;
    case 'penalty':
      return Number.isInteger(cfg.zone) && cfg.zone >= 0 && cfg.zone <= 5 ? { zone: cfg.zone } : null;
    case 'shootout':
      return {};
    default: return null;
  }
}

/* ---------------- Round lifecycle ---------------- */
// Debit + create in one statement; returns null on low balance.
async function openRound(uid, game, stake, state) {
  const rows = await sql(
    `with bal as (
       update users set balance_ghs = balance_ghs - $3,
         bonus_ghs = bonus_ghs - least(bonus_ghs, $3)
       where id = $1 and balance_ghs >= $3 returning id
     ),
     round as (
       insert into game_rounds (user_id, game, stake_ghs, state)
       select $1, $2, $3, $4::jsonb from bal returning *
     ),
     led as (
       insert into wallet_transactions (user_id, kind, method, amount_ghs, status)
       select $1, 'game_stake', $5, -$3, 'completed' from bal returning id
     )
     select * from round`,
    [uid, game, stake, JSON.stringify(state), GAME_NAMES[game]]
  );
  return rows[0] || null;
}

// Close a round exactly once; credits the payout in the same
// statement when there is one. Returns the closed round or null
// when it was already closed.
async function closeRound(round, status, payout, statePatch) {
  const state = { ...(round.state || {}), ...(statePatch || {}) };
  const rows = await sql(
    `with r as (
       update game_rounds set status = $3, payout_ghs = $4, state = $5::jsonb, settled_at = now()
       where id = $1 and user_id = $2 and status = 'open' returning *
     ),
     led as (
       insert into wallet_transactions (user_id, kind, method, amount_ghs, status)
       select user_id, 'game_win', $6, payout_ghs, 'completed' from r where payout_ghs > 0 returning id
     ),
     bal as (
       update users set balance_ghs = balance_ghs + r.payout_ghs from r
       where users.id = r.user_id and r.payout_ghs > 0 returning users.id
     )
     select * from r`,
    [round.id, round.user_id, status, payout, JSON.stringify(state), GAME_NAMES[round.game]]
  );
  return rows[0] || null;
}

async function balanceOf(uid) {
  const rows = await sql('select balance_ghs from users where id = $1', [uid]);
  return rows.length ? Number(rows[0].balance_ghs) : 0;
}

function publicRound(r, extra) {
  const st = r.state || {};
  const out = {
    id: r.id, game: r.game, stake: Number(r.stake_ghs), payout: Number(r.payout_ghs),
    status: r.status, created_at: r.created_at, settled_at: r.settled_at,
    result: st.result || null,
    ...(extra || {}),
  };
  if (r.game === 'aviator') {
    out.seed_hash = st.seed_hash || null;
    out.cashed_at = st.cashed_at_mult || null;
    // The seed (and with it the proof of the crash point) is only
    // revealed once the flight is over.
    if (r.status !== 'open') { out.crash = st.crash; out.seed = st.seed; }
    if (r.status === 'open') out.started_at = st.started_at;
  }
  if (r.game === 'shootout') {
    out.kicks = st.kicks || 0; out.goals = st.goals || 0;
    out.ladder = SHOOTOUT_LADDER;
    if (r.status === 'open') {
      out.cashout_value = st.goals > 0 ? money2(Number(r.stake_ghs) * SHOOTOUT_LADDER[st.goals - 1]) : 0;
    }
  }
  return out;
}

// Bring an open Aviator round up to date: auto cash-out lands the
// moment its multiplier is reached, and a flight that has passed
// its crash point is lost. Returns the fresh round row.
async function syncAviator(round) {
  if (!round || round.game !== 'aviator' || round.status !== 'open') return round;
  const st = round.state;
  const elapsed = Date.now() - new Date(st.started_at).getTime();
  const crashMs = msToMultiplier(st.crash);
  if (st.auto_cashout && st.auto_cashout <= st.crash && elapsed >= msToMultiplier(st.auto_cashout)) {
    return (await closeRound(round, 'cashed', money2(Number(round.stake_ghs) * st.auto_cashout), { cashed_at_mult: st.auto_cashout })) || round;
  }
  if (elapsed >= crashMs) {
    return (await closeRound(round, 'lost', 0, { final_mult: st.crash })) || round;
  }
  return round;
}

module.exports = {
  GAME_NAMES, MIN_STAKE, MAX_STAKE, ensureGameTables, money2,
  crashFromSeed, multiplierAt, msToMultiplier, PLINKO, DICE_PRICES, COIN_PRICE,
  PENALTY_PRICES, PENALTY_KEEPER_P, PENALTY_MISS_P, SHOOTOUT_LADDER,
  resolveInstant, validateConfig, openRound, closeRound, balanceOf, publicRound, syncAviator,
};
