-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run
-- (Safe to run again: it also upgrades a table created by an earlier version.)

create table if not exists public.appointments (
    id                uuid primary key default gen_random_uuid(),
    student_name      text        not null check (char_length(student_name) between 2 and 100),
    reason            text        not null check (char_length(reason) between 5 and 1000),
    appointment_date  date        not null,
    start_hour        smallint    not null,
    start_minute      smallint    not null check (start_minute between 0 and 1439),
    duration_minutes  smallint    not null default 80 check (duration_minutes in (6, 80)),
    consultation_type text        not null default 'system' check (consultation_type in ('system', 'other')),
    created_at        timestamptz not null default now(),

    -- A specific start minute on a date can only be booked once
    constraint appointments_date_start_minute_unique unique (appointment_date, start_minute)
);

-- Group bookings:
--   team_name : null for individual bookings, the team's name for group bookings
--   members   : every student attending (for individuals it's just their own name).
--               student_name holds the first member (the person who booked).
alter table public.appointments add column if not exists team_name text
    check (team_name is null or char_length(team_name) between 2 and 100);
alter table public.appointments add column if not exists members text[] not null default '{}'
    check (cardinality(members) <= 10);

-- Upgrade path for tables created with the older hourly schema:
alter table public.appointments add column if not exists start_minute smallint;
alter table public.appointments add column if not exists duration_minutes smallint not null default 80;
alter table public.appointments add column if not exists consultation_type text not null default 'system';

update public.appointments
   set start_minute = start_hour * 60
 where start_minute is null;

alter table public.appointments alter column start_minute set not null;
alter table public.appointments drop constraint if exists appointments_slot_unique;
alter table public.appointments drop constraint if exists appointments_start_hour_check;

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'appointments_date_start_minute_unique'
    ) then
        alter table public.appointments
            add constraint appointments_date_start_minute_unique unique (appointment_date, start_minute);
    end if;
end $$;

create index if not exists appointments_date_idx on public.appointments (appointment_date);

-- Row Level Security: nobody can read/write the table directly from a browser.
-- The Express server talks to Supabase using SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS.
alter table public.appointments enable row level security;


-- ---------------------------------------------------------------------------
-- OPTIONAL: only needed if you keep using SUPABASE_ANON_KEY on the server
-- instead of SUPABASE_SERVICE_ROLE_KEY. Uncomment and run.
-- (The anon key stays on the server, but anyone who obtains it could then
--  read/delete appointments, so the service role key is recommended.)
-- ---------------------------------------------------------------------------
-- create policy "anon can read appointments"   on public.appointments for select to anon using (true);
-- create policy "anon can insert appointments" on public.appointments for insert to anon with check (true);
-- create policy "anon can delete appointments" on public.appointments for delete to anon using (true);
