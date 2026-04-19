# Supabase Schema Setup

Execute this SQL in your Supabase SQL Editor:

```sql
create table profiles (
  id text primary key, -- telegram_id
  username text,
  first_name text,
  balance float8 default 0,
  active_multiplier float8 default 0.1,
  airdrop_rank int8 default 0,
  energy int8 default 1000,
  game_tickets int8 default 5,
  extra_combat_matches int8 default 0,
  combat_matches_today int8 default 0,
  last_claim_at timestamptz default now(),
  created_at timestamptz default now(),
  code_task_states jsonb default '{}'::jsonb,
  daily_quest_states jsonb default '{}'::jsonb
);

-- Enable RLS
alter table profiles enable row level security;

-- Simple public read policy (or restricted as needed)
create policy "Public access" on profiles for select using (true);
create policy "Service role access" on profiles for all using (true);
```
