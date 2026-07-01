create extension if not exists pgcrypto;

create table if not exists creators (
  id uuid primary key default gen_random_uuid(),
  x_user_id text unique,
  x_handle text,
  x_display_name text,
  x_verified boolean not null default false,
  x_access_token text,
  x_refresh_token text,
  wallet_address text unique,
  wallet_provider text,
  wallet_verified_at timestamptz,
  holds_campaign_token boolean not null default false,
  trust_score integer not null default 50,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references creators(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists wallet_auth_challenges (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  nonce text not null unique,
  message text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid references creators(id) on delete set null,
  owner_wallet text not null,
  owner_token_hash text,
  name text not null,
  tag text not null,
  token_mint text not null,
  launch_venue text not null default 'Pump.fun',
  dex_pool_address text,
  reward_pool_raw numeric(38,0) not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'live',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  creator_id uuid references creators(id) on delete set null,
  platform text not null default 'x',
  platform_post_id text not null,
  author_id text,
  author_handle text,
  post_url text,
  text text not null,
  text_hash text not null,
  contains_token_mint boolean not null default false,
  contains_launch_link boolean not null default false,
  views integer not null default 0,
  likes integer not null default 0,
  reposts integer not null default 0,
  replies integer not null default 0,
  quotes integer not null default 0,
  score integer not null default 0,
  risk_level text not null default 'low',
  risk_reasons jsonb not null default '[]'::jsonb,
  captured_at timestamptz not null default now(),
  unique(campaign_id, platform, platform_post_id)
);

create table if not exists payouts (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  creator_id uuid references creators(id) on delete set null,
  wallet_address text,
  author_handle text not null,
  rank integer not null,
  score integer not null,
  amount_raw numeric(38,0) not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(campaign_id, author_handle)
);

create index if not exists campaigns_creator_id_idx on campaigns(creator_id);
create index if not exists posts_campaign_score_idx on posts(campaign_id, score desc);
create index if not exists payouts_campaign_rank_idx on payouts(campaign_id, rank asc);
create index if not exists sessions_token_hash_idx on sessions(token_hash);

