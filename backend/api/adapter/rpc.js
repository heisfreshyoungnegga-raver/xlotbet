const { sql, readBody, send, guard, getSettings, cashoutQuoteFor, matchesById, genBookingCode, shinobiConfig, shinobiFetch } = require('../_lib');
const { caller, isAdmin } = require('./caller');
const { invoke } = require('./invoke');
const { toEnginePick, toUiMarkets } = require('./markets');
const placeHandler = require('../_handlers/bets/place');
const cashoutHandler = require('../_handlers/bets/cashout');
const withdrawHandler = require('../_handlers/wallet/withdraw');
const depositMomoHandler = require('../_handlers/wallet/deposit-momo');
const depositStatusHandler = require('../_handlers/wallet/deposit-status');
const depositOtpHandler = require('../_handlers/wallet/deposit-otp');
const balanceEditHandler = require('../_handlers/admin/balance-edit');
const confirmHandler = require('../_handlers/admin/confirm');
const rejectHandler = require('../_handlers/admin/reject');

// Deposit confirmations: a verified number+amount may dispatch
// exactly one prompt, mirroring the UI's verify-first flow. In-memory
// per instance, five-minute TTL (same posture as the login throttle).
const confirmations = new Map();
function confirmationKey(userId, phone, network, amountMinor) {
  return [userId, phone, network, amountMinor].join('|');
}
function uiIntentStatus(s) {
  const v = String(s || '');
  if (v === 'succeeded' || v === 'completed' || v === 'success') return 'succeeded';
  if (v === 'failed' || v === 'cancelled' || v === 'canceled') return 'failed';
  if (v === 'unknown' || v === 'processing') return 'processing';
  return 'requires_action'; // created / awaiting / pending / requires_action
}
function uiAction(nextAction) {
  const a = nextAction || {};
  let redirectUrl = null;
  try {
    const u = new URL(String(a.url || ''));
    if (u.protocol === 'https:') redirectUrl = u.toString();
  } catch (e) { /* not a URL */ }
  return {
    type: a.type || 'none',
    redirectUrl,
    expiresAt: a.expires_at || null,
    ussdFallback: a.ussd_fallback || null,
  };
}
const UI_NETWORKS = { mtn: 'MTN', telecel: 'TELECEL', vodafone: 'TELECEL', airteltigo: 'AIRTELTIGO', at: 'AIRTELTIGO' };

// RPC dispatch for the StakeKing frontend. Every function the app
// calls by name lands here; money-moving ones delegate to the engine
// handlers through invoke() so the engine's rules run unchanged.

function rpcError(res, message, status) {
  return send(res, status || 400, { code: 'P0001', message: String(message), details: null, hint: null });
}
function engineMessage(out, fallback) {
  if (!out || !out.json) return fallback;
  return out.json.detail || out.json.error || fallback;
}

const RPC = {
  async has_role(c, a) {
    if (!a._user_id) return false;
    if (!c.service && !isAdmin(c) && (!c.user || c.user.id !== a._user_id)) return false;
    const rows = await sql('select role from users where id = $1', [a._user_id]);
    if (!rows.length) return false;
    if (a._role === 'admin') return rows[0].role === 'admin' || rows[0].role === 'super_admin';
    return true; // every account holds the plain 'user' role
  },

  async place_bet(c, a, res) {
    if (!c.user) return rpcError(res, 'You need to sign in to place a bet.', 401);
    const ids = Array.isArray(a._match_ids) ? a._match_ids : [];
    const picks = Array.isArray(a._picks) ? a._picks : [];
    const expected = Array.isArray(a._expected_odds) ? a._expected_odds : [];
    if (!ids.length || ids.length !== picks.length) return rpcError(res, 'The slip is empty or incomplete.');
    const matchMap = await matchesById(ids).catch(() => new Map());
    const selections = [];
    for (let i = 0; i < ids.length; i++) {
      const [uiMarket, uiOption] = String(picks[i] || '').split('|');
      const eng = toEnginePick(uiMarket, uiOption);
      if (!eng) return rpcError(res, 'A selection on this slip is not available.');
      const m = matchMap.get(ids[i]);
      if (!m) return rpcError(res, 'A match on this slip could not be found.');
      // The price the user saw, from the same translation the UI reads.
      const seen = uiMarket === '1X2'
        ? Number((m.odds || {})[{ home: 'o1', draw: 'ox', away: 'o2' }[uiOption]] || 0)
        : Number(((toUiMarkets(m) || {})[uiMarket] || {})[uiOption] || 0);
      if (!(seen > 1)) return rpcError(res, 'A market on this slip is unavailable.');
      if (expected[i] != null && Math.abs(seen - Number(expected[i])) > 0.005) {
        return rpcError(res, 'ODDS_CHANGED: prices have moved. Review and accept the new prices.');
      }
      selections.push({ match_id: ids[i], market: eng.market, pick: eng.pick });
    }
    const out = await invoke(placeHandler, {
      user: c.user,
      body: { stake_ghs: Number(a._stake), mode: selections.length === 1 ? 'single' : 'multiple', selections },
    });
    if (!out.json || out.status >= 400) {
      const code = (out.json && out.json.error) || '';
      const friendly = {
        insufficient_balance: 'Insufficient balance. Deposit or lower the stake.',
        match_live_locked: 'A match on this slip is already live.',
        match_finished: 'A match on this slip has finished.',
        match_postponed: 'A match on this slip has been postponed.',
        betting_locked: 'Betting is locked on one of these matches.',
        market_unavailable: 'A market on this slip is unavailable.',
        one_selection_per_match: 'Only one selection per match is allowed.',
      }[code];
      return rpcError(res, friendly || engineMessage(out, 'The bet could not be placed.'));
    }
    return send(res, 200, out.json.code || out.json.codes && out.json.codes[0] || null);
  },

  async _quote(c, betId) {
    const bets = await sql('select * from bets where id = $1', [betId]);
    if (!bets.length) return { error: 'Ticket not found.' };
    const bet = bets[0];
    if (!c.service && !isAdmin(c) && bet.user_id !== c.user.id) return { error: 'Ticket not found.' };
    if (bet.status !== 'open') return { error: 'This ticket is no longer open.' };
    const selLegs = await sql('select match_id, market, pick, result from bet_selections where bet_id = $1', [bet.id]);
    const legMatches = await matchesById(selLegs.map((r) => r.match_id)).catch(() => new Map());
    const legs = selLegs.map((r) => ({ market: r.market, pick: r.pick, result: r.result, match: legMatches.get(r.match_id) || null }));
    const settings = await getSettings(['cashout_margin_pct']);
    const quote = cashoutQuoteFor(bet, legs, settings.cashout_margin_pct);
    if (quote === null) return { error: 'Cashout unavailable right now.' };
    return { quote };
  },
  async cashout_offer(c, a, res) {
    if (!c.user && !c.service) return rpcError(res, 'You need to sign in.', 401);
    const q = await RPC._quote(c, String(a._bet || ''));
    if (q.error) return rpcError(res, q.error);
    return send(res, 200, q.quote);
  },
  async cashout_bet(c, a, res) {
    if (!c.user) return rpcError(res, 'You need to sign in.', 401);
    const q = await RPC._quote(c, String(a._bet || ''));
    if (q.error) return rpcError(res, q.error);
    if (Number(a._amount) < q.quote - 0.01) {
      return rpcError(res, 'Partial cashout is not available yet. Cash out the full amount or keep the ticket running.');
    }
    const out = await invoke(cashoutHandler, { user: c.user, body: { bet_id: String(a._bet) } });
    if (!out.json || out.status >= 400) return rpcError(res, engineMessage(out, 'Cashout failed.'));
    return send(res, 200, Number(out.json.cashout_ghs));
  },

  async create_booking_code(c, a, res) {
    if (!c.user && !c.service) return rpcError(res, 'You need to sign in.', 401);
    const selections = Array.isArray(a._selections) ? a._selections : [];
    if (!selections.length) return rpcError(res, 'No selections to book.');
    const owner = c.user ? c.user.id : null;
    const dedupe = (owner || 'anon') + '|' + selections.map((s) => (s.matchId || s.match_id) + '|' + s.market + '|' + s.option).sort().join(';');
    const existing = await sql('select code from booking_codes where dedupe = $1', [dedupe]);
    if (existing.length) return send(res, 200, existing[0].code);
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = genBookingCode();
      const rows = await sql(
        'insert into booking_codes (code, selections, user_id, dedupe) values ($1, $2::jsonb, $3, $4) on conflict (code) do nothing returning code',
        [code, JSON.stringify(selections), owner, dedupe]
      );
      if (rows.length) return send(res, 200, code);
    }
    return rpcError(res, 'Could not create a booking code. Try again.');
  },

  async delete_ticket(c, a, res) {
    if (!c.user) return rpcError(res, 'You need to sign in.', 401);
    const bets = await sql('select user_id, status from bets where id = $1', [String(a._bet || '')]);
    if (!bets.length || bets[0].user_id !== c.user.id) return rpcError(res, 'Ticket not found.');
    if (!['won', 'lost', 'cashed_out'].includes(bets[0].status)) return rpcError(res, 'Only settled tickets can be deleted.');
    await sql('insert into adapter_hidden_bets (bet_id, user_id) values ($1, $2) on conflict (bet_id) do nothing', [String(a._bet), c.user.id]);
    return send(res, 200, null);
  },

  async request_withdrawal(c, a, res) {
    if (!c.user) return rpcError(res, 'You need to sign in.', 401);
    const out = await invoke(withdrawHandler, { user: c.user, body: { amount_ghs: Number(a._amount), method: 'MTN MoMo' } });
    if (!out.json || out.status >= 400) return rpcError(res, engineMessage(out, 'The withdrawal could not be requested.'));
    return send(res, 200, null);
  },

  async admin_adjust_balance(c, a, res) {
    if (!isAdmin(c)) return rpcError(res, 'Admin access required.', 403);
    const out = await invoke(balanceEditHandler, {
      user: c.user,
      body: { id: String(a._user || ''), delta_ghs: Number(a._amount), note: 'Adjusted from the StakeKing admin panel' },
    });
    if (!out.json || out.status >= 400) return rpcError(res, engineMessage(out, 'The balance could not be adjusted.'));
    return send(res, 200, null);
  },

  async admin_review_withdrawal(c, a, res) {
    if (!isAdmin(c)) return rpcError(res, 'Admin access required.', 403);
    const handler = a._approve ? confirmHandler : rejectHandler;
    const out = await invoke(handler, { user: c.user, body: { id: String(a._tx || '') } });
    if (!out.json || out.status >= 400) return rpcError(res, engineMessage(out, 'The review could not be completed.'));
    return send(res, 200, null);
  },

  async admin_settle_bet(c, a, res) {
    if (!isAdmin(c)) return rpcError(res, 'Admin access required.', 403);
    const betId = String(a._bet || '');
    const bets = await sql('select * from bets where id = $1', [betId]);
    if (!bets.length) return rpcError(res, 'Ticket not found.');
    if (bets[0].status !== 'open') return rpcError(res, 'This ticket is already settled.');
    if (a._won) {
      // Identical money movement to _lib.settleMatch's win credit.
      await sql(
        `with upd as (update bets set status = 'won', settled_at = now(), payout_ghs = potential_ghs where id = $1 and status = 'open' returning user_id, potential_ghs),
              led as (insert into wallet_transactions (user_id, kind, method, amount_ghs, status)
                      select user_id, 'bet_win', 'Balance', potential_ghs, 'completed' from upd returning id)
         update users set balance_ghs = balance_ghs + (select potential_ghs from upd)
         where id = (select user_id from upd)`,
        [betId]
      );
      await sql("update bet_selections set result = 'won' where bet_id = $1 and result = 'pending'", [betId]);
    } else {
      await sql("update bets set status = 'lost', settled_at = now(), payout_ghs = 0 where id = $1 and status = 'open'", [betId]);
      await sql("update bet_selections set result = 'lost' where bet_id = $1 and result = 'pending'", [betId]);
    }
    return send(res, 200, null);
  },

  async save_shinobipay_credentials(c, a, res) {
    if (!isAdmin(c)) return rpcError(res, 'Admin access required.', 403);
    await sql(
      `insert into payment_credentials (provider, api_key_ciphertext, webhook_secret_ciphertext, updated_at)
       values ('shinobipay', $1, $2, now())
       on conflict (provider) do update set
         api_key_ciphertext = coalesce(excluded.api_key_ciphertext, payment_credentials.api_key_ciphertext),
         webhook_secret_ciphertext = coalesce(excluded.webhook_secret_ciphertext, payment_credentials.webhook_secret_ciphertext),
         updated_at = now()`,
      [a._api_key_ciphertext || null, a._webhook_secret_ciphertext || null]
    );
    return send(res, 200, null);
  },

  async shinobipay_credential_status(c, a, res) {
    if (!isAdmin(c)) return rpcError(res, 'Admin access required.', 403);
    const cfg = shinobiConfig();
    let stored = { api: false, hook: false };
    try {
      const rows = await sql("select api_key_ciphertext, webhook_secret_ciphertext from payment_credentials where provider = 'shinobipay'");
      if (rows.length) stored = { api: !!rows[0].api_key_ciphertext, hook: !!rows[0].webhook_secret_ciphertext };
    } catch (e) { /* table may not exist yet on a fresh DB */ }
    return send(res, 200, {
      apiKeySet: !!cfg.secretKey || stored.api,
      webhookSecretSet: !!cfg.webhookSecret || stored.hook,
    });
  },

  async bind_shinobipay_test_intent(c, a, res) {
    if (!c.user && !c.service) return rpcError(res, 'You need to sign in.', 401);
    const owner = c.user ? c.user.id : null;
    // One bookkeeping row per intent: if the intent is already bound
    // (the adapter's deposit_create path got there first), update
    // that row instead of opening a second one under another
    // reference.
    if (a._intent) {
      const bound = await sql('select id from adapter_shinobipay_deposits where intent_id = $1', [a._intent]);
      if (bound.length) {
        await sql('update adapter_shinobipay_deposits set status = $2 where intent_id = $1',
          [a._intent, String(a._status || 'pending')]);
        return send(res, 200, null);
      }
    }
    await sql(
      `insert into adapter_shinobipay_deposits (user_id, intent_id, reference, amount_minor, status)
       values ($1, $2, $3, $4, $5)
       on conflict (reference) do update set intent_id = excluded.intent_id, status = excluded.status`,
      [owner, a._intent || null, String(a._reference || ''), Math.round(Number(a._amount) || 0), String(a._status || 'pending')]
    );
    return send(res, 200, null);
  },

  async confirm_shinobipay_verified_event(c, a, res) {
    // The engine webhook is the only path that credits a wallet.
    // This RPC reports the engine's recorded state for the reference
    // and keeps the UI's bookkeeping row in step; it never credits.
    const ref = String(a._reference || '');
    const rows = await sql("select status from wallet_transactions where kind = 'deposit' and external_ref = $1 order by created_at desc limit 1", [ref]);
    if (rows.length && rows[0].status === 'completed') {
      await sql(
        `update adapter_shinobipay_deposits set status = 'succeeded', webhook_verified_at = now(), credited_at = now(),
           last_sequence = greatest(last_sequence, $2) where reference = $1`,
        [ref, Number(a._sequence) || 0]
      );
      return send(res, 200, 'credited');
    }
    if (rows.length) return send(res, 200, rows[0].status);
    return send(res, 200, 'awaiting_webhook');
  },

  // Fixtures and odds are owned by the engine feeds on StakeKing;
  // the legacy sync RPCs answer truthfully with zero changes.
  async sync_football_fixtures(c, a, res) { return send(res, 200, 0); },
  async apply_bookmaker_odds(c, a, res) { return send(res, 200, 0); },
  async demo_deposit(c, a, res) { return rpcError(res, 'Demo deposits are retired on this platform.'); },

  // ---- ShinobiPay deposit flow (drives the UI's deposit page) ----
  async payment_readiness(c, a, res) {
    const cfg = shinobiConfig();
    const settings = await getSettings(['gateway_enabled']).catch(() => ({}));
    const ready = !!cfg.secretKey && settings.gateway_enabled !== '0';
    return send(res, 200, {
      ready,
      accountMode: cfg.secretKey ? (cfg.secretKey.startsWith('sk_live_') ? 'live' : 'test') : null,
      reason: ready ? '' : !cfg.secretKey ? 'ShinobiPay is not configured on the server yet.' : 'Instant deposits are switched off right now.',
      // The deposit page renders method objects in the UI contract's
      // own shape (GHANA_PAYMENT_METHODS). The engine runs MoMo only,
      // so no card entry is offered.
      methods: ready ? [
        { id: 'MTN', method: 'mobile_money', label: 'MTN Mobile Money' },
        { id: 'TELECEL', method: 'mobile_money', label: 'Telecel Cash' },
        { id: 'AIRTELTIGO', method: 'mobile_money', label: 'AirtelTigo Money' },
      ] : [],
      methodSource: 'engine',
    });
  },

  async deposit_verify_number(c, a, res) {
    if (!c.user) return rpcError(res, 'You need to sign in.', 401);
    const amountMinor = Math.round(Number(a._amount_minor) || 0);
    const network = UI_NETWORKS[String(a._network || '').toLowerCase()] || '';
    if (!network) return send(res, 200, { ok: false, error: 'Select a mobile money network.', retryAfter: 0, quote: null });
    const digits = String(c.user.phone || '').replace(/[\s+]/g, '');
    const intl = digits.startsWith('233') ? digits : digits.startsWith('0') ? '233' + digits.slice(1) : digits;
    let raw;
    try {
      const out = await shinobiFetch('/verify-number', {
        method: 'POST',
        body: { phone: intl, network, amount_minor: amountMinor, currency: 'GHS' },
      });
      raw = out.data || {};
      if (out.status >= 400) return send(res, 200, { ok: false, error: (raw.error && raw.error.message) || 'Number verification is unavailable. Please retry later.', retryAfter: 0, quote: null });
    } catch (e) {
      return send(res, 200, { ok: false, error: 'Number verification is unavailable. Please retry later.', retryAfter: 0, quote: null });
    }
    if (raw.verified === false) {
      return send(res, 200, {
        ok: false,
        error: raw.reason === 'no_account'
          ? 'This number has no live MoMo account on this network. Check the number and network.'
          : 'This number could not be verified. Check the number and network.',
        retryAfter: 0, quote: null,
      });
    }
    // Same acceptance rule the UI's own contract used: verified +
    // can_prompt + an account name + provider amounts that add up.
    const amt = raw.amount || {};
    const feeMinor = Number(amt.customer_fee_minor);
    const totalMinor = Number(amt.total_minor);
    if (raw.verified !== true || raw.can_prompt !== true || !String(raw.account_name || '').trim()
      || amt.currency !== 'GHS' || Number(amt.requested_minor) !== amountMinor
      || !Number.isSafeInteger(feeMinor) || feeMinor < 0 || totalMinor !== amountMinor + feeMinor) {
      return send(res, 200, { ok: false, error: 'Number verification is unavailable. Please retry later.', retryAfter: 0, quote: null });
    }
    const quote = {
      accountName: String(raw.account_name).trim(),
      requestedMinor: amountMinor,
      feeMinor,
      totalMinor,
      currency: 'GHS',
    };
    confirmations.set(confirmationKey(c.user.id, intl, network, amountMinor), Date.now() + 5 * 60000);
    return send(res, 200, { ok: true, quote, error: '', retryAfter: 0 });
  },

  async deposit_create(c, a, res) {
    if (!c.user) return rpcError(res, 'You need to sign in.', 401);
    if (String(a._method || 'mobile_money') !== 'mobile_money') {
      return rpcError(res, 'Card deposits are not available yet. Use Mobile Money.');
    }
    const amountMinor = Math.round(Number(a._amount_minor) || 0);
    const network = UI_NETWORKS[String(a._network || '').toLowerCase()] || '';
    const digits = String(c.user.phone || '').replace(/[\s+]/g, '');
    const intl = digits.startsWith('233') ? digits : digits.startsWith('0') ? '233' + digits.slice(1) : digits;
    const key = confirmationKey(c.user.id, intl, network, amountMinor);
    const expires = confirmations.get(key);
    if (!expires || expires < Date.now()) {
      return rpcError(res, 'Verify your number first, then confirm the exact total before paying.');
    }
    confirmations.delete(key); // one confirmation, one prompt
    const out = await invoke(depositMomoHandler, {
      user: c.user,
      body: { amount_ghs: amountMinor / 100, phone: intl, network },
    });
    if (!out.json || out.status >= 400) return rpcError(res, engineMessage(out, 'The payment could not be started.'));
    const reference = out.json.reference;
    const attempts = await sql('select intent_id from payment_attempts where reference = $1', [reference]);
    return send(res, 200, {
      id: attempts.length ? attempts[0].intent_id : null,
      status: uiIntentStatus(out.json.status),
      reference: 'stakeking-' + String(a._attempt_id || ''),
      retryAt: 0,
      reason: '',
      action: uiAction(out.json.next_action),
    });
  },

  async _attemptByIntent(c, intentId) {
    const rows = await sql('select * from payment_attempts where intent_id = $1 order by created_at desc limit 1', [String(intentId || '')]);
    if (!rows.length) return null;
    if (!c.service && !isAdmin(c) && rows[0].user_id !== c.user.id) return null;
    return rows[0];
  },
  async _credited(reference, intentId) {
    const rows = await sql(
      "select id from wallet_transactions where kind = 'deposit' and status = 'completed' and external_ref in ($1, $2) limit 1",
      [reference, intentId]
    );
    return rows.length > 0;
  },
  async deposit_status(c, a, res) {
    if (!c.user && !c.service) return rpcError(res, 'You need to sign in.', 401);
    const attempt = await RPC._attemptByIntent(c, a._id);
    if (!attempt) return rpcError(res, 'Payment not found.', 404);
    const out = await invoke(depositStatusHandler, { user: c.user || { id: attempt.user_id, role: 'player' }, body: { reference: attempt.reference } });
    const status = out.json && out.json.status ? out.json.status : attempt.status;
    const credited = await RPC._credited(attempt.reference, attempt.intent_id);
    return send(res, 200, {
      status: uiIntentStatus(status),
      credited,
      webhookVerified: credited,
      action: uiAction({ type: uiIntentStatus(status) === 'requires_action' ? 'await_prompt' : 'none' }),
    });
  },
  async deposit_otp(c, a, res) {
    if (!c.user) return rpcError(res, 'You need to sign in.', 401);
    const attempt = await RPC._attemptByIntent(c, a._id);
    if (!attempt) return rpcError(res, 'Payment not found.', 404);
    const out = await invoke(depositOtpHandler, { user: c.user, body: { reference: attempt.reference, otp: String(a._otp || '') } });
    if (!out.json || out.status >= 400) {
      const code = (out.json && out.json.error) || '';
      if (String(code).includes('otp')) {
        return send(res, 200, {
          status: uiIntentStatus(attempt.status), credited: false, webhookVerified: false,
          action: uiAction({ type: 'submit_otp' }),
          otpError: 'That code was rejected. Check it and try again.',
        });
      }
      return rpcError(res, engineMessage(out, 'The code could not be submitted.'));
    }
    return send(res, 200, {
      status: uiIntentStatus(out.json.status),
      credited: false,
      webhookVerified: false,
      action: uiAction(out.json.next_action),
      otpError: '',
    });
  },
};

module.exports = guard(async (req, res) => {
  const path = String((req.url || '').split('?')[0]);
  const name = decodeURIComponent(path.replace('/rest/v1/rpc/', ''));
  const fn = RPC[name];
  if (!fn) return rpcError(res, 'Unknown function: ' + name, 404);
  const body = await readBody(req);
  const c = await caller(req);
  const out = await fn(c, body || {}, res);
  return out;
});
