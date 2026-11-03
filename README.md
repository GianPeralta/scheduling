# Arnemie Gayyed — Student Consultation Scheduler

A personal scheduling website for **Arnemie Gayyed** where students book a **1‑hour consultation** either **individually** or **as a group/team**.
Built with **Node.js + Express** and **Supabase** (Postgres). Deployable to Vercel.

## Features

**Students (`/`)**
- Interactive calendar showing which days have open slots (green dot) or are fully booked (red dot)
- 1‑hour time slots for the chosen day; taken or past slots are disabled
- **Individual or Group booking**:
  - *Just me*: enter full name + reason for the meeting
  - *Group / team*: enter team name, 2–10 member names, + reason for the meeting
- Confirmation ticket with a unique booking reference
- Double booking is prevented by a database unique constraint on `(appointment_date, start_hour)`

**Arnemie's Dashboard (`/admin.html`)**
- Password‑protected (`ADMIN_PASSWORD`)
- Summary stats: today, next 7 days, all upcoming
- Upcoming / Past tabs grouped by date, showing individual names or team names + member chips
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
   | `START_HOUR` / `END_HOUR` | | Office hours, 24h clock. Default `9` / `17` |
   | `BREAK_HOURS` | | Hours without slots, comma separated. Default `12` (lunch) |
   | `WORKING_DAYS` | | `0`=Sun … `6`=Sat. Default `1,2,3,4,5` |
   | `MAX_DAYS_AHEAD` | | How far ahead students may book. Default `30` |

3. **Run locally**
   ```bash
   npm install
   npm run dev        # loads .env, restarts on changes -> http://localhost:3000
   ```

## Project structure

```
index.js               Express server + REST API
public/
  index.html, app.js   Student booking page (individual & group)
  admin.html, admin.js Arnemie's dashboard
  styles.css           Clean modern solid-color UI
supabase/schema.sql    Database table & group columns
```

## API

| Method | Route | Description |
| --- | --- | --- |
| GET | `/api/config` | Teacher info, location, today's date, booking window |
| GET | `/api/month?month=YYYY-MM` | Open slot count per day |
| GET | `/api/slots?date=YYYY-MM-DD` | Slots for a day |
| POST | `/api/bookings` | Individual (`{ type: 'individual', name, reason, date, hour }`) or Group (`{ type: 'group', teamName, members, reason, date, hour }`) |
| GET | `/api/admin/bookings` | All bookings (header `x-admin-password`) |
| DELETE | `/api/admin/bookings/:id` | Cancel a booking (header `x-admin-password`) |
