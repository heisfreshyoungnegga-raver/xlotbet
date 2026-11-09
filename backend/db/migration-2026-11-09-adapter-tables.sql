-- StakeKing adapter-native tables (2026-11-09): the UI's own content
-- and bookkeeping tables, carried in the StakeKing database and
-- served by the adapter's PostgREST surface. Money never lives here.
create table if not exists site_content (
  key text primary key,
  value text not null default ''
);
create table if not exists promotions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  active boolean not null default true,
  created_at timestamp with time zone not null default now()
);
create table if not exists sports_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  icon text not null default '',
  sort_order int not null default 0,
  active boolean not null default true
);
create table if not exists referral_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  bonus numeric not null default 0,
  uses int not null default 0,
  active boolean not null default true,
  created_at timestamp with time zone not null default now()
);
create table if not exists odds_sync_state (
  sport_key text primary key,
  requests_remaining int,
  synced_at timestamp with time zone not null default now()
);
create table if not exists user_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  kind text not null default 'idea',
  message text not null,
  rating int,
  created_at timestamp with time zone not null default now()
);
create table if not exists adapter_shinobipay_deposits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  intent_id text,
  reference text not null,
  amount_minor int not null,
  status text not null default 'pending',
  mode text not null default 'live',
  network text,
  payment_method text not null default 'mobile_money',
  last_sequence int not null default 0,
  webhook_verified_at timestamp with time zone,
  credited_at timestamp with time zone,
  created_at timestamp with time zone not null default now()
);
insert into sports_categories (name, slug, icon, sort_order) values
  ('Football', 'football', '⚽', 1),
  ('Basketball', 'basketball', '🏀', 2),
  ('Tennis', 'tennis', '🎾', 3),
  ('Volleyball', 'volleyball', '🏐', 4),
  ('Ice Hockey', 'ice-hockey', '🏒', 5),
  ('Table Tennis', 'table-tennis', '🏓', 6),
  ('Esports', 'esports', '🎮', 7)
on conflict (slug) do nothing;
insert into site_content (key, value) values
  ('shinobipay_mode', 'live'),
  ('shinobipay_enabled_requested', 'true')
on conflict (key) do nothing;
