-- Oddaroa schema state as of 2026-11-08 (Prince: "make it permanent").
-- Every statement is idempotent; the live database already carries all
-- of this. The API's lazy ensure* helpers verify the same state at
-- runtime — they now check pg_get_constraintdef before touching the
-- status constraint, and every cached ensure promise resets itself on
-- failure so one bad run can never poison a server instance (the
-- /api/match 500 outage of 2026-11-08).

-- Match status vocabulary includes postponed (created-games lifecycle).
alter table matches drop constraint if exists matches_status_check;
alter table matches add constraint matches_status_check
  check (status in ('upcoming', 'live', 'finished', 'postponed'));

-- Created-match stoppage minutes, betting lock, odds queue fairness.
alter table matches add column if not exists ht_stoppage int not null default 0;
alter table matches add column if not exists ft_stoppage int not null default 0;
alter table matches add column if not exists betting_locked boolean not null default false;
alter table matches add column if not exists odds_attempt_at timestamptz;
alter table matches add column if not exists goal_events jsonb not null default '[]'::jsonb;

-- Support chat (two-way): who wrote, which admin, seen stamp.
alter table support_messages add column if not exists sender text not null default 'user';
alter table support_messages add column if not exists admin_id uuid;
alter table support_messages add column if not exists read_at timestamptz;
create index if not exists support_messages_user_created_idx
  on support_messages (user_id, created_at);

-- Bets: exact paid-out amount for cashouts and settlements.
alter table bets add column if not exists payout_ghs numeric;
