-- 2026-11-09: the StakeKing catalog DB was applied without
-- matches.odds_full (the full market book jsonb the engine reads for
-- has_full and the single-match view); /api/matches 500'd on the
-- missing column until it was added live. ensureMatchColumns now
-- self-heals it too; this file is the record.
alter table matches add column if not exists odds_full jsonb;
