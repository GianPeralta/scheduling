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
  3. **Retrieval of Manuscript** (`5 minutes`): Scheduled once students receive the email saying their manuscript is checked; all members must be present or they will not be accommodated.
  4. **Communication Letter Signature** (`5 minutes`, **shown only to students who registered Arnemie Gayyed as Adviser**): Interactive prerequisite check verifying the letter already bears the initial of **Ma'am Melinda Beninsig** before continuing.
  5. **Capstone / Thesis Defense** (`1 hour` for **Capstone 1 / Thesis 1**, `2 hours` for **Capstone 2 / Thesis 2**): Students can confirm or update their course level when booking, view available defense windows, and type their preferred start time (e.g. `2:30` → automatically reserves `2:30 PM – 3:30 PM` for Capstone 1 or `2:30 PM – 4:30 PM` for Capstone 2) or tap a suggested start time.
- **Weekly consultation schedule (Tuesday – Thursday)** until **December 10**:
  - **Tuesday**: 2:10 PM – 3:30 PM
  - **Wednesday**: 12:50 PM – 2:10 PM
  - **Thursday**: 2:10 PM – 3:30 PM
- **Weekly defense schedule (Monday – Saturday)** until **December 10**:
  - **Monday**: 11:30 AM – 2:10 PM, 3:30 PM – 4:50 PM
  - **Tuesday**: 10:10 AM – 11:30 AM, 2:10 PM – 3:30 PM, 4:50 PM – 6:10 PM
  - **Wednesday**: 11:30 AM – 2:10 PM, 3:30 PM – 4:50 PM
  - **Thursday**: 10:10 AM – 11:30 AM, 2:10 PM – 3:30 PM, 4:50 PM – 6:10 PM
  - **Friday**: 7:30 AM – 8:30 AM, 11:30 AM – 12:50 PM, 4:50 PM – 6:10 PM
  - **Saturday**: 8:50 AM – 12:50 PM, 2:10 PM – 6:10 PM
- **Cross-schedule overlap prevention**: if a time slot has been booked as a consultation, it cannot be booked for a defense (and vice versa), while 0-minute Drop-offs never block timed slots.
- Confirmation ticket with a unique booking reference + **Student Profile** modal (`My Profile`) showing registered Capstone/Thesis details, upcoming & past consultations, and any **cancelled schedules with the instructor's cancellation reason**

**Arnemie's Dashboard (`/admin.html`)**
- Password‑protected (`ADMIN_PASSWORD`)
- Summary stats: today, next 7 days, all upcoming
- Upcoming / Past / Cancelled tabs grouped by date, showing consultation badges (`System · 15m`, `Drop-off · 0m`, `Retrieval · 5m`, `Comm. Letter · 5m`), `Adviser` / `Panel Member` role badges, Capstone/Thesis titles, and member chips
- One‑click **"Notify Checked"** button on Drop-off Manuscript cards to automatically email the group's registered university address when their manuscript is ready for retrieval
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
   | `MAX_ACTIVE_BOOKINGS_PER_STUDENT` | | Default `2` (`0` = unlimited) |
   | `SESSION_DAYS` | | Default `7` |
   | `MEETING_LOCATION` | | Default `Faculty Office` |
   | `TIMEZONE` | | Default `Asia/Manila` |
   | `BOOKING_END_DATE` | | Default `YYYY-12-10` (December 10) |

3. **Run locally**
   ```bash
   npm install
   npm run dev        # loads .env, restarts on changes -> http://localhost:3000
   ```
