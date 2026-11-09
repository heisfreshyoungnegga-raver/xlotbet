-- Oddaroa backend schema (Postgres 15+, works on Neon and Supabase)
-- Money is stored in GHS with 2 decimals. The wallet ledger is the source
-- of truth; users.balance_ghs is a cache the API updates in the same
-- transaction as every ledger insert.

create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  phone text,
  email text,
  password_hash text not null,
  display_name text,
  role text not null default 'player' check (role in ('player', 'admin', 'super_admin')),
  status text not null default 'active' check (status in ('active', 'blocked')),
  balance_ghs numeric(12, 2) not null default 0,
  created_at timestamptz not null default now()
);
-- Login identifiers: phone OR email, each unique when present.
-- Admin-tier accounts may be created with an email and no phone.
create unique index if not exists users_phone_unique on users (phone) where phone is not null;
create unique index if not exists users_email_unique on users (lower(email)) where email is not null;

create table if not exists operator_settings (
  key text primary key,
  value text not null
);
insert into operator_settings (key, value) values
  ('manual_deposit_network', 'MTN MoMo'),
  ('manual_deposit_number', '0530868738'),
  ('manual_deposit_name', 'SULEMANA ALHASSAN'),
  ('withdraw_deposits_required', '6')
on conflict (key) do nothing;

create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  league text not null,
  home_team text not null,
  away_team text not null,
  starts_at timestamptz not null,
  status text not null default 'upcoming' check (status in ('upcoming', 'live', 'finished')),
  minute int,
  score_home int not null default 0,
  score_away int not null default 0,
  odds jsonb not null default '{}'::jsonb,
  external_ref text,
  home_logo text,
  away_logo text,
  created_at timestamptz not null default now()
);
create unique index if not exists matches_external_ref_idx
  on matches (external_ref) where external_ref is not null;
create index if not exists matches_starts_idx on matches (starts_at);
create index if not exists matches_status_idx on matches (status);

create table if not exists bets (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  user_id uuid not null references users (id),
  stake_ghs numeric(12, 2) not null check (stake_ghs > 0),
  total_odds numeric(10, 3) not null,
  potential_ghs numeric(12, 2) not null,
  status text not null default 'open' check (status in ('open', 'won', 'lost', 'cashed_out', 'void')),
  placed_at timestamptz not null default now(),
  settled_at timestamptz
);
create index if not exists bets_user_idx on bets (user_id, placed_at desc);
create index if not exists bets_code_idx on bets (code);

create table if not exists bet_selections (
  id uuid primary key default gen_random_uuid(),
  bet_id uuid not null references bets (id) on delete cascade,
  match_id uuid not null references matches (id),
  market text not null,
  pick text not null,
  odds numeric(10, 3) not null,
  result text not null default 'pending' check (result in ('pending', 'won', 'lost', 'void'))
);
create index if not exists selections_bet_idx on bet_selections (bet_id);

create table if not exists wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  kind text not null check (kind in ('deposit', 'withdrawal', 'bet_stake', 'bet_win', 'cashout', 'adjustment')),
  method text,
  amount_ghs numeric(12, 2) not null,
  status text not null default 'pending' check (status in ('pending', 'completed', 'rejected')),
  external_ref text,
  note text,
  confirmed_by uuid references users (id),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  proof_image text
);
-- Manual-deposit transaction screenshots (added 2026-11-03).
alter table wallet_transactions add column if not exists proof_image text;
create index if not exists wallet_user_idx on wallet_transactions (user_id, created_at desc);
create index if not exists wallet_status_idx on wallet_transactions (status, kind);

-- ShinobiPay direct-push deposit attempts. One row per try; the wallet
-- is credited (a completed wallet_transactions deposit row) only by the
-- webhook handler after signature verification + re-verification.
create table if not exists payment_attempts (
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
);
create index if not exists attempts_user_idx on payment_attempts (user_id, created_at desc);

-- Webhook idempotency: one row per delivered event id.
create table if not exists webhook_events (
  event_id text primary key,
  received_at timestamptz not null default now()
);

create table if not exists support_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users (id),
  subject text not null,
  body text not null,
  status text not null default 'open' check (status in ('open', 'answered', 'closed')),
  created_at timestamptz not null default now()
);

-- Completed deposits are the ones that count toward the withdrawal rule.
create or replace function completed_deposit_count(p_user uuid)
returns int language sql stable as $$
  select count(*)::int from wallet_transactions
  where user_id = p_user and kind = 'deposit' and status = 'completed'
$$;

-- Withdrawal guard: a withdrawal row cannot be created until the user
-- reaches the required number of completed deposits (operator setting,
-- default 6). This enforces Prince's rule in the database itself, so no
-- API bug or admin shortcut can bypass it silently.
create or replace function enforce_withdrawal_rule()
returns trigger language plpgsql as $$
declare
  required int;
  actor_role text;
begin
  if new.kind = 'withdrawal' then
    -- Admin-tier accounts withdraw their own earnings (commission
    -- payouts land in their wallet balance): the deposit ladder is a
    -- player rule (Prince, 2026-11-05).
    select role into actor_role from users where id = new.user_id;
    if actor_role in ('admin', 'super_admin') then
      return new;
    end if;
    select coalesce((select value::int from operator_settings
                     where key = 'withdraw_deposits_required'), 6)
      into required;
    if completed_deposit_count(new.user_id) < required then
      raise exception 'withdrawal locked: % of % required deposits completed',
        completed_deposit_count(new.user_id), required;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists wallet_withdrawal_guard on wallet_transactions;
create trigger wallet_withdrawal_guard
  before insert on wallet_transactions
  for each row execute function enforce_withdrawal_rule();

-- Admin platform: invite attribution, one-time invite links (admin and
-- super-admin kinds), the commission ledger, featured-match goal
-- schedules, and the super-admin control settings. The API also creates
-- these lazily (ensureAdminTables), so this section is the record.
alter table users add column if not exists invite_code text;
create unique index if not exists users_invite_code_idx on users (invite_code) where invite_code is not null;
alter table users add column if not exists invited_by uuid references users (id);
-- users.status also allows 'pending' (invited admins awaiting verification).

create table if not exists invites (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  kind text not null default 'admin',
  created_by uuid references users (id),
  expires_at timestamptz not null,
  used_by uuid references users (id),
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists commissions (
  id uuid primary key default gen_random_uuid(),
  earner_id uuid not null references users (id),
  source_user_id uuid not null references users (id),
  source_txn_id uuid references wallet_transactions (id),
  basis_ghs numeric(12, 2) not null,
  pct numeric(6, 2) not null,
  amount_ghs numeric(12, 2) not null,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists commissions_source_idx on commissions (source_txn_id) where source_txn_id is not null;

alter table matches add column if not exists goal_events jsonb not null default '[]'::jsonb;

insert into operator_settings (key, value) values
  ('gateway_enabled', '1'),
  ('payouts_frozen', '0'),
  ('admin_commission_pct', '0'),
  ('user_cashback_pct', '0')
on conflict (key) do nothing;

-- What the admin payout queue screen reads.
create or replace view admin_pending_queue as
  select wt.id, wt.user_id, u.phone, wt.kind, wt.method, wt.amount_ghs,
         wt.external_ref, wt.created_at, (wt.proof_image is not null) as has_proof,
         wt.payout_meta
  from wallet_transactions wt
  join users u on u.id = wt.user_id
  where wt.status = 'pending' and wt.kind in ('deposit', 'withdrawal')
  order by wt.created_at asc;
