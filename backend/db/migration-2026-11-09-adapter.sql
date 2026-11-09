-- StakeKing adapter support table (2026-11-09): GoTrue-style user
-- metadata the frontend keeps on the auth user (date of birth,
-- country, referral code used at signup). The engine's users table
-- stays untouched; this is adapter-side storage only.
create table if not exists adapter_user_meta (
  user_id uuid primary key,
  meta jsonb not null default '{}'::jsonb
);
