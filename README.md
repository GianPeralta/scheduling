# Arnemie Gayyed — Student Consultation Scheduler

A personal scheduling website for **Arnemie Gayyed** where students book a consultation either **individually** or **as a group/team**.
Built with **Node.js + Express** and **Supabase** (Postgres). Deployable to Vercel.

## Features

**Students (`/`)**
- **Student accounts (1 representative per Capstone/Thesis, 1–3 members max)**: students sign in or register first with their university email (`ALLOWED_EMAIL_DOMAINS`), Capstone/Thesis title, course level (`Capstone 1`, `Capstone 2`, `Thesis 1`, or `Thesis 2`), 1 to 3 members (supports solo, pair, or 3-member groups), and instructor role (`Adviser` or `Panel Member`), verified via a 6‑digit SMTP OTP.
- **1-day advance booking rule**: consultations and defenses must be scheduled at least 1 day before the scheduled day (same-day booking is closed).
- **Consultations & Capstone / Thesis Defense**:
  1. **System Consultation** (`15 minutes`): All members must be present.
  2. **Drop-off Manuscript** (`Drop-off only · 0 min`): Deducts 0 minutes from the schedule; students are notified via their school email once their manuscript is checked.
  3. **Retrieval of Manuscript** (`5 minutes`): Scheduled once students receive the email saying their manuscript is checked; at least 2 or all members must be present or they will not be accommodated.
  4. **Communication Letter Signature** (`5 minutes`, **shown only to students who registered Arnemie Gayyed as Adviser**): Interactive prerequisite check verifying the letter already bears the initial of **Ma'am Melinda Beninsig** before continuing.
  5. **Pickup of Communication Letter** (`5 minutes`, **shown only to students who registered Arnemie Gayyed as Adviser**): Scheduled once students receive the email notification that their signed communication letter is ready for pickup, using instructor-configured pickup windows.
  6. **Other Consultations** (`10 minutes`): Available for all students for other Capstone or Thesis concerns.
  7. **Capstone / Thesis Defense** (`1 hour` for **Capstone 1 / Thesis 1**, `2 hours` for **Capstone 2 / Thesis 2**): Students can confirm or update their course level, view available defense windows, and type their preferred start time (e.g. `2:30` → automatically reserves `2:30 PM – 3:30 PM` for Capstone 1 or `2:30 PM – 4:30 PM` for Capstone 2) or tap a suggested start time.
- **Visual Schedule & Availability Manager (`/admin.html`)**:
  - Calendar dates **start closed** until opened by the instructor.
  - Select a single date, multiple dates, or a date range on the interactive calendar to open **Consultations**, **Capstone / Thesis Defenses**, or **Comm. Letter Pickups** independently.
  - Choose **10:00 AM – 5:00 PM** (full day), **My Consultation / Defense Hours Only** (configurable per weekday Monday–Saturday), or **Custom Time Window(s)**, or block dates/times in one place.
- **Cross-schedule overlap prevention**: if a time slot has been booked as a consultation, it cannot be booked for a defense (and vice versa), while 0-minute Drop-offs never block timed slots.
- Confirmation ticket with a unique booking reference + **Student Profile** modal (`My Profile`) showing registered Capstone/Thesis details, upcoming & past consultations, and any **cancelled schedules with the instructor's cancellation reason**

**Arnemie's Dashboard (`/admin.html`)**
- Password‑protected (`ADMIN_PASSWORD`)
- Summary stats: today, next 7 days, all upcoming
- Upcoming / Past / Cancelled tabs grouped by date, showing consultation badges (`System · 15m`, `Drop-off · 0m`, `Retrieval · 5m`, `Comm. Letter · 5m`), `Adviser` / `Panel Member` role badges, Capstone/Thesis titles, and member chips
- One‑click **"Notify Checked"** button on Drop-off Manuscript cards to automatically email the group's registered university address when their manuscript is ready for retrieval
- **10-minute appointment reminders**: automatically emails the instructor (`TEACHER_EMAIL`, defaulting to `nemie07gayyed@gmail.com`) 10 minutes before every scheduled appointment (also triggerable via `/api/cron/reminders`)
- Instant search across student names, emails, Capstone/Thesis titles, group members, reasons, cancellation reasons, and reference codes
- **Cancel with reason**: cancelling an appointment frees up the time slot immediately and saves the instructor's cancellation reason directly to the student's profile

## Setup

1. **Create (or update) the table** – in Supabase go to *SQL Editor*, paste [`supabase/schema.sql`](supabase/schema.sql) and run it. (Safe to re‑run if you already ran an earlier version.)
2. **Environment variables** – copy `.env.example` to `.env` and fill it in
   (on Vercel: *Project Settings → Environment Variables*).

   | Variable | Required | Description |
   | --- | --- | --- |
   | `SUPABASE_URL` | ✅ | Your Supabase project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Server‑only key (required for student accounts) |
   | `ADMIN_PASSWORD` | ✅ | Password for Arnemie's dashboard |
   | `ALLOWED_EMAIL_DOMAINS` | ✅ | University email domain(s) allowed to register, e.g. `myuni.edu.ph` |
   | `SESSION_SECRET` | ✅ | 32+ random characters used to sign logins |
   | `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | ✅ | SMTP account used to email verification codes |
   | `SMTP_FROM` | | Sender name/address (defaults to `SMTP_USER`) |
   | `TEACHER_EMAIL` | | Instructor email receiving 10-minute appointment reminders (defaults to `nemie07gayyed@gmail.com`) |
   | `INSTRUCTOR_SCHOOL_EMAIL` | | Instructor school email shown to students for other concerns & set as `Reply-To` on outgoing student emails (defaults to `abgayyed@uc-bcf.edu.ph`) |
   | `MAX_ACTIVE_BOOKINGS_PER_STUDENT` | | Default `2` (`0` = unlimited) |
   | `SESSION_DAYS` | | Default `7` |
   | `MEETING_LOCATION` | | Default `Faculty Office` |
   | `TIMEZONE` | | Default `Asia/Manila` |
   | `BOOKING_END_DATE` | | Default `YYYY-12-12` (December 12, or updated live in `/admin.html`) |

3. **Run locally**
   ```bash
   npm install
   npm run dev        # loads .env, restarts on changes -> http://localhost:3000
   ```
