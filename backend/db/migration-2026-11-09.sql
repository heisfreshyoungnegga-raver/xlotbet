-- Oddaroa schema state additions, 2026-11-09 (push 105).
-- Stake-only bonus bucket on users + per-earner commission uniqueness
-- (a deposit now books TWO commission rows: referring admin + super).
alter table users add column if not exists bonus_ghs numeric(12,2) not null default 0;
drop index if exists commissions_source_idx;
create unique index if not exists commissions_source_earner_idx
  on commissions (earner_id, source_txn_id) where source_txn_id is not null;
