-- LeadReach: per-user data tables + row-level security.
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.

create table if not exists profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'starter',
  created_at timestamptz not null default now()
);

create table if not exists stats (
  user_id uuid primary key references auth.users(id) on delete cascade,
  domains_crawled integer not null default 0,
  leads_qualified integer not null default 0,
  leads_pushed integer not null default 0,
  runs_completed integer not null default 0,
  total_run_ms bigint not null default 0
);

create table if not exists run_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  at timestamptz not null default now(),
  niche text,
  filters jsonb,
  domains_parsed integer,
  crawl_successful integer,
  handles_found integer,
  qualified integer,
  pushed integer,
  skipped_duplicate integer,
  push_failed integer,
  status text,
  crawl_ms bigint,
  enrich_ms bigint,
  duration_ms bigint,
  is_retry boolean not null default false
);
create index if not exists run_history_user_at_idx on run_history (user_id, at desc);

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  brand_name text,
  instagram_handle text,
  website text,
  followers integer,
  last_post_at timestamptz,
  niche text,
  status text,
  created_at timestamptz not null default now()
);
create index if not exists leads_user_created_idx on leads (user_id, created_at desc);

create table if not exists seen_domains (
  user_id uuid not null references auth.users(id) on delete cascade,
  domain text not null,
  crawled_at timestamptz not null default now(),
  primary key (user_id, domain)
);

-- Caches the most recent run's qualified leads (post-Apify-enrichment, the
-- expensive-to-produce output) so a failed/misconfigured Airtable push can
-- be retried without re-crawling or re-spending on Apify. One row per user.
create table if not exists last_run_cache (
  user_id uuid primary key references auth.users(id) on delete cascade,
  saved_at timestamptz not null default now(),
  niche text,
  qualified_leads jsonb not null default '[]'
);

-- Row-level security: a user can only ever see their own rows. The backend
-- server uses the service-role key (which bypasses RLS) for normal writes;
-- this is defense-in-depth for any future path that queries Supabase
-- directly from the browser.
alter table profiles enable row level security;
alter table stats enable row level security;
alter table run_history enable row level security;
alter table leads enable row level security;
alter table seen_domains enable row level security;
alter table last_run_cache enable row level security;

create policy "own profile" on profiles for all using (auth.uid() = user_id);
create policy "own stats" on stats for all using (auth.uid() = user_id);
create policy "own run_history" on run_history for all using (auth.uid() = user_id);
create policy "own leads" on leads for all using (auth.uid() = user_id);
create policy "own seen_domains" on seen_domains for all using (auth.uid() = user_id);
create policy "own last_run_cache" on last_run_cache for all using (auth.uid() = user_id);
