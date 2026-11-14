-- Workout: run once in Supabase → SQL Editor (same project as Plan and Pocket; these tables don't touch theirs).

-- Each workout: planned or done. Exercises are a list like
-- [{"name":"Bench press","muscle":"chest","type":"strength","sets":[{"w":135,"r":8,"done":true}],"min":null,"done":false}]
create table if not exists public.wk_sessions (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  day        date        not null,
  title      text        not null check (char_length(title) between 1 and 120),
  kind       text        not null default 'strength' check (kind in ('strength', 'cardio', 'stretch')),
  status     text        not null default 'planned' check (status in ('planned', 'done', 'skipped')),
  exercises  jsonb       not null default '[]'::jsonb,
  notes      text        not null default '' check (char_length(notes) <= 2000),
  source     text        not null default 'app' check (source in ('app', 'claude')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wk_sessions_user_day on public.wk_sessions (user_id, day);

-- Goal and weekly targets (Claude reads these before suggesting anything).
create table if not exists public.wk_profile (
  user_id    uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  timezone   text        not null default 'America/Los_Angeles',
  goal       text        not null default 'general fitness' check (char_length(goal) <= 200),
  targets    jsonb       not null default '{"strength":4,"cardio":2,"stretch":3}'::jsonb,
  notes      text        not null default '' check (char_length(notes) <= 2000),
  updated_at timestamptz not null default now()
);

-- Every change Claude makes, with before and after, so the app can undo it.
create table if not exists public.wk_changes (
  id         bigint      generated always as identity primary key,
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  session_id uuid        not null,
  action     text        not null check (action in ('add', 'update', 'delete')),
  before     jsonb,
  after      jsonb,
  summary    text        not null default '',
  undone     boolean     not null default false,
  created_at timestamptz not null default now()
);
create index if not exists wk_changes_user_time on public.wk_changes (user_id, created_at desc);

-- The connector link for the Claude app. Only a SHA-256 hash of the secret is stored.
create table if not exists public.wk_connector (
  user_id    uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  token_hash text        not null unique,
  created_at timestamptz not null default now()
);

create or replace function public.wk_touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists wk_sessions_touch on public.wk_sessions;
create trigger wk_sessions_touch before update on public.wk_sessions for each row execute function public.wk_touch();
drop trigger if exists wk_profile_touch on public.wk_profile;
create trigger wk_profile_touch before update on public.wk_profile for each row execute function public.wk_touch();

alter table public.wk_sessions  enable row level security;
alter table public.wk_profile   enable row level security;
alter table public.wk_changes   enable row level security;
alter table public.wk_connector enable row level security;

drop policy if exists "Own rows only" on public.wk_sessions;
create policy "Own rows only" on public.wk_sessions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Own rows only" on public.wk_profile;
create policy "Own rows only" on public.wk_profile for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Own rows only" on public.wk_changes;
create policy "Own rows only" on public.wk_changes for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Own rows only" on public.wk_connector;
create policy "Own rows only" on public.wk_connector for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

do $$ begin
  begin alter publication supabase_realtime add table public.wk_sessions; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.wk_changes;  exception when duplicate_object then null; end;
end $$;

-- ===== Rest alerts on the lock screen (added Nov 2026) =====
-- Each device that turned on notifications (a Web Push subscription).
create table if not exists public.wk_push (
  endpoint   text        primary key,
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  sub        jsonb       not null,
  created_at timestamptz not null default now()
);
-- The rest timer that's running now. The push function only sends if the token still matches (skipping the rest deletes it).
create table if not exists public.wk_rest (
  user_id    uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  token      uuid        not null,
  created_at timestamptz not null default now()
);
alter table public.wk_push enable row level security;
alter table public.wk_rest enable row level security;
drop policy if exists "Own rows only" on public.wk_push;
create policy "Own rows only" on public.wk_push for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Own rows only" on public.wk_rest;
create policy "Own rows only" on public.wk_rest for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ===== Morning recovery check (added Nov 2026) =====
-- Your normal resting heart rate and HRV, and each morning's reading.
alter table public.wk_profile add column if not exists rhr_base integer check (rhr_base between 25 and 120);
alter table public.wk_profile add column if not exists hrv_base integer check (hrv_base between 5 and 300);
create table if not exists public.wk_daily (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  day        date        not null,
  rhr        integer     check (rhr between 25 and 150),
  hrv        integer     check (hrv between 5 and 300),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.wk_daily enable row level security;
drop policy if exists "Own rows only" on public.wk_daily;
create policy "Own rows only" on public.wk_daily for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
do $$ begin
  begin alter publication supabase_realtime add table public.wk_daily; exception when duplicate_object then null; end;
end $$;
