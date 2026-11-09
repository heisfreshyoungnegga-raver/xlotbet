-- StakeKing fresh-database completion (2026-11-09): two tables the
-- live Oddaroa database carries but that never landed in the .sql
-- files (they were applied straight to the live DB when the features
-- shipped). Definitions read back from the live Oddaroa schema.
create table if not exists booking_codes (
  code text primary key,
  selections jsonb not null,
  created_at timestamp with time zone not null default now(),
  user_id uuid,
  dedupe text
);
create unique index if not exists booking_codes_dedupe_ux
  on booking_codes (dedupe) where dedupe is not null;

create table if not exists commission_payout_requests (
  id uuid primary key default gen_random_uuid(),
  earner_id uuid not null,
  amount_ghs numeric not null,
  status text not null default 'pending',
  created_at timestamp with time zone not null default now(),
  decided_at timestamp with time zone,
  decided_by uuid
);
create unique index if not exists cpr_open_idx
  on commission_payout_requests (earner_id) where status = 'pending';
