-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run
-- (Safe to run again: it also upgrades a table created by an earlier version.)

create table if not exists public.appointments (
    id                uuid primary key default gen_random_uuid(),
    student_name      text        not null check (char_length(student_name) between 2 and 100),
    reason            text        not null check (char_length(reason) between 5 and 1000),
    appointment_date  date        not null,
    start_hour        smallint    not null,
    start_minute      smallint    not null check (start_minute between 0 and 1439),
    duration_minutes  smallint    not null default 15 check (duration_minutes in (0, 5, 6, 15, 80)),
    consultation_type   text        not null default 'system'
                                    check (consultation_type in ('system', 'dropoff', 'retrieval', 'letter', 'other')),
    status              text        not null default 'scheduled'
                                    check (status in ('scheduled', 'cancelled')),
    cancellation_reason text        check (cancellation_reason is null or char_length(cancellation_reason) between 2 and 500),
    cancelled_at        timestamptz,
    notified_at         timestamptz,
    created_at          timestamptz not null default now()
);

-- Group bookings:
--   team_name : null for individual bookings, the team's name for group bookings
--   members   : every student attending (for individuals it's just their own name).
--               student_name holds the first member (the person who booked).
alter table public.appointments add column if not exists team_name text
    check (team_name is null or char_length(team_name) between 2 and 200);
alter table public.appointments drop constraint if exists appointments_team_name_check;
alter table public.appointments add constraint appointments_team_name_check
    check (team_name is null or char_length(team_name) between 2 and 200);
alter table public.appointments add column if not exists members text[] not null default '{}'
    check (cardinality(members) <= 3);
alter table public.appointments drop constraint if exists appointments_members_check;
alter table public.appointments add constraint appointments_members_check
    check (cardinality(members) <= 3) not valid;

-- Upgrade path for tables created with the older hourly schema:
alter table public.appointments add column if not exists start_minute smallint;
alter table public.appointments add column if not exists duration_minutes smallint not null default 80;
alter table public.appointments add column if not exists consultation_type text not null default 'system';

update public.appointments
   set start_minute = start_hour * 60
 where start_minute is null;

alter table public.appointments alter column start_minute set not null;
alter table public.appointments add column if not exists status text not null default 'scheduled';
alter table public.appointments drop constraint if exists appointments_status_check;
alter table public.appointments add constraint appointments_status_check
    check (status in ('scheduled', 'cancelled'));
alter table public.appointments add column if not exists cancellation_reason text;
alter table public.appointments drop constraint if exists appointments_cancellation_reason_check;
alter table public.appointments add constraint appointments_cancellation_reason_check
    check (cancellation_reason is null or char_length(cancellation_reason) between 2 and 500);
alter table public.appointments add column if not exists cancelled_at timestamptz;
alter table public.appointments add column if not exists notified_at timestamptz;
alter table public.appointments drop constraint if exists appointments_slot_unique;
alter table public.appointments drop constraint if exists appointments_start_hour_check;
alter table public.appointments drop constraint if exists appointments_duration_minutes_check;
alter table public.appointments add constraint appointments_duration_minutes_check
    check (duration_minutes in (0, 5, 6, 15, 80));
alter table public.appointments drop constraint if exists appointments_consultation_type_check;
alter table public.appointments add constraint appointments_consultation_type_check
    check (consultation_type in ('system', 'dropoff', 'retrieval', 'letter', 'other'));

-- Drop-off manuscripts (duration_minutes = 0) and cancelled appointments (status = 'cancelled')
-- do not lock time slots on the schedule.
alter table public.appointments drop constraint if exists appointments_date_start_minute_unique;
drop index if exists public.appointments_timed_slot_unique;
create unique index appointments_timed_slot_unique
    on public.appointments (appointment_date, start_minute)
    where duration_minutes > 0 and status <> 'cancelled';

create index if not exists appointments_date_idx on public.appointments (appointment_date);

-- Row Level Security: nobody can read/write the table directly from a browser.
-- The Express server talks to Supabase using SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS.
alter table public.appointments enable row level security;


-- ---------------------------------------------------------------------------
-- Student accounts (university email, verified with a one-time code)
-- ---------------------------------------------------------------------------
create table if not exists public.students (
    id               uuid primary key default gen_random_uuid(),
    email            text        not null unique check (email = lower(email)),
    full_name        text        not null check (char_length(full_name) between 2 and 100),
    capstone_title   text        check (capstone_title is null or char_length(capstone_title) between 2 and 200),
    instructor_role  text        check (instructor_role is null or instructor_role in ('adviser', 'panel')),
    members          text[]      not null default '{}' check (cardinality(members) <= 3),
    password_hash    text        not null,
    failed_logins    smallint    not null default 0,
    locked_until     timestamptz,
    last_login_at    timestamptz,
    created_at       timestamptz not null default now()
);

alter table public.students add column if not exists capstone_title text
    check (capstone_title is null or char_length(capstone_title) between 2 and 200);
alter table public.students add column if not exists instructor_role text
    check (instructor_role is null or instructor_role in ('adviser', 'panel'));
alter table public.students add column if not exists members text[] not null default '{}'
    check (cardinality(members) <= 3);
alter table public.students drop constraint if exists students_members_check;
alter table public.students add constraint students_members_check
    check (cardinality(members) <= 3) not valid;

-- One-time codes emailed for registration / password reset (permanent log of all attempts)
create table if not exists public.email_otps (
    id               uuid primary key default gen_random_uuid(),
    email            text        not null,
    student_name     text,
    capstone_title   text,
    instructor_role  text,
    members          text[],
    purpose          text        not null check (purpose in ('register', 'reset')),
    otp_code         text,
    code_hash        text        not null,
    status           text        not null default 'pending'
                                 check (status in ('pending', 'verified', 'expired', 'failed', 'superseded', 'send_failed')),
    payload          jsonb,                       -- pending registration details
    attempts         smallint    not null default 0,
    expires_at       timestamptz not null,
    verified_at      timestamptz,
    created_at       timestamptz not null default now()
);

-- Upgrade path if email_otps was created with an older schema:
alter table public.email_otps drop constraint if exists email_otps_pkey;
alter table public.email_otps add column if not exists id uuid default gen_random_uuid();
update public.email_otps set id = gen_random_uuid() where id is null;
alter table public.email_otps alter column id set not null;

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.email_otps'::regclass and contype = 'p'
    ) then
        alter table public.email_otps add constraint email_otps_id_pkey primary key (id);
    end if;
end $$;

alter table public.email_otps add column if not exists student_name text;
alter table public.email_otps add column if not exists capstone_title text;
alter table public.email_otps add column if not exists instructor_role text;
alter table public.email_otps add column if not exists members text[];
alter table public.email_otps add column if not exists otp_code text;
alter table public.email_otps add column if not exists status text not null default 'pending';
alter table public.email_otps add column if not exists verified_at timestamptz;
create index if not exists email_otps_email_purpose_idx on public.email_otps (email, purpose, created_at desc);

-- Link every booking to the student account that made it
alter table public.appointments add column if not exists student_id uuid
    references public.students (id) on delete set null;
alter table public.appointments add column if not exists student_email text;
alter table public.appointments add column if not exists capstone_title text;
alter table public.appointments add column if not exists instructor_role text
    check (instructor_role is null or instructor_role in ('adviser', 'panel'));
create index if not exists appointments_student_idx on public.appointments (student_id);

alter table public.students   enable row level security;
alter table public.email_otps enable row level security;


-- ---------------------------------------------------------------------------
-- OPTIONAL: only needed if you keep using SUPABASE_ANON_KEY on the server
-- instead of SUPABASE_SERVICE_ROLE_KEY. Uncomment and run.
-- (The anon key stays on the server, but anyone who obtains it could then
--  read/delete appointments, so the service role key is recommended.)
-- ---------------------------------------------------------------------------
-- create policy "anon can read appointments"   on public.appointments for select to anon using (true);
-- create policy "anon can insert appointments" on public.appointments for insert to anon with check (true);
-- create policy "anon can delete appointments" on public.appointments for delete to anon using (true);
