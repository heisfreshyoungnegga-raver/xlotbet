-- StakeKing adapter RPC support (2026-11-09): settled-ticket hiding
-- (the UI's swipe-delete; engine history stays intact) and the
-- payment credential presence store the settings page reads.
create table if not exists adapter_hidden_bets (
  bet_id uuid primary key,
  user_id uuid not null,
  hidden_at timestamp with time zone not null default now()
);
create table if not exists payment_credentials (
  provider text primary key,
  api_key_ciphertext text,
  webhook_secret_ciphertext text,
  updated_at timestamp with time zone not null default now()
);
create unique index if not exists adapter_shinobipay_deposits_reference_ux
  on adapter_shinobipay_deposits (reference);
