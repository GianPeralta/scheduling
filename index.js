const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '20kb' }));

// Serve the frontend (on Vercel, files in /public are served by the CDN automatically)
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/* Configuration & Schedule                                            */
/* ------------------------------------------------------------------ */
// This site is only for one teacher: Arnemie Gayyed.
const TEACHER_NAME = 'Arnemie Gayyed';

const hm = (h, m) => h * 60 + m;

const SYSTEM_DURATION = 80; // 1h 20min for system/software/webapp consultations
const OTHER_DURATION = 6;   // 6 minutes for all other consultations

const CONSULTATION_TYPES = {
    system: {
        id: 'system',
        title: 'System / Software / Web App',
        description: 'Consult about the system, software, or web app you made',
        durationMinutes: SYSTEM_DURATION,
        durationLabel: '1 hr 20 min',
    },
    other: {
        id: 'other',
        title: 'Other Consultation',
        description: 'Quick consultation for other questions or concerns',
        durationMinutes: OTHER_DURATION,
        durationLabel: '6 minutes',
    },
};

// Available consultation windows per day of week (0 = Sun ... 6 = Sat)
// Every window is composed of 1h 20m (80-minute) blocks.
const WINDOWS_BY_DAY = {
    // MONDAY: 11:30AM - 2:10PM, 3:30PM - 4:50PM, 6:10PM - 7:30PM
    1: [
        [hm(11, 30), hm(14, 10)],
        [hm(15, 30), hm(16, 50)],
        [hm(18, 10), hm(19, 30)],
    ],
    // TUESDAY: 10:10AM - 11:30AM, 2:10PM - 3:30PM, 4:50PM - 7:30PM
    2: [
        [hm(10, 10), hm(11, 30)],
        [hm(14, 10), hm(15, 30)],
        [hm(16, 50), hm(19, 30)],
    ],
    // WEDNESDAY: 11:30AM - 2:10PM, 3:30PM - 4:50PM, 6:10PM - 7:30PM
    3: [
        [hm(11, 30), hm(14, 10)],
        [hm(15, 30), hm(16, 50)],
        [hm(18, 10), hm(19, 30)],
    ],
    // THURSDAY: 10:10AM - 11:30AM, 2:10PM - 3:30PM, 4:50PM - 7:30PM
    4: [
        [hm(10, 10), hm(11, 30)],
        [hm(14, 10), hm(15, 30)],
        [hm(16, 50), hm(19, 30)],
    ],
    // FRIDAY: 7:30AM - 8:50AM, 11:30AM - 12:50PM, 4:50PM - 7:30PM
    5: [
        [hm(7, 30), hm(8, 50)],
        [hm(11, 30), hm(12, 50)],
        [hm(16, 50), hm(19, 30)],
    ],
    // SATURDAY: 8:50AM - 12:50PM, 2:10PM - 7:30PM
    6: [
        [hm(8, 50), hm(12, 50)],
        [hm(14, 10), hm(19, 30)],
    ],
};

const CONFIG = {
    location: process.env.MEETING_LOCATION || 'Faculty Office',
    timezone: process.env.TIMEZONE || 'Asia/Manila',
    workingDays: [1, 2, 3, 4, 5, 6],
    bookingEndDate: process.env.BOOKING_END_DATE || null, // defaults to Dec 10 of current year
};

const TABLE = 'appointments';

/* ------------------------------------------------------------------ */
/* Supabase client                                                     */
/* ------------------------------------------------------------------ */
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
/* Date & Time helpers (computed in the teacher's timezone)            */
/* ------------------------------------------------------------------ */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function nowInTz() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: CONFIG.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type).value;
    const hour = parseInt(get('hour'), 10) % 24;
    const minute = parseInt(get('minute'), 10) % 60;
    return {
        date: `${get('year')}-${get('month')}-${get('day')}`,
        hour,
        minute,
        minuteOfDay: hour * 60 + minute,
    };
}

function getLastBookableDate(now = nowInTz()) {
    return CONFIG.bookingEndDate || `${now.date.slice(0, 4)}-12-10`;
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

function formatMinute(totalMinutes) {
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    const suffix = h >= 12 ? 'PM' : 'AM';
    const hr = h % 12 === 0 ? 12 : h % 12;
    return `${hr}:${String(m).padStart(2, '0')} ${suffix}`;
}

function normalizePurpose(purpose) {
    return purpose === 'other' ? 'other' : 'system';
}

/** Generate all candidate slots for a date and consultation purpose ('system' | 'other'). */
function generateDaySlots(dateStr, purpose = 'system') {
    const dt = parseDate(dateStr);
    if (!dt) return [];
    const windows = WINDOWS_BY_DAY[dt.getUTCDay()] || [];
    const normalized = normalizePurpose(purpose);
    const slots = [];

    for (const [winStart, winEnd] of windows) {
        const windowLabel = `${formatMinute(winStart)} – ${formatMinute(winEnd)}`;
        // Step through 1h 20m (80-minute) blocks inside each window
        for (let blockStart = winStart; blockStart + SYSTEM_DURATION <= winEnd; blockStart += SYSTEM_DURATION) {
            const blockEnd = blockStart + SYSTEM_DURATION;
            const blockLabel = `${formatMinute(blockStart)} – ${formatMinute(blockEnd)}`;
            if (normalized === 'system') {
                slots.push({
                    startMinute: blockStart,
                    endMinute: blockEnd,
                    durationMinutes: SYSTEM_DURATION,
                    label: formatMinute(blockStart),
                    endLabel: formatMinute(blockEnd),
                    windowLabel: blockLabel,
                });
            } else {
                // Generate 6-minute slots within each 80-minute block so a 6-minute booking
                // never straddles two 80-minute blocks.
                for (let m = blockStart; m + OTHER_DURATION <= blockEnd; m += OTHER_DURATION) {
                    slots.push({
                        startMinute: m,
                        endMinute: m + OTHER_DURATION,
                        durationMinutes: OTHER_DURATION,
                        label: formatMinute(m),
                        endLabel: formatMinute(m + OTHER_DURATION),
                        windowLabel: blockLabel,
                    });
                }
            }
        }
    }

    return slots;
}

/** Extract [startMinute, endMinute] from a DB row (compatible with legacy rows). */
function rowInterval(r) {
    const start = Number.isFinite(r.start_minute) ? r.start_minute : (Number(r.start_hour) || 0) * 60;
    const duration = Number.isFinite(r.duration_minutes)
        ? r.duration_minutes
        : r.consultation_type === 'other'
            ? OTHER_DURATION
            : SYSTEM_DURATION;
    return [start, start + duration];
}

function hasOverlap(startMinute, endMinute, intervals) {
    for (const [bStart, bEnd] of intervals) {
        if (startMinute < bEnd && endMinute > bStart) return true;
    }
    return false;
}

/** Is this date one the teacher accepts bookings for at all? */
function isBookableDate(dateStr, now = nowInTz()) {
    const dt = parseDate(dateStr);
    if (!dt) return false;
    const windows = WINDOWS_BY_DAY[dt.getUTCDay()];
    if (!windows || !windows.length) return false;
    if (dateStr < now.date) return false;
    if (dateStr > getLastBookableDate(now)) return false;
    return true;
}

/** Slots on the current day must start in the future. */
function isFutureSlot(dateStr, startMinute, now = nowInTz()) {
    return dateStr > now.date || (dateStr === now.date && startMinute > now.minuteOfDay);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */
app.get('/api/config', (req, res) => {
    const now = nowInTz();
    res.json({
        teacherName: TEACHER_NAME,
        location: CONFIG.location,
        timezone: CONFIG.timezone,
        consultationTypes: CONSULTATION_TYPES,
        workingDays: CONFIG.workingDays,
        today: now.date,
        lastBookableDate: getLastBookableDate(now),
    });
});

// Number of open slots for every day in a month: /api/month?month=2026-11&purpose=system
app.get('/api/month', async (req, res) => {
    const month = String(req.query.month || '');
    const purpose = normalizePurpose(req.query.purpose);
    if (!/^\d{4}-\d{2}$/.test(month) || !parseDate(`${month}-01`)) {
        return res.status(400).json({ error: 'Invalid month. Use YYYY-MM.' });
    }

    const first = `${month}-01`;
    const firstDt = parseDate(first);
    const last = toDateStr(new Date(Date.UTC(firstDt.getUTCFullYear(), firstDt.getUTCMonth() + 1, 0)));

    const { data, error } = await db()
        .from(TABLE)
        .select('*')
        .gte('appointment_date', first)
        .lte('appointment_date', last);
    if (error) return res.status(500).json({ error: error.message });

    const intervalsByDate = new Map();
    for (const r of data) {
        const d = r.appointment_date;
        if (!intervalsByDate.has(d)) intervalsByDate.set(d, []);
        intervalsByDate.get(d).push(rowInterval(r));
    }

    const now = nowInTz();
    const days = {};

    for (let d = first; d <= last; d = addDays(d, 1)) {
        if (!isBookableDate(d, now)) {
            days[d] = { bookable: false, open: 0 };
            continue;
        }
        const daySlots = generateDaySlots(d, purpose);
        const bookedIntervals = intervalsByDate.get(d) || [];
        const open = daySlots.filter(
            (s) => isFutureSlot(d, s.startMinute, now) && !hasOverlap(s.startMinute, s.endMinute, bookedIntervals)
        ).length;
        days[d] = { bookable: true, open };
    }

    res.json({ month, purpose, days });
});

// Slots for one day: /api/slots?date=2026-11-04&purpose=system
app.get('/api/slots', async (req, res) => {
    const date = String(req.query.date || '');
    const purpose = normalizePurpose(req.query.purpose);
    if (!parseDate(date)) return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD.' });

    const now = nowInTz();
    if (!isBookableDate(date, now)) return res.json({ date, purpose, slots: [] });

    const { data, error } = await db().from(TABLE).select('*').eq('appointment_date', date);
    if (error) return res.status(500).json({ error: error.message });

    const bookedIntervals = data.map(rowInterval);
    const slots = generateDaySlots(date, purpose).map((s) => ({
        startMinute: s.startMinute,
        endMinute: s.endMinute,
        durationMinutes: s.durationMinutes,
        label: s.label,
        endLabel: s.endLabel,
        windowLabel: s.windowLabel,
        available: isFutureSlot(date, s.startMinute, now) && !hasOverlap(s.startMinute, s.endMinute, bookedIntervals),
    }));

    res.json({ date, purpose, slots });
});

const MAX_MEMBERS = 10;
const cleanName = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');

/** Shape a database row for the frontend. */
function toBooking(r) {
    const members = Array.isArray(r.members) && r.members.length ? r.members : [r.student_name];
    const [startMinute, endMinute] = rowInterval(r);
    const durationMinutes = endMinute - startMinute;
    const consultationType = r.consultation_type || (durationMinutes === OTHER_DURATION ? 'other' : 'system');
    return {
        id: r.id,
        reference: r.id.slice(0, 8).toUpperCase(),
        type: r.team_name ? 'group' : 'individual',
        consultationType,
        durationMinutes,
        durationLabel: durationMinutes === OTHER_DURATION ? '6 min' : '1 hr 20 min',
        name: r.student_name,
        teamName: r.team_name || null,
        members,
        reason: r.reason,
        date: r.appointment_date,
        hour: Math.floor(startMinute / 60),
        startMinute,
        endMinute,
        label: `${formatMinute(startMinute)} – ${formatMinute(endMinute)}`,
        createdAt: r.created_at,
    };
}

app.post('/api/bookings', async (req, res) => {
    const body = req.body || {};
    const type = body.type === 'group' ? 'group' : 'individual';
    const consultationType = normalizePurpose(body.consultationType);
    const durationMinutes = CONSULTATION_TYPES[consultationType].durationMinutes;
    const reason = String(body.reason ?? '').trim();
    const date = String(body.date ?? '');
    const startMinute = Number(body.startMinute);

    let members;
    let teamName = null;

    if (type === 'group') {
        teamName = cleanName(body.teamName);
        if (teamName.length < 2 || teamName.length > 100) {
            return res.status(400).json({ error: 'Please enter your team name (2–100 characters).' });
        }
        members = (Array.isArray(body.members) ? body.members : []).map(cleanName).filter(Boolean);
        if (members.length < 2) {
            return res.status(400).json({ error: 'A group booking needs at least 2 member names.' });
        }
        if (members.length > MAX_MEMBERS) {
            return res.status(400).json({ error: `A group can have at most ${MAX_MEMBERS} members.` });
        }
    } else {
        members = [cleanName(body.name)];
    }

    if (members.some((m) => m.length < 2 || m.length > 100)) {
        return res.status(400).json({
            error: type === 'group'
                ? 'Each member needs a full name (2–100 characters).'
                : 'Please enter your full name (2–100 characters).',
        });
    }
    if (reason.length < 5 || reason.length > 1000) {
        return res.status(400).json({ error: 'Please describe your reason (5–1000 characters).' });
    }

    const now = nowInTz();
    const validSlot = generateDaySlots(date, consultationType).find((s) => s.startMinute === startMinute);
    if (!isBookableDate(date, now) || !validSlot || !isFutureSlot(date, startMinute, now)) {
        return res.status(400).json({ error: 'That time slot is not available. Please choose another one.' });
    }

    // Check for any overlapping booking on the same date
    const { data: existingRows, error: existingErr } = await db()
        .from(TABLE)
        .select('*')
        .eq('appointment_date', date);
    if (existingErr) return res.status(500).json({ error: existingErr.message });

    const bookedIntervals = existingRows.map(rowInterval);
    if (hasOverlap(validSlot.startMinute, validSlot.endMinute, bookedIntervals)) {
        return res.status(409).json({ error: 'Sorry, someone just booked a slot that overlaps with that time. Please pick another time.' });
    }

    const { data, error } = await db()
        .from(TABLE)
        .insert([{
            student_name: members[0], // the person booking (group representative)
            team_name: teamName,
            members,
            reason,
            appointment_date: date,
            start_hour: Math.floor(startMinute / 60),
            start_minute: startMinute,
            duration_minutes: durationMinutes,
            consultation_type: consultationType,
        }])
        .select('*')
        .single();

    if (error) {
        if (error.code === '23505') {
            return res.status(409).json({ error: 'Sorry, someone just booked that slot. Please pick another time.' });
        }
        if (error.code === '42703' || error.code === 'PGRST204') {
            return res.status(500).json({
                error: 'Database schema needs updating: please run supabase/schema.sql in your Supabase SQL Editor.',
            });
        }
        return res.status(500).json({ error: error.message });
    }

    res.status(201).json({ booking: toBooking(data) });
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
        .select('*')
        .order('appointment_date', { ascending: true })
        .order('start_hour', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    const now = nowInTz();
    const bookings = data.map(toBooking).sort(
        (a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute
    );
    res.json({
        today: now.date,
        currentHour: now.hour,
        currentMinute: now.minuteOfDay,
        bookings,
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
