# Arnemie Gayyed — Student Consultation Scheduler

A personal scheduling website for **Arnemie Gayyed** where students book a consultation either **individually** or **as a group/team**.
Built with **Node.js + Express** and **Supabase** (Postgres). Deployable to Vercel.

## Features

**Students (`/`)**
- **Two consultation types**:
  - **System / Software / Web App** (`1 hr 20 min`): For students or groups consulting about the system, software, or web app they made.
  - **Other Consultation** (`6 minutes`): Quick check-in for any other questions or concerns.
- **Weekly schedule (Monday – Saturday)** until **December 10**:
  - **Monday**: 11:30 AM – 2:10 PM, 3:30 PM – 4:50 PM, 6:10 PM – 7:30 PM
  - **Tuesday**: 10:10 AM – 11:30 AM, 2:10 PM – 3:30 PM, 4:50 PM – 7:30 PM
  - **Wednesday**: 11:30 AM – 2:10 PM, 3:30 PM – 4:50 PM, 6:10 PM – 7:30 PM
  - **Thursday**: 10:10 AM – 11:30 AM, 2:10 PM – 3:30 PM, 4:50 PM – 7:30 PM
  - **Friday**: 7:30 AM – 8:50 AM, 11:30 AM – 12:50 PM, 4:50 PM – 7:30 PM
  - **Saturday**: 8:50 AM – 12:50 PM, 2:10 PM – 7:30 PM
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
   | `SUPABASE_SERVICE_ROLE_KEY` | ✅* | Recommended. Server‑only key. (*or `SUPABASE_ANON_KEY` + the optional policies in `schema.sql`) |
   | `ADMIN_PASSWORD` | ✅ | Password for Arnemie's dashboard |
   | `MEETING_LOCATION` | | Default `Faculty Office` |
   | `TIMEZONE` | | Default `Asia/Manila` |
   | `BOOKING_END_DATE` | | Default `YYYY-12-10` (December 10) |

3. **Run locally**
   ```bash
   npm install
   npm run dev        # loads .env, restarts on changes -> http://localhost:3000
   ```
