# Hardened Supabase Schema Setup

To close the "loophole" and prevent cheating, execute this SQL:

```sql
-- 1. Create/Re-Create the table
-- (Note: This will delete existing data if you use DROP)
drop table if exists profiles;
create table profiles (
  id text primary key, -- telegram_id
  username text,
  first_name text,
  photo_url text,
  balance float8 default 0,
  multiplier float8 default 0.1,
  airdropRank int8 default 0,
  energy int8 default 1000,
  daily_quest_states jsonb default '{}'::jsonb,
  last_claim_at timestamptz default now(),
  updated_at timestamptz default now(),
  created_at timestamptz default now(),
  referred_by text
);

-- 2. ENABLE RLS (Security Hardened)
alter table profiles enable row level security;

-- 3. Set up Policies
-- A. Public/Anon can only SEE data (for leaderboard), but NOT change it.
create policy "Players are viewable by everyone" on profiles
  for select using (true);

-- B. System Role Bypasses RLS (The server uses this)
-- You don't need a specific policy for Service Role, it works by default.
```

### 🚨 IMPORTANT SECURITY STEP:
To allow the server to work with RLS enabled:
1. Go to **Supabase Dashboard** -> **Project Settings** -> **API**.
2. Find the key labeled **`service_role` `secret`** (the one that says "bypasses RLS").
3. Add a new secret to your hosting environment (AI Studio/Render/Vercel) named **`SUPABASE_SERVICE_ROLE_KEY`** and paste that secret key there.
