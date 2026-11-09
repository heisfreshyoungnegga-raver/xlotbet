// Bidirectional market translation between the PrimeStake/Oddaroa
// engine and the StakeKing UI. One module owns both directions so a
// price the UI shows is always a price the engine can settle.
//
// UI shape (src/lib/match-markets.ts): markets is a plain object
//   { "Double Chance": {"1X": 1.4, "X2": 1.5, "12": 1.3},
//     "Over/Under 2.5": {"Over": 1.9, "Under": 1.9},
//     "GG/NG": {"GG": 1.8, "NG": 2.0},
//     "Correct Score": {"1:0": 7.5, ...},
//     "Handicap +0.5": {"Home +0.5": 1.9, "Away -0.5": 1.9}, ... }
// 1X2 itself travels in the odds_home/odds_draw/odds_away columns.
//
// Engine shapes: the classic odds jsonb (o1/ox/o2, dc12/dc1x/dcx2,
// gg/ng, over25/under25..., cs10..., sph/spa) and odds_full, the
// API-Football book: [{id, name, values: [{value, odd}]}] with names
// like "Goals Over/Under" and value labels like "Over 2.5".

function num(v) { const n = Number(v); return Number.isFinite(n) && n > 1 ? n : null; }
function fmtLine(x) { return (x > 0 ? '+' : '') + Number(x).toFixed(1).replace(/\.0$/, ''); }

// ---------- engine -> UI ----------

function classicToUi(odds) {
  const markets = {};
  if (!odds) return markets;
  const dc = {};
  if (num(odds.dc1x)) dc['1X'] = Number(odds.dc1x);
  if (num(odds.dcx2)) dc['X2'] = Number(odds.dcx2);
  if (num(odds.dc12)) dc['12'] = Number(odds.dc12);
  if (Object.keys(dc).length) markets['Double Chance'] = dc;
  if (num(odds.gg) && num(odds.ng)) markets['GG/NG'] = { GG: Number(odds.gg), NG: Number(odds.ng) };
  for (const key of Object.keys(odds)) {
    const ou = /^over(\d)(\d)$/.exec(key);
    if (ou) {
      const line = ou[1] + '.' + ou[2];
      const over = num(odds[key]), under = num(odds['under' + ou[1] + ou[2]]);
      if (over && under) markets['Over/Under ' + line] = { Over: over, Under: under };
      continue;
    }
    const cs = /^cs(\d)(\d)$/.exec(key);
    if (cs && num(odds[key])) {
      markets['Correct Score'] = markets['Correct Score'] || {};
      markets['Correct Score'][cs[1] + ':' + cs[2]] = Number(odds[key]);
    }
  }
  // Classic handicap keys sph/spa carry one stored line each in the
  // market NAME at placement time, not in the odds jsonb, so a stored
  // book alone cannot rebuild the UI's "Handicap <line>" market;
  // odds_full covers handicaps whenever a full book exists.
  return markets;
}

function fullBookToUi(book) {
  const markets = {};
  if (!Array.isArray(book)) return markets;
  for (const m of book) {
    if (!m || !Array.isArray(m.values)) continue;
    const name = String(m.name || '');
    const vals = m.values.filter((v) => v && num(v.odd));
    if (!vals.length) continue;
    if (name === 'Match Winner') continue; // -> odds columns
    if (name === 'Double Chance') {
      const dc = {};
      for (const v of vals) {
        if (v.value === 'Home/Draw') dc['1X'] = Number(v.odd);
        else if (v.value === 'Draw/Away') dc['X2'] = Number(v.odd);
        else if (v.value === 'Home/Away') dc['12'] = Number(v.odd);
      }
      if (Object.keys(dc).length) markets['Double Chance'] = dc;
      continue;
    }
    if (name === 'Both Teams Score' || name === 'Both Teams To Score') {
      const gg = {};
      for (const v of vals) {
        if (v.value === 'Yes') gg.GG = Number(v.odd);
        else if (v.value === 'No') gg.NG = Number(v.odd);
      }
      if (gg.GG && gg.NG) markets['GG/NG'] = gg;
      continue;
    }
    if (name === 'Goals Over/Under' || name === 'Goals Over/Under First Half' || name === 'Goals Over/Under - Second Half') {
      const suffix = name === 'Goals Over/Under' ? '' : name.endsWith('First Half') ? ' - First Half' : ' - Second Half';
      for (const v of vals) {
        const mm = /^(Over|Under) (\d+(?:\.\d+)?)$/.exec(String(v.value));
        if (!mm) continue;
        const key = 'Over/Under ' + mm[2] + suffix;
        markets[key] = markets[key] || {};
        markets[key][mm[1]] = Number(v.odd);
      }
      continue;
    }
    if (name === 'Exact Score' || name === 'Correct Score') {
      const cs = {};
      for (const v of vals) cs[String(v.value)] = Number(v.odd);
      if (Object.keys(cs).length) markets['Correct Score'] = cs;
      continue;
    }
    // Everything else (Handicap Result, HT/FT Double, Odd/Even,
    // Clean Sheet, half winners, ...) passes through under its own
    // name with its own value labels: the UI renders any market
    // generically, and the reverse map below restores it exactly.
    const out = {};
    for (const v of vals) out[String(v.value)] = Number(v.odd);
    if (Object.keys(out).length) markets[name] = out;
  }
  return markets;
}

// Full UI markets object for one engine match row. Merged per market
// AND per option, with the classic odds winning per option: both
// sources price Correct Score, for example, and a shallow assign
// would drop every book scoreline the classic grid lacks.
function toUiMarkets(match) {
  const fromFull = fullBookToUi(match && match.odds_full);
  const fromClassic = classicToUi(match && match.odds);
  const out = {};
  for (const [name, options] of Object.entries(fromFull)) out[name] = Object.assign({}, options);
  for (const [name, options] of Object.entries(fromClassic)) {
    out[name] = Object.assign({}, out[name] || {}, options);
  }
  return out;
}

// ---------- UI -> engine ----------

// Returns {market, pick} in engine terms for one UI selection, or
// null when the selection cannot be expressed. `market` is either a
// classic market name understood by _lib.keyFor/pickWon ('1X2',
// 'Double Chance', 'Both Teams To Score', 'Over/Under 2.5',
// 'Correct Score', 'Handicap +0.5') or an API-Football book name
// settled by afPickWon.
function toEnginePick(uiMarket, uiOption) {
  const market = String(uiMarket || '');
  const option = String(uiOption || '');
  if (market === '1X2') {
    const pick = option === 'home' ? '1' : option === 'draw' ? 'X' : option === 'away' ? '2' : null;
    return pick ? { market: '1X2', pick } : null;
  }
  if (market === 'Double Chance') {
    return ['1X', 'X2', '12'].includes(option) ? { market: 'Double Chance', pick: option } : null;
  }
  if (market === 'GG/NG') {
    if (option === 'GG') return { market: 'Both Teams To Score', pick: 'Yes' };
    if (option === 'NG') return { market: 'Both Teams To Score', pick: 'No' };
    return null;
  }
  const ou = /^Over\/Under (\d+(?:\.\d+)?)( - (First|Second) Half)?$/.exec(market);
  if (ou) {
    if (option !== 'Over' && option !== 'Under') return null;
    if (ou[3] === 'First') return { market: 'Goals Over/Under First Half', pick: option + ' ' + ou[1] };
    if (ou[3] === 'Second') return { market: 'Goals Over/Under - Second Half', pick: option + ' ' + ou[1] };
    return { market: 'Over/Under ' + ou[1], pick: option + ' ' + ou[1] };
  }
  if (market === 'Correct Score') {
    return /^\d+:\d+$/.test(option) ? { market: 'Correct Score', pick: option } : null;
  }
  const hc = /^Handicap ([+-]?\d+(?:\.\d+)?)$/.exec(market);
  if (hc) {
    // UI two-way spread: option "Home +0.5" / "Away -0.5" -> classic
    // engine handicap market named by the HOME line.
    const om = /^(Home|Away) ([+-]?\d+(?:\.\d+)?)$/.exec(option);
    if (!om) return null;
    return { market: 'Handicap ' + fmtLine(parseFloat(hc[1])), pick: option };
  }
  // Pass-through book markets: option labels are the AF value labels.
  if (market) return { market, pick: option };
  return null;
}

// ---------- engine -> UI (single stored pick) ----------

// Inverse of toEnginePick for one stored engine selection, used when
// building the UI's bets.selections arrays. Returns
// {market, option, optionLabel} in UI terms.
function toUiPick(engineMarket, enginePick) {
  const market = String(engineMarket || '');
  const pick = String(enginePick || '');
  if (market === '1X2' || market === 'Match Winner') {
    const map = {
      '1': ['home', 'Home'], Home: ['home', 'Home'],
      X: ['draw', 'Draw'], Draw: ['draw', 'Draw'],
      '2': ['away', 'Away'], Away: ['away', 'Away'],
    };
    const hit = map[pick];
    if (hit) return { market: '1X2', option: hit[0], optionLabel: hit[1] };
  }
  if (market === 'Double Chance') return { market, option: pick, optionLabel: { '1X': 'Home or Draw', X2: 'Draw or Away', '12': 'Home or Away' }[pick] || pick };
  if (market === 'Both Teams To Score' || market === 'Both Teams Score') {
    return { market: 'GG/NG', option: pick === 'Yes' ? 'GG' : 'NG', optionLabel: pick === 'Yes' ? 'GG' : 'NG' };
  }
  const ou = /^Over\/Under (\d+(?:\.\d+)?)$/.exec(market);
  if (ou) {
    const side = pick.startsWith('Over') ? 'Over' : 'Under';
    return { market, option: side, optionLabel: side + ' ' + ou[1] };
  }
  if (market === 'Goals Over/Under' || market === 'Goals Over/Under First Half' || market === 'Goals Over/Under - Second Half') {
    const mm = /^(Over|Under) (\d+(?:\.\d+)?)$/.exec(pick);
    if (mm) {
      const suffix = market.endsWith('First Half') ? ' - First Half' : market.endsWith('Second Half') ? ' - Second Half' : '';
      return { market: 'Over/Under ' + mm[2] + suffix, option: mm[1], optionLabel: pick };
    }
  }
  if (market === 'Exact Score') return { market: 'Correct Score', option: pick, optionLabel: pick };
  if (market === 'Correct Score') return { market, option: pick, optionLabel: pick };
  const hc = /^Handicap ([+-]?\d+(?:\.\d+)?)$/.exec(market);
  if (hc) return { market, option: pick, optionLabel: pick };
  // Pass-through book markets keep their AF name and value label.
  return { market, option: pick, optionLabel: pick };
}

module.exports = { toUiMarkets, toEnginePick, toUiPick, classicToUi, fullBookToUi, fmtLine };
