# Arnemie Gayyed — Student Consultation Scheduler

A personal scheduling website for **Arnemie Gayyed** where students book a consultation either **individually** or **as a group/team**.
Built with **Node.js + Express** and **Supabase** (Postgres). Deployable to Vercel.

## Features

**Students (`/`)**
- **Student accounts**: students must log in to book. Registration only accepts university emails (`ALLOWED_EMAIL_DOMAINS`) and is verified with a 6‑digit code sent by SMTP. Includes "forgot password" via emailed code, login lockout after repeated failures, and a per‑student limit on upcoming bookings.
- **Two consultation types**:
  - **System Consultation** (`1 hr 20 min`): For students or groups consulting about the system, software, or web app they made.
  - **Other Consultation** (`6 minutes`): Quick check-in for any other questions or concerns.
- **Weekly schedule (Tuesday – Thursday)** until **December 10**:
  - **Tuesday**: 2:10 PM – 3:30 PM
  - **Wednesday**: 12:50 PM – 2:10 PM
  - **Thursday**: 2:10 PM – 3:30 PM
- Automatic overlap prevention between 1 hr 20 min and 6-minute slots
- **Individual or Group booking**:
  - *Just me*: enter full name + reason for the meeting
  - *Group / team*: enter team name, 2–10 member names, + reason for the meeting
- Confirmation ticket with a unique booking reference

**Arnemie's Dashboard (`/admin.html`)**
- Password‑protected (`ADMIN_PASSWORD`)
- Summary stats: today, next 7 days, all upcoming
- Upcoming / Past tabs grouped by date, showing consultation duration badge (`System / App · 1h 20m` or `Other · 6m`), individual names or team names + member chips
- Instant search across student names, team names, group members, reasons, and reference codes
- One‑click cancel to free up a time slot again

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
