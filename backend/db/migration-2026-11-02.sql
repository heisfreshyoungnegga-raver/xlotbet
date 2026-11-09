-- Oddaroa migration 2026-11-02: super-admin tier + ESPN match source.
-- Run once in the Neon SQL editor (safe to re-run: guards everywhere).

-- 1) Roles: player | admin | super_admin
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check
  check (role in ('player', 'admin', 'super_admin'));

-- 2) ESPN linkage + team logos on matches
alter table matches add column if not exists external_ref text;
alter table matches add column if not exists home_logo text;
alter table matches add column if not exists away_logo text;
create unique index if not exists matches_external_ref_idx
  on matches (external_ref) where external_ref is not null;
