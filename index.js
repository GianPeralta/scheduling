const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '20kb' }));

// Serve the frontend (on Vercel, files in /public are served by the CDN automatically)
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/* Configuration (all values can be overridden with environment vars)  */
/* ------------------------------------------------------------------ */
const intEnv = (value, fallback) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
};
const listEnv = (value, fallback) =>
    (value ?? fallback)
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v !== '')
        .map(Number)
        .filter(Number.isFinite);

const CONFIG = {
    teacherName: process.env.TEACHER_NAME || 'Your Teacher',
    meetingTitle: process.env.MEETING_TITLE || 'Student Consultation',
    location: process.env.MEETING_LOCATION || 'Faculty Office',
    timezone: process.env.TIMEZONE || 'Asia/Manila',
    startHour: intEnv(process.env.START_HOUR, 9), // first slot starts at 9:00
    endHour: intEnv(process.env.END_HOUR, 17), // last slot ends at 17:00
    breakHours: listEnv(process.env.BREAK_HOURS, '12'), // 12:00-13:00 lunch break
    workingDays: listEnv(process.env.WORKING_DAYS, '1,2,3,4,5'), // 0 = Sunday ... 6 = Saturday
    maxDaysAhead: intEnv(process.env.MAX_DAYS_AHEAD, 30),
};

const TABLE = 'appointments';

/* ------------------------------------------------------------------ */
/* Supabase client                                                     */
/* ------------------------------------------------------------------ */
// The key is only ever used on the server. The service role key is recommended
// (see supabase/schema.sql), but the anon key works too if the RLS policies allow it.
let supabase = null;
function db() {
    if (supabase) return supabase;
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
        const err = new Error('Server is missing SUPABASE_URL / SUPABASE key environment variables.');
        err.status = 500;
        throw err;
    }
    supabase = createClient(url, key, { auth: { persistSession: false } });
    return supabase;
}

/* ------------------------------------------------------------------ */
/* Date helpers (everything is computed in the teacher's timezone)     */
/* ------------------------------------------------------------------ */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function nowInTz() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: CONFIG.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type).value;
    return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: parseInt(get('hour'), 10) % 24 };
}

function parseDate(str) {
    if (typeof str !== 'string' || !DATE_RE.test(str)) return null;
    const [y, m, d] = str.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return dt;
}

const toDateStr = (dt) => dt.toISOString().slice(0, 10);

function addDays(str, days) {
    const dt = parseDate(str);
    dt.setUTCDate(dt.getUTCDate() + days);
    return toDateStr(dt);
}

function slotHours() {
    const hours = [];
    for (let h = CONFIG.startHour; h < CONFIG.endHour; h++) {
        if (!CONFIG.breakHours.includes(h)) hours.push(h);
    }
    return hours;
}

function formatHour(h) {
    const suffix = h >= 12 ? 'PM' : 'AM';
    const hr = h % 12 === 0 ? 12 : h % 12;
    return `${hr}:00 ${suffix}`;
}

/** Is this date one the teacher accepts bookings for at all? */
function isBookableDate(dateStr, now = nowInTz()) {
    const dt = parseDate(dateStr);
    if (!dt) return false;
    if (!CONFIG.workingDays.includes(dt.getUTCDay())) return false;
    if (dateStr < now.date) return false;
    if (dateStr > addDays(now.date, CONFIG.maxDaysAhead)) return false;
    return true;
}

/** Slots on the current day must start in a future hour. */
function isFutureSlot(dateStr, hour, now = nowInTz()) {
    return dateStr > now.date || (dateStr === now.date && hour > now.hour);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */
app.get('/api/config', (req, res) => {
    const now = nowInTz();
    res.json({
        teacherName: CONFIG.teacherName,
        meetingTitle: CONFIG.meetingTitle,
        location: CONFIG.location,
        timezone: CONFIG.timezone,
        durationMinutes: 60,
        workingDays: CONFIG.workingDays,
        maxDaysAhead: CONFIG.maxDaysAhead,
        today: now.date,
        lastBookableDate: addDays(now.date, CONFIG.maxDaysAhead),
    });
});

// Number of open slots for every day in a month: /api/month?month=2026-11
app.get('/api/month', async (req, res) => {
    const month = String(req.query.month || '');
    if (!/^\d{4}-\d{2}$/.test(month) || !parseDate(`${month}-01`)) {
        return res.status(400).json({ error: 'Invalid month. Use YYYY-MM.' });
    }

    const first = `${month}-01`;
    const firstDt = parseDate(first);
    const last = toDateStr(new Date(Date.UTC(firstDt.getUTCFullYear(), firstDt.getUTCMonth() + 1, 0)));

    const { data, error } = await db()
        .from(TABLE)
        .select('appointment_date, start_hour')
        .gte('appointment_date', first)
        .lte('appointment_date', last);
    if (error) return res.status(500).json({ error: error.message });

    const taken = new Set(data.map((r) => `${r.appointment_date}#${r.start_hour}`));
    const now = nowInTz();
    const hours = slotHours();
    const days = {};

    for (let d = first; d <= last; d = addDays(d, 1)) {
        if (!isBookableDate(d, now)) {
            days[d] = { bookable: false, open: 0 };
            continue;
        }
        const open = hours.filter((h) => isFutureSlot(d, h, now) && !taken.has(`${d}#${h}`)).length;
        days[d] = { bookable: true, open };
    }

    res.json({ month, days });
});

// Slots for one day: /api/slots?date=2026-11-04
app.get('/api/slots', async (req, res) => {
    const date = String(req.query.date || '');
    if (!parseDate(date)) return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD.' });

    const now = nowInTz();
    if (!isBookableDate(date, now)) return res.json({ date, slots: [] });

    const { data, error } = await db().from(TABLE).select('start_hour').eq('appointment_date', date);
    if (error) return res.status(500).json({ error: error.message });

    const taken = new Set(data.map((r) => r.start_hour));
    const slots = slotHours().map((h) => ({
        hour: h,
        label: formatHour(h),
        endLabel: formatHour(h + 1),
        available: isFutureSlot(date, h, now) && !taken.has(h),
    }));

    res.json({ date, slots });
});

app.post('/api/bookings', async (req, res) => {
    const name = String(req.body?.name ?? '').trim().replace(/\s+/g, ' ');
    const reason = String(req.body?.reason ?? '').trim();
    const date = String(req.body?.date ?? '');
    const hour = Number(req.body?.hour);

    if (name.length < 2 || name.length > 100) {
        return res.status(400).json({ error: 'Please enter your full name (2–100 characters).' });
    }
    if (reason.length < 5 || reason.length > 1000) {
        return res.status(400).json({ error: 'Please describe your reason (5–1000 characters).' });
    }
    const now = nowInTz();
    if (!isBookableDate(date, now) || !Number.isInteger(hour) || !slotHours().includes(hour) || !isFutureSlot(date, hour, now)) {
        return res.status(400).json({ error: 'That time slot is not available. Please choose another one.' });
    }

    const { data, error } = await db()
        .from(TABLE)
        .insert([{ student_name: name, reason, appointment_date: date, start_hour: hour }])
        .select('id, student_name, reason, appointment_date, start_hour')
        .single();

    if (error) {
        if (error.code === '23505') {
            return res.status(409).json({ error: 'Sorry, someone just booked that slot. Please pick another time.' });
        }
        return res.status(500).json({ error: error.message });
    }

    res.status(201).json({
        booking: {
            id: data.id,
            reference: data.id.slice(0, 8).toUpperCase(),
            name: data.student_name,
            reason: data.reason,
            date: data.appointment_date,
            hour: data.start_hour,
            label: `${formatHour(data.start_hour)} – ${formatHour(data.start_hour + 1)}`,
        },
    });
});

/* ------------------------------------------------------------------ */
/* Admin API (protected by ADMIN_PASSWORD)                             */
/* ------------------------------------------------------------------ */
function requireAdmin(req, res, next) {
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected) {
        return res.status(503).json({ error: 'ADMIN_PASSWORD is not configured on the server.' });
    }
    const given = String(req.get('x-admin-password') || '');
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    if (!crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ error: 'Incorrect password.' });
    }
    next();
}

app.get('/admin', (req, res) => res.redirect('/admin.html'));

app.post('/api/admin/login', requireAdmin, (req, res) => res.json({ ok: true }));

app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
    const { data, error } = await db()
        .from(TABLE)
        .select('id, student_name, reason, appointment_date, start_hour, created_at')
        .order('appointment_date', { ascending: true })
        .order('start_hour', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    const now = nowInTz();
    res.json({
        today: now.date,
        currentHour: now.hour,
        bookings: data.map((r) => ({
            id: r.id,
            reference: r.id.slice(0, 8).toUpperCase(),
            name: r.student_name,
            reason: r.reason,
            date: r.appointment_date,
            hour: r.start_hour,
            label: `${formatHour(r.start_hour)} – ${formatHour(r.start_hour + 1)}`,
            createdAt: r.created_at,
        })),
    });
});

app.delete('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });
    const { error } = await db().from(TABLE).delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Something went wrong.' });
});

// Export the Express API for Vercel
module.exports = app;

// Listen locally if not running on Vercel
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}
