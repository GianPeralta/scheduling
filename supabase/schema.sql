-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run

create table if not exists public.appointments (
    id               uuid primary key default gen_random_uuid(),
    student_name     text        not null check (char_length(student_name) between 2 and 100),
    reason           text        not null check (char_length(reason) between 5 and 1000),
    appointment_date date        not null,
    start_hour       smallint    not null check (start_hour between 0 and 23),
    created_at       timestamptz not null default now(),

    -- A time slot can only be booked once (prevents double booking)
    constraint appointments_slot_unique unique (appointment_date, start_hour)
);

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

