-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run
-- (Safe to run again: it also upgrades a table created by an earlier version.)

create table if not exists public.appointments (
    id                uuid primary key default gen_random_uuid(),
    student_name      text        not null check (char_length(student_name) between 2 and 100),
    reason            text        not null check (char_length(reason) between 5 and 1000),
    appointment_date  date        not null,
    start_hour        smallint    not null,
    start_minute      smallint    not null check (start_minute between 0 and 1439),
    duration_minutes  smallint    not null default 15 check (duration_minutes in (0, 5, 6, 10, 15, 60, 80, 120)),
    consultation_type   text        not null default 'system'
                                    check (consultation_type in ('system', 'dropoff', 'retrieval', 'letter', 'defense', 'other')),
    status              text        not null default 'scheduled'
                                    check (status in ('scheduled', 'cancelled')),
    cancellation_reason text        check (cancellation_reason is null or char_length(cancellation_reason) between 2 and 500),
    cancelled_at        timestamptz,
    notified_at             timestamptz,
    reminder_sent_at        timestamptz,
    student_reminder_sent_at timestamptz,
    rescheduled_at          timestamptz,
    rescheduled_count       smallint    not null default 0,
    previous_date           date,
    previous_start_minute   smallint,
    created_at              timestamptz not null default now()
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
alter table public.appointments add column if not exists reminder_sent_at timestamptz;
alter table public.appointments add column if not exists student_reminder_sent_at timestamptz;
alter table public.appointments add column if not exists rescheduled_at timestamptz;
alter table public.appointments add column if not exists rescheduled_count smallint not null default 0;
alter table public.appointments add column if not exists previous_date date;
alter table public.appointments add column if not exists previous_start_minute smallint;
alter table public.appointments drop constraint if exists appointments_slot_unique;
alter table public.appointments drop constraint if exists appointments_start_hour_check;
alter table public.appointments drop constraint if exists appointments_duration_minutes_check;
alter table public.appointments add constraint appointments_duration_minutes_check
    check (duration_minutes in (0, 5, 6, 10, 15, 60, 80, 120));
alter table public.appointments drop constraint if exists appointments_consultation_type_check;
alter table public.appointments add constraint appointments_consultation_type_check
    check (consultation_type in ('system', 'dropoff', 'retrieval', 'letter', 'defense', 'other'));

-- Defenses: 'capstone1' / 'thesis1' = 1 hour (60), 'capstone2' / 'thesis2' = 2 hours (120)
alter table public.appointments add column if not exists defense_level text;
alter table public.appointments drop constraint if exists appointments_defense_level_check;
alter table public.appointments add constraint appointments_defense_level_check
    check (defense_level is null or defense_level in ('capstone1', 'capstone2', 'thesis1', 'thesis2'));

-- Drop-off manuscripts (duration_minutes = 0) and cancelled appointments (status = 'cancelled')
-- do not lock time slots on the schedule.
alter table public.appointments drop constraint if exists appointments_date_start_minute_unique;
drop index if exists public.appointments_timed_slot_unique;
create unique index appointments_timed_slot_unique
    on public.appointments (appointment_date, start_minute)
    where duration_minutes > 0 and status <> 'cancelled';

create index if not exists appointments_date_idx on public.appointments (appointment_date);

-- Safety net against double-booking: no two active timed appointments (consultations or defenses)
-- may overlap on the same day. The server already checks this; the constraint also blocks the rare
-- case of two students submitting overlapping times at the same instant.
-- If old data already contains overlaps, this step is skipped with a notice (everything else still works).
create extension if not exists btree_gist;
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'appointments_no_overlap') then
        alter table public.appointments add constraint appointments_no_overlap
            exclude using gist (
                appointment_date with =,
                int4range(start_minute, start_minute + duration_minutes) with &&
            ) where (duration_minutes > 0 and status <> 'cancelled');
    end if;
exception when others then
    raise notice 'Skipped appointments_no_overlap constraint: %', sqlerrm;
end $$;

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

-- The group's current course (chosen at registration, updated when they book a defense)
alter table public.students add column if not exists project_level text;
alter table public.students drop constraint if exists students_project_level_check;
alter table public.students add constraint students_project_level_check
    check (project_level is null or project_level in ('capstone1', 'capstone2', 'thesis1', 'thesis2'));
alter table public.students add column if not exists updated_at timestamptz;
alter table public.students add column if not exists change_history jsonb not null default '[]'::jsonb;

-- Audit log of changes students make to their registration info
create table if not exists public.student_update_logs (
    id                uuid primary key default gen_random_uuid(),
    student_id        uuid references public.students (id) on delete cascade,
    student_name      text,
    student_email     text,
    changed_fields    text[]      not null default '{}',
    previous_values   jsonb       not null default '{}'::jsonb,
    new_values        jsonb       not null default '{}'::jsonb,
    changes_summary   text,
    verified_via_otp  boolean     not null default false,
    created_at        timestamptz not null default now()
);
create index if not exists student_update_logs_student_idx on public.student_update_logs (student_id, created_at desc);
alter table public.student_update_logs enable row level security;

-- One-time codes emailed for registration / password reset (permanent log of all attempts)
create table if not exists public.email_otps (
    id               uuid primary key default gen_random_uuid(),
    email            text        not null,
    student_name     text,
    capstone_title   text,
    instructor_role  text,
    members          text[],
    purpose          text        not null check (purpose in ('register', 'reset', 'email_change')),
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
alter table public.email_otps drop constraint if exists email_otps_status_check;
alter table public.email_otps add constraint email_otps_status_check
    check (status in ('pending', 'verified', 'expired', 'failed', 'superseded', 'send_failed'));
alter table public.email_otps add column if not exists verified_at timestamptz;
alter table public.email_otps drop constraint if exists email_otps_purpose_check;
alter table public.email_otps add constraint email_otps_purpose_check
    check (purpose in ('register', 'reset', 'email_change'));
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
-- Blocked dates & time ranges (instructor unavailable / sick / official business)
-- ---------------------------------------------------------------------------
create table if not exists public.blocked_schedules (
    id            uuid primary key default gen_random_uuid(),
    blocked_date  date        not null,
    is_full_day   boolean     not null default true,
    start_minute  smallint    check (start_minute is null or (start_minute >= 0 and start_minute < 1440)),
    end_minute    smallint    check (end_minute is null or (end_minute > 0 and end_minute <= 1440)),
    reason        text        check (reason is null or char_length(reason) <= 500),
    created_at    timestamptz not null default now(),
    constraint blocked_schedules_time_check
        check (is_full_day or (start_minute is not null and end_minute is not null and start_minute < end_minute))
);

create index if not exists blocked_schedules_date_idx on public.blocked_schedules (blocked_date);
alter table public.blocked_schedules enable row level security;


-- ---------------------------------------------------------------------------
-- OPTIONAL: only needed if you keep using SUPABASE_ANON_KEY on the server
-- instead of SUPABASE_SERVICE_ROLE_KEY. Uncomment and run.
-- (The anon key stays on the server, but anyone who obtains it could then
--  read/delete appointments, so the service role key is recommended.)
-- ---------------------------------------------------------------------------
-- create policy "anon can read appointments"   on public.appointments for select to anon using (true);
-- create policy "anon can insert appointments" on public.appointments for insert to anon with check (true);
-- create policy "anon can delete appointments" on public.appointments for delete to anon using (true);

-- Enable Supabase Realtime Postgres Changes on appointments and blocked_schedules (safe to re-run)
do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'appointments'
        ) then
            alter publication supabase_realtime add table public.appointments;
        end if;
        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'blocked_schedules'
        ) then
            alter publication supabase_realtime add table public.blocked_schedules;
        end if;
    end if;
exception when others then
    raise notice 'Skipped supabase_realtime publication setup: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- Atomic Appointment Rescheduling (single database transaction)
-- ---------------------------------------------------------------------------
create or replace function public.reschedule_appointment(
    p_appointment_id uuid,
    p_student_id uuid,
    p_new_date date,
    p_new_start_minute smallint,
    p_new_duration_minutes smallint,
    p_new_reason text default null
)
returns setof public.appointments
language plpgsql
set search_path = public
as $$
declare
    v_row public.appointments%rowtype;
    v_duration smallint;
    v_reason text;
begin
    select *
      into v_row
      from public.appointments
     where id = p_appointment_id
       and student_id = p_student_id
       for update;

    if not found then
        raise exception 'Appointment not found.' using errcode = 'P0002';
    end if;

    if v_row.status = 'cancelled' then
        raise exception 'Cancelled appointments cannot be rescheduled.' using errcode = 'P0001';
    end if;

    v_duration := coalesce(p_new_duration_minutes, v_row.duration_minutes);
    if v_row.appointment_date = p_new_date and v_row.start_minute = p_new_start_minute then
        raise exception 'Please select a different date or time to reschedule your appointment.' using errcode = 'P0001';
    end if;

    v_reason := coalesce(nullif(btrim(p_new_reason), ''), v_row.reason);

    if v_duration = 0 then
        if exists (
            select 1
              from public.appointments
             where student_id = p_student_id
               and id <> p_appointment_id
               and status <> 'cancelled'
               and duration_minutes = 0
               and appointment_date = p_new_date
        ) then
            raise exception 'Your group already has a Manuscript Drop-off scheduled on this date.' using errcode = '23505';
        end if;
    else
        perform pg_advisory_xact_lock(hashtext('appointments:' || p_new_date::text));
        if exists (
            select 1
              from public.blocked_schedules
             where blocked_date = p_new_date
               and (
                   is_full_day
                   or int4range(start_minute::int, end_minute::int)
                       && int4range(p_new_start_minute::int, (p_new_start_minute + v_duration)::int)
               )
        ) then
            raise exception 'The instructor is unavailable during that date/time.' using errcode = '23P01';
        end if;
        if exists (
            select 1
              from public.appointments
             where appointment_date = p_new_date
               and id <> p_appointment_id
               and status <> 'cancelled'
               and duration_minutes > 0
               and int4range(start_minute::int, (start_minute + duration_minutes)::int)
                   && int4range(p_new_start_minute::int, (p_new_start_minute + v_duration)::int)
        ) then
            raise exception 'That time slot overlaps with an existing booking.' using errcode = '23P01';
        end if;
    end if;

    return query
    update public.appointments
       set appointment_date = p_new_date,
           start_hour = floor(p_new_start_minute / 60)::smallint,
           start_minute = p_new_start_minute,
           duration_minutes = v_duration,
           reason = v_reason,
           previous_date = v_row.appointment_date,
           previous_start_minute = v_row.start_minute,
           rescheduled_at = now(),
           rescheduled_count = coalesce(v_row.rescheduled_count, 0) + 1,
           reminder_sent_at = null,
           student_reminder_sent_at = null
     where id = p_appointment_id
       and student_id = p_student_id
       and status = 'scheduled'
    returning *;
end;
$$;
