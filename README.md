# ConsultHub – Student Consultation Scheduler

A scheduling website where students book a **1‑hour consultation** with their teacher.
Built with **Node.js + Express** and **Supabase** (Postgres). Deployable to Vercel.

## Features

**Students (`/`)**
- Calendar showing which days have open slots (green dot) or are fully booked (red dot)
- 1‑hour time slots for the chosen day; taken or past slots are disabled
- Enter full name + reason for the meeting, then confirm
- Confirmation screen with a booking reference
- Double booking is blocked by the database (unique slot constraint)

**Teacher (`/admin.html`)**
- Password‑protected dashboard (`ADMIN_PASSWORD`)
- Stats: today, next 7 days, all upcoming
- Upcoming / Past tabs, grouped by date, with search
- Cancel an appointment (the slot opens up again)

## Setup

1. **Create the table** – in Supabase go to *SQL Editor*, paste [`supabase/schema.sql`](supabase/schema.sql) and run it.
2. **Environment variables** – copy `.env.example` to `.env` and fill it in
   (on Vercel: *Project Settings → Environment Variables*).

   | Variable | Required | Description |
   | --- | --- | --- |
   | `SUPABASE_URL` | ✅ | Your Supabase project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | ✅* | Recommended. Server-only key. (*or `SUPABASE_ANON_KEY` + the optional policies in `schema.sql`) |
   | `ADMIN_PASSWORD` | ✅ | Password for the teacher dashboard |
   | `TEACHER_NAME` | | Shown on the booking page |
   | `MEETING_TITLE` | | Default `Student Consultation` |
   | `MEETING_LOCATION` | | Default `Faculty Office` |
   | `TIMEZONE` | | Default `Asia/Manila` |
   | `START_HOUR` / `END_HOUR` | | Office hours, 24h clock. Default `9` / `17` |
   | `BREAK_HOURS` | | Hours without slots, comma separated. Default `12` (lunch) |
   | `WORKING_DAYS` | | `0`=Sun … `6`=Sat. Default `1,2,3,4,5` |
   | `MAX_DAYS_AHEAD` | | How far ahead students may book. Default `30` |

3. **Run locally**
   ```bash
   npm install
   npm run dev        # loads .env, restarts on changes → http://localhost:3000
   ```

## Project structure

```
index.js             Express server + REST API
public/
  index.html, app.js     Student booking page
  admin.html, admin.js   Teacher dashboard
  styles.css             Shared styles
supabase/schema.sql  Database table
```

## API

| Method | Route | Description |
| --- | --- | --- |
| GET | `/api/config` | Teacher info, today's date, booking window |
| GET | `/api/month?month=YYYY-MM` | Open slot count per day |
| GET | `/api/slots?date=YYYY-MM-DD` | Slots for a day |
| POST | `/api/bookings` | `{ name, reason, date, hour }` |
| GET | `/api/admin/bookings` | All bookings (header `x-admin-password`) |
| DELETE | `/api/admin/bookings/:id` | Cancel a booking (header `x-admin-password`) |

