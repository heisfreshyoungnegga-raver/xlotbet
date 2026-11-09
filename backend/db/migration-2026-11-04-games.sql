-- Casino games: one rounds table for every game (2026-11-04).
-- Money moves only through wallet_transactions; users.balance_ghs is
-- updated in the same statement as the ledger row, like bets.
create table if not exists game_rounds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  game text not null check (game in ('aviator', 'plinko', 'dice', 'coinflip', 'shootout', 'penalty')),
  stake_ghs numeric(12, 2) not null check (stake_ghs > 0),
  payout_ghs numeric(12, 2) not null default 0,
  status text not null default 'open' check (status in ('open', 'won', 'lost', 'cashed')),
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index if not exists game_rounds_user_idx on game_rounds (user_id, created_at desc);
create index if not exists game_rounds_game_idx on game_rounds (game, created_at desc);

-- Game ledger rows need their own wallet kinds.
alter table wallet_transactions drop constraint if exists wallet_transactions_kind_check;
alter table wallet_transactions add constraint wallet_transactions_kind_check
  check (kind in ('deposit', 'withdrawal', 'bet_stake', 'bet_win', 'cashout', 'adjustment', 'game_stake', 'game_win'));
