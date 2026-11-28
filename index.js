const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json({ limit: '20kb' }));

// Serve the frontend (on Vercel, files in /public are served by the CDN automatically)
app.use(express.static(path.join(__dirname, 'public')));

// Serve @supabase/supabase-js UMD bundle for browser WebSockets without an external CDN
app.get('/vendor/supabase.js', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(__dirname, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js'));
});

// Opportunistic background reminder check on API traffic (throttled to once every 30s).
// Disabled on Vercel: serverless functions freeze after responding, which would leave the
// check half-finished. On Vercel the external cron (/api/cron/reminders) does the work.
let lastApiReminderSweepAt = 0;
app.use('/api', (req, res, next) => {
    if (!process.env.VERCEL && req.path !== '/cron/reminders') {
        const nowMs = Date.now();
        if (nowMs - lastApiReminderSweepAt >= 30 * 1000) {
            lastApiReminderSweepAt = nowMs;
            checkAndSendAppointmentReminders().catch((err) => {
                console.error('Background reminder check failed:', err.message || err);
            });
        }
    }
    next();
});

/* ------------------------------------------------------------------ */
/* Configuration & Schedule                                            */
/* ------------------------------------------------------------------ */
// This site is only for one teacher: Arnemie Gayyed.
const TEACHER_NAME = 'Arnemie Gayyed';
const TEACHER_EMAIL = String(process.env.TEACHER_EMAIL || 'nemie07gayyed@gmail.com').trim().toLowerCase();
const REMINDER_MINUTES_BEFORE = 10; // Send reminder to teacher 10 minutes before every appointment
const STUDENT_REMINDER_MINUTES_BEFORE = intEnv('STUDENT_REMINDER_MINUTES_BEFORE', 60) || 60; // Send reminder to student before every appointment

const hm = (h, m) => h * 60 + m;

const SYSTEM_DURATION = 15;       // 15 minutes for System Consultation
const DROPOFF_DURATION = 0;       // Drop-off only (takes 0 minutes off the schedule)
const RETRIEVAL_DURATION = 5;     // 5 minutes for Manuscript Retrieval
const LETTER_DURATION = 5;        // 5 minutes for Communication Letter Signature
const LETTER_PICKUP_DURATION = 5; // 5 minutes for Communication Letter Pickup
const OTHER_DURATION = 10;        // 10 minutes for Other Consultations

const MIN_MEMBERS = 1;        // Solo (1), pair (2), or 3-member Capstone / Thesis groups allowed
const MAX_MEMBERS = 3;
const CANCEL_CUTOFF_MINUTES = 120; // Students can only cancel at least 2 hours (120 minutes) before schedule

const CONSULTATION_TYPES = {
    system: {
        id: 'system',
        title: 'System Consultation',
        description: 'Present and consult about the system, software, or web app your group made.',
        note: 'All members must be present during System Consultations.',
        durationMinutes: SYSTEM_DURATION,
        durationLabel: '15 minutes',
    },
    dropoff: {
        id: 'dropoff',
        title: 'Drop-off Manuscript',
        description: 'Drop off your manuscript only.',
        note: 'Once your manuscript is checked, you will be notified through the school email you used during registration.',
        durationMinutes: DROPOFF_DURATION,
        durationLabel: 'Drop-off only',
    },
    retrieval: {
        id: 'retrieval',
        title: 'Retrieval of Manuscript',
        description: 'Once notified by email that your manuscript is checked, schedule this to discuss the needed changes.',
        note: 'At least 2 or all members must be present, otherwise you will not be accommodated.',
        durationMinutes: RETRIEVAL_DURATION,
        durationLabel: '5 minutes',
    },
    letter: {
        id: 'letter',
        title: 'Communication Letter Signature',
        description: 'Request your adviser’s signature on an official communication letter.',
        note: 'Your letter must already have the initial of Ma’am Melinda Beninsig before requesting your adviser’s signature.',
        durationMinutes: LETTER_DURATION,
        durationLabel: '5 minutes',
        adviserOnly: true,
    },
    letter_pickup: {
        id: 'letter_pickup',
        title: 'Pickup of Communication Letter',
        description: 'Pick up your signed communication letter once notified by email.',
        note: 'Schedule this only after receiving the email notification that your communication letter is ready for pickup.',
        durationMinutes: LETTER_PICKUP_DURATION,
        durationLabel: '5 minutes',
        adviserOnly: true,
    },
    other: {
        id: 'other',
        title: 'Other Consultations',
        description: 'Consult about other Capstone or Thesis concerns.',
        note: 'Available for all students.',
        durationMinutes: OTHER_DURATION,
        durationLabel: '10 minutes',
    },
    defense: {
        id: 'defense',
        title: 'Defense',
        description: 'Schedule your Capstone / Thesis defense.',
        note: 'All members must be present. Capstone 1 / Thesis 1 = 1 hour, Capstone 2 / Thesis 2 = 2 hours.',
        durationMinutes: null, // depends on the defense level (see DEFENSE_LEVELS)
        durationLabel: '1–2 hours',
    },
};

/* ---------- Defense (Capstone / Thesis) ---------- */
// The group's level is saved on the account at registration and can be updated when booking a defense.
const DEFENSE_LEVELS = {
    capstone1: { id: 'capstone1', label: 'Capstone 1', durationMinutes: 60, durationLabel: '1 hour' },
    capstone2: { id: 'capstone2', label: 'Capstone 2', durationMinutes: 120, durationLabel: '2 hours' },
    thesis1: { id: 'thesis1', label: 'Thesis 1', durationMinutes: 60, durationLabel: '1 hour' },
    thesis2: { id: 'thesis2', label: 'Thesis 2', durationMinutes: 120, durationLabel: '2 hours' },
};
const DEFENSE_START_STEP = 5;          // students may start a defense on any 5-minute mark
const MAX_UPCOMING_DEFENSES = 1;       // one upcoming defense per group at a time

const normalizeDefenseLevel = (v) =>
    (Object.prototype.hasOwnProperty.call(DEFENSE_LEVELS, v) ? v : null);

// Available defense windows per day of week (0 = Sun ... 6 = Sat).
// A defense must fit entirely inside one window.
const DEFENSE_WINDOWS_BY_DAY = {
    // MONDAY: 11:30AM - 2:10PM, 3:30PM - 4:50PM
    1: [[hm(11, 30), hm(14, 10)], [hm(15, 30), hm(16, 50)]],
    // TUESDAY: 10:10AM - 11:30AM, 2:10PM - 3:30PM, 4:50PM - 6:10PM
    2: [[hm(10, 10), hm(11, 30)], [hm(14, 10), hm(15, 30)], [hm(16, 50), hm(18, 10)]],
    // WEDNESDAY: 11:30AM - 2:10PM, 3:30PM - 4:50PM
    3: [[hm(11, 30), hm(14, 10)], [hm(15, 30), hm(16, 50)]],
    // THURSDAY: 10:10AM - 11:30AM, 2:10PM - 3:30PM, 4:50PM - 6:10PM
    4: [[hm(10, 10), hm(11, 30)], [hm(14, 10), hm(15, 30)], [hm(16, 50), hm(18, 10)]],
    // FRIDAY: 7:30AM - 8:30AM, 11:30AM - 12:50PM, 4:50PM - 6:10PM
    5: [[hm(7, 30), hm(8, 30)], [hm(11, 30), hm(12, 50)], [hm(16, 50), hm(18, 10)]],
    // SATURDAY: 8:50AM - 12:50PM, 2:10PM - 6:10PM
    6: [[hm(8, 50), hm(12, 50)], [hm(14, 10), hm(18, 10)]],
};

// Available consultation windows per day of week (0 = Sun ... 6 = Sat)
// Every window is composed of 1h 20m (80-minute) blocks.
const WINDOWS_BY_DAY = {
    // TUESDAY: 2:10PM - 3:30PM
    2: [
        [hm(14, 10), hm(15, 30)],
    ],
    // WEDNESDAY: 12:50PM - 2:10PM
    3: [
        [hm(12, 50), hm(14, 10)],
    ],
    // THURSDAY: 2:10PM - 3:30PM
    4: [
        [hm(14, 10), hm(15, 30)],
    ],
};

// Special date-range schedule overrides (seeded on initial setup before custom admin edits)
// Dec 7 – Dec 12: 10:00 AM – 5:00 PM
const FULL_DAY_START_MINUTE = hm(10, 0); // 10:00 AM
const FULL_DAY_END_MINUTE = hm(17, 0);   // 5:00 PM
const FULL_DAY_WINDOW = [FULL_DAY_START_MINUTE, FULL_DAY_END_MINUTE];

const INITIAL_SEEDED_OPEN_DATES = [
    '2026-12-07',
    '2026-12-08',
    '2026-12-09',
    '2026-12-10',
    '2026-12-11',
    '2026-12-12',
];

const CONFIG = {
    location: process.env.MEETING_LOCATION || 'Faculty Office',
    timezone: process.env.TIMEZONE || 'Asia/Manila',
    workingDays: [2, 3, 4],
    bookingEndDate: process.env.BOOKING_END_DATE || null,
};

const TABLE = 'appointments';
const BLOCKED_TABLE = 'blocked_schedules';
const LETTER_PICKUP_TABLE = 'letter_pickup_schedules';
const SETTINGS_TABLE = 'scheduler_settings';
const BOOKING_END_DATE_KEY = 'booking_end_date';
const SCHEDULE_CONFIG_KEY = 'schedule_config_v1';
const BLOCKED_SETTING_SENTINEL_DATE = '1970-01-01';
const BLOCKED_SETTING_PREFIX = '__SETTING_BOOKING_END_DATE__:';

/* ------------------------------------------------------------------ */
/* Supabase client                                                     */
/* ------------------------------------------------------------------ */
function getSupabaseServerKey() {
    return (
        process.env.SUPABASE_SECRET_KEY
        || process.env.SUPABASE_SERVICE_ROLE_KEY
        || process.env.SUPABASE_PUBLISHABLE_KEY
        || process.env.SUPABASE_ANON_KEY
        || null
    );
}

function getSupabasePublicKey() {
    return (
        process.env.SUPABASE_PUBLISHABLE_KEY
        || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
        || process.env.SUPABASE_ANON_KEY
        || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
        || null
    );
}

let supabase = null;
function db() {
    if (supabase) return supabase;
    const url = process.env.SUPABASE_URL;
    const key = getSupabaseServerKey();
    if (!url || !key) {
        const err = new Error('Server is missing SUPABASE_URL / SUPABASE key environment variables.');
        err.status = 500;
        throw err;
    }
    supabase = createClient(url, key, { auth: { persistSession: false } });
    return supabase;
}

/* ------------------------------------------------------------------ */
/* Live Realtime Hub (Supabase WebSockets + SSE + Serverless Pulse)    */
/* ------------------------------------------------------------------ */
const REALTIME_CHANNEL = 'scheduler-live';
let realtimeVersion = Date.now();
let lastRealtimeEvent = {
    version: realtimeVersion,
    type: 'init',
    timestamp: new Date().toISOString(),
};
const sseClients = new Set();
let serverRealtimeChannel = null;

function sendSseKeepalive() {
    for (const res of sseClients) {
        try {
            res.write(': keepalive\n\n');
        } catch {
            sseClients.delete(res);
        }
    }
}

if (!process.env.VERCEL) {
    const keepaliveTimer = setInterval(sendSseKeepalive, 20 * 1000);
    if (keepaliveTimer.unref) keepaliveTimer.unref();
}

function notifyRealtimeListeners(event = {}, { fromSupabaseWs = false } = {}) {
    realtimeVersion = Date.now();
    lastRealtimeEvent = {
        version: realtimeVersion,
        timestamp: new Date().toISOString(),
        ...event,
    };
    const frame = `data: ${JSON.stringify(lastRealtimeEvent)}\n\n`;
    for (const res of sseClients) {
        try {
            res.write(frame);
        } catch {
            sseClients.delete(res);
        }
    }
    if (!fromSupabaseWs && process.env.SUPABASE_URL && getSupabaseServerKey()) {
        try {
            if (serverRealtimeChannel && typeof serverRealtimeChannel.send === 'function') {
                const res = serverRealtimeChannel.send({
                    type: 'broadcast',
                    event: 'schedule_change',
                    payload: lastRealtimeEvent,
                });
                if (res && typeof res.catch === 'function') res.catch(() => {});
                return res;
            }
            if (process.env.VERCEL) {
                const tmpClient = db();
                const tmpChannel = tmpClient.channel(REALTIME_CHANNEL);
                if (typeof tmpChannel.httpSend === 'function') {
                    return tmpChannel
                        .httpSend('schedule_change', lastRealtimeEvent)
                        .catch(() => {})
                        .finally(() => {
                            if (typeof tmpClient.removeChannel === 'function') {
                                Promise.resolve(tmpClient.removeChannel(tmpChannel)).catch(() => {});
                            }
                        });
                }
            }
        } catch (err) {
            console.error('Supabase Realtime broadcast error:', err.message || err);
        }
    }
    return Promise.resolve();
}

function startServerRealtimeSubscription() {
    if (process.env.VERCEL || serverRealtimeChannel) return;
    if (!process.env.SUPABASE_URL || !(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)) {
        return;
    }
    try {
        const client = db();
        serverRealtimeChannel = client
            .channel(REALTIME_CHANNEL, { config: { broadcast: { self: false } } })
            .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, (payload) => {
                const row = payload?.new || payload?.old || {};
                notifyRealtimeListeners(
                    {
                        type: `db_${String(payload?.eventType || 'change').toLowerCase()}`,
                        table: TABLE,
                        date: row.appointment_date || null,
                        bookingId: row.id || null,
                    },
                    { fromSupabaseWs: true }
                );
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: BLOCKED_TABLE }, (payload) => {
                const row = payload?.new || payload?.old || {};
                notifyRealtimeListeners(
                    {
                        type: `block_${String(payload?.eventType || 'change').toLowerCase()}`,
                        table: BLOCKED_TABLE,
                        date: row.blocked_date || null,
                    },
                    { fromSupabaseWs: true }
                );
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: LETTER_PICKUP_TABLE }, (payload) => {
                const row = payload?.new || payload?.old || {};
                lastScheduleConfigLoadedAt = 0;
                notifyRealtimeListeners(
                    {
                        type: `letter_pickup_schedule_${String(payload?.eventType || 'change').toLowerCase()}`,
                        table: LETTER_PICKUP_TABLE,
                        date: row.available_date || null,
                    },
                    { fromSupabaseWs: true }
                );
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: SETTINGS_TABLE }, (payload) => {
                const row = payload?.new || payload?.old || {};
                lastScheduleConfigLoadedAt = 0;
                lastSettingsLoadedAt = 0;
                notifyRealtimeListeners(
                    {
                        type: 'schedule_config_updated',
                        table: SETTINGS_TABLE,
                        key: row.key || null,
                    },
                    { fromSupabaseWs: true }
                );
            })
            .on('broadcast', { event: 'schedule_change' }, ({ payload }) => {
                if (payload?.type === 'schedule_config_updated') {
                    lastScheduleConfigLoadedAt = 0;
                }
                if (payload?.bookingEndDate && parseDate(payload.bookingEndDate)) {
                    cachedBookingEndDate = payload.bookingEndDate;
                    lastSettingsLoadedAt = Date.now();
                }
                notifyRealtimeListeners(payload || { type: 'broadcast' }, { fromSupabaseWs: true });
            });

        serverRealtimeChannel.subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log(`Supabase Realtime subscribed on channel "${REALTIME_CHANNEL}"`);
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                console.warn(`Supabase Realtime channel status: ${status}`);
            }
        });
    } catch (err) {
        console.warn('Could not start Supabase Realtime WebSocket subscription:', err.message || err);
    }
}

/* ------------------------------------------------------------------ */
/* Student accounts (university email + OTP verification)              */
/* ------------------------------------------------------------------ */
const STUDENTS_TABLE = 'students';
const STUDENT_LOGS_TABLE = 'student_update_logs';
const OTP_TABLE = 'email_otps';
const EMAIL_LOGS_TABLE = 'email_logs';
const EMAIL_LOGS_FALLBACK_KEY = 'email_logs_v1';
const MAX_EMAIL_LOGS_RETURNED = 300;
const MAX_FALLBACK_EMAIL_LOGS = 250;
const SESSION_COOKIE = 'sid';

function intEnv(name, fallback) {
    const v = parseInt(process.env[name], 10);
    return Number.isInteger(v) && v >= 0 ? v : fallback;
}

const AUTH = {
    // e.g. "myuniversity.edu.ph" or "myuniversity.edu.ph,student.myuniversity.edu.ph"
    allowedDomains: String(process.env.ALLOWED_EMAIL_DOMAINS || '')
        .split(',')
        .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
        .filter(Boolean),
    sessionDays: intEnv('SESSION_DAYS', 7) || 7,
    otpMinutes: 10,          // a code is valid for 10 minutes
    otpMaxAttempts: 5,       // wrong guesses before the code is destroyed
    otpResendSeconds: 60,    // cooldown between code emails
    loginMaxFailures: 5,     // wrong passwords before the account is temporarily locked
    loginLockMinutes: 15,
    // How many upcoming consultations one student may hold at a time (0 = unlimited)
    maxActiveBookings: intEnv('MAX_ACTIVE_BOOKINGS_PER_STUDENT', 2),
};

function httpError(status, message, extra = {}) {
    const err = new Error(message);
    err.status = status;
    Object.assign(err, extra);
    return err;
}

function sessionSecret() {
    const s = process.env.SESSION_SECRET;
    if (!s || s.length < 32) {
        throw httpError(500, 'Server is missing SESSION_SECRET (at least 32 random characters).');
    }
    return s;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizeEmail = (v) => String(v ?? '').trim().toLowerCase();

/** Only emails from the configured university domain(s) (or their subdomains) may register. */
function isUniversityEmail(email) {
    if (!AUTH.allowedDomains.length) {
        throw httpError(500, 'Server is missing ALLOWED_EMAIL_DOMAINS (your university email domain).');
    }
    if (email.length > 254 || !EMAIL_RE.test(email)) return false;
    const domain = email.split('@').pop();
    return AUTH.allowedDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

function domainHint() {
    return AUTH.allowedDomains.map((d) => `@${d}`).join(' or ');
}

/* ---------- passwords (scrypt, built into Node) ---------- */
const scryptAsync = (password, salt) =>
    new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key)));
    });

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = await scryptAsync(password, salt);
    return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
    const [alg, salt, key] = String(stored || '').split('$');
    if (alg !== 'scrypt' || !salt || !key) return false;
    const expected = Buffer.from(key, 'base64');
    const actual = await scryptAsync(password, Buffer.from(salt, 'base64'));
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function validatePassword(password) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
        return 'Password must be 8–128 characters long.';
    }
    return null;
}

/* ---------- sessions (signed, HttpOnly cookie) ---------- */
const signValue = (value) => crypto.createHmac('sha256', sessionSecret()).update(value).digest('base64url');
// Changing the password changes this value, which logs out every other session.
const passwordVersion = (hash) => crypto.createHash('sha256').update(String(hash)).digest('base64url').slice(0, 16);

function getCookie(req, name) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i > -1 && part.slice(0, i).trim() === name) {
            try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
        }
    }
    return null;
}

const cookieOptions = () => ({
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(process.env.VERCEL) || process.env.NODE_ENV === 'production',
    path: '/',
});

function setSession(res, student) {
    const payload = Buffer.from(JSON.stringify({
        sid: student.id,
        pv: passwordVersion(student.password_hash),
        exp: Date.now() + AUTH.sessionDays * 24 * 60 * 60 * 1000,
    })).toString('base64url');
    res.cookie(SESSION_COOKIE, `${payload}.${signValue(payload)}`, {
        ...cookieOptions(),
        maxAge: AUTH.sessionDays * 24 * 60 * 60 * 1000,
    });
}

function clearSession(res) {
    res.clearCookie(SESSION_COOKIE, cookieOptions());
}

function readSession(req) {
    const token = getCookie(req, SESSION_COOKIE);
    if (!token) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const a = Buffer.from(sig);
    const b = Buffer.from(signValue(payload));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!data || typeof data.exp !== 'number' || data.exp < Date.now()) return null;
        return data;
    } catch {
        return null;
    }
}

async function currentStudent(req) {
    const session = readSession(req);
    if (!session || !/^[0-9a-f-]{36}$/i.test(String(session.sid))) return null;
    const { data, error } = await db().from(STUDENTS_TABLE).select('*').eq('id', session.sid).maybeSingle();
    if (error) throw error;
    if (!data || passwordVersion(data.password_hash) !== session.pv) return null;
    return data;
}

async function requireStudent(req, res, next) {
    const student = await currentStudent(req);
    if (!student) {
        clearSession(res);
        return res.status(401).json({ error: 'Please log in with your university email to book.', code: 'AUTH_REQUIRED' });
    }
    req.student = student;
    next();
}

function latestIsoTimestamp(...values) {
    let bestIso = null;
    let bestMs = -Infinity;
    for (const v of values) {
        if (!v) continue;
        const ms = new Date(v).getTime();
        if (Number.isFinite(ms) && ms > bestMs) {
            bestMs = ms;
            bestIso = new Date(ms).toISOString();
        }
    }
    return bestIso;
}

function extractStudentNotificationTimestamps(studentRow, appointmentRows = []) {
    const history = Array.isArray(studentRow?.change_history) ? studentRow.change_history : [];
    const historyManuscriptTimes = history
        .filter((h) => h && h.type === 'notification' && h.kind === 'manuscript_ready' && h.notifiedAt)
        .map((h) => h.notifiedAt);
    const historyLetterTimes = history
        .filter((h) => h && h.type === 'notification' && h.kind === 'letter_ready' && h.notifiedAt)
        .map((h) => h.notifiedAt);

    const dropoffNotifiedTimes = (appointmentRows || [])
        .filter((r) => isActiveRow(r) && r.consultation_type === 'dropoff' && r.notified_at)
        .map((r) => r.notified_at);
    const letterNotifiedTimes = (appointmentRows || [])
        .filter((r) => isActiveRow(r) && r.consultation_type === 'letter' && r.notified_at)
        .map((r) => r.notified_at);

    return {
        manuscriptNotifiedAt: latestIsoTimestamp(
            studentRow?.manuscript_notified_at,
            ...historyManuscriptTimes,
            ...dropoffNotifiedTimes
        ),
        letterNotifiedAt: latestIsoTimestamp(
            studentRow?.letter_notified_at,
            ...historyLetterTimes,
            ...letterNotifiedTimes
        ),
    };
}

function computePickupEligibility(studentRow, appointmentRows = [], now = nowInTz()) {
    const { manuscriptNotifiedAt, letterNotifiedAt } = extractStudentNotificationTimestamps(studentRow, appointmentRows);

    const isUpcomingAppointment = (r) => {
        if (!isActiveRow(r)) return false;
        if (r.status && r.status !== 'scheduled') return false;
        if (r.appointment_date < now.date) return false;
        const [, end] = rowInterval(r);
        return r.appointment_date > now.date || end > now.minuteOfDay;
    };

    const countsTowardNotification = (r) => isActiveRow(r) && r.status !== 'no_show';

    const latestRetrievalBookedAt = latestIsoTimestamp(
        ...(appointmentRows || [])
            .filter((r) => countsTowardNotification(r) && r.consultation_type === 'retrieval')
            .map((r) => r.created_at)
    );
    const latestLetterPickupBookedAt = latestIsoTimestamp(
        ...(appointmentRows || [])
            .filter((r) => countsTowardNotification(r) && r.consultation_type === 'letter_pickup')
            .map((r) => r.created_at)
    );

    const hasUpcomingRetrieval = (appointmentRows || []).some(
        (r) => isUpcomingAppointment(r) && r.consultation_type === 'retrieval'
    );
    const hasUpcomingLetterPickup = (appointmentRows || []).some(
        (r) => isUpcomingAppointment(r) && r.consultation_type === 'letter_pickup'
    );

    const hasUnclaimedRetrievalNotification = Boolean(
        manuscriptNotifiedAt
        && (!latestRetrievalBookedAt || new Date(manuscriptNotifiedAt).getTime() > new Date(latestRetrievalBookedAt).getTime())
    );
    const hasUnclaimedLetterNotification = Boolean(
        letterNotifiedAt
        && (!latestLetterPickupBookedAt || new Date(letterNotifiedAt).getTime() > new Date(latestLetterPickupBookedAt).getTime())
    );

    const canBookRetrieval = !hasUpcomingRetrieval && hasUnclaimedRetrievalNotification;
    const canBookLetterPickup = !hasUpcomingLetterPickup && hasUnclaimedLetterNotification;

    return {
        manuscriptNotifiedAt,
        letterNotifiedAt,
        canBookRetrieval,
        canBookLetterPickup,
        hasUpcomingRetrieval,
        hasUpcomingLetterPickup,
        retrievalAlreadyBookedForNotification: Boolean(manuscriptNotifiedAt && !hasUnclaimedRetrievalNotification),
        letterPickupAlreadyBookedForNotification: Boolean(letterNotifiedAt && !hasUnclaimedLetterNotification),
    };
}

async function recordStudentPickupNotification({ studentId = null, email = null, kind, notifiedAt = new Date().toISOString() }) {
    if (!['manuscript_ready', 'letter_ready'].includes(kind)) return null;
    let studentRow = null;

    if (studentId && /^[0-9a-f-]{36}$/i.test(String(studentId))) {
        const { data } = await db().from(STUDENTS_TABLE).select('*').eq('id', studentId).maybeSingle();
        studentRow = data || null;
    }
    if (!studentRow && email) {
        const normalized = normalizeEmail(email);
        if (normalized) {
            studentRow = await findStudentByEmail(normalized).catch(() => null);
        }
    }
    if (!studentRow) return null;

    const rawHistory = Array.isArray(studentRow.change_history) ? studentRow.change_history : [];
    const memberEmailsMeta = rawHistory.find((h) => h && h.type === 'member_emails');
    const prevHistory = rawHistory.filter((h) => h && h.type !== 'member_emails');
    const notifEntry = {
        id: crypto.randomUUID(),
        type: 'notification',
        kind,
        notifiedAt,
    };
    const nextHistory = [
        ...(memberEmailsMeta ? [memberEmailsMeta] : []),
        notifEntry,
        ...prevHistory,
    ].slice(0, 50);
    const colName = kind === 'manuscript_ready' ? 'manuscript_notified_at' : 'letter_notified_at';

    let { error } = await db()
        .from(STUDENTS_TABLE)
        .update({
            [colName]: notifiedAt,
            change_history: nextHistory,
        })
        .eq('id', studentRow.id);

    if (error && ['42703', 'PGRST204'].includes(error.code)) {
        const fallbackRes = await db()
            .from(STUDENTS_TABLE)
            .update({ change_history: nextHistory })
            .eq('id', studentRow.id);
        error = fallbackRes.error;
    }
    if (error) {
        console.error(`Failed to record ${kind} notification on student ${studentRow.id}:`, error);
    }
    return studentRow;
}

function extractStudentMemberEmails(studentRow) {
    if (!studentRow) return [];
    const primary = normalizeEmail(studentRow.email);
    const members = Array.isArray(studentRow.members) && studentRow.members.length
        ? studentRow.members
        : (studentRow.full_name ? [studentRow.full_name] : []);
    const targetLen = Math.max(1, Math.min(MAX_MEMBERS, members.length || 1));

    let rawSource = null;
    if (Array.isArray(studentRow.member_emails) && studentRow.member_emails.length > 0) {
        rawSource = studentRow.member_emails;
    } else if (Array.isArray(studentRow.change_history)) {
        const metaEntry = studentRow.change_history.find(
            (h) => h && h.type === 'member_emails' && Array.isArray(h.memberEmails)
        );
        if (metaEntry) rawSource = metaEntry.memberEmails;
    }

    const out = [primary || ''];
    for (let i = 1; i < targetLen; i += 1) {
        const candidate = normalizeEmail(rawSource?.[i] || '');
        out.push(candidate && EMAIL_RE.test(candidate) && candidate !== primary ? candidate : '');
    }
    return out;
}

function validateAndAlignMemberEmails(primaryEmail, members, rawMemberEmails, errorField = 'regMembers') {
    const cleanPrimary = normalizeEmail(primaryEmail);
    const aligned = [cleanPrimary];
    const seen = new Set(cleanPrimary ? [cleanPrimary] : []);
    const rawArr = Array.isArray(rawMemberEmails) ? rawMemberEmails : [];

    for (let i = 1; i < members.length; i += 1) {
        const mEmail = normalizeEmail(rawArr[i] ?? '');
        if (!mEmail) {
            aligned.push('');
            continue;
        }
        if (!isUniversityEmail(mEmail)) {
            return {
                field: errorField,
                error: `Please enter a valid university email (${domainHint()}) for ${members[i] || `Member ${i + 1}`}, or leave it blank.`,
            };
        }
        if (seen.has(mEmail)) {
            return {
                field: errorField,
                error: mEmail === cleanPrimary
                    ? `Groupmate email (${mEmail}) cannot be the same as the main representative's email.`
                    : `Duplicate groupmate email (${mEmail}). Each member must use their own university email.`,
            };
        }
        seen.add(mEmail);
        aligned.push(mEmail);
    }

    return { memberEmails: aligned };
}

function getGroupRecipientEmails({ primaryEmail = null, memberEmails = null, studentRow = null, booking = null } = {}) {
    const seen = new Set();
    const recipients = [];
    const addEmail = (raw) => {
        const clean = normalizeEmail(raw);
        if (!clean || clean.length > 254 || !EMAIL_RE.test(clean) || seen.has(clean)) return;
        seen.add(clean);
        recipients.push(clean);
    };

    addEmail(primaryEmail);
    addEmail(booking?.studentEmail);
    addEmail(studentRow?.email);
    if (Array.isArray(memberEmails)) memberEmails.forEach(addEmail);
    if (Array.isArray(booking?.memberEmails)) booking.memberEmails.forEach(addEmail);
    if (studentRow) extractStudentMemberEmails(studentRow).forEach(addEmail);

    return recipients;
}

const publicStudent = (s) => {
    const { manuscriptNotifiedAt, letterNotifiedAt } = extractStudentNotificationTimestamps(s);
    const filteredHistory = (Array.isArray(s.change_history) ? s.change_history : [])
        .filter((h) => h && h.type !== 'notification' && h.type !== 'member_emails');
    const members = Array.isArray(s.members) && s.members.length ? s.members : [s.full_name];
    const memberEmails = extractStudentMemberEmails(s);
    return {
        id: s.id,
        name: s.full_name,
        email: s.email,
        capstoneTitle: s.capstone_title || null,
        instructorRole: s.instructor_role || null,
        projectLevel: normalizeDefenseLevel(s.project_level),
        members,
        memberEmails,
        updatedAt: s.updated_at || null,
        manuscriptNotifiedAt,
        letterNotifiedAt,
        changeHistory: filteredHistory,
    };
};

/* ---------- email (SMTP) ---------- */
let transporter = null;
function mailer() {
    if (transporter) return transporter;
    const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
        throw httpError(500, 'Server is missing SMTP_HOST / SMTP_USER / SMTP_PASS environment variables.');
    }
    const port = Number(process.env.SMTP_PORT) || 587;
    transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port,
        secure: port === 465, // 465 = SSL, 587 = STARTTLS
        auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    return transporter;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/* ---------- outgoing email activity tracking (instructor + system) ---------- */
const VALID_EMAIL_CATEGORIES = new Set(['reminder', 'pickup_notice', 'booking', 'cancellation', 'custom', 'otp']);
const recentMemoryEmailLogs = [];

function normalizeEmailLogRow(r) {
    if (!r || typeof r !== 'object') return null;
    const sentBy = r.sent_by === 'instructor' || r.sentBy === 'instructor' ? 'instructor' : 'system';
    const rawCat = r.category || 'custom';
    const category = VALID_EMAIL_CATEGORIES.has(rawCat) ? rawCat : 'custom';
    const recipientsRaw = Array.isArray(r.recipients)
        ? r.recipients
        : typeof r.recipients === 'string' && r.recipients
            ? r.recipients.split(',')
            : [];
    const recipients = [...new Set(recipientsRaw.map((e) => normalizeEmail(e)).filter(Boolean))];
    return {
        id: String(r.id || crypto.randomUUID()),
        sentBy,
        category,
        emailType: String(r.email_type || r.emailType || category),
        status: (r.status === 'failed') ? 'failed' : 'sent',
        subject: String(r.subject || '(No subject)').slice(0, 300),
        recipients,
        recipientName: r.recipient_name ?? r.recipientName ?? null,
        capstoneTitle: r.capstone_title ?? r.capstoneTitle ?? null,
        studentId: r.student_id ?? r.studentId ?? null,
        bookingId: r.booking_id ?? r.bookingId ?? null,
        bodyPreview: r.body_preview ?? r.bodyPreview ?? null,
        errorMessage: r.error_message ?? r.errorMessage ?? null,
        createdAt: r.created_at || r.createdAt || new Date().toISOString(),
    };
}

async function appendFallbackEmailLog(dbRow) {
    try {
        const { data } = await db()
            .from(SETTINGS_TABLE)
            .select('value')
            .eq('key', EMAIL_LOGS_FALLBACK_KEY)
            .maybeSingle();
        let existing = [];
        if (data?.value) {
            try {
                const parsed = JSON.parse(data.value);
                if (Array.isArray(parsed)) existing = parsed;
            } catch { /* ignore malformed json */ }
        }
        const next = [dbRow, ...existing.filter((x) => x && x.id !== dbRow.id)].slice(0, MAX_FALLBACK_EMAIL_LOGS);
        await db()
            .from(SETTINGS_TABLE)
            .upsert(
                [{ key: EMAIL_LOGS_FALLBACK_KEY, value: JSON.stringify(next), updated_at: new Date().toISOString() }],
                { onConflict: 'key' }
            );
    } catch (err) {
        console.warn('Fallback email log save skipped:', err.message || err);
    }
}

async function recordEmailLog(entry = {}, { emitRealtime = true } = {}) {
    const recipientsInput = Array.isArray(entry.recipients)
        ? entry.recipients
        : entry.to
            ? (Array.isArray(entry.to) ? entry.to : [entry.to])
            : [];
    const recipients = [...new Set(recipientsInput.map((e) => normalizeEmail(e)).filter(Boolean))];
    const sentBy = entry.sentBy === 'instructor' ? 'instructor' : 'system';
    const category = VALID_EMAIL_CATEGORIES.has(entry.category) ? entry.category : 'custom';
    const uuidRe = /^[0-9a-f-]{36}$/i;
    const dbRow = {
        id: crypto.randomUUID(),
        sent_by: sentBy,
        category,
        email_type: String(entry.emailType || category).slice(0, 64),
        status: entry.status === 'failed' ? 'failed' : 'sent',
        subject: String(entry.subject || '(No subject)').trim().slice(0, 300),
        recipients,
        recipient_name: entry.recipientName ? String(entry.recipientName).trim().slice(0, 200) : null,
        capstone_title: entry.capstoneTitle ? String(entry.capstoneTitle).trim().slice(0, 200) : null,
        student_id: entry.studentId && uuidRe.test(String(entry.studentId)) ? String(entry.studentId) : null,
        booking_id: entry.bookingId && uuidRe.test(String(entry.bookingId)) ? String(entry.bookingId) : null,
        body_preview: entry.bodyPreview ? String(entry.bodyPreview).trim().slice(0, 1500) : null,
        error_message: entry.errorMessage ? String(entry.errorMessage).trim().slice(0, 500) : null,
        created_at: entry.createdAt || new Date().toISOString(),
    };

    const serialized = normalizeEmailLogRow(dbRow);
    recentMemoryEmailLogs.unshift(serialized);
    if (recentMemoryEmailLogs.length > MAX_FALLBACK_EMAIL_LOGS) {
        recentMemoryEmailLogs.length = MAX_FALLBACK_EMAIL_LOGS;
    }

    try {
        const { error } = await db().from(EMAIL_LOGS_TABLE).insert([dbRow]);
        if (error) {
            if (['42P01', 'PGRST205', '42703', 'PGRST204'].includes(error.code)) {
                await appendFallbackEmailLog(dbRow);
            } else {
                console.warn('Could not insert email_logs row:', error.message || error);
            }
        }
    } catch (err) {
        console.warn('Could not persist email log:', err.message || err);
    }

    if (emitRealtime) {
        const rt = notifyRealtimeListeners({
            type: 'email_logged',
            sentBy: dbRow.sent_by,
            category: dbRow.category,
        });
        if (process.env.VERCEL) await rt;
    }

    return serialized;
}

async function sendOtpEmail(to, code, purpose, name) {
    const isReset = purpose === 'reset';
    const isEmailChange = purpose === 'email_change';
    const subject = isReset
        ? `${code} is your password reset code`
        : isEmailChange
            ? `${code} is your email verification code`
            : `${code} is your verification code`;
    const maskedSubject = isReset
        ? '•••••• is your password reset code'
        : isEmailChange
            ? '•••••• is your email verification code'
            : '•••••• is your verification code';
    const emailType = isReset
        ? 'otp_reset'
        : isEmailChange
            ? 'otp_email_change'
            : 'otp_register';
    const intro = isReset
        ? `Use the code below to reset your password for booking consultations with ${TEACHER_NAME}.`
        : isEmailChange
            ? `Use the code below to verify your new university email address for booking consultations with ${TEACHER_NAME}.`
            : `Use the code below to verify your university email and finish creating your account for booking consultations with ${TEACHER_NAME}.`;
    const greeting = name ? `Hi ${name},` : 'Hi,';
    const footer = `This code expires in ${AUTH.otpMinutes} minutes. If you didn't request it, you can ignore this email.`;
    const maskedBodyPreview = `${greeting}\n\n${intro}\n\n    ••••••\n\n${footer}`;

    try {
        await mailer().sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to,
            subject,
            text: `${greeting}\n\n${intro}\n\n    ${code}\n\n${footer}`,
            html: `
                <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;color:#0f172a">
                    <p>${escapeHtml(greeting)}</p>
                    <p>${escapeHtml(intro)}</p>
                    <p style="font-size:32px;font-weight:700;letter-spacing:8px;text-align:center;
                              background:#f0fdfa;color:#0f766e;padding:16px;border-radius:12px">${code}</p>
                    <p style="color:#64748b;font-size:13px">${escapeHtml(footer)}</p>
                </div>`,
        });
        await recordEmailLog({
            sentBy: 'system',
            category: 'otp',
            emailType,
            status: 'sent',
            subject: maskedSubject,
            recipients: [to],
            recipientName: name || null,
            bodyPreview: maskedBodyPreview,
        });
    } catch (err) {
        await recordEmailLog({
            sentBy: 'system',
            category: 'otp',
            emailType,
            status: 'failed',
            subject: maskedSubject,
            recipients: [to],
            recipientName: name || null,
            bodyPreview: maskedBodyPreview,
            errorMessage: err.message || String(err),
        });
        throw err;
    }
}

/* ---------- one-time codes (stored permanently in Supabase) ---------- */
const otpHash = (email, purpose, code) =>
    crypto.createHmac('sha256', sessionSecret()).update(`${purpose}:${email}:${code}`).digest('hex');

async function issueOtp(email, purpose, { payload = null, name = null } = {}) {
    const purposeList = purpose === 'email_change' ? ['email_change', 'register'] : [purpose];
    const { data: existing, error } = await db()
        .from(OTP_TABLE)
        .select('id, created_at, status')
        .eq('email', email)
        .in('purpose', purposeList)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    if (existing && existing.status !== 'send_failed') {
        const elapsed = Math.floor((Date.now() - new Date(existing.created_at).getTime()) / 1000);
        const wait = AUTH.otpResendSeconds - elapsed;
        if (wait > 0) {
            throw httpError(429, `Please wait ${wait} seconds before requesting a new code.`, { retryAfter: wait });
        }
    }

    // Mark any older pending codes for this email+purpose as superseded so only the newest code works
    await db()
        .from(OTP_TABLE)
        .update({ status: 'superseded' })
        .eq('email', email)
        .in('purpose', purposeList)
        .eq('status', 'pending');

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const now = Date.now();
    const baseOtpRow = {
        email,
        student_name: name || payload?.name || null,
        capstone_title: payload?.capstoneTitle || null,
        instructor_role: payload?.instructorRole || null,
        members: Array.isArray(payload?.members) ? payload.members : null,
        purpose,
        otp_code: code,
        code_hash: otpHash(email, purpose, code),
        status: 'pending',
        payload,
        attempts: 0,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + AUTH.otpMinutes * 60 * 1000).toISOString(),
    };
    const rowData = Array.isArray(payload?.memberEmails)
        ? { ...baseOtpRow, member_emails: payload.memberEmails }
        : baseOtpRow;

    let { data: inserted, error: insertErr } = await db()
        .from(OTP_TABLE)
        .insert([rowData])
        .select('id')
        .single();
    if (insertErr && ['42703', 'PGRST204'].includes(insertErr.code)) {
        const retryWithoutCol = await db()
            .from(OTP_TABLE)
            .insert([baseOtpRow])
            .select('id')
            .single();
        inserted = retryWithoutCol.data;
        insertErr = retryWithoutCol.error;
    }
    if (insertErr && insertErr.code === '23514' && purpose === 'email_change') {
        const fallbackRes = await db()
            .from(OTP_TABLE)
            .insert([{ ...baseOtpRow, purpose: 'register' }])
            .select('id')
            .single();
        inserted = fallbackRes.data;
        insertErr = fallbackRes.error;
    }
    if (insertErr) throw insertErr;

    try {
        await sendOtpEmail(email, code, purpose, name);
    } catch (err) {
        console.error('SMTP error:', err);
        await db().from(OTP_TABLE).update({ status: 'send_failed' }).eq('id', inserted.id);
        if (err.status) throw err;
        throw httpError(502, 'We could not send the verification email right now. Please try again later.');
    }
}

/** Checks a code; marks the row verified and returns it (with its payload) on success, otherwise throws. */
async function consumeOtp(email, purpose, code) {
    const purposeList = purpose === 'email_change' ? ['email_change', 'register'] : [purpose];
    const { data: row, error } = await db()
        .from(OTP_TABLE)
        .select('*')
        .eq('email', email)
        .in('purpose', purposeList)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    if (!row || row.status !== 'pending') {
        throw httpError(400, 'No active code for this email. Please request a new one.');
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
        await db().from(OTP_TABLE).update({ status: 'expired' }).eq('id', row.id);
        throw httpError(400, 'That code has expired. Please request a new one.');
    }
    if (row.attempts >= AUTH.otpMaxAttempts) {
        await db().from(OTP_TABLE).update({ status: 'failed' }).eq('id', row.id);
        throw httpError(429, 'Too many incorrect attempts. Please request a new code.');
    }

    const given = Buffer.from(otpHash(email, purpose, String(code ?? '').trim()));
    const expected = Buffer.from(row.code_hash);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        const attempts = row.attempts + 1;
        const left = AUTH.otpMaxAttempts - attempts;
        if (left <= 0) {
            await db().from(OTP_TABLE).update({ attempts, status: 'failed' }).eq('id', row.id);
            throw httpError(429, 'Too many incorrect attempts. Please request a new code.');
        }
        await db().from(OTP_TABLE).update({ attempts }).eq('id', row.id);
        throw httpError(400, `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.`);
    }

    await db()
        .from(OTP_TABLE)
        .update({ status: 'verified', verified_at: new Date().toISOString() })
        .eq('id', row.id);
    return row;
}

async function findStudentByEmail(email) {
    const { data, error } = await db().from(STUDENTS_TABLE).select('*').eq('email', email).maybeSingle();
    if (error) throw error;
    return data;
}

async function findStudentByCapstoneTitle(capstoneTitle, excludeStudentId = null) {
    const clean = cleanName(capstoneTitle);
    if (!clean) return null;
    const escaped = clean.replace(/[%_\\]/g, (m) => `\\${m}`);
    let query = db()
        .from(STUDENTS_TABLE)
        .select('id, full_name, email, capstone_title')
        .ilike('capstone_title', escaped);
    if (excludeStudentId) {
        query = query.neq('id', excludeStudentId);
    }
    const { data, error } = await query.limit(5);
    if (error) {
        if (['42703', 'PGRST204'].includes(error.code)) return null;
        throw error;
    }
    const normTarget = clean.toLowerCase();
    return (data || []).find((row) => cleanName(row.capstone_title).toLowerCase() === normTarget) || null;
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

/* ---------- Dynamic Schedule Configuration (Consultations, Defenses, Letter Pickups) ---------- */
const SCHEDULE_CONFIG_VERSION = 2;
const SCHEDULE_CATEGORIES = ['consultation', 'defense', 'letter_pickup'];
const SCHEDULE_MODES = ['full_day', 'regular', 'custom'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function normalizeWindowIntervals(rawWindows, minDuration = 5) {
    if (!Array.isArray(rawWindows)) return [];
    const valid = [];
    for (const item of rawWindows) {
        const s = Array.isArray(item) ? Number(item[0]) : Number(item?.startMinute);
        const e = Array.isArray(item) ? Number(item[1]) : Number(item?.endMinute);
        if (Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e <= 1440 && e - s >= minDuration) {
            valid.push([s, e]);
        }
    }
    valid.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const [s, e] of valid) {
        const last = merged[merged.length - 1];
        if (last && s <= last[1]) {
            last[1] = Math.max(last[1], e);
        } else {
            merged.push([s, e]);
        }
    }
    return merged;
}

function cloneHoursTable(table) {
    const out = {};
    for (let d = 0; d <= 6; d += 1) {
        out[d] = Array.isArray(table[d]) ? table[d].map(([s, e]) => [s, e]) : [];
    }
    return out;
}

function normalizeHoursByDayMap(rawMap, fallbackTable, minDuration = 5) {
    if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
        return cloneHoursTable(fallbackTable);
    }
    const out = {};
    for (let d = 0; d <= 6; d += 1) {
        if (Object.prototype.hasOwnProperty.call(rawMap, d) || Object.prototype.hasOwnProperty.call(rawMap, String(d))) {
            const rawWins = rawMap[d] ?? rawMap[String(d)];
            out[d] = normalizeWindowIntervals(rawWins, minDuration);
        } else {
            out[d] = Array.isArray(fallbackTable[d]) ? fallbackTable[d].map(([s, e]) => [s, e]) : [];
        }
    }
    return out;
}

function buildNovemberSeededOpenDates(consultationHoursByDay = WINDOWS_BY_DAY, defenseHoursByDay = DEFENSE_WINDOWS_BY_DAY) {
    const seeded = [];
    // Preset November 2026 schedule:
    // - Consultations on Tuesdays, Wednesdays, and Thursdays using regular Consultation Hours
    // - Defenses on Mondays–Saturdays using regular Defense Hours
    for (let day = 1; day <= 30; day += 1) {
        const date = `2026-11-${String(day).padStart(2, '0')}`;
        const dow = new Date(Date.UTC(2026, 10, day)).getUTCDay();
        const consultWins = Array.isArray(consultationHoursByDay[dow]) ? consultationHoursByDay[dow] : [];
        if (consultWins.length > 0) {
            seeded.push({
                id: `seed-consultation-${date}`,
                date,
                category: 'consultation',
                mode: 'regular',
                windows: consultWins.map(([s, e]) => [s, e]),
                note: null,
                updatedAt: null,
            });
        }
        const defWins = Array.isArray(defenseHoursByDay[dow]) ? defenseHoursByDay[dow] : [];
        if (defWins.length > 0) {
            seeded.push({
                id: `seed-defense-${date}`,
                date,
                category: 'defense',
                mode: 'regular',
                windows: defWins.map(([s, e]) => [s, e]),
                note: null,
                updatedAt: null,
            });
        }
    }
    return seeded;
}

function buildDefaultScheduleConfig() {
    const consultationHoursByDay = cloneHoursTable(WINDOWS_BY_DAY);
    const defenseHoursByDay = cloneHoursTable(DEFENSE_WINDOWS_BY_DAY);
    const openDates = buildNovemberSeededOpenDates(consultationHoursByDay, defenseHoursByDay);
    for (const date of INITIAL_SEEDED_OPEN_DATES) {
        openDates.push({
            id: `seed-consultation-${date}`,
            date,
            category: 'consultation',
            mode: 'full_day',
            windows: [[FULL_DAY_START_MINUTE, FULL_DAY_END_MINUTE]],
            note: null,
            updatedAt: null,
        });
        openDates.push({
            id: `seed-defense-${date}`,
            date,
            category: 'defense',
            mode: 'full_day',
            windows: [[FULL_DAY_START_MINUTE, FULL_DAY_END_MINUTE]],
            note: null,
            updatedAt: null,
        });
    }
    return indexScheduleConfig({
        version: SCHEDULE_CONFIG_VERSION,
        consultationHoursByDay,
        defenseHoursByDay,
        openDates,
    });
}

function indexScheduleConfig(cfg) {
    const byDateCategory = new Map();
    for (const entry of cfg.openDates || []) {
        byDateCategory.set(`${entry.date}|${entry.category}`, entry);
    }
    cfg.byDateCategory = byDateCategory;
    return cfg;
}

function normalizeScheduleConfigObject(raw) {
    if (!raw || typeof raw !== 'object') return buildDefaultScheduleConfig();
    const rawVersion = Number(raw.version) || 1;
    const consultationHoursByDay = normalizeHoursByDayMap(raw.consultationHoursByDay, WINDOWS_BY_DAY, 5);
    const defenseHoursByDay = normalizeHoursByDayMap(raw.defenseHoursByDay, DEFENSE_WINDOWS_BY_DAY, 30);

    // Ensure November preset weekly hours are populated when upgrading from v1
    if (rawVersion < SCHEDULE_CONFIG_VERSION) {
        for (const dow of [2, 3, 4]) {
            if (!consultationHoursByDay[dow] || consultationHoursByDay[dow].length === 0) {
                consultationHoursByDay[dow] = WINDOWS_BY_DAY[dow].map(([s, e]) => [s, e]);
            }
        }
        for (const dow of [1, 2, 3, 4, 5, 6]) {
            if (!defenseHoursByDay[dow] || defenseHoursByDay[dow].length === 0) {
                defenseHoursByDay[dow] = DEFENSE_WINDOWS_BY_DAY[dow].map(([s, e]) => [s, e]);
            }
        }
    }

    const dedup = new Map();
    if (rawVersion < SCHEDULE_CONFIG_VERSION) {
        for (const seeded of buildNovemberSeededOpenDates(consultationHoursByDay, defenseHoursByDay)) {
            dedup.set(`${seeded.date}|${seeded.category}`, seeded);
        }
    }

    if (Array.isArray(raw.openDates)) {
        for (const item of raw.openDates) {
            if (!item || typeof item !== 'object') continue;
            const date = String(item.date || '').trim();
            const category = String(item.category || '').trim();
            if (!parseDate(date) || !SCHEDULE_CATEGORIES.includes(category)) continue;
            const mode = SCHEDULE_MODES.includes(item.mode) ? item.mode : 'custom';
            const minDur = category === 'defense' ? 30 : 5;
            const windows = mode === 'full_day'
                ? [[FULL_DAY_START_MINUTE, FULL_DAY_END_MINUTE]]
                : normalizeWindowIntervals(item.windows, minDur);
            const note = typeof item.note === 'string' && item.note.trim()
                ? item.note.trim().slice(0, 500)
                : null;
            dedup.set(`${date}|${category}`, {
                id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : crypto.randomUUID(),
                date,
                category,
                mode,
                windows,
                note,
                updatedAt: item.updatedAt || null,
            });
        }
    }

    const openDates = [...dedup.values()].sort(
        (a, b) => a.date.localeCompare(b.date) || SCHEDULE_CATEGORIES.indexOf(a.category) - SCHEDULE_CATEGORIES.indexOf(b.category)
    );

    return indexScheduleConfig({
        version: SCHEDULE_CONFIG_VERSION,
        consultationHoursByDay,
        defenseHoursByDay,
        openDates,
    });
}

function resolveOpenEntryWindows(entry, cfg) {
    if (!entry) return [];
    if (entry.mode === 'full_day') {
        return [[FULL_DAY_START_MINUTE, FULL_DAY_END_MINUTE]];
    }
    if (entry.mode === 'regular') {
        const dt = parseDate(entry.date);
        const dow = dt ? dt.getUTCDay() : -1;
        const sourceTable = entry.category === 'defense'
            ? cfg.defenseHoursByDay
            : cfg.consultationHoursByDay;
        const regularWins = (dow >= 0 && Array.isArray(sourceTable?.[dow])) ? sourceTable[dow] : [];
        if (regularWins.length) return regularWins.map(([s, e]) => [s, e]);
        return Array.isArray(entry.windows) ? entry.windows.map(([s, e]) => [s, e]) : [];
    }
    return Array.isArray(entry.windows) ? entry.windows.map(([s, e]) => [s, e]) : [];
}

let cachedScheduleConfig = buildDefaultScheduleConfig();
let cachedLegacyPickupByDate = new Map();
let lastScheduleConfigLoadedAt = 0;
let cachedBookingEndDate = null;
let lastSettingsLoadedAt = 0;

function getActiveScheduleConfig() {
    return cachedScheduleConfig || buildDefaultScheduleConfig();
}

async function loadScheduleConfig({ force = false } = {}) {
    if (!force && lastScheduleConfigLoadedAt && Date.now() - lastScheduleConfigLoadedAt < 3000) {
        return cachedScheduleConfig;
    }
    try {
        const [{ data, error }, pickupRes] = await Promise.all([
            db()
                .from(SETTINGS_TABLE)
                .select('value, updated_at')
                .eq('key', SCHEDULE_CONFIG_KEY)
                .maybeSingle(),
            db()
                .from(LETTER_PICKUP_TABLE)
                .select('*')
                .order('available_date', { ascending: true })
                .order('start_minute', { ascending: true }),
        ]);

        if (!error && data?.value) {
            try {
                const parsed = JSON.parse(data.value);
                cachedScheduleConfig = normalizeScheduleConfigObject(parsed);
            } catch {
                cachedScheduleConfig = buildDefaultScheduleConfig();
            }
        } else if (!error && !data) {
            cachedScheduleConfig = buildDefaultScheduleConfig();
        }

        if (!pickupRes.error && Array.isArray(pickupRes.data)) {
            const byDate = new Map();
            for (const r of pickupRes.data) {
                const d = r.available_date;
                if (!d) continue;
                if (!byDate.has(d)) byDate.set(d, []);
                byDate.get(d).push(r);
            }
            cachedLegacyPickupByDate = byDate;
        }
        lastScheduleConfigLoadedAt = Date.now();
    } catch {
        // Ignore transient lookup errors and fall back to cached / default config
    }
    return cachedScheduleConfig;
}

async function saveScheduleConfig(nextConfig) {
    const normalized = normalizeScheduleConfigObject({
        ...nextConfig,
        version: SCHEDULE_CONFIG_VERSION,
    });
    const payloadStr = JSON.stringify({
        version: SCHEDULE_CONFIG_VERSION,
        consultationHoursByDay: normalized.consultationHoursByDay,
        defenseHoursByDay: normalized.defenseHoursByDay,
        openDates: normalized.openDates,
    });

    const { error } = await db()
        .from(SETTINGS_TABLE)
        .upsert(
            [{ key: SCHEDULE_CONFIG_KEY, value: payloadStr, updated_at: new Date().toISOString() }],
            { onConflict: 'key' }
        );

    if (error) {
        if (['42P01', 'PGRST205'].includes(error.code)) {
            throw httpError(500, 'Database schema needs updating: please run supabase/schema.sql in your Supabase SQL Editor.');
        }
        throw error;
    }

    cachedScheduleConfig = normalized;
    lastScheduleConfigLoadedAt = Date.now();
    return normalized;
}

async function loadBookingEndDateSetting({ force = false } = {}) {
    await loadScheduleConfig({ force });
    return getLastBookableDate();
}

async function saveBookingEndDateSetting(dateStr) {
    const clean = String(dateStr || '').trim();
    if (!parseDate(clean)) {
        throw httpError(400, 'Please select a valid cutoff date (YYYY-MM-DD).', { field: 'bookingEndDateInput' });
    }
    cachedBookingEndDate = clean;
    lastSettingsLoadedAt = Date.now();
    return clean;
}

function serializeWindowsWithLabels(wins) {
    return (wins || []).map(([s, e]) => ({
        startMinute: s,
        endMinute: e,
        label: `${formatMinute(s)} – ${formatMinute(e)}`,
    }));
}

function serializeScheduleConfig(cfg = getActiveScheduleConfig(), legacyPickupByDate = cachedLegacyPickupByDate) {
    const consultationHoursByDay = {};
    const defenseHoursByDay = {};
    for (let d = 0; d <= 6; d += 1) {
        consultationHoursByDay[d] = serializeWindowsWithLabels(cfg.consultationHoursByDay[d] || []);
        defenseHoursByDay[d] = serializeWindowsWithLabels(cfg.defenseHoursByDay[d] || []);
    }

    const mergedEntries = cfg.openDates.map((entry) => {
        const effective = resolveOpenEntryWindows(entry, cfg);
        return {
            id: entry.id,
            date: entry.date,
            category: entry.category,
            mode: entry.mode,
            windows: serializeWindowsWithLabels(entry.windows),
            effectiveWindows: serializeWindowsWithLabels(effective),
            label: effective.map(([s, e]) => `${formatMinute(s)} – ${formatMinute(e)}`).join(', ') || 'No hours set',
            note: entry.note || null,
            updatedAt: entry.updatedAt || null,
        };
    });

    // Include any legacy letter_pickup_schedules rows on dates not already in openDates
    if (legacyPickupByDate && legacyPickupByDate.size > 0) {
        for (const [date, rows] of legacyPickupByDate.entries()) {
            if (cfg.byDateCategory.has(`${date}|letter_pickup`)) continue;
            const wins = normalizePickupWindows(rows);
            if (!wins.length) continue;
            const note = rows.find((r) => r.note)?.note || null;
            mergedEntries.push({
                id: `legacy-pickup-${date}`,
                date,
                category: 'letter_pickup',
                mode: 'custom',
                windows: serializeWindowsWithLabels(wins),
                effectiveWindows: serializeWindowsWithLabels(wins),
                label: wins.map(([s, e]) => `${formatMinute(s)} – ${formatMinute(e)}`).join(', '),
                note,
                updatedAt: rows[0]?.created_at || null,
            });
        }
        mergedEntries.sort(
            (a, b) => a.date.localeCompare(b.date) || SCHEDULE_CATEGORIES.indexOf(a.category) - SCHEDULE_CATEGORIES.indexOf(b.category)
        );
    }

    const presetConsultationHoursByDay = {};
    const presetDefenseHoursByDay = {};
    for (let d = 0; d <= 6; d += 1) {
        presetConsultationHoursByDay[d] = serializeWindowsWithLabels(WINDOWS_BY_DAY[d] || []);
        presetDefenseHoursByDay[d] = serializeWindowsWithLabels(DEFENSE_WINDOWS_BY_DAY[d] || []);
    }

    return {
        fullDayWindow: {
            startMinute: FULL_DAY_START_MINUTE,
            endMinute: FULL_DAY_END_MINUTE,
            label: `${formatMinute(FULL_DAY_START_MINUTE)} – ${formatMinute(FULL_DAY_END_MINUTE)}`,
        },
        presets: {
            consultationHoursByDay: presetConsultationHoursByDay,
            defenseHoursByDay: presetDefenseHoursByDay,
        },
        consultationHoursByDay,
        defenseHoursByDay,
        openDates: mergedEntries,
    };
}

function getEndOfNextMonth(dateStr) {
    const dt = parseDate(dateStr);
    if (!dt) return `${String(dateStr || '2026').slice(0, 4)}-12-31`;
    return toDateStr(new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 2, 0)));
}

function getLastBookableDate(now = nowInTz()) {
    let maxDate = getEndOfNextMonth(now.date);
    const cfg = getActiveScheduleConfig();
    for (const entry of cfg.openDates) {
        if (entry.date > maxDate && resolveOpenEntryWindows(entry, cfg).length > 0) {
            maxDate = entry.date;
        }
    }
    for (const [date, rows] of cachedLegacyPickupByDate.entries()) {
        if (date > maxDate && normalizePickupWindows(rows).length > 0) {
            maxDate = date;
        }
    }
    if (cachedBookingEndDate && cachedBookingEndDate > maxDate) {
        maxDate = cachedBookingEndDate;
    }
    return maxDate;
}

function getEarliestOpenDatesByCategory(now = nowInTz(), fullDayBlockedDates = null) {
    const first = getFirstBookableDate(now);
    const cfg = getActiveScheduleConfig();
    const earliest = {
        consultation: null,
        defense: null,
        letter_pickup: null,
    };
    for (const entry of cfg.openDates) {
        if (entry.date < first) continue;
        if (fullDayBlockedDates && fullDayBlockedDates.has(entry.date)) continue;
        if (!resolveOpenEntryWindows(entry, cfg).length) continue;
        if (!earliest[entry.category] || entry.date < earliest[entry.category]) {
            earliest[entry.category] = entry.date;
        }
    }
    for (const [date, rows] of cachedLegacyPickupByDate.entries()) {
        if (date < first) continue;
        if (fullDayBlockedDates && fullDayBlockedDates.has(date)) continue;
        if (!normalizePickupWindows(rows).length) continue;
        if (!earliest.letter_pickup || date < earliest.letter_pickup) {
            earliest.letter_pickup = date;
        }
    }
    return earliest;
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
    return Object.prototype.hasOwnProperty.call(CONSULTATION_TYPES, purpose) ? purpose : 'system';
}

/** Generate all candidate slots for a date and consultation purpose. */
function generateDaySlots(dateStr, purpose = 'system', customWindows = null) {
    const dt = parseDate(dateStr);
    if (!dt) return [];
    const normalized = normalizePurpose(purpose);
    if (normalized === 'defense') return []; // defenses use typed start times (see defenseDayAvailability)
    const windows = windowsForDate(dateStr, normalized, customWindows);
    const typeInfo = CONSULTATION_TYPES[normalized];
    const slots = [];

    for (const [winStart, winEnd] of windows) {
        const windowLabel = `${formatMinute(winStart)} – ${formatMinute(winEnd)}`;
        if (normalized === 'dropoff') {
            // Drop-off allows students to drop off during the window.
            slots.push({
                startMinute: winStart,
                endMinute: winEnd,
                durationMinutes: 0,
                isDropoff: true,
                label: windowLabel,
                endLabel: 'Drop-off only',
                windowLabel,
            });
        } else {
            const dur = typeInfo.durationMinutes;
            for (let m = winStart; m + dur <= winEnd; m += dur) {
                slots.push({
                    startMinute: m,
                    endMinute: m + dur,
                    durationMinutes: dur,
                    isDropoff: false,
                    label: formatMinute(m),
                    endLabel: formatMinute(m + dur),
                    windowLabel,
                });
            }
        }
    }

    return slots;
}

/** Is this booking active (not cancelled by the instructor)? */
function isActiveRow(r) {
    return r.status !== 'cancelled';
}

/** Does this DB row occupy timed minutes on the teacher's schedule? (Drop-offs do not.) */
function isTimedRow(r) {
    return r.consultation_type !== 'dropoff' && Number(r.duration_minutes) !== 0;
}

/** Extract [startMinute, endMinute] from a DB row (compatible with legacy & drop-off rows). */
function rowInterval(r) {
    const start = Number.isFinite(r.start_minute) ? r.start_minute : (Number(r.start_hour) || 0) * 60;
    if (!isTimedRow(r)) {
        const windows = windowsForDate(r.appointment_date, 'dropoff');
        const matched = windows.find(([ws, we]) => start >= ws && start < we) || windows[0];
        return [start, matched ? matched[1] : start + 80];
    }
    const duration = Number.isFinite(r.duration_minutes) && r.duration_minutes > 0
        ? r.duration_minutes
        : CONSULTATION_TYPES[r.consultation_type]?.durationMinutes || SYSTEM_DURATION;
    return [start, start + duration];
}

function hasOverlap(startMinute, endMinute, intervals) {
    for (const [bStart, bEnd] of intervals) {
        if (startMinute < bEnd && endMinute > bStart) return true;
    }
    return false;
}

/** Consultations must be booked at least 1 day before the consultation day. */
function getFirstBookableDate(now = nowInTz()) {
    return addDays(now.date, 1);
}

/** Time windows open on a given date for this purpose (dates start closed unless opened by the instructor). */
function windowsForDate(dateStr, purpose = 'system', customWindows = null) {
    const dt = parseDate(dateStr);
    if (!dt) return [];
    const cfg = getActiveScheduleConfig();
    const category = purpose === 'defense'
        ? 'defense'
        : purpose === 'letter_pickup'
            ? 'letter_pickup'
            : 'consultation';

    const entry = cfg.byDateCategory.get(`${dateStr}|${category}`);
    const openedWins = entry ? resolveOpenEntryWindows(entry, cfg) : [];

    if (category === 'letter_pickup') {
        const legacyRows = cachedLegacyPickupByDate.get(dateStr) || [];
        const legacyWins = Array.isArray(customWindows)
            ? customWindows
            : normalizePickupWindows(legacyRows);
        if (openedWins.length && legacyWins.length) {
            return normalizeWindowIntervals([...openedWins, ...legacyWins], LETTER_PICKUP_DURATION);
        }
        return openedWins.length ? openedWins : legacyWins;
    }

    return openedWins;
}

/** Is this date one the teacher accepts bookings for at all? */
function isBookableDate(dateStr, now = nowInTz(), purpose = 'system', customWindows = null) {
    const dt = parseDate(dateStr);
    if (!dt) return false;
    if (dateStr < getFirstBookableDate(now)) return false;
    if (!windowsForDate(dateStr, purpose, customWindows).length) return false;
    return true;
}

/**
 * Defense availability for a date: every defense window with its free gaps
 * (anything already booked — consultations or other defenses — is subtracted).
 */
function defenseDayAvailability(dateStr, durationMinutes, bookedIntervals) {
    return windowsForDate(dateStr, 'defense').map(([ws, we]) => {
        const busy = bookedIntervals
            .filter(([s, e]) => s < we && e > ws)
            .map(([s, e]) => [Math.max(s, ws), Math.min(e, we)])
            .sort((a, b) => a[0] - b[0]);

        const mergedBusy = [];
        for (const [s, e] of busy) {
            const last = mergedBusy[mergedBusy.length - 1];
            if (last && s <= last[1]) last[1] = Math.max(last[1], e);
            else mergedBusy.push([s, e]);
        }

        const free = [];
        let cursor = ws;
        for (const [s, e] of mergedBusy) {
            if (s > cursor) free.push([cursor, s]);
            cursor = Math.max(cursor, e);
        }
        if (cursor < we) free.push([cursor, we]);

        return {
            startMinute: ws,
            endMinute: we,
            label: `${formatMinute(ws)} – ${formatMinute(we)}`,
            busy: mergedBusy.map(([s, e]) => ({
                startMinute: s,
                endMinute: e,
                label: `${formatMinute(s)} – ${formatMinute(e)}`,
            })),
            free: free.map(([s, e]) => {
                const earliest = Math.ceil(s / DEFENSE_START_STEP) * DEFENSE_START_STEP;
                const latest = Math.floor((e - durationMinutes) / DEFENSE_START_STEP) * DEFENSE_START_STEP;
                const fits = latest >= earliest;
                return {
                    startMinute: s,
                    endMinute: e,
                    label: `${formatMinute(s)} – ${formatMinute(e)}`,
                    fits,
                    earliestStartMinute: fits ? earliest : null,
                    latestStartMinute: fits ? latest : null,
                };
            }),
        };
    });
}

/** Can a defense of this length start at startMinute on this date? */
function isValidDefenseStart(dateStr, startMinute, durationMinutes, bookedIntervals) {
    if (!Number.isInteger(startMinute) || startMinute % DEFENSE_START_STEP !== 0) return false;
    const endMinute = startMinute + durationMinutes;
    const insideWindow = windowsForDate(dateStr, 'defense')
        .some(([ws, we]) => startMinute >= ws && endMinute <= we);
    return insideWindow && !hasOverlap(startMinute, endMinute, bookedIntervals);
}

/** Number of free gaps on a date that can fit a defense of this length (used for the calendar). */
function countOpenDefenseRanges(dateStr, durationMinutes, bookedIntervals) {
    return defenseDayAvailability(dateStr, durationMinutes, bookedIntervals)
        .reduce((n, w) => n + w.free.filter((f) => f.fits).length, 0);
}

/** All bookable dates are at least tomorrow (1 day in advance). */
function isFutureSlot(dateStr, startMinute, now = nowInTz()) {
    return dateStr >= getFirstBookableDate(now);
}

/** How many minutes remain until [dateStr, startMinute] in the configured timezone. */
function minutesUntilBooking(dateStr, startMinute, now = nowInTz()) {
    const targetDt = parseDate(dateStr);
    const todayDt = parseDate(now.date);
    if (!targetDt || !todayDt) return -Infinity;
    const diffDays = Math.round((targetDt.getTime() - todayDt.getTime()) / 86400000);
    return diffDays * 1440 + (startMinute - now.minuteOfDay);
}

/* ---------- Blocked Dates & Times (Instructor Unavailable) ---------- */
function blockInterval(b) {
    return b.is_full_day ? [0, 1440] : [Number(b.start_minute) || 0, Number(b.end_minute) || 1440];
}

/** Check if a time window [winStart, winEnd] is completely covered by blocked intervals. */
function isWindowFullyBlocked(winStart, winEnd, blockedIntervals) {
    if (!blockedIntervals || !blockedIntervals.length) return false;
    const busy = blockedIntervals
        .filter(([s, e]) => s < winEnd && e > winStart)
        .map(([s, e]) => [Math.max(s, winStart), Math.min(e, winEnd)])
        .sort((a, b) => a[0] - b[0]);
    if (!busy.length || busy[0][0] > winStart) return false;
    let coveredEnd = busy[0][1];
    for (let i = 1; i < busy.length; i++) {
        if (busy[i][0] > coveredEnd) return false;
        coveredEnd = Math.max(coveredEnd, busy[i][1]);
    }
    return coveredEnd >= winEnd;
}

function toBlockedSchedule(r) {
    const isFullDay = Boolean(r.is_full_day);
    const startMinute = isFullDay ? 0 : Number(r.start_minute);
    const endMinute = isFullDay ? 1440 : Number(r.end_minute);
    return {
        id: r.id,
        date: r.blocked_date,
        isFullDay,
        startMinute,
        endMinute,
        label: isFullDay ? 'Entire day' : `${formatMinute(startMinute)} – ${formatMinute(endMinute)}`,
        reason: r.reason || null,
        createdAt: r.created_at,
    };
}

async function fetchBlockedByDateRange(first, last) {
    const { data, error } = await db()
        .from(BLOCKED_TABLE)
        .select('*')
        .gte('blocked_date', first)
        .lte('blocked_date', last)
        .order('blocked_date', { ascending: true });
    if (error) {
        if (['42P01', 'PGRST205'].includes(error.code)) return [];
        throw error;
    }
    return (data || []).filter((r) => !String(r.reason || '').startsWith(BLOCKED_SETTING_PREFIX));
}

async function fetchBlockedByDate(date) {
    const { data, error } = await db()
        .from(BLOCKED_TABLE)
        .select('*')
        .eq('blocked_date', date);
    if (error) {
        if (['42P01', 'PGRST205'].includes(error.code)) return [];
        throw error;
    }
    return (data || []).filter((r) => !String(r.reason || '').startsWith(BLOCKED_SETTING_PREFIX));
}

/* ---------- Communication Letter Pickup Schedules ---------- */
function toLetterPickupSchedule(r) {
    const startMinute = Number(r.start_minute) || 0;
    const endMinute = Number(r.end_minute) || 0;
    return {
        id: r.id,
        date: r.available_date,
        startMinute,
        endMinute,
        slotCount: Math.max(0, Math.floor((endMinute - startMinute) / LETTER_PICKUP_DURATION)),
        label: `${formatMinute(startMinute)} – ${formatMinute(endMinute)}`,
        note: r.note || null,
        createdAt: r.created_at,
    };
}

function normalizePickupWindows(rows) {
    if (!Array.isArray(rows) || !rows.length) return [];
    const intervals = rows
        .map((r) => [Number(r.start_minute), Number(r.end_minute)])
        .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && s >= 0 && e <= 1440 && e - s >= LETTER_PICKUP_DURATION)
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const [s, e] of intervals) {
        const last = merged[merged.length - 1];
        if (last && s <= last[1]) {
            last[1] = Math.max(last[1], e);
        } else {
            merged.push([s, e]);
        }
    }
    return merged;
}

async function fetchLetterPickupByDateRange(first, last) {
    const { data, error } = await db()
        .from(LETTER_PICKUP_TABLE)
        .select('*')
        .gte('available_date', first)
        .lte('available_date', last)
        .order('available_date', { ascending: true })
        .order('start_minute', { ascending: true });
    if (error) {
        if (['42P01', 'PGRST205'].includes(error.code)) return [];
        throw error;
    }
    return data || [];
}

async function fetchLetterPickupByDate(date) {
    const { data, error } = await db()
        .from(LETTER_PICKUP_TABLE)
        .select('*')
        .eq('available_date', date)
        .order('start_minute', { ascending: true });
    if (error) {
        if (['42P01', 'PGRST205'].includes(error.code)) return [];
        throw error;
    }
    return data || [];
}

async function loadLatestLetterPickupDate() {
    try {
        const { data, error } = await db()
            .from(LETTER_PICKUP_TABLE)
            .select('available_date')
            .order('available_date', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (!error && data?.available_date) return data.available_date;
    } catch {
        // Ignore lookup errors so /api/config always responds
    }
    return null;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */
app.get('/api/config', async (req, res) => {
    const now = nowInTz();
    const firstBookable = getFirstBookableDate(now);
    const [cfg, latestLetterPickupDate, futureBlocks] = await Promise.all([
        loadScheduleConfig(),
        loadLatestLetterPickupDate(),
        fetchBlockedByDateRange(firstBookable, '9999-12-31').catch(() => []),
    ]);
    const fullDayBlockedSet = new Set(
        (futureBlocks || []).filter((b) => b.is_full_day).map((b) => b.blocked_date)
    );
    const serializedCfg = serializeScheduleConfig(cfg);
    const earliestOpenDates = getEarliestOpenDatesByCategory(now, fullDayBlockedSet);
    const maxOpenPickup = serializedCfg.openDates
        .filter((e) => e.category === 'letter_pickup' && e.effectiveWindows.length > 0)
        .map((e) => e.date)
        .sort()
        .pop() || null;
    const effectiveLatestPickup = [latestLetterPickupDate, maxOpenPickup].filter(Boolean).sort().pop() || null;

    res.json({
        teacherName: TEACHER_NAME,
        teacherEmail: TEACHER_EMAIL,
        reminderMinutesBefore: REMINDER_MINUTES_BEFORE,
        location: CONFIG.location,
        timezone: CONFIG.timezone,
        consultationTypes: CONSULTATION_TYPES,
        workingDays: CONFIG.workingDays,
        today: now.date,
        firstBookableDate: getFirstBookableDate(now),
        lastBookableDate: getLastBookableDate(now),
        latestLetterPickupDate: effectiveLatestPickup,
        earliestOpenDates,
        allowedEmailDomains: AUTH.allowedDomains,
        maxActiveBookings: AUTH.maxActiveBookings,
        minGroupMembers: MIN_MEMBERS,
        maxGroupMembers: MAX_MEMBERS,
        cancelCutoffMinutes: CANCEL_CUTOFF_MINUTES,
        defenseLevels: DEFENSE_LEVELS,
        defenseStartStep: DEFENSE_START_STEP,
        consultationWindowsByDay: serializedCfg.consultationHoursByDay,
        defenseWindowsByDay: serializedCfg.defenseHoursByDay,
        realtime: {
            supabaseUrl: process.env.SUPABASE_URL || null,
            supabaseAnonKey: getSupabasePublicKey(),
            channel: REALTIME_CHANNEL,
            serverless: Boolean(process.env.VERCEL),
        },
    });
});

app.get('/api/realtime/pulse', (req, res) => {
    const now = nowInTz();
    res.set('Cache-Control', 'no-store');
    res.json({
        version: realtimeVersion,
        lastEvent: lastRealtimeEvent,
        today: now.date,
        currentMinute: now.minuteOfDay,
    });
});

app.get('/api/realtime/stream', (req, res) => {
    if (process.env.VERCEL) {
        return res.status(204).end();
    }
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'connected', version: realtimeVersion, lastEvent: lastRealtimeEvent })}\n\n`);
    sseClients.add(res);
    req.on('close', () => {
        sseClients.delete(res);
    });
});

/* ------------------------------------------------------------------ */
/* Student auth API                                                    */
/* ------------------------------------------------------------------ */
app.get('/api/auth/me', async (req, res) => {
    const student = await currentStudent(req);
    res.json({ student: student ? publicStudent(student) : null });
});

// Step 1 of registration: validate details and email a 6-digit code
app.post('/api/auth/register/start', async (req, res) => {
    const body = req.body || {};
    const name = cleanName(body.name);
    const email = normalizeEmail(body.email);
    const capstoneTitle = cleanName(body.capstoneTitle);
    const instructorRole = body.instructorRole === 'panel'
        ? 'panel'
        : body.instructorRole === 'adviser'
            ? 'adviser'
            : null;
    const projectLevel = normalizeDefenseLevel(body.projectLevel);
    const rawMembers = (Array.isArray(body.members) ? body.members : []).map(cleanName).filter(Boolean);
    const password = body.password;

    if (name.length < 2 || name.length > 100) {
        return res.status(400).json({ field: 'regName', error: 'Please enter your full name (2–100 characters).' });
    }
    if (!isUniversityEmail(email)) {
        return res.status(400).json({ field: 'regEmail', error: `Please use your university email (${domainHint()}).` });
    }
    if (capstoneTitle.length < 3 || capstoneTitle.length > 200) {
        return res.status(400).json({ field: 'regCapstone', error: 'Please enter your Capstone / Thesis title (3–200 characters).' });
    }
    if (!instructorRole) {
        return res.status(400).json({ field: 'regRole', error: `Please select whether ${TEACHER_NAME} is your Adviser or Panel Member.` });
    }
    if (!projectLevel) {
        return res.status(400).json({ field: 'regLevel', error: 'Please select your course: Capstone 1, Capstone 2, Thesis 1, or Thesis 2.' });
    }

    // Member 1 is always the representative registering; attach up to 2 additional members (1–3 total)
    const members = [name, ...rawMembers.slice(1)];
    if (members.length < MIN_MEMBERS) {
        return res.status(400).json({ field: 'regMembers', error: 'Please enter at least 1 member name.' });
    }
    if (members.length > MAX_MEMBERS) {
        return res.status(400).json({ field: 'regMembers', error: `Only up to ${MAX_MEMBERS} members are allowed in a Capstone / Thesis group.` });
    }
    if (members.some((m) => m.length < 2 || m.length > 100)) {
        return res.status(400).json({ field: 'regMembers', error: 'Each member needs a full name (2–100 characters).' });
    }

    const emailCheck = validateAndAlignMemberEmails(email, members, body.memberEmails, 'regMembers');
    if (emailCheck.error) {
        return res.status(400).json({ field: emailCheck.field, error: emailCheck.error });
    }
    const { memberEmails } = emailCheck;

    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ field: 'regPassword', error: pwError });

    if (await findStudentByEmail(email)) {
        return res.status(409).json({ field: 'regEmail', error: 'This email is already registered. Please log in instead.' });
    }

    const existingTitleGroup = await findStudentByCapstoneTitle(capstoneTitle);
    if (existingTitleGroup) {
        return res.status(409).json({
            field: 'regCapstone',
            error: `A group account with this Capstone / Thesis title is already registered by ${existingTitleGroup.full_name}. Only one representative per group should register.`,
        });
    }

    // OTP is sent ONLY to the main representative (`email`); groupmate emails receive consultation updates once registered.
    const passwordHash = await hashPassword(password);
    const payload = { name, capstoneTitle, instructorRole, projectLevel, members, memberEmails, passwordHash };
    await issueOtp(email, 'register', { payload, name });
    res.json({ ok: true, email, expiresInMinutes: AUTH.otpMinutes, resendSeconds: AUTH.otpResendSeconds });
});

// Step 2 of registration: verify the code, create the account and log in
app.post('/api/auth/register/verify', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const row = await consumeOtp(email, 'register', req.body?.code);
    const { name, capstoneTitle, instructorRole, projectLevel, members, memberEmails, passwordHash } = row.payload || {};
    if (!name || !passwordHash) {
        return res.status(400).json({ error: 'Registration details were lost. Please register again.' });
    }

    if (capstoneTitle) {
        const existingTitleGroup = await findStudentByCapstoneTitle(capstoneTitle);
        if (existingTitleGroup) {
            return res.status(409).json({
                field: 'regCapstone',
                error: `A group account with this Capstone / Thesis title is already registered by ${existingTitleGroup.full_name}. Only one representative per group should register.`,
            });
        }
    }

    const finalMembers = Array.isArray(members) && members.length ? members : [name];
    const alignedEmails = validateAndAlignMemberEmails(email, finalMembers, memberEmails, 'regMembers').memberEmails || [email];
    const nowIso = new Date().toISOString();
    const memberEmailsMeta = {
        id: crypto.randomUUID(),
        type: 'member_emails',
        memberEmails: alignedEmails,
        updatedAt: nowIso,
    };

    const baseStudentRow = {
        email,
        full_name: name,
        capstone_title: capstoneTitle || null,
        instructor_role: instructorRole || null,
        project_level: normalizeDefenseLevel(projectLevel),
        members: finalMembers,
        password_hash: passwordHash,
        last_login_at: nowIso,
    };

    let { data: student, error } = await db()
        .from(STUDENTS_TABLE)
        .insert([{
            ...baseStudentRow,
            member_emails: alignedEmails,
            change_history: [memberEmailsMeta],
        }])
        .select('*')
        .single();

    if (error && ['42703', 'PGRST204'].includes(error.code)) {
        const retryWithHistory = await db()
            .from(STUDENTS_TABLE)
            .insert([{
                ...baseStudentRow,
                change_history: [memberEmailsMeta],
            }])
            .select('*')
            .single();
        student = retryWithHistory.data;
        error = retryWithHistory.error;
    }
    if (error && ['42703', 'PGRST204'].includes(error.code)) {
        const retryBase = await db()
            .from(STUDENTS_TABLE)
            .insert([baseStudentRow])
            .select('*')
            .single();
        student = retryBase.data;
        error = retryBase.error;
    }
    if (error) {
        if (error.code === '23505') {
            return res.status(409).json({ error: 'This email is already registered. Please log in instead.' });
        }
        throw error;
    }

    setSession(res, student);
    const rtPromise = notifyRealtimeListeners({ type: 'student_registered', studentId: student.id });
    if (process.env.VERCEL) await rtPromise;
    res.status(201).json({ student: publicStudent(student) });
});

app.post('/api/auth/resend', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const rawPurpose = req.body?.purpose;
    const purpose = rawPurpose === 'reset'
        ? 'reset'
        : rawPurpose === 'email_change'
            ? 'email_change'
            : 'register';
    const purposeList = purpose === 'email_change' ? ['email_change', 'register'] : [purpose];

    const { data: row, error } = await db()
        .from(OTP_TABLE)
        .select('payload')
        .eq('email', email)
        .in('purpose', purposeList)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) throw error;

    if (purpose === 'register') {
        if (!row?.payload) {
            return res.status(400).json({ error: 'Your registration session expired. Please fill in the form again.' });
        }
        await issueOtp(email, 'register', { payload: row.payload, name: row.payload.name });
    } else if (purpose === 'email_change') {
        const student = await currentStudent(req);
        if (!student) {
            return res.status(401).json({ error: 'Please log in to continue.', code: 'AUTH_REQUIRED' });
        }
        if (!row?.payload || row.payload.studentId !== student.id) {
            return res.status(400).json({ error: 'Your email verification session expired. Please submit your changes again.' });
        }
        await issueOtp(email, 'email_change', { payload: row.payload, name: row.payload.name || student.full_name });
    } else {
        const student = await findStudentByEmail(email);
        if (student) await issueOtp(email, 'reset', { name: student.full_name });
    }
    res.json({ ok: true, resendSeconds: AUTH.otpResendSeconds });
});

// Dummy hash so a login for an unknown email takes as long as a real one
const DUMMY_HASH_PROMISE = hashPassword(crypto.randomBytes(16).toString('hex'));

app.post('/api/auth/login', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? '');
    const invalid = () => res.status(401).json({ error: 'Incorrect email or password.' });

    const student = EMAIL_RE.test(email) ? await findStudentByEmail(email) : null;
    if (!student) {
        await verifyPassword(password, await DUMMY_HASH_PROMISE);
        return invalid();
    }

    if (student.locked_until && new Date(student.locked_until).getTime() > Date.now()) {
        const mins = Math.ceil((new Date(student.locked_until).getTime() - Date.now()) / 60000);
        return res.status(429).json({
            error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}, or reset your password.`,
        });
    }

    if (!(await verifyPassword(password, student.password_hash))) {
        const failures = (student.failed_logins || 0) + 1;
        const lock = failures >= AUTH.loginMaxFailures;
        await db().from(STUDENTS_TABLE).update({
            failed_logins: lock ? 0 : failures,
            locked_until: lock ? new Date(Date.now() + AUTH.loginLockMinutes * 60000).toISOString() : null,
        }).eq('id', student.id);
        return invalid();
    }

    await db().from(STUDENTS_TABLE).update({
        failed_logins: 0,
        locked_until: null,
        last_login_at: new Date().toISOString(),
    }).eq('id', student.id);

    setSession(res, student);
    res.json({ student: publicStudent(student) });
});

app.post('/api/auth/logout', (req, res) => {
    clearSession(res);
    res.json({ ok: true });
});

// Forgot password, step 1: email a reset code (same answer whether or not the account exists)
app.post('/api/auth/forgot/start', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    const student = await findStudentByEmail(email);
    if (student) await issueOtp(email, 'reset', { name: student.full_name });
    res.json({ ok: true, email, expiresInMinutes: AUTH.otpMinutes, resendSeconds: AUTH.otpResendSeconds });
});

// Forgot password, step 2: verify the code, set the new password and log in
app.post('/api/auth/forgot/verify', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const pwError = validatePassword(req.body?.password);
    if (pwError) return res.status(400).json({ error: pwError });

    await consumeOtp(email, 'reset', req.body?.code);
    const student = await findStudentByEmail(email);
    if (!student) return res.status(400).json({ error: 'Account not found. Please register.' });

    const passwordHash = await hashPassword(req.body.password);
    const { data: updated, error } = await db()
        .from(STUDENTS_TABLE)
        .update({ password_hash: passwordHash, failed_logins: 0, locked_until: null, last_login_at: new Date().toISOString() })
        .eq('id', student.id)
        .select('*')
        .single();
    if (error) throw error;

    setSession(res, updated);
    res.json({ student: publicStudent(updated) });
});

/* ---------- Student profile update (with OTP verification for email changes) ---------- */
function validateStudentProfileFields(body) {
    const name = cleanName(body?.name);
    const email = normalizeEmail(body?.email);
    const capstoneTitle = cleanName(body?.capstoneTitle);
    const instructorRole = body?.instructorRole === 'panel'
        ? 'panel'
        : body?.instructorRole === 'adviser'
            ? 'adviser'
            : null;
    const projectLevel = normalizeDefenseLevel(body?.projectLevel);
    const rawMembers = (Array.isArray(body?.members) ? body.members : []).map(cleanName).filter(Boolean);

    if (name.length < 2 || name.length > 100) {
        return { field: 'profileName', error: 'Please enter your full name (2–100 characters).' };
    }
    if (!isUniversityEmail(email)) {
        return { field: 'profileEmail', error: `Please use your university email (${domainHint()}).` };
    }
    if (capstoneTitle.length < 3 || capstoneTitle.length > 200) {
        return { field: 'profileCapstone', error: 'Please enter your Capstone / Thesis title (3–200 characters).' };
    }
    if (!instructorRole) {
        return { field: 'profileRole', error: `Please select whether ${TEACHER_NAME} is your Adviser or Panel Member.` };
    }
    if (!projectLevel) {
        return { field: 'profileLevel', error: 'Please select your course: Capstone 1, Capstone 2, Thesis 1, or Thesis 2.' };
    }

    const members = [name, ...rawMembers.slice(1)];
    if (members.length < MIN_MEMBERS) {
        return { field: 'profileMembers', error: 'Please enter at least 1 member name.' };
    }
    if (members.length > MAX_MEMBERS) {
        return { field: 'profileMembers', error: `Only up to ${MAX_MEMBERS} members are allowed in a Capstone / Thesis group.` };
    }
    if (members.some((m) => m.length < 2 || m.length > 100)) {
        return { field: 'profileMembers', error: 'Each member needs a full name (2–100 characters).' };
    }

    const emailCheck = validateAndAlignMemberEmails(email, members, body?.memberEmails, 'profileMembers');
    if (emailCheck.error) {
        return { field: emailCheck.field, error: emailCheck.error };
    }

    return {
        values: { name, email, capstoneTitle, instructorRole, projectLevel, members, memberEmails: emailCheck.memberEmails },
    };
}

function formatRoleLabel(role) {
    if (role === 'panel') return 'Panel Member';
    if (role === 'adviser') return 'Adviser';
    return role || '—';
}

function formatLevelLabel(level) {
    const normalized = normalizeDefenseLevel(level);
    return normalized ? DEFENSE_LEVELS[normalized].label : (level || '—');
}

function computeStudentProfileDiff(current, next) {
    const prevMembers = Array.isArray(current.members) && current.members.length
        ? current.members
        : [current.full_name];
    const nextMembers = Array.isArray(next.members) && next.members.length
        ? next.members
        : [next.name];

    const prevGroupmateEmails = extractStudentMemberEmails(current).slice(1).filter(Boolean);
    const nextGroupmateEmails = (Array.isArray(next.memberEmails) ? next.memberEmails : [])
        .slice(1, nextMembers.length)
        .map(normalizeEmail)
        .filter(Boolean);

    const comparisons = [
        {
            field: 'full_name',
            label: 'Full name',
            prevRaw: current.full_name || '',
            nextRaw: next.name || '',
            from: current.full_name || '—',
            to: next.name || '—',
        },
        {
            field: 'email',
            label: 'University email',
            prevRaw: normalizeEmail(current.email),
            nextRaw: normalizeEmail(next.email),
            from: current.email || '—',
            to: next.email || '—',
        },
        {
            field: 'capstone_title',
            label: 'Capstone / Thesis title',
            prevRaw: current.capstone_title || '',
            nextRaw: next.capstoneTitle || '',
            from: current.capstone_title || '—',
            to: next.capstoneTitle || '—',
        },
        {
            field: 'instructor_role',
            label: 'Instructor role',
            prevRaw: current.instructor_role || '',
            nextRaw: next.instructorRole || '',
            from: formatRoleLabel(current.instructor_role),
            to: formatRoleLabel(next.instructorRole),
        },
        {
            field: 'project_level',
            label: 'Course',
            prevRaw: normalizeDefenseLevel(current.project_level) || '',
            nextRaw: normalizeDefenseLevel(next.projectLevel) || '',
            from: formatLevelLabel(current.project_level),
            to: formatLevelLabel(next.projectLevel),
        },
        {
            field: 'members',
            label: 'Group members',
            prevRaw: JSON.stringify(prevMembers),
            nextRaw: JSON.stringify(nextMembers),
            from: prevMembers.join(', '),
            to: nextMembers.join(', '),
        },
        {
            field: 'member_emails',
            label: 'Groupmate emails',
            prevRaw: JSON.stringify(prevGroupmateEmails),
            nextRaw: JSON.stringify(nextGroupmateEmails),
            from: prevGroupmateEmails.length ? prevGroupmateEmails.join(', ') : 'None',
            to: nextGroupmateEmails.length ? nextGroupmateEmails.join(', ') : 'None',
        },
    ];

    const changedFields = [];
    const previousValues = {};
    const newValues = {};
    const changes = [];

    for (const item of comparisons) {
        if (item.prevRaw !== item.nextRaw) {
            changedFields.push(item.field);
            previousValues[item.field] = item.from;
            newValues[item.field] = item.to;
            changes.push({
                field: item.field,
                label: item.label,
                from: item.from,
                to: item.to,
            });
        }
    }

    const changesSummary = changes.map((c) => `${c.label}: "${c.from}" → "${c.to}"`).join('; ');
    return {
        hasChanges: changedFields.length > 0,
        changedFields,
        previousValues,
        newValues,
        changes,
        changesSummary,
    };
}

async function assertNoAdviserOnlyRoleConflict(studentId, nextInstructorRole) {
    if (nextInstructorRole !== 'panel') return;
    const now = nowInTz();
    const { data, error } = await db()
        .from(TABLE)
        .select('id, appointment_date, start_minute, start_hour, duration_minutes, consultation_type, status')
        .eq('student_id', studentId)
        .eq('status', 'scheduled')
        .in('consultation_type', ['letter', 'letter_pickup']);
    if (error) throw error;

    const hasUpcomingAdviserOnly = (data || []).some((r) => {
        if (!isActiveRow(r) || r.appointment_date < now.date) return false;
        const [, end] = rowInterval(r);
        return r.appointment_date > now.date || end > now.minuteOfDay;
    });
    if (hasUpcomingAdviserOnly) {
        throw httpError(
            409,
            `You cannot switch your instructor role to Panel Member while you have an upcoming Communication Letter appointment scheduled. Please cancel that appointment in My Appointments first.`,
            { field: 'profileRole', code: 'ADVISER_APPOINTMENT_CONFLICT' }
        );
    }
}

async function applyStudentProfileUpdate(
    currentStudentRow,
    { name, email, capstoneTitle, instructorRole, projectLevel, members, memberEmails },
    { verifiedViaOtp = false } = {}
) {
    const studentId = currentStudentRow.id;
    await assertNoAdviserOnlyRoleConflict(studentId, instructorRole);

    const normalizedMembers = Array.isArray(members) && members.length ? members : [name];
    const normalizedLevel = normalizeDefenseLevel(projectLevel);
    const alignedEmails = validateAndAlignMemberEmails(
        email,
        normalizedMembers,
        Array.isArray(memberEmails) ? memberEmails : extractStudentMemberEmails(currentStudentRow),
        'profileMembers'
    ).memberEmails || [normalizeEmail(email)];

    const diff = computeStudentProfileDiff(currentStudentRow, {
        name,
        email,
        capstoneTitle,
        instructorRole,
        projectLevel: normalizedLevel,
        members: normalizedMembers,
        memberEmails: alignedEmails,
    });

    const nowIso = new Date().toISOString();
    const coreUpdate = {
        email,
        full_name: name,
        capstone_title: capstoneTitle,
        instructor_role: instructorRole,
        project_level: normalizedLevel,
        members: normalizedMembers,
    };

    let logEntry = null;
    if (diff.hasChanges) {
        logEntry = {
            id: crypto.randomUUID(),
            studentId,
            studentName: name,
            studentEmail: email,
            changedFields: diff.changedFields,
            previousValues: diff.previousValues,
            newValues: diff.newValues,
            changes: diff.changes,
            changesSummary: diff.changesSummary,
            verifiedViaOtp: Boolean(verifiedViaOtp),
            createdAt: nowIso,
        };
        console.log(
            `[Student Profile Update] ${name} (${email})${verifiedViaOtp ? ' [OTP verified]' : ''}: ${diff.changesSummary}`
        );
    }

    const prevHistory = (Array.isArray(currentStudentRow.change_history) ? currentStudentRow.change_history : [])
        .filter((h) => h && h.type !== 'member_emails');
    const memberEmailsMeta = {
        id: crypto.randomUUID(),
        type: 'member_emails',
        memberEmails: alignedEmails,
        updatedAt: nowIso,
    };
    const nextHistory = [
        memberEmailsMeta,
        ...(logEntry ? [logEntry, ...prevHistory] : prevHistory),
    ].slice(0, 50);

    let { data: updated, error } = await db()
        .from(STUDENTS_TABLE)
        .update({
            ...coreUpdate,
            member_emails: alignedEmails,
            ...(diff.hasChanges ? { updated_at: nowIso } : {}),
            change_history: nextHistory,
        })
        .eq('id', studentId)
        .select('*')
        .single();

    // Fallback if member_emails hasn't been added via schema.sql yet (change_history still stores memberEmailsMeta)
    if (error && ['42703', 'PGRST204'].includes(error.code)) {
        const retryWithHistory = await db()
            .from(STUDENTS_TABLE)
            .update({
                ...coreUpdate,
                ...(diff.hasChanges ? { updated_at: nowIso } : {}),
                change_history: nextHistory,
            })
            .eq('id', studentId)
            .select('*')
            .single();
        updated = retryWithHistory.data;
        error = retryWithHistory.error;
    }

    // Fallback if updated_at / change_history columns haven't been added via schema.sql yet
    if (error && ['42703', 'PGRST204'].includes(error.code)) {
        const retryRes = await db()
            .from(STUDENTS_TABLE)
            .update(coreUpdate)
            .eq('id', studentId)
            .select('*')
            .single();
        updated = retryRes.data;
        error = retryRes.error;
    }

    if (error) {
        if (error.code === '23505') {
            throw httpError(409, 'This email is already registered to another account.', { field: 'profileEmail' });
        }
        throw error;
    }

    // Record a permanent audit row in student_update_logs if any field changed
    if (logEntry) {
        const { error: logErr } = await db()
            .from(STUDENT_LOGS_TABLE)
            .insert([{
                id: logEntry.id,
                student_id: studentId,
                student_name: name,
                student_email: email,
                changed_fields: diff.changedFields,
                previous_values: diff.previousValues,
                new_values: diff.newValues,
                changes_summary: diff.changesSummary,
                verified_via_otp: Boolean(verifiedViaOtp),
                created_at: nowIso,
            }]);
        if (logErr && !['42P01', 'PGRST205', '42703', 'PGRST204'].includes(logErr.code)) {
            console.error('Could not insert student_update_logs row:', logErr);
        }
    }

    // Only sync profile metadata to upcoming scheduled appointments so completed/cancelled/no-show history is preserved
    const now = nowInTz();
    const { data: scheduledRows } = await db()
        .from(TABLE)
        .select('id, appointment_date, start_minute, start_hour, duration_minutes, consultation_type, status')
        .eq('student_id', studentId)
        .eq('status', 'scheduled');

    const upcomingIds = (scheduledRows || [])
        .filter((r) => {
            if (!isActiveRow(r) || r.appointment_date < now.date) return false;
            const [, end] = rowInterval(r);
            return r.appointment_date > now.date || end > now.minuteOfDay;
        })
        .map((r) => r.id);

    if (upcomingIds.length) {
        await db()
            .from(TABLE)
            .update({
                student_email: email,
                student_name: name,
                capstone_title: capstoneTitle,
                team_name: capstoneTitle,
                instructor_role: instructorRole,
                members: normalizedMembers,
            })
            .in('id', upcomingIds)
            .eq('status', 'scheduled');

        await db()
            .from(TABLE)
            .update({ defense_level: normalizedLevel })
            .in('id', upcomingIds)
            .eq('status', 'scheduled')
            .neq('consultation_type', 'defense');
    }

    // If the student verified a new email, also update student_email on any un-notified dropoff/letter row so pickup notifications reach them
    if (email !== normalizeEmail(currentStudentRow.email)) {
        await db()
            .from(TABLE)
            .update({ student_email: email })
            .eq('student_id', studentId)
            .neq('status', 'cancelled')
            .in('consultation_type', ['dropoff', 'letter'])
            .is('notified_at', null);
    }

    return updated;
}

async function handleStudentProfileUpdate(req, res) {
    const student = req.student;
    const validation = validateStudentProfileFields(req.body);
    if (validation.error) {
        return res.status(400).json({ field: validation.field, error: validation.error });
    }

    const { name, email, capstoneTitle, instructorRole, projectLevel, members, memberEmails } = validation.values;
    await assertNoAdviserOnlyRoleConflict(student.id, instructorRole);

    const existingTitleGroup = await findStudentByCapstoneTitle(capstoneTitle, student.id);
    if (existingTitleGroup) {
        return res.status(409).json({
            field: 'profileCapstone',
            error: `Another group account (${existingTitleGroup.full_name}) is already registered with this Capstone / Thesis title.`,
        });
    }

    const emailChanged = email !== normalizeEmail(student.email);

    if (emailChanged) {
        const existing = await findStudentByEmail(email);
        if (existing && existing.id !== student.id) {
            return res.status(409).json({
                field: 'profileEmail',
                error: 'This email is already registered to another account.',
            });
        }

        const payload = {
            studentId: student.id,
            name,
            email,
            capstoneTitle,
            instructorRole,
            projectLevel,
            members,
            memberEmails,
        };
        await issueOtp(email, 'email_change', { payload, name });
        return res.json({
            ok: true,
            otpRequired: true,
            email,
            expiresInMinutes: AUTH.otpMinutes,
            resendSeconds: AUTH.otpResendSeconds,
        });
    }

    const updated = await applyStudentProfileUpdate(
        student,
        {
            name,
            email: student.email,
            capstoneTitle,
            instructorRole,
            projectLevel,
            members,
            memberEmails,
        },
        { verifiedViaOtp: false }
    );
    setSession(res, updated);
    const rtPromise = notifyRealtimeListeners({ type: 'student_updated', studentId: updated.id });
    if (process.env.VERCEL) await rtPromise;
    return res.json({
        ok: true,
        otpRequired: false,
        student: publicStudent(updated),
    });
}

app.put('/api/profile', requireStudent, handleStudentProfileUpdate);
app.post('/api/profile/update', requireStudent, handleStudentProfileUpdate);

app.post('/api/profile/email/verify', requireStudent, async (req, res) => {
    const student = req.student;
    const email = normalizeEmail(req.body?.email);
    if (!isUniversityEmail(email)) {
        return res.status(400).json({ error: `Please use your university email (${domainHint()}).` });
    }

    const existing = await findStudentByEmail(email);
    if (existing && existing.id !== student.id) {
        return res.status(409).json({ error: 'This email is already registered to another account.' });
    }

    const row = await consumeOtp(email, 'email_change', req.body?.code);
    const payload = row.payload || {};
    if (payload.studentId !== student.id) {
        return res.status(400).json({ error: 'Verification session does not match your account. Please try again.' });
    }

    const updated = await applyStudentProfileUpdate(
        student,
        {
            name: payload.name || student.full_name,
            email,
            capstoneTitle: payload.capstoneTitle || student.capstone_title,
            instructorRole: payload.instructorRole || student.instructor_role,
            projectLevel: payload.projectLevel || student.project_level,
            members: Array.isArray(payload.members) && payload.members.length
                ? payload.members
                : (Array.isArray(student.members) && student.members.length ? student.members : [student.full_name]),
            memberEmails: Array.isArray(payload.memberEmails)
                ? payload.memberEmails
                : extractStudentMemberEmails(student),
        },
        { verifiedViaOtp: true }
    );

    setSession(res, updated);
    const rtPromise = notifyRealtimeListeners({ type: 'student_updated', studentId: updated.id });
    if (process.env.VERCEL) await rtPromise;
    res.json({ ok: true, student: publicStudent(updated) });
});

// Number of open slots for every day in a month: /api/month?month=2026-11&purpose=system
// For defenses also pass the level: /api/month?month=2026-11&purpose=defense&level=capstone2
app.get('/api/month', async (req, res) => {
    const month = String(req.query.month || '');
    const purpose = normalizePurpose(req.query.purpose);
    const isDefense = purpose === 'defense';
    const level = isDefense ? (normalizeDefenseLevel(req.query.level) || 'capstone1') : null;
    const defenseDuration = isDefense ? DEFENSE_LEVELS[level].durationMinutes : 0;
    if (!/^\d{4}-\d{2}$/.test(month) || !parseDate(`${month}-01`)) {
        return res.status(400).json({ error: 'Invalid month. Use YYYY-MM.' });
    }

    const rawExcludeId = String(req.query.excludeBookingId || '').trim();
    let excludeBookingId = /^[0-9a-f-]{36}$/i.test(rawExcludeId) ? rawExcludeId : null;
    const requester = await currentStudent(req).catch(() => null);
    const requesterId = requester?.id || null;
    if (excludeBookingId && !requesterId) {
        excludeBookingId = null;
    }

    const first = `${month}-01`;
    const firstDt = parseDate(first);
    const last = toDateStr(new Date(Date.UTC(firstDt.getUTCFullYear(), firstDt.getUTCMonth() + 1, 0)));

    const isLetterPickup = purpose === 'letter_pickup';
    const [{ data, error }, blockedRows, pickupRows] = await Promise.all([
        db()
            .from(TABLE)
            .select('*')
            .gte('appointment_date', first)
            .lte('appointment_date', last),
        fetchBlockedByDateRange(first, last),
        isLetterPickup ? fetchLetterPickupByDateRange(first, last) : Promise.resolve([]),
        loadBookingEndDateSetting(),
    ]);
    if (error) return res.status(500).json({ error: error.message });

    const pickupRowsByDate = new Map();
    if (isLetterPickup) {
        for (const p of pickupRows) {
            const d = p.available_date;
            if (!pickupRowsByDate.has(d)) pickupRowsByDate.set(d, []);
            pickupRowsByDate.get(d).push(p);
        }
    }

    const excludedRow = excludeBookingId
        ? (data.find((r) => r.id === excludeBookingId && r.student_id === requesterId && isActiveRow(r)) || null)
        : null;

    const intervalsByDate = new Map();
    const studentDropoffDates = new Set();
    for (const r of data) {
        if (!isActiveRow(r)) continue;
        if (excludedRow && r.id === excludedRow.id) continue;
        if (requesterId && r.student_id === requesterId && (!r.status || r.status === 'scheduled') && !isTimedRow(r)) {
            studentDropoffDates.add(r.appointment_date);
        }
        if (!isTimedRow(r)) continue; // Cancelled & Drop-offs take 0 minutes off schedule
        const d = r.appointment_date;
        if (!intervalsByDate.has(d)) intervalsByDate.set(d, []);
        intervalsByDate.get(d).push(rowInterval(r));
    }

    const blocksByDate = new Map();
    for (const b of blockedRows) {
        const d = b.blocked_date;
        if (!blocksByDate.has(d)) blocksByDate.set(d, []);
        blocksByDate.get(d).push(b);
    }

    const now = nowInTz();
    const days = {};

    for (let d = first; d <= last; d = addDays(d, 1)) {
        const customWindows = isLetterPickup
            ? normalizePickupWindows(pickupRowsByDate.get(d) || [])
            : null;
        if (!isBookableDate(d, now, purpose, customWindows)) {
            days[d] = { bookable: false, open: 0 };
            continue;
        }
        const bookedIntervals = intervalsByDate.get(d) || [];
        const dayBlocks = blocksByDate.get(d) || [];
        const blockedIntervals = dayBlocks.map(blockInterval);
        const allBusyIntervals = [...bookedIntervals, ...blockedIntervals];
        const blockReason = dayBlocks.find((b) => b.is_full_day && b.reason)?.reason
            || dayBlocks.find((b) => b.reason)?.reason
            || null;
        const hasFullDayBlock = dayBlocks.some((b) => b.is_full_day);
        const serializedBlocks = dayBlocks.map(toBlockedSchedule);

        if (isDefense) {
            let open = 0;
            if (!hasFullDayBlock) {
                if (excludedRow && excludedRow.appointment_date === d) {
                    const excludedStart = Number(excludedRow.start_minute);
                    open = defenseDayAvailability(d, defenseDuration, allBusyIntervals).reduce(
                        (n, w) => n + w.free.filter(
                            (f) => f.fits && (f.latestStartMinute > f.earliestStartMinute || f.earliestStartMinute !== excludedStart)
                        ).length,
                        0
                    );
                } else {
                    open = countOpenDefenseRanges(d, defenseDuration, allBusyIntervals);
                }
            }
            const blocked = Boolean(hasFullDayBlock || (open === 0 && dayBlocks.length > 0));
            days[d] = {
                bookable: true,
                open,
                blocked,
                hasBlocks: dayBlocks.length > 0,
                blockReason: dayBlocks.length > 0 ? blockReason : null,
                blocks: serializedBlocks,
            };
            continue;
        }
        const daySlots = generateDaySlots(d, purpose, customWindows);
        const excludedStart = (excludedRow && excludedRow.appointment_date === d)
            ? Number(excludedRow.start_minute)
            : null;
        const hasOtherStudentDropoff = studentDropoffDates.has(d);
        const open = hasFullDayBlock
            ? 0
            : daySlots.filter(
                (s) => isFutureSlot(d, s.startMinute, now)
                    && !(excludedStart !== null && s.startMinute === excludedStart)
                    && (s.isDropoff
                        ? (!hasOtherStudentDropoff && !isWindowFullyBlocked(s.startMinute, s.endMinute, blockedIntervals))
                        : !hasOverlap(s.startMinute, s.endMinute, allBusyIntervals))
            ).length;
        const blocked = Boolean(hasFullDayBlock || (open === 0 && dayBlocks.length > 0));
        days[d] = {
            bookable: true,
            open,
            blocked,
            hasBlocks: dayBlocks.length > 0,
            blockReason: dayBlocks.length > 0 ? blockReason : null,
            blocks: serializedBlocks,
        };
    }

    res.json({ month, purpose, level, days });
});

// Slots for one day: /api/slots?date=2026-11-04&purpose=system
// Defenses return free time ranges instead: /api/slots?date=2026-11-07&purpose=defense&level=capstone1
app.get('/api/slots', async (req, res) => {
    const date = String(req.query.date || '');
    const purpose = normalizePurpose(req.query.purpose);
    if (!parseDate(date)) return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD.' });

    const rawExcludeId = String(req.query.excludeBookingId || '').trim();
    let excludeBookingId = /^[0-9a-f-]{36}$/i.test(rawExcludeId) ? rawExcludeId : null;
    const requester = await currentStudent(req).catch(() => null);
    const requesterId = requester?.id || null;
    if (excludeBookingId && !requesterId) {
        excludeBookingId = null;
    }

    const isDefense = purpose === 'defense';
    const isLetterPickup = purpose === 'letter_pickup';
    const level = isDefense ? (normalizeDefenseLevel(req.query.level) || 'capstone1') : null;
    const now = nowInTz();

    const [pickupRows] = await Promise.all([
        isLetterPickup ? fetchLetterPickupByDate(date) : Promise.resolve([]),
        loadBookingEndDateSetting(),
    ]);
    const customWindows = isLetterPickup ? normalizePickupWindows(pickupRows) : null;

    if (!isBookableDate(date, now, purpose, customWindows)) {
        return res.json({ date, purpose, level, slots: [], windows: [] });
    }

    const [{ data, error }, dayBlocks] = await Promise.all([
        db().from(TABLE).select('*').eq('appointment_date', date),
        fetchBlockedByDate(date),
    ]);
    if (error) return res.status(500).json({ error: error.message });

    const excludedRow = excludeBookingId
        ? (data.find((r) => r.id === excludeBookingId && r.student_id === requesterId && isActiveRow(r)) || null)
        : null;
    const hasOtherStudentDropoff = Boolean(
        requesterId && data.some((r) => r.student_id === requesterId && (!excludedRow || r.id !== excludedRow.id) && isActiveRow(r) && (!r.status || r.status === 'scheduled') && !isTimedRow(r))
    );
    const bookedIntervals = data
        .filter((r) => isActiveRow(r) && isTimedRow(r) && (!excludedRow || r.id !== excludedRow.id))
        .map(rowInterval);
    const blockedIntervals = dayBlocks.map(blockInterval);
    const allBusyIntervals = [...bookedIntervals, ...blockedIntervals];
    const fullDayBlock = dayBlocks.find((b) => b.is_full_day) || null;
    const blockReason = fullDayBlock?.reason || dayBlocks.find((b) => b.reason)?.reason || null;

    if (isDefense) {
        const durationMinutes = DEFENSE_LEVELS[level].durationMinutes;
        const windows = defenseDayAvailability(date, durationMinutes, allBusyIntervals);
        const currentStartMinute = (excludedRow && excludedRow.appointment_date === date)
            ? Number(excludedRow.start_minute)
            : null;
        const openRanges = windows.reduce(
            (n, w) => n + w.free.filter(
                (f) => f.fits && (currentStartMinute === null || f.latestStartMinute > f.earliestStartMinute || f.earliestStartMinute !== currentStartMinute)
            ).length,
            0
        );
        const isDayBlocked = Boolean(fullDayBlock) || (openRanges === 0 && dayBlocks.length > 0);
        return res.json({
            date,
            purpose,
            level,
            durationMinutes,
            startStep: DEFENSE_START_STEP,
            currentStartMinute,
            blocked: isDayBlocked,
            blockReason,
            blocks: dayBlocks.map(toBlockedSchedule),
            windows,
            slots: [],
        });
    }

    const slots = generateDaySlots(date, purpose, customWindows).map((s) => {
        const isCurrentBooking = Boolean(
            excludedRow && excludedRow.appointment_date === date && Number(excludedRow.start_minute) === s.startMinute
        );
        const blockedByAdmin = Boolean(fullDayBlock) || (
            s.isDropoff
                ? isWindowFullyBlocked(s.startMinute, s.endMinute, blockedIntervals)
                : hasOverlap(s.startMinute, s.endMinute, blockedIntervals)
        );
        const matchedBlock = blockedByAdmin
            ? dayBlocks.find((b) => {
                if (b.is_full_day) return true;
                const [bs, be] = blockInterval(b);
                return s.startMinute < be && s.endMinute > bs;
            })
            : null;
        return {
            startMinute: s.startMinute,
            endMinute: s.endMinute,
            durationMinutes: s.durationMinutes,
            isDropoff: Boolean(s.isDropoff),
            currentBooking: isCurrentBooking,
            label: s.label,
            endLabel: s.endLabel,
            windowLabel: s.windowLabel,
            blocked: blockedByAdmin,
            blockReason: matchedBlock?.reason || blockReason || null,
            available: isFutureSlot(date, s.startMinute, now)
                && !blockedByAdmin
                && !isCurrentBooking
                && (s.isDropoff ? !hasOtherStudentDropoff : !hasOverlap(s.startMinute, s.endMinute, bookedIntervals)),
        };
    });

    const openSlots = slots.filter((s) => s.available).length;
    const isDayBlocked = Boolean(fullDayBlock) || (openSlots === 0 && dayBlocks.length > 0);

    res.json({
        date,
        purpose,
        blocked: isDayBlocked,
        blockReason,
        blocks: dayBlocks.map(toBlockedSchedule),
        slots,
    });
});

const cleanName = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');

function formatDurationLabel(consultationType, durationMinutes) {
    if (consultationType === 'dropoff' || durationMinutes === 0) return 'Drop-off only';
    if (durationMinutes === 80) return '1 hr 20 min';
    if (durationMinutes > 0 && durationMinutes % 60 === 0) {
        const hours = durationMinutes / 60;
        return `${hours} hour${hours === 1 ? '' : 's'}`;
    }
    return `${durationMinutes} min`;
}

function formatConsultationTitle(consultationType, defenseLevel = null) {
    if (consultationType === 'defense') {
        const level = DEFENSE_LEVELS[defenseLevel];
        return level ? `${level.label} Defense` : 'Defense';
    }
    if (CONSULTATION_TYPES[consultationType]) return CONSULTATION_TYPES[consultationType].title;
    if (consultationType === 'other') return 'Other Consultations';
    return 'Consultation';
}

/* ---------- Calendar (.ics & Google Calendar) helpers ---------- */
function localDateMinuteToUtc(dateStr, minuteOfDay, timeZone = CONFIG.timezone) {
    const dt = parseDate(dateStr);
    if (!dt) return new Date();
    const totalMinutes = Number.isFinite(minuteOfDay) ? minuteOfDay : 0;
    const hour = Math.floor(totalMinutes / 60);
    const min = ((totalMinutes % 60) + 60) % 60;
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth();
    const d = dt.getUTCDate();
    const utcGuessMs = Date.UTC(y, m, d, hour, min, 0);

    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    });

    const tzWallAsUtcMs = (ms) => {
        const parts = fmt.formatToParts(new Date(ms));
        const get = (type) => parseInt(parts.find((p) => p.type === type).value, 10);
        return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    };

    const offset1 = tzWallAsUtcMs(utcGuessMs) - utcGuessMs;
    const pass1 = utcGuessMs - offset1;
    const offset2 = tzWallAsUtcMs(pass1) - pass1;
    return new Date(utcGuessMs - offset2);
}

function formatIcsUtcDate(date) {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function escapeIcsText(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/\r\n|\r|\n/g, '\\n')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,');
}

function foldIcsLine(line) {
    if (Buffer.byteLength(line, 'utf8') <= 75) return line;
    const parts = [];
    let current = '';
    let currentBytes = 0;
    for (const ch of line) {
        const chBytes = Buffer.byteLength(ch, 'utf8');
        if (currentBytes + chBytes > 75 && current) {
            parts.push(current);
            current = ` ${ch}`;
            currentBytes = 1 + chBytes;
        } else {
            current += ch;
            currentBytes += chBytes;
        }
    }
    if (current) parts.push(current);
    return parts.join('\r\n');
}

function bookingUtcInterval(booking) {
    const startMin = Number.isFinite(booking.startMinute) ? booking.startMinute : (Number(booking.hour) || 0) * 60;
    const endMin = Number.isFinite(booking.endMinute) && booking.endMinute > startMin
        ? booking.endMinute
        : startMin + (Number(booking.durationMinutes) > 0 ? Number(booking.durationMinutes) : 15);
    return {
        startUtc: localDateMinuteToUtc(booking.date, startMin),
        endUtc: localDateMinuteToUtc(booking.date, endMin),
    };
}

function buildBookingCalendarDescription(booking) {
    const projectOrStudent = booking.capstoneTitle || booking.teamName || booking.name || 'Student Group';
    const courseLabel = booking.projectLevelLabel || booking.defenseLevelLabel || '—';
    const roleLabel = formatRoleLabel(booking.instructorRole);
    const membersList = Array.isArray(booking.members) && booking.members.length
        ? booking.members.join(', ')
        : (booking.name || '—');
    const lines = [
        `Consultation: ${booking.consultationTitle || 'Consultation'} (${booking.durationLabel || '—'})`,
        `Capstone / Thesis: ${projectOrStudent}`,
        `Course & Role: ${courseLabel} · ${roleLabel}`,
        `Group Members: ${membersList}`,
    ];
    if (booking.reason) lines.push(`Agenda / Notes: ${booking.reason}`);
    if (booking.status === 'cancelled' && booking.cancellationReason) {
        lines.push(`Cancellation Reason: ${booking.cancellationReason}`);
    }
    lines.push(`Reference: #${booking.reference}`);
    return lines.join('\n');
}

function buildBookingIcs(booking, { method = 'PUBLISH', status = 'CONFIRMED', sequence = 0 } = {}) {
    const { startUtc, endUtc } = bookingUtcInterval(booking);
    const dtStart = formatIcsUtcDate(startUtc);
    const dtEnd = formatIcsUtcDate(endUtc);
    const dtStamp = formatIcsUtcDate(new Date());
    const summary = `${booking.consultationTitle || 'Consultation'} — ${TEACHER_NAME}`;
    const description = buildBookingCalendarDescription(booking);

    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Arnemie Gayyed//Consultation Scheduler//EN',
        'CALSCALE:GREGORIAN',
        `METHOD:${method}`,
        'BEGIN:VEVENT',
        `UID:booking-${booking.id}@arnemie-consultation-scheduler`,
        `DTSTAMP:${dtStamp}`,
        `DTSTART:${dtStart}`,
        `DTEND:${dtEnd}`,
        `SUMMARY:${escapeIcsText(summary)}`,
        `LOCATION:${escapeIcsText(CONFIG.location)}`,
        `DESCRIPTION:${escapeIcsText(description)}`,
        `STATUS:${status}`,
        `SEQUENCE:${sequence}`,
    ];

    if (status !== 'CANCELLED') {
        lines.push(
            'BEGIN:VALARM',
            'ACTION:DISPLAY',
            `DESCRIPTION:${escapeIcsText(`Upcoming ${booking.consultationTitle || 'Consultation'} with ${TEACHER_NAME}`)}`,
            'TRIGGER:-PT30M',
            'END:VALARM'
        );
    }

    lines.push('END:VEVENT', 'END:VCALENDAR');
    return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

function formatOutlookLocalDateTime(dateStr, minuteOfDay) {
    const totalMinutes = Math.max(0, Math.floor(Number(minuteOfDay) || 0));
    const dayOffset = Math.floor(totalMinutes / 1440);
    const remMinutes = totalMinutes % 1440;
    const hh = String(Math.floor(remMinutes / 60)).padStart(2, '0');
    const mm = String(remMinutes % 60).padStart(2, '0');
    const targetDate = dayOffset > 0 ? addDays(dateStr, dayOffset) : dateStr;
    return `${targetDate}T${hh}:${mm}:00`;
}

function buildOutlookCalendarUrl(booking) {
    const startMin = Number.isFinite(booking.startMinute) ? booking.startMinute : (Number(booking.hour) || 0) * 60;
    const endMin = Number.isFinite(booking.endMinute) && booking.endMinute > startMin
        ? booking.endMinute
        : startMin + (Number(booking.durationMinutes) > 0 ? Number(booking.durationMinutes) : 15);
    const params = new URLSearchParams({
        path: '/calendar/action/compose',
        rru: 'addevent',
        startdt: formatOutlookLocalDateTime(booking.date, startMin),
        enddt: formatOutlookLocalDateTime(booking.date, endMin),
        subject: `${booking.consultationTitle || 'Consultation'} — ${TEACHER_NAME}`,
        body: buildBookingCalendarDescription(booking),
        location: CONFIG.location,
    });
    return `https://outlook.office.com/calendar/0/deeplink/compose?${params.toString()}`;
}

/** Shape a database row for the frontend. */
function toBooking(r, now, studentOrLookup = null) {
    const current = (now && typeof now === 'object' && now.date) ? now : nowInTz();
    let matchedStudent = null;
    if (studentOrLookup) {
        if (studentOrLookup.byId && studentOrLookup.byEmail) {
            matchedStudent = studentOrLookup.byId.get(r.student_id)
                || studentOrLookup.byEmail.get(String(r.student_email || '').toLowerCase())
                || null;
        } else if (studentOrLookup.id) {
            const matchesId = !r.student_id || r.student_id === studentOrLookup.id;
            const matchesEmail = Boolean(
                r.student_email && studentOrLookup.email
                && String(r.student_email).toLowerCase() === String(studentOrLookup.email).toLowerCase()
            );
            if (matchesId || matchesEmail) {
                matchedStudent = studentOrLookup;
            }
        }
    }
    const members = Array.isArray(r.members) && r.members.length
        ? r.members
        : (Array.isArray(matchedStudent?.members) && matchedStudent.members.length
            ? matchedStudent.members
            : [r.student_name]);
    const timed = isTimedRow(r);
    const [startMinute, endMinute] = rowInterval(r);
    const durationMinutes = timed ? (endMinute - startMinute) : 0;
    const consultationType = r.consultation_type || 'system';
    const timeRange = `${formatMinute(startMinute)} – ${formatMinute(endMinute)}`;
    const status = ['scheduled', 'completed', 'no_show', 'cancelled'].includes(r.status)
        ? r.status
        : 'scheduled';
    const attendedMembers = Array.isArray(r.attended_members)
        ? r.attended_members.map(cleanName).filter(Boolean).slice(0, MAX_MEMBERS)
        : [];
    const revisionNotes = typeof r.revision_notes === 'string' && r.revision_notes.trim()
        ? r.revision_notes.trim()
        : null;
    const revisionChecklist = Array.isArray(r.revision_checklist)
        ? r.revision_checklist
            .filter((item) => item && typeof item === 'object' && String(item.text || '').trim())
            .map((item, idx) => ({
                id: String(item.id || `item-${idx + 1}`).slice(0, 64),
                text: String(item.text).trim().slice(0, 300),
                done: Boolean(item.done),
            }))
            .slice(0, 30)
        : [];
    const minutesUntilStart = minutesUntilBooking(r.appointment_date, startMinute, current);
    const canCancel = status === 'scheduled' && minutesUntilStart >= CANCEL_CUTOFF_MINUTES;
    const canReschedule = canCancel;
    const previousDate = r.previous_date || null;
    const previousStartMinute = Number.isFinite(r.previous_start_minute)
        ? Number(r.previous_start_minute)
        : null;
    let previousLabel = null;
    if (previousDate && previousStartMinute !== null) {
        const [prevStart, prevEnd] = rowInterval({
            ...r,
            appointment_date: previousDate,
            start_minute: previousStartMinute,
            start_hour: Math.floor(previousStartMinute / 60),
        });
        const prevRange = `${formatMinute(prevStart)} – ${formatMinute(prevEnd)}`;
        previousLabel = timed ? prevRange : `${prevRange} (Drop-off)`;
    }
    const projectLevel = consultationType === 'defense'
        ? (normalizeDefenseLevel(r.defense_level) || normalizeDefenseLevel(matchedStudent?.project_level) || null)
        : (normalizeDefenseLevel(matchedStudent?.project_level) || normalizeDefenseLevel(r.defense_level) || null);
    const defenseLevel = consultationType === 'defense' ? projectLevel : null;
    const primaryEmail = r.student_email || matchedStudent?.email || null;
    const memberEmails = matchedStudent
        ? extractStudentMemberEmails({ ...matchedStudent, email: primaryEmail || matchedStudent.email })
        : (primaryEmail ? [normalizeEmail(primaryEmail)] : []);
    const booking = {
        id: r.id,
        reference: r.id.slice(0, 8).toUpperCase(),
        type: r.team_name || members.length >= 2 ? 'group' : 'individual',
        consultationType,
        consultationTitle: formatConsultationTitle(consultationType, defenseLevel),
        defenseLevel,
        defenseLevelLabel: defenseLevel ? DEFENSE_LEVELS[defenseLevel].label : null,
        projectLevel,
        projectLevelLabel: projectLevel ? DEFENSE_LEVELS[projectLevel].label : null,
        isDropoff: !timed,
        durationMinutes,
        durationLabel: formatDurationLabel(consultationType, durationMinutes),
        studentId: r.student_id || matchedStudent?.id || null,
        name: r.student_name || matchedStudent?.full_name || '',
        studentEmail: primaryEmail,
        memberEmails,
        capstoneTitle: r.capstone_title || r.team_name || matchedStudent?.capstone_title || null,
        instructorRole: r.instructor_role || matchedStudent?.instructor_role || null,
        teamName: r.team_name || matchedStudent?.capstone_title || null,
        members,
        reason: r.reason,
        date: r.appointment_date,
        hour: Math.floor(startMinute / 60),
        startMinute,
        endMinute,
        label: timed ? timeRange : `${timeRange} (Drop-off)`,
        status,
        canCancel,
        canReschedule,
        rescheduledAt: r.rescheduled_at || null,
        rescheduledCount: Number(r.rescheduled_count) || 0,
        previousDate,
        previousStartMinute,
        previousLabel,
        cancellationReason: r.cancellation_reason || null,
        cancelledAt: r.cancelled_at || null,
        notifiedAt: r.notified_at || null,
        reminderSentAt: r.reminder_sent_at || (!['dropoff', 'letter'].includes(r.consultation_type) ? r.notified_at : null) || null,
        studentReminderSentAt: r.student_reminder_sent_at || null,
        attendedMembers,
        revisionNotes,
        revisionChecklist,
        completedAt: r.completed_at || null,
        createdAt: r.created_at,
    };
    booking.outlookCalendarUrl = buildOutlookCalendarUrl(booking);
    booking.icsUrl = `/api/bookings/${r.id}/ics`;
    return booking;
}

function summarizePreviousConsultation(prev) {
    if (!prev) return null;
    return {
        id: prev.id,
        reference: prev.reference,
        date: prev.date,
        label: prev.label,
        consultationType: prev.consultationType,
        consultationTitle: prev.consultationTitle,
        status: prev.status,
        members: prev.members,
        attendedMembers: prev.attendedMembers,
        revisionNotes: prev.revisionNotes,
        revisionChecklist: prev.revisionChecklist,
        completedAt: prev.completedAt,
    };
}

function attachPreviousConsultations(bookings) {
    if (!Array.isArray(bookings) || !bookings.length) return bookings;
    const byGroup = new Map();
    for (const b of bookings) {
        b.previousConsultation = null;
        if (b.status === 'cancelled') continue;
        const key = b.studentId || (b.studentEmail ? String(b.studentEmail).toLowerCase() : '');
        if (!key) continue;
        if (!byGroup.has(key)) byGroup.set(key, []);
        byGroup.get(key).push(b);
    }

    for (const groupBookings of byGroup.values()) {
        groupBookings.sort(
            (a, b) => a.date.localeCompare(b.date)
                || a.startMinute - b.startMinute
                || String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
        );

        let lastWithRevisions = null;
        for (let i = 0; i < groupBookings.length; i += 1) {
            const b = groupBookings[i];
            const prev = i > 0 ? groupBookings[i - 1] : null;
            const immediatePrev = prev && (
                prev.status === 'completed'
                || prev.status === 'no_show'
                || (Array.isArray(prev.attendedMembers) && prev.attendedMembers.length > 0)
            ) ? prev : null;

            b.previousConsultation = summarizePreviousConsultation(lastWithRevisions || immediatePrev);

            const hasRevisions = (Array.isArray(b.revisionChecklist) && b.revisionChecklist.length > 0)
                || Boolean(b.revisionNotes);
            if (hasRevisions) {
                lastWithRevisions = b;
            }
        }
    }

    return bookings;
}

// Logged-in student's bookings (upcoming, cancelled with instructor reason, and past)
app.get('/api/my-bookings', requireStudent, async (req, res) => {
    const now = nowInTz();
    const { data, error } = await db()
        .from(TABLE)
        .select('*')
        .eq('student_id', req.student.id)
        .order('appointment_date', { ascending: false })
        .order('start_minute', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const bookings = attachPreviousConsultations(data.map((r) => toBooking(r, now, req.student)));
    const eligibility = computePickupEligibility(req.student, data || []);
    res.json({
        today: now.date,
        currentMinute: now.minuteOfDay,
        bookings,
        eligibility,
    });
});

// Download an .ics calendar invite for a logged-in student's appointment
app.get('/api/bookings/:id/ics', requireStudent, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
        return res.status(400).json({ error: 'Invalid appointment ID.' });
    }

    const { data: row, error } = await db()
        .from(TABLE)
        .select('*')
        .eq('id', req.params.id)
        .eq('student_id', req.student.id)
        .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!row) return res.status(404).json({ error: 'Appointment not found.' });

    const booking = toBooking(row, null, req.student);
    const isCancelled = booking.status === 'cancelled';
    const sequence = isCancelled
        ? (booking.rescheduledCount || 0) + 1
        : (booking.rescheduledCount || 0);
    const ics = buildBookingIcs(booking, {
        method: isCancelled ? 'CANCEL' : 'PUBLISH',
        status: isCancelled ? 'CANCELLED' : 'CONFIRMED',
        sequence,
    });

    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="consultation-${booking.reference.toLowerCase()}.ics"`);
    res.send(ics);
});

// Allow a logged-in student to cancel their own appointment (only at least 2 hours before the schedule)
app.post('/api/bookings/:id/cancel', requireStudent, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
        return res.status(400).json({ error: 'Invalid appointment ID.' });
    }

    const { data: row, error: fetchErr } = await db()
        .from(TABLE)
        .select('*')
        .eq('id', req.params.id)
        .eq('student_id', req.student.id)
        .maybeSingle();
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!row) return res.status(404).json({ error: 'Appointment not found.' });

    if (row.status === 'cancelled') {
        return res.status(400).json({ error: 'This appointment has already been cancelled.' });
    }
    if (row.status === 'completed' || row.status === 'no_show') {
        return res.status(400).json({ error: 'Completed or recorded appointments cannot be cancelled.' });
    }

    const now = nowInTz();
    const [startMinute] = rowInterval(row);
    const minsLeft = minutesUntilBooking(row.appointment_date, startMinute, now);

    if (minsLeft < CANCEL_CUTOFF_MINUTES) {
        return res.status(400).json({
            code: 'CANCEL_WINDOW_PASSED',
            error: 'Appointments can only be cancelled at least 2 hours before the scheduled time.',
        });
    }

    const cancelledAt = new Date().toISOString();
    const { data, error } = await db()
        .from(TABLE)
        .update({
            status: 'cancelled',
            cancellation_reason: 'Cancelled by student.',
            cancelled_at: cancelledAt,
        })
        .eq('id', row.id)
        .eq('student_id', req.student.id)
        .select('*')
        .maybeSingle();

    if (error) {
        if (['23514', '42703', 'PGRST204'].includes(error.code)) {
            return res.status(500).json({
                error: 'Database schema needs updating: please run supabase/schema.sql in your Supabase SQL Editor.',
            });
        }
        return res.status(500).json({ error: error.message });
    }
    if (!data) return res.status(404).json({ error: 'Appointment not found.' });

    remindedAppointmentIds.delete(row.id);
    remindedStudentAppointmentIds.delete(row.id);

    const booking = toBooking(data, now, req.student);
    const emailPromise = sendStudentCancellationEmail(booking, resolveSiteOrigin(req), { cancelledBy: 'student' }).catch((err) => {
        console.error('Failed to send student cancellation email:', err.message || err);
    });
    const rtPromise = notifyRealtimeListeners({
        type: 'booking_cancelled',
        date: data.appointment_date,
        bookingId: data.id,
        by: 'student',
    });
    if (process.env.VERCEL) {
        await Promise.all([emailPromise, rtPromise]);
    }

    res.json({ ok: true, booking });
});

// Atomically swap a logged-in student's existing appointment to a new date/time in one transaction
async function handleStudentReschedule(req, res) {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
        return res.status(400).json({ error: 'Invalid appointment ID.' });
    }

    const student = req.student;
    const { data: row, error: fetchErr } = await db()
        .from(TABLE)
        .select('*')
        .eq('id', req.params.id)
        .eq('student_id', student.id)
        .maybeSingle();
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!row) return res.status(404).json({ error: 'Appointment not found.' });

    if (row.status === 'cancelled') {
        return res.status(400).json({ error: 'Cancelled appointments cannot be rescheduled.' });
    }
    if (row.status === 'completed' || row.status === 'no_show') {
        return res.status(400).json({ error: 'Completed or recorded appointments cannot be rescheduled.' });
    }

    const now = nowInTz();
    const [currentStartMinute] = rowInterval(row);
    const minsLeft = minutesUntilBooking(row.appointment_date, currentStartMinute, now);
    if (minsLeft < CANCEL_CUTOFF_MINUTES) {
        return res.status(400).json({
            code: 'RESCHEDULE_WINDOW_PASSED',
            error: 'Appointments can only be rescheduled at least 2 hours before the scheduled time.',
        });
    }

    const consultationType = normalizePurpose(row.consultation_type);
    const typeInfo = CONSULTATION_TYPES[consultationType];
    const isDefense = consultationType === 'defense';
    const isDropoff = consultationType === 'dropoff' || Number(row.duration_minutes) === 0;
    const defenseLevel = isDefense
        ? (normalizeDefenseLevel(row.defense_level) || normalizeDefenseLevel(student.project_level) || 'capstone1')
        : null;
    const durationMinutes = isDropoff
        ? DROPOFF_DURATION
        : isDefense
            ? (Number.isFinite(row.duration_minutes) && row.duration_minutes > 0 ? Number(row.duration_minutes) : DEFENSE_LEVELS[defenseLevel].durationMinutes)
            : (Number.isFinite(row.duration_minutes) && row.duration_minutes > 0 ? Number(row.duration_minutes) : typeInfo.durationMinutes);

    const body = req.body || {};
    const date = String(body.date ?? '').trim();
    const startMinute = Number(body.startMinute);

    if (!parseDate(date)) {
        return res.status(400).json({ error: 'Please select a valid date.' });
    }
    if (!Number.isInteger(startMinute) || startMinute < 0 || startMinute >= 1440) {
        return res.status(400).json({ error: 'Please select a valid start time.' });
    }
    if (date === row.appointment_date && startMinute === currentStartMinute) {
        return res.status(400).json({
            code: 'SAME_SLOT',
            error: 'Please select a different date or time to reschedule your appointment.',
        });
    }
    if (date <= now.date) {
        return res.status(400).json({
            error: isDefense
                ? 'Defenses must be scheduled at least 1 day before the defense day.'
                : 'Consultations must be scheduled at least 1 day before the consultation day.',
        });
    }

    let nextReason = row.reason;
    if (Object.prototype.hasOwnProperty.call(body, 'reason') && body.reason !== null && body.reason !== undefined) {
        const trimmed = String(body.reason).trim();
        if (trimmed.length > 0) {
            if (trimmed.length < 5 || trimmed.length > 1000) {
                return res.status(400).json({
                    field: 'reason',
                    error: 'Please provide brief details for this consultation (5–1000 characters).',
                });
            }
            nextReason = trimmed;
        }
    }

    await loadScheduleConfig({ force: true });

    let slotStart;
    let slotEnd;
    if (isDefense) {
        if (!isBookableDate(date, now, 'defense') || !isValidDefenseStart(date, startMinute, durationMinutes, [])) {
            return res.status(400).json({
                error: `That start time is not within the defense schedule for this day, or a ${formatDurationLabel('defense', durationMinutes)} defense would not fit before the window ends. Please choose another time.`,
            });
        }
        slotStart = startMinute;
        slotEnd = startMinute + durationMinutes;
    } else {
        const customWindows = consultationType === 'letter_pickup'
            ? normalizePickupWindows(await fetchLetterPickupByDate(date))
            : null;
        const validSlot = generateDaySlots(date, consultationType, customWindows).find((s) => s.startMinute === startMinute);
        if (!isBookableDate(date, now, consultationType, customWindows) || !validSlot || !isFutureSlot(date, startMinute, now)) {
            return res.status(400).json({ error: 'That time slot is not available. Please choose another one.' });
        }
        slotStart = validSlot.startMinute;
        slotEnd = validSlot.endMinute;
    }

    const dayBlocks = await fetchBlockedByDate(date);
    if (dayBlocks.length) {
        const blockedIntervals = dayBlocks.map(blockInterval);
        const isBlocked = dayBlocks.some((b) => b.is_full_day) || (
            isDropoff
                ? isWindowFullyBlocked(slotStart, slotEnd, blockedIntervals)
                : hasOverlap(slotStart, slotEnd, blockedIntervals)
        );
        if (isBlocked) {
            const matchedBlock = dayBlocks.find((b) => {
                const [bs, be] = blockInterval(b);
                return slotStart < be && slotEnd > bs;
            }) || dayBlocks[0];
            return res.status(409).json({
                code: 'SLOT_UNAVAILABLE',
                error: matchedBlock?.reason
                    ? `The instructor is unavailable during that date/time (${matchedBlock.reason}). Your original appointment is unchanged.`
                    : 'The instructor is unavailable during that date/time. Your original appointment is unchanged.',
            });
        }
    }

    const { data: existingRows, error: existingErr } = await db()
        .from(TABLE)
        .select('*')
        .eq('appointment_date', date);
    if (existingErr) return res.status(500).json({ error: existingErr.message });

    if (isDropoff) {
        const duplicateDropoff = existingRows.some(
            (r) => r.id !== row.id && r.student_id === student.id && isActiveRow(r) && (!r.status || r.status === 'scheduled') && !isTimedRow(r)
        );
        if (duplicateDropoff) {
            return res.status(409).json({
                code: 'BOOKING_LIMIT',
                error: 'Your group already has a Manuscript Drop-off scheduled on this date. Your original appointment is unchanged.',
            });
        }
    } else {
        const bookedIntervals = existingRows
            .filter((r) => r.id !== row.id && isActiveRow(r) && isTimedRow(r))
            .map(rowInterval);
        if (hasOverlap(slotStart, slotEnd, bookedIntervals)) {
            return res.status(409).json({
                code: 'SLOT_UNAVAILABLE',
                error: isDefense
                    ? `${formatMinute(slotStart)} – ${formatMinute(slotEnd)} overlaps with a time that is already booked. Your original appointment is unchanged — please pick another time.`
                    : 'Sorry, someone just booked a slot that overlaps with that time. Your original appointment is unchanged — please pick another time.',
            });
        }
    }

    const previousBooking = toBooking(row, now, student);
    const rescheduledAt = new Date().toISOString();
    const nextRescheduledCount = (Number(row.rescheduled_count) || 0) + 1;

    let updatedRow = null;
    let updateErr = null;

    const rpcRes = await db()
        .rpc('reschedule_appointment', {
            p_appointment_id: row.id,
            p_student_id: student.id,
            p_new_date: date,
            p_new_start_minute: slotStart,
            p_new_duration_minutes: durationMinutes,
            p_new_reason: nextReason,
        });

    if (!rpcRes.error && rpcRes.data) {
        updatedRow = Array.isArray(rpcRes.data) ? rpcRes.data[0] : rpcRes.data;
    } else if (rpcRes.error && ['42883', 'PGRST202', '42703', 'PGRST204'].includes(rpcRes.error.code)) {
        const extRes = await db()
            .from(TABLE)
            .update({
                appointment_date: date,
                start_hour: Math.floor(slotStart / 60),
                start_minute: slotStart,
                duration_minutes: durationMinutes,
                reason: nextReason,
                previous_date: row.appointment_date,
                previous_start_minute: currentStartMinute,
                rescheduled_at: rescheduledAt,
                rescheduled_count: nextRescheduledCount,
                reminder_sent_at: null,
                student_reminder_sent_at: null,
            })
            .eq('id', row.id)
            .eq('student_id', student.id)
            .eq('status', 'scheduled')
            .select('*')
            .maybeSingle();

        if (!extRes.error) {
            updatedRow = extRes.data;
        } else if (['42703', 'PGRST204'].includes(extRes.error.code)) {
            const coreRes = await db()
                .from(TABLE)
                .update({
                    appointment_date: date,
                    start_hour: Math.floor(slotStart / 60),
                    start_minute: slotStart,
                    duration_minutes: durationMinutes,
                    reason: nextReason,
                    reminder_sent_at: null,
                    student_reminder_sent_at: null,
                })
                .eq('id', row.id)
                .eq('student_id', student.id)
                .eq('status', 'scheduled')
                .select('*')
                .maybeSingle();
            updatedRow = coreRes.data;
            updateErr = coreRes.error;
        } else {
            updateErr = extRes.error;
        }
    } else {
        updateErr = rpcRes.error;
    }

    if (updateErr) {
        if (updateErr.code === '23505' && isDropoff) {
            return res.status(409).json({
                code: 'BOOKING_LIMIT',
                error: 'Your group already has a Manuscript Drop-off scheduled on this date. Your original appointment is unchanged.',
            });
        }
        if (updateErr.code === '23505' || updateErr.code === '23P01') {
            const isUnavailableErr = String(updateErr.message || '').toLowerCase().includes('unavailable');
            return res.status(409).json({
                code: 'SLOT_UNAVAILABLE',
                error: isUnavailableErr
                    ? 'The instructor is unavailable during that date/time. Your original appointment is unchanged.'
                    : 'Sorry, someone just booked that time. Your original appointment is still intact — please pick another time.',
            });
        }
        if (updateErr.code === 'P0002') {
            return res.status(404).json({ error: 'Appointment not found.' });
        }
        if (updateErr.code === 'P0001') {
            return res.status(400).json({ error: updateErr.message || 'Could not reschedule this appointment.' });
        }
        if (['23514', '42703', 'PGRST204'].includes(updateErr.code)) {
            return res.status(500).json({
                error: 'Database schema needs updating: please run supabase/schema.sql in your Supabase SQL Editor.',
            });
        }
        return res.status(500).json({ error: updateErr.message });
    }
    if (!updatedRow) {
        return res.status(409).json({
            error: 'This appointment could not be rescheduled because its status changed. Please refresh your appointments.',
        });
    }

    remindedAppointmentIds.delete(row.id);
    remindedStudentAppointmentIds.delete(row.id);

    const booking = toBooking(updatedRow, now, student);
    const emailPromise = sendStudentRescheduleEmail(booking, previousBooking, resolveSiteOrigin(req)).catch((err) => {
        console.error('Failed to send student reschedule email:', err.message || err);
    });
    const rtPromise = notifyRealtimeListeners({
        type: 'booking_rescheduled',
        date: booking.date,
        previousDate: previousBooking.date,
        bookingId: booking.id,
    });
    if (process.env.VERCEL) {
        await Promise.all([emailPromise, rtPromise]);
    }

    res.json({ ok: true, booking, previousBooking });
}

app.post('/api/bookings/:id/reschedule', requireStudent, handleStudentReschedule);
app.put('/api/bookings/:id/reschedule', requireStudent, handleStudentReschedule);

app.post('/api/bookings', requireStudent, async (req, res) => {
    const body = req.body || {};
    const student = req.student;
    const consultationType = normalizePurpose(body.consultationType);
    const typeInfo = CONSULTATION_TYPES[consultationType];
    const isDefense = consultationType === 'defense';
    const defenseLevel = isDefense
        ? (normalizeDefenseLevel(body.defenseLevel) || normalizeDefenseLevel(student.project_level) || 'capstone1')
        : null;
    const durationMinutes = isDefense ? DEFENSE_LEVELS[defenseLevel].durationMinutes : typeInfo.durationMinutes;
    const isDropoff = consultationType === 'dropoff';
    const requiresAllMembers = consultationType === 'system' || consultationType === 'retrieval' || isDefense;
    const type = (requiresAllMembers || body.type === 'group') ? 'group' : 'individual';
    const date = String(body.date ?? '');
    const startMinute = Number(body.startMinute);

    if (consultationType === 'letter') {
        if (student.instructor_role !== 'adviser') {
            return res.status(403).json({
                code: 'ADVISER_ONLY',
                error: `Communication Letter Signature is only available for students who registered ${TEACHER_NAME} as their Adviser.`,
            });
        }
        if (body.beninsigInitialConfirmed !== true) {
            return res.status(400).json({
                code: 'BENINSIG_REQUIRED',
                error: "Please obtain the initial of Ma'am Melinda Beninsig on your communication letter first before scheduling a signature with your adviser.",
            });
        }
    }

    if (consultationType === 'letter_pickup') {
        if (student.instructor_role !== 'adviser') {
            return res.status(403).json({
                code: 'ADVISER_ONLY',
                error: `Pickup of Communication Letter is only available for students who registered ${TEACHER_NAME} as their Adviser.`,
            });
        }
        if (body.letterPickupEmailConfirmed !== true) {
            return res.status(400).json({
                code: 'LETTER_PICKUP_EMAIL_REQUIRED',
                error: 'Please wait until you are notified through email that your communication letter is ready for pickup before scheduling.',
            });
        }
    }

    if (consultationType === 'retrieval') {
        if (body.retrievalEmailConfirmed !== true) {
            return res.status(400).json({
                code: 'RETRIEVAL_EMAIL_REQUIRED',
                error: 'Please wait until you are notified through email that your manuscript has been checked before scheduling a Retrieval of Manuscript.',
            });
        }
    }

    let rawReason = String(body.reason ?? '').trim();
    if (!rawReason && consultationType === 'dropoff') {
        rawReason = 'Manuscript drop-off for checking.';
    } else if (!rawReason && consultationType === 'retrieval') {
        rawReason = 'Retrieval of checked manuscript to discuss needed revisions.';
    } else if (!rawReason && consultationType === 'letter_pickup') {
        rawReason = 'Pickup of signed communication letter.';
    } else if (!rawReason && isDefense) {
        rawReason = `${DEFENSE_LEVELS[defenseLevel].label} defense.`;
    }
    const reason = rawReason;

    // Always preserve Capstone / Thesis title even for 1- or 2-member groups
    const teamName = cleanName(body.teamName || student.capstone_title);
    if (teamName.length < 2 || teamName.length > 200) {
        return res.status(400).json({
            field: 'teamName',
            error: 'Please enter your Capstone / Thesis title (2–200 characters).',
        });
    }

    const registeredMembers = (Array.isArray(student.members) && student.members.length ? student.members : [student.full_name])
        .map(cleanName)
        .filter(Boolean)
        .slice(0, MAX_MEMBERS);
    if (!registeredMembers.length) registeredMembers.push(student.full_name);
    registeredMembers[0] = student.full_name;

    let members;
    if (requiresAllMembers) {
        // Mandatory all-member schedules always use the group's registered members
        members = [...registeredMembers];
    } else if (type === 'group') {
        const submittedMembers = (Array.isArray(body.members) ? body.members : []).map(cleanName).filter(Boolean);
        members = submittedMembers.length ? submittedMembers : [...registeredMembers];
        // Member 1 is always the logged-in student (the person responsible for the booking)
        members[0] = student.full_name;
        if (members.length < MIN_MEMBERS) {
            return res.status(400).json({ field: 'members', error: 'Please enter at least 1 member name.' });
        }
        if (members.length > MAX_MEMBERS) {
            return res.status(400).json({
                field: 'members',
                error: `Only up to ${MAX_MEMBERS} members are allowed in a Capstone / Thesis group.`,
            });
        }
    } else {
        // Representative-only attendance uses the verified account's name while keeping teamName
        members = [student.full_name];
    }

    if (members.some((m) => m.length < 2 || m.length > 100)) {
        return res.status(400).json({
            field: 'members',
            error: 'Each member needs a full name (2–100 characters).',
        });
    }
    if (reason.length < 5 || reason.length > 1000) {
        return res.status(400).json({
            field: 'reason',
            error: 'Please provide brief details for this consultation (5–1000 characters).',
        });
    }

    const now = nowInTz();
    if (parseDate(date) && date <= now.date) {
        return res.status(400).json({
            error: isDefense
                ? 'Defenses must be scheduled at least 1 day before the defense day.'
                : 'Consultations must be scheduled at least 1 day before the consultation day.',
        });
    }

    await loadScheduleConfig({ force: true });

    let slotStart;
    let slotEnd;
    if (isDefense) {
        // Defenses use a typed start time; it must fit entirely inside one defense window.
        if (!isBookableDate(date, now, 'defense') || !Number.isInteger(startMinute)
            || !isValidDefenseStart(date, startMinute, durationMinutes, [])) {
            return res.status(400).json({
                error: `That start time is not within the defense schedule for this day, or a ${DEFENSE_LEVELS[defenseLevel].durationLabel} defense would not fit before the window ends. Please choose another time.`,
            });
        }
        slotStart = startMinute;
        slotEnd = startMinute + durationMinutes;
    } else {
        const customWindows = consultationType === 'letter_pickup'
            ? normalizePickupWindows(await fetchLetterPickupByDate(date))
            : null;
        const validSlot = generateDaySlots(date, consultationType, customWindows).find((s) => s.startMinute === startMinute);
        if (!isBookableDate(date, now, consultationType, customWindows) || !validSlot || !isFutureSlot(date, startMinute, now)) {
            return res.status(400).json({ error: 'That time slot is not available. Please choose another one.' });
        }
        slotStart = validSlot.startMinute;
        slotEnd = validSlot.endMinute;
    }

    // Check student's existing appointments (for pickup notification eligibility & upcoming limits)
    const { data: allMine, error: mineErr } = await db()
        .from(TABLE)
        .select('*')
        .eq('student_id', student.id);
    if (mineErr) return res.status(500).json({ error: mineErr.message });

    const eligibility = computePickupEligibility(student, allMine || [], now);
    if (consultationType === 'retrieval' && !eligibility.canBookRetrieval) {
        const msg = eligibility.hasUpcomingRetrieval
            ? 'You already have an upcoming Retrieval of Manuscript scheduled. You can reschedule or cancel it in My Appointments (at least 2 hours before the schedule).'
            : eligibility.retrievalAlreadyBookedForNotification
                ? 'You have already scheduled a Retrieval of Manuscript for your latest manuscript-ready notification. Please wait for a new email notification after your next manuscript check.'
                : 'You can only schedule a Retrieval of Manuscript after an email notification has been sent to you confirming that your manuscript is checked and ready for pickup.';
        return res.status(403).json({
            code: 'RETRIEVAL_EMAIL_REQUIRED',
            alreadyBooked: eligibility.retrievalAlreadyBookedForNotification,
            hasUpcoming: eligibility.hasUpcomingRetrieval,
            error: msg,
        });
    }
    if (consultationType === 'letter_pickup' && !eligibility.canBookLetterPickup) {
        const msg = eligibility.hasUpcomingLetterPickup
            ? 'You already have an upcoming Communication Letter Pickup scheduled. You can reschedule or cancel it in My Appointments (at least 2 hours before the schedule).'
            : eligibility.letterPickupAlreadyBookedForNotification
                ? 'You have already scheduled a Pickup of Communication Letter for your latest email notification. Please wait for a new notification if you submitted another letter.'
                : 'You can only schedule a Pickup of Communication Letter after an email notification has been sent to you confirming that your signed letter is ready for pickup.';
        return res.status(403).json({
            code: 'LETTER_PICKUP_EMAIL_REQUIRED',
            alreadyBooked: eligibility.letterPickupAlreadyBookedForNotification,
            hasUpcoming: eligibility.hasUpcomingLetterPickup,
            error: msg,
        });
    }

    const upcomingMine = (allMine || []).filter((r) => {
        if (!isActiveRow(r)) return false;
        if (r.status && r.status !== 'scheduled') return false;
        if (r.appointment_date < now.date) return false;
        const [, end] = rowInterval(r);
        return r.appointment_date > now.date || end > now.minuteOfDay;
    });

    if (isDefense) {
        // Defenses have their own limit and do not use up the group's consultation slots.
        const upcomingDefenses = upcomingMine.filter((r) => r.consultation_type === 'defense');
        if (upcomingDefenses.length >= MAX_UPCOMING_DEFENSES) {
            return res.status(409).json({
                code: 'BOOKING_LIMIT',
                error: 'Your group already has an upcoming defense scheduled. You can reschedule or cancel it in My Appointments (at least 2 hours before the schedule).',
            });
        }
    } else if (consultationType === 'letter_pickup') {
        if (upcomingMine.some((r) => r.consultation_type === 'letter_pickup')) {
            return res.status(409).json({
                code: 'BOOKING_LIMIT',
                error: 'Your group already has an upcoming Communication Letter Pickup scheduled. You can reschedule or cancel it in My Appointments (at least 2 hours before the schedule).',
            });
        }
    } else if (isDropoff) {
        if (upcomingMine.some((r) => !isTimedRow(r) && r.appointment_date === date)) {
            return res.status(409).json({
                code: 'BOOKING_LIMIT',
                error: 'Your group has already scheduled a Manuscript Drop-off on this date.',
            });
        }
        if (upcomingMine.filter((r) => !isTimedRow(r)).length >= 2) {
            return res.status(409).json({
                code: 'BOOKING_LIMIT',
                error: 'You already have pending Manuscript Drop-offs scheduled.',
            });
        }
    } else {
        if (consultationType === 'retrieval' && upcomingMine.some((r) => r.consultation_type === 'retrieval')) {
            return res.status(409).json({
                code: 'BOOKING_LIMIT',
                error: 'Your group already has an upcoming Retrieval of Manuscript scheduled. You can reschedule or cancel it in My Appointments (at least 2 hours before the schedule).',
            });
        }
        if (AUTH.maxActiveBookings > 0) {
            const upcomingTimed = upcomingMine.filter(
                (r) => isTimedRow(r) && r.consultation_type !== 'defense' && r.consultation_type !== 'letter_pickup'
            );
            if (upcomingTimed.length >= AUTH.maxActiveBookings) {
                return res.status(409).json({
                    code: 'BOOKING_LIMIT',
                    error: AUTH.maxActiveBookings === 1
                        ? 'You already have an upcoming timed consultation. You can reschedule or cancel it in My Appointments (at least 2 hours before the schedule).'
                        : `You already have ${upcomingTimed.length} upcoming timed consultations (the limit is ${AUTH.maxActiveBookings}). You can reschedule or cancel one in My Appointments at least 2 hours before the schedule.`,
                });
            }
        }
    }

    // Reject any booking (consultation, defense, or drop-off) that falls on a date/time blocked by the instructor.
    const dayBlocks = await fetchBlockedByDate(date);
    if (dayBlocks.length) {
        const blockedIntervals = dayBlocks.map(blockInterval);
        const isBlocked = dayBlocks.some((b) => b.is_full_day) || (
            isDropoff
                ? isWindowFullyBlocked(slotStart, slotEnd, blockedIntervals)
                : hasOverlap(slotStart, slotEnd, blockedIntervals)
        );
        if (isBlocked) {
            const matchedBlock = dayBlocks.find((b) => {
                const [bs, be] = blockInterval(b);
                return slotStart < be && slotEnd > bs;
            }) || dayBlocks[0];
            return res.status(409).json({
                error: matchedBlock?.reason
                    ? `The instructor is unavailable during that date/time (${matchedBlock.reason}). Please choose another date or time.`
                    : 'The instructor is unavailable during that date/time. Please choose another date or time.',
            });
        }
    }

    // For timed bookings (consultations AND defenses), reject anything overlapping an existing timed booking.
    // This is what prevents a defense from taking time already booked for a consultation, and vice versa.
    if (!isDropoff) {
        const { data: existingRows, error: existingErr } = await db()
            .from(TABLE)
            .select('*')
            .eq('appointment_date', date);
        if (existingErr) return res.status(500).json({ error: existingErr.message });

        const bookedIntervals = existingRows.filter((r) => isActiveRow(r) && isTimedRow(r)).map(rowInterval);
        if (hasOverlap(slotStart, slotEnd, bookedIntervals)) {
            return res.status(409).json({
                error: isDefense
                    ? `${formatMinute(slotStart)} – ${formatMinute(slotEnd)} overlaps with a time that is already booked (a consultation or another defense). Please pick another start time.`
                    : 'Sorry, someone just booked a slot that overlaps with that time. Please pick another time.',
            });
        }
    }

    const row = {
        student_name: members[0], // the person booking (group representative)
        team_name: teamName,
        members,
        reason,
        appointment_date: date,
        start_hour: Math.floor(slotStart / 60),
        start_minute: slotStart,
        duration_minutes: durationMinutes,
        consultation_type: consultationType,
        student_id: student.id,
        student_email: student.email,
        capstone_title: student.capstone_title || teamName || null,
        instructor_role: student.instructor_role || null,
    };
    const studentLevel = normalizeDefenseLevel(student.project_level);
    if (isDefense) row.defense_level = defenseLevel;
    else if (studentLevel) row.defense_level = studentLevel;

    const { data, error } = await db()
        .from(TABLE)
        .insert([row])
        .select('*')
        .single();

    if (error) {
        if (error.code === '23505' || error.code === '23P01') {
            // 23505 = same start time taken, 23P01 = overlapping time range taken (appointments_no_overlap)
            return res.status(409).json({ error: 'Sorry, someone just booked that time. Please pick another time.' });
        }
        if (error.code === '23514' || error.code === '42703' || error.code === 'PGRST204') {
            return res.status(500).json({
                error: 'Database schema needs updating: please run supabase/schema.sql in your Supabase SQL Editor.',
            });
        }
        return res.status(500).json({ error: error.message });
    }

    // Remember the group's current Capstone / Thesis level (e.g. after moving from Capstone 1 to Capstone 2)
    let updatedStudent = null;
    if (isDefense && student.project_level !== defenseLevel) {
        const { data: s, error: levelErr } = await db()
            .from(STUDENTS_TABLE)
            .update({ project_level: defenseLevel })
            .eq('id', student.id)
            .select('*')
            .maybeSingle();
        if (levelErr) console.error('Could not save project level:', levelErr);
        else if (s) updatedStudent = publicStudent(s);
    }

    const booking = toBooking(data, now, student);
    const emailPromise = sendStudentBookingConfirmationEmail(booking, resolveSiteOrigin(req)).catch((err) => {
        console.error('Failed to send student booking confirmation email:', err.message || err);
    });
    const rtPromise = notifyRealtimeListeners({
        type: 'booking_created',
        date: booking.date,
        bookingId: booking.id,
    });
    if (process.env.VERCEL) {
        await Promise.all([emailPromise, rtPromise]);
    }

    res.status(201).json({ booking, student: updatedStudent });
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

app.get('/appointments', (req, res) => res.redirect('/appointments.html'));
app.get('/admin', (req, res) => res.redirect('/admin.html'));

app.post('/api/admin/login', requireAdmin, (req, res) => res.json({ ok: true }));

async function fetchStudentUpdateLogs() {
    const { data, error } = await db()
        .from(STUDENT_LOGS_TABLE)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
    if (error) {
        if (['42P01', 'PGRST205'].includes(error.code)) return [];
        console.error('Could not fetch student_update_logs:', error);
        return [];
    }
    return data || [];
}

async function fetchStoredEmailLogs(limit = MAX_EMAIL_LOGS_RETURNED) {
    const byId = new Map();
    const addRow = (raw) => {
        const normalized = normalizeEmailLogRow(raw);
        if (normalized && !byId.has(normalized.id)) {
            byId.set(normalized.id, normalized);
        }
    };

    try {
        const { data, error } = await db()
            .from(EMAIL_LOGS_TABLE)
            .select('*')
            .order('created_at', { ascending: false })
            .limit(limit);
        if (!error && Array.isArray(data)) {
            data.forEach(addRow);
        } else if (error && ['42P01', 'PGRST205', '42703', 'PGRST204'].includes(error.code)) {
            const { data: fallbackSetting } = await db()
                .from(SETTINGS_TABLE)
                .select('value')
                .eq('key', EMAIL_LOGS_FALLBACK_KEY)
                .maybeSingle();
            if (fallbackSetting?.value) {
                try {
                    const parsed = JSON.parse(fallbackSetting.value);
                    if (Array.isArray(parsed)) parsed.forEach(addRow);
                } catch { /* ignore */ }
            }
        } else if (error) {
            console.error('Could not fetch email_logs:', error);
        }
    } catch (err) {
        console.warn('Email log query fallback:', err.message || err);
    }

    recentMemoryEmailLogs.forEach(addRow);
    return [...byId.values()].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function buildCompleteEmailLogs({ storedLogs = [], rawAppointmentRows = [], bookings = [], studentRows = [] } = {}) {
    const merged = [...storedLogs];
    const recordedBookingTypes = new Set();
    const recordedPickupTimes = [];

    for (const log of storedLogs) {
        if (log.bookingId) {
            recordedBookingTypes.add(`${log.bookingId}|${log.emailType}`);
            if (log.emailType.startsWith('booking_cancelled')) {
                recordedBookingTypes.add(`${log.bookingId}|booking_cancelled`);
            }
            if (log.emailType === 'defense_scheduled_admin') {
                recordedBookingTypes.add(`${log.bookingId}|booking_confirmed`);
            }
            if (log.emailType === 'defense_rescheduled_admin') {
                recordedBookingTypes.add(`${log.bookingId}|booking_rescheduled`);
            }
        }
        if (log.category === 'pickup_notice') {
            recordedPickupTimes.push({
                studentId: log.studentId || null,
                primaryEmail: log.recipients?.[0] || null,
                emailType: log.emailType,
                ms: new Date(log.createdAt).getTime(),
            });
        }
    }

    const hasNearbyPickupLog = (studentId, primaryEmail, emailType, isoTime) => {
        const ms = new Date(isoTime).getTime();
        if (!Number.isFinite(ms)) return true;
        return recordedPickupTimes.some((p) => {
            if (p.emailType !== emailType) return false;
            const sameTarget = (studentId && p.studentId && p.studentId === studentId)
                || (primaryEmail && p.primaryEmail && p.primaryEmail === primaryEmail);
            return sameTarget && Math.abs(p.ms - ms) <= 120 * 1000;
        });
    };

    const rawById = new Map();
    for (const r of rawAppointmentRows) {
        if (r?.id) rawById.set(r.id, r);
    }

    const nowMs = Date.now();
    const HISTORICAL_SETTLE_MS = 30 * 1000;

    for (const b of bookings) {
        const r = rawById.get(b.id);
        if (!r) continue;
        const recipients = getGroupRecipientEmails({ booking: b });
        const groupDisplayName = Array.isArray(b.members) && b.members.length ? b.members.join(', ') : b.name;
        const projectTitle = b.capstoneTitle || b.teamName || null;
        const dateLabel = formatLongDateStr(b.date);

        // 1. Instructor 10-min reminder
        if (r.reminder_sent_at && !recordedBookingTypes.has(`${b.id}|instructor_reminder`)) {
            merged.push({
                id: `hist-t-rem-${b.id}`,
                sentBy: 'system',
                category: 'reminder',
                emailType: 'instructor_reminder',
                status: 'sent',
                subject: `Reminder: ${b.consultationTitle} (${b.label}) — ${projectTitle || b.name}`,
                recipients: TEACHER_EMAIL ? [TEACHER_EMAIL] : [],
                recipientName: TEACHER_NAME,
                capstoneTitle: projectTitle,
                studentId: b.studentId || null,
                bookingId: b.id,
                bodyPreview: `Automated 10-minute reminder sent to ${TEACHER_NAME} for ${b.consultationTitle} on ${dateLabel} (${b.label}).`,
                errorMessage: null,
                createdAt: r.reminder_sent_at,
            });
        }

        // 2. Student 1-hr reminder
        if (r.student_reminder_sent_at && recipients.length && !recordedBookingTypes.has(`${b.id}|student_reminder`)) {
            merged.push({
                id: `hist-s-rem-${b.id}`,
                sentBy: 'system',
                category: 'reminder',
                emailType: 'student_reminder',
                status: 'sent',
                subject: `Reminder: Your ${b.consultationTitle} (${b.label}) — #${b.reference}`,
                recipients,
                recipientName: groupDisplayName,
                capstoneTitle: projectTitle,
                studentId: b.studentId || null,
                bookingId: b.id,
                bodyPreview: `Automated appointment reminder sent to ${recipients.join(', ')} for ${b.consultationTitle} on ${dateLabel} (${b.label}).`,
                errorMessage: null,
                createdAt: r.student_reminder_sent_at,
            });
        }

        // 3. Pickup notice sent from Drop-off / Comm. Letter card
        if (r.notified_at && recipients.length && ['dropoff', 'letter'].includes(b.consultationType)) {
            const pType = b.consultationType === 'letter' ? 'letter_ready' : 'manuscript_ready';
            if (!recordedBookingTypes.has(`${b.id}|${pType}`) && !hasNearbyPickupLog(b.studentId, recipients[0], pType, r.notified_at)) {
                const subj = pType === 'letter_ready'
                    ? 'Communication Letter Ready for Pickup'
                    : 'Manuscript Ready for Pickup — Please Schedule Your Retrieval';
                merged.push({
                    id: `hist-pickup-${b.id}`,
                    sentBy: 'instructor',
                    category: 'pickup_notice',
                    emailType: pType,
                    status: 'sent',
                    subject: subj,
                    recipients,
                    recipientName: groupDisplayName,
                    capstoneTitle: projectTitle,
                    studentId: b.studentId || null,
                    bookingId: b.id,
                    bodyPreview: `Notification sent to ${recipients.join(', ')} for ${projectTitle || groupDisplayName}.`,
                    errorMessage: null,
                    createdAt: r.notified_at,
                });
                recordedPickupTimes.push({
                    studentId: b.studentId || null,
                    primaryEmail: recipients[0] || null,
                    emailType: pType,
                    ms: new Date(r.notified_at).getTime(),
                });
            }
        }

        // 4. Historical booking confirmation / reschedule / cancellation (>30s old so in-flight sends aren't duplicated)
        if (recipients.length && r.created_at && (nowMs - new Date(r.created_at).getTime() > HISTORICAL_SETTLE_MS)
            && !recordedBookingTypes.has(`${b.id}|booking_confirmed`)) {
            merged.push({
                id: `hist-conf-${b.id}`,
                sentBy: 'system',
                category: 'booking',
                emailType: 'booking_confirmed',
                status: 'sent',
                subject: `Confirmed: ${b.consultationTitle} on ${dateLabel} (${b.label}) — #${b.reference}`,
                recipients,
                recipientName: groupDisplayName,
                capstoneTitle: projectTitle,
                studentId: b.studentId || null,
                bookingId: b.id,
                bodyPreview: `Booking confirmation sent to ${recipients.join(', ')} for ${b.consultationTitle} on ${dateLabel} (${b.label}).`,
                errorMessage: null,
                createdAt: r.created_at,
            });
        }

        if (recipients.length && r.rescheduled_at && (nowMs - new Date(r.rescheduled_at).getTime() > HISTORICAL_SETTLE_MS)
            && !recordedBookingTypes.has(`${b.id}|booking_rescheduled`)) {
            merged.push({
                id: `hist-resched-${b.id}`,
                sentBy: 'system',
                category: 'booking',
                emailType: 'booking_rescheduled',
                status: 'sent',
                subject: `Rescheduled: ${b.consultationTitle} moved to ${dateLabel} (${b.label}) — #${b.reference}`,
                recipients,
                recipientName: groupDisplayName,
                capstoneTitle: projectTitle,
                studentId: b.studentId || null,
                bookingId: b.id,
                bodyPreview: `Reschedule confirmation sent to ${recipients.join(', ')} for ${b.consultationTitle} on ${dateLabel} (${b.label}).`,
                errorMessage: null,
                createdAt: r.rescheduled_at,
            });
        }

        if (recipients.length && b.status === 'cancelled' && r.cancelled_at
            && (nowMs - new Date(r.cancelled_at).getTime() > HISTORICAL_SETTLE_MS)
            && !recordedBookingTypes.has(`${b.id}|booking_cancelled`)) {
            const isStuCancel = b.cancellationReason === 'Cancelled by student.';
            merged.push({
                id: `hist-canc-${b.id}`,
                sentBy: 'system',
                category: 'cancellation',
                emailType: isStuCancel ? 'booking_cancelled_student' : 'booking_cancelled_admin',
                status: 'sent',
                subject: `Cancelled: ${b.consultationTitle} on ${dateLabel} (${b.label}) — #${b.reference}`,
                recipients,
                recipientName: groupDisplayName,
                capstoneTitle: projectTitle,
                studentId: b.studentId || null,
                bookingId: b.id,
                bodyPreview: `Cancellation notice sent to ${recipients.join(', ')}. Reason: ${b.cancellationReason || 'Instructor unavailable.'}`,
                errorMessage: null,
                createdAt: r.cancelled_at,
            });
        }
    }

    // 5. Historical manual pickup notifications stored in students.change_history
    for (const s of studentRows) {
        if (!Array.isArray(s.change_history)) continue;
        const recipients = getGroupRecipientEmails({ primaryEmail: s.email, studentRow: s });
        if (!recipients.length) continue;
        const groupDisplayName = Array.isArray(s.members) && s.members.length ? s.members.join(', ') : s.full_name;
        for (const h of s.change_history) {
            if (!h || h.type !== 'notification' || !['manuscript_ready', 'letter_ready'].includes(h.kind) || !h.notifiedAt) continue;
            if (hasNearbyPickupLog(s.id, recipients[0], h.kind, h.notifiedAt)) continue;
            const subj = h.kind === 'letter_ready'
                ? 'Communication Letter Ready for Pickup'
                : 'Manuscript Ready for Pickup — Please Schedule Your Retrieval';
            merged.push({
                id: `hist-stu-notif-${h.id || `${s.id}-${h.notifiedAt}`}`,
                sentBy: 'instructor',
                category: 'pickup_notice',
                emailType: h.kind,
                status: 'sent',
                subject: subj,
                recipients,
                recipientName: groupDisplayName,
                capstoneTitle: s.capstone_title || null,
                studentId: s.id,
                bookingId: null,
                bodyPreview: `Pickup notification emailed to ${recipients.join(', ')}.`,
                errorMessage: null,
                createdAt: h.notifiedAt,
            });
            recordedPickupTimes.push({
                studentId: s.id,
                primaryEmail: recipients[0],
                emailType: h.kind,
                ms: new Date(h.notifiedAt).getTime(),
            });
        }
    }

    merged.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return merged.slice(0, MAX_EMAIL_LOGS_RETURNED);
}

app.get('/api/admin/email-logs', requireAdmin, async (req, res) => {
    const [{ data: apptRows, error: apptErr }, studentsRes, storedLogs] = await Promise.all([
        db().from(TABLE).select('*'),
        db().from(STUDENTS_TABLE).select('*'),
        fetchStoredEmailLogs(MAX_EMAIL_LOGS_RETURNED),
    ]);
    if (apptErr) return res.status(500).json({ error: apptErr.message });

    const studentRows = Array.isArray(studentsRes?.data) ? studentsRes.data : [];
    const studentLookup = { byId: new Map(), byEmail: new Map() };
    studentRows.forEach((s) => {
        studentLookup.byId.set(s.id, s);
        if (s.email) studentLookup.byEmail.set(s.email.toLowerCase(), s);
    });
    const now = nowInTz();
    const bookings = (apptRows || []).map((r) => toBooking(r, now, studentLookup));
    let emailLogs = buildCompleteEmailLogs({
        storedLogs,
        rawAppointmentRows: apptRows || [],
        bookings,
        studentRows,
    });

    const sentByFilter = String(req.query.sentBy || '').trim().toLowerCase();
    if (sentByFilter === 'instructor' || sentByFilter === 'system') {
        emailLogs = emailLogs.filter((item) => item.sentBy === sentByFilter);
    }

    const catFilter = String(req.query.category || '').trim().toLowerCase();
    if (catFilter === 'others') {
        emailLogs = emailLogs.filter((item) => item.category !== 'reminder');
    } else if (catFilter === 'booking_updates') {
        emailLogs = emailLogs.filter((item) => item.category === 'booking' || item.category === 'cancellation');
    } else if (VALID_EMAIL_CATEGORIES.has(catFilter)) {
        emailLogs = emailLogs.filter((item) => item.category === catFilter);
    }

    const q = String(req.query.q || '').trim().toLowerCase();
    if (q) {
        emailLogs = emailLogs.filter((item) =>
            (item.subject && item.subject.toLowerCase().includes(q))
            || (item.recipientName && item.recipientName.toLowerCase().includes(q))
            || (item.capstoneTitle && item.capstoneTitle.toLowerCase().includes(q))
            || (item.bodyPreview && item.bodyPreview.toLowerCase().includes(q))
            || (Array.isArray(item.recipients) && item.recipients.some((r) => r.toLowerCase().includes(q)))
        );
    }

    res.json({ ok: true, emailLogs });
});

app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
    const [{ data, error }, blockedRows, pickupRows, studentsRes, rawUpdateLogs, storedEmailLogs] = await Promise.all([
        db()
            .from(TABLE)
            .select('*')
            .order('appointment_date', { ascending: true })
            .order('start_minute', { ascending: true }),
        fetchBlockedByDateRange('1970-01-01', '9999-12-31'),
        fetchLetterPickupByDateRange('1970-01-01', '9999-12-31'),
        db()
            .from(STUDENTS_TABLE)
            .select('*')
            .order('created_at', { ascending: false }),
        fetchStudentUpdateLogs(),
        fetchStoredEmailLogs(MAX_EMAIL_LOGS_RETURNED),
        loadBookingEndDateSetting({ force: true }),
    ]);
    if (error) return res.status(500).json({ error: error.message });

    const studentRows = Array.isArray(studentsRes?.data) ? studentsRes.data : [];
    const studentLookup = {
        byId: new Map(),
        byEmail: new Map(),
    };
    studentRows.forEach((s) => {
        studentLookup.byId.set(s.id, s);
        if (s.email) studentLookup.byEmail.set(s.email.toLowerCase(), s);
    });

    const logsByStudentId = new Map();
    const serializedLogs = [];
    const seenLogIds = new Set();

    for (const r of rawUpdateLogs) {
        const entry = {
            id: r.id,
            studentId: r.student_id,
            studentName: r.student_name,
            studentEmail: r.student_email,
            changedFields: Array.isArray(r.changed_fields) ? r.changed_fields : [],
            previousValues: r.previous_values || {},
            newValues: r.new_values || {},
            changesSummary: r.changes_summary || '',
            verifiedViaOtp: Boolean(r.verified_via_otp),
            createdAt: r.created_at,
        };
        seenLogIds.add(entry.id);
        serializedLogs.push(entry);
        if (entry.studentId) {
            if (!logsByStudentId.has(entry.studentId)) logsByStudentId.set(entry.studentId, []);
            logsByStudentId.get(entry.studentId).push(entry);
        }
    }

    // Merge any logs stored in students.change_history that aren't already in serializedLogs
    for (const s of studentRows) {
        if (!Array.isArray(s.change_history)) continue;
        for (const h of s.change_history) {
            if (!h || h.type === 'notification' || h.type === 'member_emails' || (h.id && seenLogIds.has(h.id))) continue;
            if (h.id) seenLogIds.add(h.id);
            serializedLogs.push(h);
            if (!logsByStudentId.has(s.id)) logsByStudentId.set(s.id, []);
            logsByStudentId.get(s.id).push(h);
        }
    }
    serializedLogs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

    const now = nowInTz();
    const bookings = attachPreviousConsultations(
        data.map((r) => toBooking(r, now, studentLookup)).sort(
            (a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute
        )
    );
    const blockedSchedules = blockedRows.map(toBlockedSchedule).sort(
        (a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute
    );
    const letterPickupSchedules = pickupRows.map(toLetterPickupSchedule).sort(
        (a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute
    );
    const students = studentRows.map((s) => {
        const level = normalizeDefenseLevel(s.project_level);
        const history = (logsByStudentId.get(s.id) || []).sort(
            (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
        );
        return {
            id: s.id,
            name: s.full_name,
            email: s.email,
            capstoneTitle: s.capstone_title || null,
            instructorRole: s.instructor_role || null,
            projectLevel: level,
            projectLevelLabel: level ? DEFENSE_LEVELS[level].label : null,
            members: Array.isArray(s.members) && s.members.length ? s.members : [s.full_name],
            memberEmails: extractStudentMemberEmails(s),
            lastLoginAt: s.last_login_at || null,
            updatedAt: s.updated_at || history[0]?.createdAt || null,
            createdAt: s.created_at || null,
            changeHistory: history,
        };
    });
    const emailLogs = buildCompleteEmailLogs({
        storedLogs: storedEmailLogs,
        rawAppointmentRows: data || [],
        bookings,
        studentRows,
    });
    res.json({
        today: now.date,
        currentHour: now.hour,
        currentMinute: now.minuteOfDay,
        bookingEndDate: getLastBookableDate(now),
        scheduleConfig: serializeScheduleConfig(getActiveScheduleConfig(), cachedLegacyPickupByDate),
        bookings,
        blockedSchedules,
        letterPickupSchedules,
        students,
        studentUpdateLogs: serializedLogs,
        emailLogs,
    });
});

/* ---------- Unified Schedule & Availability Admin Endpoints ---------- */
function extractTargetDatesFromBody(body) {
    const set = new Set();
    if (Array.isArray(body?.dates)) {
        for (const raw of body.dates) {
            const d = String(raw || '').trim();
            if (parseDate(d)) set.add(d);
        }
    } else if (body?.date) {
        const start = String(body.date || '').trim();
        const end = body.endDate ? String(body.endDate).trim() : start;
        if (!parseDate(start)) {
            throw httpError(400, 'Please select a valid date.');
        }
        if (!parseDate(end) || end < start) {
            throw httpError(400, 'End date must be on or after the start date.');
        }
        const diff = Math.round((parseDate(end).getTime() - parseDate(start).getTime()) / 86400000);
        if (diff > 120) {
            throw httpError(400, 'You can select at most 120 days at a time.');
        }
        for (let d = start; d <= end; d = addDays(d, 1)) {
            set.add(d);
        }
    }
    const sorted = [...set].sort();
    if (!sorted.length) {
        throw httpError(400, 'Please select at least one date on the calendar.');
    }
    if (sorted.length > 120) {
        throw httpError(400, 'You can update at most 120 dates at a time.');
    }
    return sorted;
}

app.get('/api/admin/schedule', requireAdmin, async (req, res) => {
    const cfg = await loadScheduleConfig({ force: true });
    res.json({
        ok: true,
        scheduleConfig: serializeScheduleConfig(cfg, cachedLegacyPickupByDate),
    });
});

// Open 1 or more dates for Consultations, Capstone/Thesis Defense, and/or Comm. Letter Pickup
app.post('/api/admin/schedule/open', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const dates = extractTargetDatesFromBody(body);

    const rawCategories = Array.isArray(body.categories)
        ? body.categories
        : body.category
            ? [body.category]
            : [];
    const categories = [...new Set(rawCategories.map((c) => String(c || '').trim()))]
        .filter((c) => SCHEDULE_CATEGORIES.includes(c));
    if (!categories.length) {
        return res.status(400).json({ error: 'Please choose what schedule type to open (Consultations, Defense, or Letter Pickup).' });
    }

    const mode = SCHEDULE_MODES.includes(body.mode) ? body.mode : 'full_day';
    const rawNote = String(body.note ?? '').trim();
    const note = rawNote ? rawNote.slice(0, 500) : null;
    const unblockDates = Boolean(body.unblockDates);

    const currentCfg = await loadScheduleConfig({ force: true });

    let customWindows = [];
    if (mode === 'custom') {
        const minDur = categories.includes('defense') && categories.length === 1 ? 60 : 5;
        customWindows = normalizeWindowIntervals(body.windows, minDur);
        if (!customWindows.length) {
            return res.status(400).json({
                error: categories.includes('defense') && categories.length === 1
                    ? 'Please enter a valid start and end time (at least 1 hour long for defenses).'
                    : 'Please enter a valid start and end time (end time must be after start time).',
            });
        }
        if (categories.includes('defense') && !customWindows.some(([s, e]) => e - s >= 60)) {
            return res.status(400).json({
                error: 'Custom defense windows must be at least 1 hour (60 minutes) long so Capstone / Thesis defenses can fit.',
            });
        }
    } else if (mode === 'regular') {
        for (const cat of categories) {
            const sourceTable = cat === 'defense'
                ? currentCfg.defenseHoursByDay
                : currentCfg.consultationHoursByDay;
            const matchingDates = dates.filter((d) => {
                const dow = parseDate(d).getUTCDay();
                return Array.isArray(sourceTable[dow]) && sourceTable[dow].length > 0;
            });
            if (matchingDates.length === 0) {
                const missingWeekdays = [...new Set(dates.map((d) => WEEKDAY_NAMES[parseDate(d).getUTCDay()]))];
                const daysText = missingWeekdays.join(', ');
                const labelText = cat === 'defense' ? 'Defense Hours' : 'Consultation Hours';
                return res.status(400).json({
                    code: 'NO_REGULAR_HOURS_FOR_DAY',
                    missingWeekdays,
                    category: cat,
                    error: `${daysText} ${missingWeekdays.length === 1 ? 'has' : 'have'} no weekly ${labelText} set yet. Pick "10:00 AM – 5:00 PM" or "Custom Time Window(s)" above, or add ${daysText} hours in "My Regular Weekly Hours" below.`,
                });
            }
        }
    }

    const nextOpenMap = new Map();
    for (const entry of currentCfg.openDates) {
        nextOpenMap.set(`${entry.date}|${entry.category}`, { ...entry });
    }

    const nowIso = new Date().toISOString();
    let openedCount = 0;
    const openedDatesSet = new Set();
    const skippedDatesSet = new Set();
    const pickupDatesTouched = [];

    for (const d of dates) {
        const dow = parseDate(d).getUTCDay();
        for (const cat of categories) {
            const key = `${d}|${cat}`;
            const existing = nextOpenMap.get(key);
            let storedWindows;
            if (mode === 'full_day') {
                storedWindows = [[FULL_DAY_START_MINUTE, FULL_DAY_END_MINUTE]];
            } else if (mode === 'regular') {
                const tbl = cat === 'defense' ? currentCfg.defenseHoursByDay : currentCfg.consultationHoursByDay;
                storedWindows = (tbl[dow] || []).map(([s, e]) => [s, e]);
                if (storedWindows.length === 0) {
                    skippedDatesSet.add(d);
                    continue;
                }
            } else {
                storedWindows = customWindows.map(([s, e]) => [s, e]);
            }

            nextOpenMap.set(key, {
                id: existing?.id && !String(existing.id).startsWith('seed-') ? existing.id : crypto.randomUUID(),
                date: d,
                category: cat,
                mode,
                windows: storedWindows,
                note: note !== null ? note : (existing?.note || null),
                updatedAt: nowIso,
            });
            openedCount += 1;
            openedDatesSet.add(d);
            if (cat === 'letter_pickup') pickupDatesTouched.push(d);
        }
    }

    const effectiveOpenedDates = [...openedDatesSet];
    const skippedDates = [...skippedDatesSet].filter((d) => !openedDatesSet.has(d));

    // Remove superseded legacy letter_pickup_schedules rows for dates now managed in schedule_config_v1
    if (pickupDatesTouched.length) {
        try {
            await db().from(LETTER_PICKUP_TABLE).delete().in('available_date', [...new Set(pickupDatesTouched)]);
            for (const pd of pickupDatesTouched) cachedLegacyPickupByDate.delete(pd);
        } catch {
            // Ignore if legacy table doesn't exist
        }
    }

    let unblockedCount = 0;
    if (unblockDates && effectiveOpenedDates.length) {
        try {
            const { data: removedBlocks } = await db()
                .from(BLOCKED_TABLE)
                .delete()
                .in('blocked_date', effectiveOpenedDates)
                .eq('is_full_day', true)
                .select('id');
            unblockedCount = Array.isArray(removedBlocks) ? removedBlocks.length : 0;
        } catch {
            // Ignore block cleanup errors
        }
    }

    const saved = await saveScheduleConfig({
        version: SCHEDULE_CONFIG_VERSION,
        consultationHoursByDay: currentCfg.consultationHoursByDay,
        defenseHoursByDay: currentCfg.defenseHoursByDay,
        openDates: [...nextOpenMap.values()],
    });

    const rtPromise = notifyRealtimeListeners({
        type: 'schedule_config_updated',
        action: 'open',
        dates: effectiveOpenedDates,
        categories,
    });
    if (process.env.VERCEL) await rtPromise;

    res.json({
        ok: true,
        openedCount,
        openedDates: effectiveOpenedDates,
        skippedDates,
        unblockedCount,
        scheduleConfig: serializeScheduleConfig(saved, cachedLegacyPickupByDate),
    });
});

// Close / remove opened availability on 1 or more dates (for selected categories or by entry id)
app.post('/api/admin/schedule/close', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const currentCfg = await loadScheduleConfig({ force: true });

    const targetId = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : null;
    let dates = [];
    if (!targetId) {
        dates = extractTargetDatesFromBody(body);
    }
    const rawCategories = Array.isArray(body.categories) && body.categories.length
        ? body.categories
        : body.category
            ? [body.category]
            : SCHEDULE_CATEGORIES;
    const categorySet = new Set(rawCategories.filter((c) => SCHEDULE_CATEGORIES.includes(c)));
    const dateSet = new Set(dates);

    const pickupDatesToClear = new Set();
    if (targetId && targetId.startsWith('legacy-pickup-')) {
        const legacyDate = targetId.slice('legacy-pickup-'.length);
        if (parseDate(legacyDate)) pickupDatesToClear.add(legacyDate);
    }

    let closedCount = 0;
    const remaining = currentCfg.openDates.filter((entry) => {
        const matchById = Boolean(targetId && entry.id === targetId);
        const matchByDateCat = !targetId && dateSet.has(entry.date) && categorySet.has(entry.category);
        if (matchById || matchByDateCat) {
            closedCount += 1;
            if (entry.category === 'letter_pickup') pickupDatesToClear.add(entry.date);
            return false;
        }
        return true;
    });

    if (!targetId && categorySet.has('letter_pickup')) {
        for (const d of dates) {
            if (cachedLegacyPickupByDate.has(d)) {
                pickupDatesToClear.add(d);
                closedCount += 1;
            }
        }
    }

    if (pickupDatesToClear.size > 0) {
        try {
            await db().from(LETTER_PICKUP_TABLE).delete().in('available_date', [...pickupDatesToClear]);
            for (const d of pickupDatesToClear) cachedLegacyPickupByDate.delete(d);
        } catch {
            // Ignore legacy table cleanup errors
        }
    }

    const saved = await saveScheduleConfig({
        version: SCHEDULE_CONFIG_VERSION,
        consultationHoursByDay: currentCfg.consultationHoursByDay,
        defenseHoursByDay: currentCfg.defenseHoursByDay,
        openDates: remaining,
    });

    const rtPromise = notifyRealtimeListeners({
        type: 'schedule_config_updated',
        action: 'close',
        dates: dates.length ? dates : [...pickupDatesToClear],
    });
    if (process.env.VERCEL) await rtPromise;

    res.json({
        ok: true,
        closedCount,
        scheduleConfig: serializeScheduleConfig(saved, cachedLegacyPickupByDate),
    });
});

// Update default weekly Consultation Hours and/or Defense Hours (used when opening dates in 'regular' mode)
app.put('/api/admin/schedule/regular-hours', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const currentCfg = await loadScheduleConfig({ force: true });

    const resetPreset = typeof body.resetPreset === 'string' ? body.resetPreset.trim() : '';
    let nextConsultationHours;
    if (resetPreset === 'consultation' || resetPreset === 'all') {
        nextConsultationHours = cloneHoursTable(WINDOWS_BY_DAY);
    } else if (body.consultationHoursByDay && typeof body.consultationHoursByDay === 'object') {
        nextConsultationHours = normalizeHoursByDayMap(body.consultationHoursByDay, {}, 5);
    } else {
        nextConsultationHours = currentCfg.consultationHoursByDay;
    }

    let nextDefenseHours;
    if (resetPreset === 'defense' || resetPreset === 'all') {
        nextDefenseHours = cloneHoursTable(DEFENSE_WINDOWS_BY_DAY);
    } else if (body.defenseHoursByDay && typeof body.defenseHoursByDay === 'object') {
        nextDefenseHours = normalizeHoursByDayMap(body.defenseHoursByDay, {}, 30);
    } else {
        nextDefenseHours = currentCfg.defenseHoursByDay;
    }

    // Update stored snapshots on any existing 'regular' entries that now have updated hours
    const updatedOpenDates = currentCfg.openDates.map((entry) => {
        if (entry.mode !== 'regular') return entry;
        const dow = parseDate(entry.date)?.getUTCDay();
        const tbl = entry.category === 'defense' ? nextDefenseHours : nextConsultationHours;
        const nextWins = Array.isArray(tbl?.[dow]) && tbl[dow].length ? tbl[dow].map(([s, e]) => [s, e]) : entry.windows;
        return { ...entry, windows: nextWins };
    });

    const saved = await saveScheduleConfig({
        version: SCHEDULE_CONFIG_VERSION,
        consultationHoursByDay: nextConsultationHours,
        defenseHoursByDay: nextDefenseHours,
        openDates: updatedOpenDates,
    });

    const rtPromise = notifyRealtimeListeners({
        type: 'schedule_config_updated',
        action: 'regular_hours',
    });
    if (process.env.VERCEL) await rtPromise;

    res.json({
        ok: true,
        scheduleConfig: serializeScheduleConfig(saved, cachedLegacyPickupByDate),
    });
});

async function handleAdminBookingEndDateUpdate(req, res) {
    const rawDate = String(req.body?.bookingEndDate ?? req.body?.date ?? '').trim();
    if (!parseDate(rawDate)) {
        return res.status(400).json({
            field: 'bookingEndDateInput',
            error: 'Please select a valid cutoff date (YYYY-MM-DD).',
        });
    }
    const now = nowInTz();
    if (rawDate < now.date) {
        return res.status(400).json({
            field: 'bookingEndDateInput',
            error: 'The booking cutoff date must be today or a future date.',
        });
    }

    const bookingEndDate = await saveBookingEndDateSetting(rawDate);
    const rtPromise = notifyRealtimeListeners({
        type: 'settings_updated',
        bookingEndDate,
    });
    if (process.env.VERCEL) await rtPromise;

    res.json({
        ok: true,
        bookingEndDate,
    });
}

app.post('/api/admin/settings/booking-end-date', requireAdmin, handleAdminBookingEndDateUpdate);
app.put('/api/admin/settings/booking-end-date', requireAdmin, handleAdminBookingEndDateUpdate);

// List all blocked dates / time ranges
app.get('/api/admin/blocks', requireAdmin, async (req, res) => {
    const blockedRows = await fetchBlockedByDateRange('1970-01-01', '9999-12-31');
    const blockedSchedules = blockedRows.map(toBlockedSchedule).sort(
        (a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute
    );
    res.json({ blockedSchedules });
});

// Block one or more dates (supports body.dates array or body.date + body.endDate) or a specific time range
app.post('/api/admin/blocks', requireAdmin, async (req, res) => {
    const body = req.body || {};
    let targetDates;
    try {
        targetDates = extractTargetDatesFromBody(body);
    } catch (err) {
        return res.status(err.status || 400).json({ field: 'blockDate', error: err.message });
    }
    const isFullDay = body.isFullDay !== false;
    const startMinute = isFullDay ? null : Number(body.startMinute);
    const endMinute = isFullDay ? null : Number(body.endMinute);
    const rawReason = String(body.reason ?? '').trim();
    const reason = rawReason ? rawReason.slice(0, 500) : null;
    const cancelExisting = Boolean(body.cancelExisting);

    if (!isFullDay) {
        if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute)
            || startMinute < 0 || endMinute > 1440 || startMinute >= endMinute) {
            return res.status(400).json({
                field: 'blockTime',
                error: 'Please enter a valid start and end time (end time must be after start time).',
            });
        }
    }

    const rowsToInsert = targetDates.map((d) => ({
        blocked_date: d,
        is_full_day: isFullDay,
        start_minute: isFullDay ? null : startMinute,
        end_minute: isFullDay ? null : endMinute,
        reason,
    }));
    const firstDate = targetDates[0];
    const lastDate = targetDates[targetDates.length - 1];

    const { data: inserted, error: insertErr } = await db()
        .from(BLOCKED_TABLE)
        .insert(rowsToInsert)
        .select('*');

    if (insertErr) {
        if (['42P01', 'PGRST205', '23514', '42703', 'PGRST204'].includes(insertErr.code)) {
            return res.status(500).json({
                error: 'Database schema needs updating: please run supabase/schema.sql in your Supabase SQL Editor.',
            });
        }
        return res.status(500).json({ error: insertErr.message });
    }

    const now = nowInTz();
    let cancelledBookings = [];
    if (cancelExisting) {
        const [{ data: activeRows, error: activeErr }, allBlocksInRange] = await Promise.all([
            db()
                .from(TABLE)
                .select('*')
                .in('appointment_date', targetDates)
                .neq('status', 'cancelled'),
            isFullDay ? Promise.resolve([]) : fetchBlockedByDateRange(firstDate, lastDate),
        ]);
        if (!activeErr && Array.isArray(activeRows) && activeRows.length) {
            const bStart = isFullDay ? 0 : startMinute;
            const bEnd = isFullDay ? 1440 : endMinute;
            const blocksByDate = new Map();
            for (const blk of allBlocksInRange) {
                const d = blk.blocked_date;
                if (!blocksByDate.has(d)) blocksByDate.set(d, []);
                blocksByDate.get(d).push(blockInterval(blk));
            }
            const toCancelIds = activeRows
                .filter((r) => {
                    if (!isActiveRow(r)) return false;
                    if (isFullDay) return true;
                    const [rs, re] = rowInterval(r);
                    if (!(rs < bEnd && re > bStart)) return false;
                    if (isTimedRow(r)) return true;
                    const intervalsForDay = blocksByDate.get(r.appointment_date) || [[bStart, bEnd]];
                    return isWindowFullyBlocked(rs, re, intervalsForDay);
                })
                .map((r) => r.id);

            if (toCancelIds.length) {
                const cancelReasonText = reason
                    ? `Instructor unavailable: ${reason}`
                    : 'Cancelled because the instructor is unavailable on this date/time.';
                const { data: updatedRows } = await db()
                    .from(TABLE)
                    .update({
                        status: 'cancelled',
                        cancellation_reason: cancelReasonText.slice(0, 500),
                        cancelled_at: new Date().toISOString(),
                    })
                    .in('id', toCancelIds)
                    .select('*');
                if (Array.isArray(updatedRows) && updatedRows.length) {
                    const cancelLookup = await buildStudentLookupForRows(updatedRows);
                    cancelledBookings = updatedRows.map((r) => toBooking(r, now, cancelLookup));
                    const siteOrigin = resolveSiteOrigin(req);
                    const cancelEmailsPromise = Promise.allSettled(
                        cancelledBookings.map((b) =>
                            sendStudentCancellationEmail(b, siteOrigin, { cancelledBy: 'instructor' }).catch((err) => {
                                console.error(`Failed to send block cancellation email for ${b.id}:`, err.message || err);
                            })
                        )
                    );
                    if (process.env.VERCEL) await cancelEmailsPromise;
                }
            }
        }
    }

    const rtPromise = notifyRealtimeListeners({
        type: 'schedule_blocked',
        date: firstDate,
        dates: targetDates,
        cancelledCount: cancelledBookings.length,
    });
    if (process.env.VERCEL) await rtPromise;

    res.status(201).json({
        ok: true,
        blocks: (inserted || []).map(toBlockedSchedule),
        cancelledBookings,
    });
});

// Remove all blocks on 1 or more selected dates
app.post('/api/admin/blocks/unblock-dates', requireAdmin, async (req, res) => {
    const dates = extractTargetDatesFromBody(req.body || {});
    const { data, error } = await db()
        .from(BLOCKED_TABLE)
        .delete()
        .in('blocked_date', dates)
        .not('reason', 'like', `${BLOCKED_SETTING_PREFIX}%`)
        .select('id');
    // Note: rows with null reason are ignored by `not like` in SQL, so also delete null-reason rows on those dates
    const { data: nullReasonData, error: err2 } = await db()
        .from(BLOCKED_TABLE)
        .delete()
        .in('blocked_date', dates)
        .is('reason', null)
        .select('id');
    const anyErr = error || err2;
    if (anyErr) {
        if (['42P01', 'PGRST205'].includes(anyErr.code)) {
            return res.status(500).json({
                error: 'Database schema needs updating: please run supabase/schema.sql in your Supabase SQL Editor.',
            });
        }
        return res.status(500).json({ error: anyErr.message });
    }
    const removedIds = [
        ...(Array.isArray(data) ? data.map((r) => r.id) : []),
        ...(Array.isArray(nullReasonData) ? nullReasonData.map((r) => r.id) : []),
    ];
    const rtPromise = notifyRealtimeListeners({ type: 'schedule_unblocked', dates });
    if (process.env.VERCEL) await rtPromise;
    res.json({ ok: true, removedIds });
});

// Remove a blocked date or time range
app.delete('/api/admin/blocks/:id', requireAdmin, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });
    const { error } = await db().from(BLOCKED_TABLE).delete().eq('id', req.params.id);
    if (error) {
        if (['42P01', 'PGRST205'].includes(error.code)) {
            return res.status(500).json({
                error: 'Database schema needs updating: please run supabase/schema.sql in your Supabase SQL Editor.',
            });
        }
        return res.status(500).json({ error: error.message });
    }
    const rtPromise = notifyRealtimeListeners({ type: 'schedule_unblocked', blockId: req.params.id });
    if (process.env.VERCEL) await rtPromise;
    res.json({ ok: true });
});

// List all custom available dates / time ranges for Communication Letter Pickup
app.get('/api/admin/letter-pickup-schedules', requireAdmin, async (req, res) => {
    const rows = await fetchLetterPickupByDateRange('1970-01-01', '9999-12-31');
    const letterPickupSchedules = rows.map(toLetterPickupSchedule).sort(
        (a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute
    );
    res.json({ letterPickupSchedules });
});

// Add an available date & time window for Communication Letter Pickup (5-minute slots)
app.post('/api/admin/letter-pickup-schedules', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const date = String(body.date || '').trim();
    const startMinute = Number(body.startMinute);
    const endMinute = Number(body.endMinute);
    const rawNote = String(body.note ?? '').trim();
    const note = rawNote ? rawNote.slice(0, 500) : null;

    if (!parseDate(date)) {
        return res.status(400).json({ field: 'letterPickupDate', error: 'Please select a valid date.' });
    }
    const now = nowInTz();
    if (date <= now.date) {
        return res.status(400).json({
            field: 'letterPickupDate',
            error: 'Please select a future date (students must schedule at least 1 day in advance).',
        });
    }
    if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute)
        || startMinute < 0 || endMinute > 1440 || startMinute >= endMinute) {
        return res.status(400).json({
            field: 'letterPickupTime',
            error: 'Please enter a valid start and end time (end time must be after start time).',
        });
    }
    if (endMinute - startMinute < LETTER_PICKUP_DURATION) {
        return res.status(400).json({
            field: 'letterPickupTime',
            error: `Time range must be at least ${LETTER_PICKUP_DURATION} minutes long.`,
        });
    }

    const { data: inserted, error: insertErr } = await db()
        .from(LETTER_PICKUP_TABLE)
        .insert([{
            available_date: date,
            start_minute: startMinute,
            end_minute: endMinute,
            note,
        }])
        .select('*')
        .single();

    if (insertErr) {
        if (['42P01', 'PGRST205', '23514', '42703', 'PGRST204'].includes(insertErr.code)) {
            return res.status(500).json({
                error: 'Database schema needs updating: please run supabase/schema.sql in your Supabase SQL Editor.',
            });
        }
        return res.status(500).json({ error: insertErr.message });
    }

    const schedule = toLetterPickupSchedule(inserted);
    const rtPromise = notifyRealtimeListeners({
        type: 'letter_pickup_schedule_created',
        date,
        scheduleId: schedule.id,
    });
    if (process.env.VERCEL) await rtPromise;

    res.status(201).json({ ok: true, schedule });
});

// Remove an available date & time window for Communication Letter Pickup
app.delete('/api/admin/letter-pickup-schedules/:id', requireAdmin, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });
    const { error } = await db().from(LETTER_PICKUP_TABLE).delete().eq('id', req.params.id);
    if (error) {
        if (['42P01', 'PGRST205'].includes(error.code)) {
            return res.status(500).json({
                error: 'Database schema needs updating: please run supabase/schema.sql in your Supabase SQL Editor.',
            });
        }
        return res.status(500).json({ error: error.message });
    }
    const rtPromise = notifyRealtimeListeners({ type: 'letter_pickup_schedule_deleted', scheduleId: req.params.id });
    if (process.env.VERCEL) await rtPromise;
    res.json({ ok: true });
});

function buildManuscriptReadyEmail({ studentName, title, siteOrigin, note = '' }) {
    const cleanTitle = title || 'your Capstone / Thesis manuscript';
    const greeting = `Dear ${studentName || 'Student'},`;
    const cleanNote = String(note || '').trim();
    const subject = 'Manuscript Ready for Pickup — Please Schedule Your Retrieval';

    const bodyText = [
        greeting,
        '',
        `Good day. This is to inform you that your manuscript (${cleanTitle}) has been reviewed and is now ready for pickup.`,
        ...(cleanNote ? ['', `Instructor Note:\n${cleanNote}`] : []),
        '',
        'Kindly visit the consultation scheduling portal to book a "Retrieval of Manuscript" (5-minute) appointment so the necessary revisions and feedback can be discussed with your group:',
        siteOrigin,
        '',
        'Important Reminders:',
        '• Appointments must be scheduled at least one (1) day prior to your preferred consultation date.',
        '• At least two (2) or all group members are required to be present during the manuscript retrieval; otherwise, your group will not be accommodated.',
        '',
        'Thank you.',
    ].join('\n');

    const noteHtml = cleanNote
        ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;padding:10px 14px;border-radius:8px;font-size:14px;color:#334155;margin:12px 0"><strong>Instructor Note:</strong><br/>${escapeHtml(cleanNote).replace(/\r\n|\r|\n/g, '<br/>')}</div>`
        : '';

    const bodyHtml = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:auto;color:#0f172a;line-height:1.6">
            <p>${escapeHtml(greeting)}</p>
            <p>Good day. This is to inform you that your manuscript (<strong>${escapeHtml(cleanTitle)}</strong>) has been reviewed and is now <strong>ready for pickup</strong>.</p>
            ${noteHtml}
            <p>Kindly visit the consultation scheduling portal to book a <strong>Retrieval of Manuscript (5-minute)</strong> appointment so the necessary revisions and feedback can be discussed with your group:</p>
            ${siteOrigin ? `<p style="margin:22px 0">
                <a href="${escapeHtml(siteOrigin)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px">
                    Schedule Manuscript Retrieval
                </a>
            </p>` : ''}
            <div style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;padding:12px 14px;border-radius:8px;font-size:13px">
                <strong>Important Reminders:</strong>
                <ul style="margin:6px 0 0;padding-left:18px">
                    <li>Appointments must be scheduled at least <strong>one (1) day prior</strong> to your preferred consultation date.</li>
                    <li><strong>At least two (2) or all group members are required to be present</strong> during the manuscript retrieval; otherwise, your group will not be accommodated.</li>
                </ul>
            </div>
            <p style="margin-top:18px;color:#475569;font-size:14px">Thank you.</p>
        </div>`;

    return { subject, text: bodyText, html: bodyHtml };
}

function buildLetterReadyEmail({ studentName, title, siteOrigin, reason = '', note = '' }) {
    const cleanTitle = title || 'your Capstone / Thesis group';
    const greeting = `Dear ${studentName || 'Student'},`;
    const letterReason = typeof reason === 'string' && reason.trim() ? reason.trim() : '';
    const cleanNote = String(note || '').trim();
    const subject = 'Communication Letter Ready for Pickup';

    const bodyText = [
        greeting,
        '',
        `Good day. This is to inform you that the communication letter for ${cleanTitle} has been signed by ${TEACHER_NAME} and is now ready for pickup at ${CONFIG.location}.`,
        ...(letterReason ? ['', `Letter Details: ${letterReason}`] : []),
        ...(cleanNote ? ['', `Instructor Note:\n${cleanNote}`] : []),
        '',
        'Kindly visit the consultation scheduling portal to schedule a "Pickup of Communication Letter" (5-minute) appointment:',
        ...(siteOrigin ? [siteOrigin] : []),
        '',
        'Reminder: Appointments must be scheduled at least one (1) day prior to your preferred pickup date.',
        '',
        'Thank you.',
    ].join('\n');

    const letterReasonHtml = letterReason
        ? `<p style="background:#f8fafc;border:1px solid #e2e8f0;padding:10px 14px;border-radius:8px;font-size:14px;color:#334155"><strong>Letter Details:</strong> ${escapeHtml(letterReason)}</p>`
        : '';
    const noteHtml = cleanNote
        ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;padding:10px 14px;border-radius:8px;font-size:14px;color:#334155;margin:12px 0"><strong>Instructor Note:</strong><br/>${escapeHtml(cleanNote).replace(/\r\n|\r|\n/g, '<br/>')}</div>`
        : '';
    const portalBtnHtml = siteOrigin
        ? `<p style="margin:22px 0"><a href="${escapeHtml(siteOrigin)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px">Schedule Letter Pickup</a></p>`
        : '';

    const bodyHtml = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:auto;color:#0f172a;line-height:1.6">
            <p>${escapeHtml(greeting)}</p>
            <p>Good day. This is to inform you that the communication letter for <strong>${escapeHtml(cleanTitle)}</strong> has been signed by <strong>${escapeHtml(TEACHER_NAME)}</strong> and is now <strong>ready for pickup</strong> at <strong>${escapeHtml(CONFIG.location)}</strong>.</p>
            ${letterReasonHtml}
            ${noteHtml}
            <p>Kindly visit the consultation scheduling portal to book a <strong>Pickup of Communication Letter (5-minute)</strong> appointment:</p>
            ${portalBtnHtml}
            <div style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;padding:10px 14px;border-radius:8px;font-size:13px">
                <strong>Reminder:</strong> Appointments must be scheduled at least <strong>one (1) day prior</strong> to your preferred pickup date.
            </div>
            <p style="margin-top:18px;color:#475569;font-size:14px">Thank you.</p>
        </div>`;

    return { subject, text: bodyText, html: bodyHtml };
}

function buildManualStudentEmail({ template, studentName, capstoneTitle, subject, message, siteOrigin }) {
    const cleanSubject = cleanName(subject || '').slice(0, 200);
    const cleanNote = String(message || '').trim();
    const greeting = `Dear ${studentName || 'Student'},`;

    if (template === 'manuscript_ready') {
        const built = buildManuscriptReadyEmail({
            studentName,
            title: capstoneTitle || 'your Capstone / Thesis manuscript',
            siteOrigin,
            note: cleanNote,
        });
        return { ...built, subject: cleanSubject || built.subject };
    }

    if (template === 'letter_ready') {
        const built = buildLetterReadyEmail({
            studentName,
            title: capstoneTitle || 'your Capstone / Thesis group',
            siteOrigin,
            note: cleanNote,
        });
        return { ...built, subject: cleanSubject || built.subject };
    }

    if (template === 'schedule_reminder') {
        const defaultSubject = 'Reminder: Please Schedule Your Consultation / Drop-off Appointment Online';
        const titleClause = capstoneTitle ? ` for ${capstoneTitle}` : '';
        const titleClauseHtml = capstoneTitle ? ` for <strong>${escapeHtml(capstoneTitle)}</strong>` : '';
        const bodyText = [
            greeting,
            '',
            `Good day. This is a friendly reminder to schedule your appointment${titleClause} with ${TEACHER_NAME} through the consultation scheduling portal (e.g. Drop-off Manuscript, Communication Letter Signature, System Consultation, or Defense).`,
            ...(cleanNote ? ['', `Instructor Note:\n${cleanNote}`] : []),
            ...(siteOrigin ? ['', `Schedule your appointment here: ${siteOrigin}`] : []),
            '',
            'Reminder: Appointments must be scheduled at least one (1) day prior to your preferred consultation date.',
            '',
            'Thank you.',
        ].join('\n');

        const noteHtml = cleanNote
            ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;padding:10px 14px;border-radius:8px;font-size:14px;color:#334155;margin:12px 0"><strong>Instructor Note:</strong><br/>${escapeHtml(cleanNote).replace(/\r\n|\r|\n/g, '<br/>')}</div>`
            : '';
        const portalBtnHtml = siteOrigin
            ? `<p style="margin:22px 0"><a href="${escapeHtml(siteOrigin)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px">Open Scheduling Portal</a></p>`
            : '';

        const bodyHtml = `
            <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:auto;color:#0f172a;line-height:1.6">
                <p>${escapeHtml(greeting)}</p>
                <p>Good day. This is a friendly reminder to schedule your appointment${titleClauseHtml} with <strong>${escapeHtml(TEACHER_NAME)}</strong> through the consultation scheduling portal (e.g. Drop-off Manuscript, Communication Letter Signature, System Consultation, or Defense).</p>
                ${noteHtml}
                ${portalBtnHtml}
                <div style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;padding:10px 14px;border-radius:8px;font-size:13px">
                    <strong>Reminder:</strong> Appointments must be scheduled at least <strong>one (1) day prior</strong> to your preferred consultation date.
                </div>
                <p style="margin-top:18px;color:#475569;font-size:14px">Thank you.</p>
            </div>`;

        return { subject: cleanSubject || defaultSubject, text: bodyText, html: bodyHtml };
    }

    // Custom message
    const titleHeaderText = capstoneTitle ? `Capstone / Thesis: ${capstoneTitle}\n\n` : '';
    const titleHeaderHtml = capstoneTitle
        ? `<p style="margin:0 0 12px;font-size:13px;color:#64748b"><strong>Capstone / Thesis:</strong> ${escapeHtml(capstoneTitle)}</p>`
        : '';
    const bodyText = [
        greeting,
        '',
        `${titleHeaderText}${cleanNote}`,
        ...(siteOrigin ? ['', `Consultation Scheduling Portal: ${siteOrigin}`] : []),
        '',
        `— ${TEACHER_NAME}`,
    ].join('\n');

    const bodyHtml = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:auto;color:#0f172a;line-height:1.6">
            <p>${escapeHtml(greeting)}</p>
            ${titleHeaderHtml}
            <div style="white-space:normal;color:#0f172a">${escapeHtml(cleanNote).replace(/\r\n|\r|\n/g, '<br/>')}</div>
            ${siteOrigin ? `<p style="margin:22px 0 8px"><a href="${escapeHtml(siteOrigin)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:8px">Open Scheduling Portal</a></p>` : ''}
            <p style="margin-top:18px;color:#475569;font-size:14px">— ${escapeHtml(TEACHER_NAME)}</p>
        </div>`;

    return { subject: cleanSubject, text: bodyText, html: bodyHtml };
}

// Send email notification to student (and groupmates) that their dropped-off manuscript has been checked
app.post('/api/admin/bookings/:id/notify-checked', requireAdmin, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });

    const { data: row, error: fetchErr } = await db()
        .from(TABLE)
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!row) return res.status(404).json({ error: 'Booking not found.' });
    if (!row.student_email) {
        return res.status(400).json({ error: 'This booking does not have a student email on file.' });
    }

    const studentRow = await fetchStudentForBooking(row);
    const recipients = getGroupRecipientEmails({ primaryEmail: row.student_email, studentRow });
    const membersGreeting = Array.isArray(row.members) && row.members.length > 1 && recipients.length > 1
        ? row.members.join(', ')
        : row.student_name;

    const title = row.capstone_title || row.team_name || 'your Capstone / Thesis manuscript';
    const siteOrigin = resolveSiteOrigin(req) || `${req.protocol}://${req.get('host')}`;
    const emailContent = buildManuscriptReadyEmail({
        studentName: membersGreeting,
        title,
        siteOrigin,
    });

    try {
        await mailer().sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: recipients,
            subject: emailContent.subject,
            text: emailContent.text,
            html: emailContent.html,
        });
        await recordEmailLog({
            sentBy: 'instructor',
            category: 'pickup_notice',
            emailType: 'manuscript_ready',
            status: 'sent',
            subject: emailContent.subject,
            recipients,
            recipientName: membersGreeting || row.student_name || null,
            capstoneTitle: row.capstone_title || row.team_name || null,
            studentId: row.student_id || studentRow?.id || null,
            bookingId: row.id,
            bodyPreview: emailContent.text,
        }, { emitRealtime: false });
    } catch (err) {
        console.error('Failed to send manuscript checked notification email:', err);
        await recordEmailLog({
            sentBy: 'instructor',
            category: 'pickup_notice',
            emailType: 'manuscript_ready',
            status: 'failed',
            subject: emailContent.subject,
            recipients,
            recipientName: membersGreeting || row.student_name || null,
            capstoneTitle: row.capstone_title || row.team_name || null,
            studentId: row.student_id || studentRow?.id || null,
            bookingId: row.id,
            bodyPreview: emailContent.text,
            errorMessage: err.message || String(err),
        });
        if (err.status) throw err;
        throw httpError(502, 'Could not send notification email right now. Please check your SMTP configuration and try again.');
    }

    const notifiedAt = new Date().toISOString();
    const { error: updateErr } = await db().from(TABLE).update({ notified_at: notifiedAt }).eq('id', row.id);
    if (updateErr) throw updateErr;
    await recordStudentPickupNotification({
        studentId: row.student_id,
        email: row.student_email,
        kind: 'manuscript_ready',
        notifiedAt,
    });
    const rtPromise = notifyRealtimeListeners({ type: 'dropoff_notified', bookingId: row.id, date: row.appointment_date });
    if (process.env.VERCEL) await rtPromise;
    res.json({ ok: true, notifiedAt, recipients });
});

// Send email notification to student (and groupmates) that their communication letter has been signed and is ready for pickup
app.post('/api/admin/bookings/:id/notify-letter-ready', requireAdmin, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });

    const { data: row, error: fetchErr } = await db()
        .from(TABLE)
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!row) return res.status(404).json({ error: 'Booking not found.' });
    if (!row.student_email) {
        return res.status(400).json({ error: 'This booking does not have a student email on file.' });
    }

    const studentRow = await fetchStudentForBooking(row);
    const recipients = getGroupRecipientEmails({ primaryEmail: row.student_email, studentRow });
    const membersGreeting = Array.isArray(row.members) && row.members.length > 1 && recipients.length > 1
        ? row.members.join(', ')
        : row.student_name;

    const title = row.capstone_title || row.team_name || 'your Capstone / Thesis group';
    const siteOrigin = resolveSiteOrigin(req) || `${req.protocol}://${req.get('host')}`;
    const emailContent = buildLetterReadyEmail({
        studentName: membersGreeting,
        title,
        siteOrigin,
        reason: row.reason,
    });

    try {
        await mailer().sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: recipients,
            subject: emailContent.subject,
            text: emailContent.text,
            html: emailContent.html,
        });
        await recordEmailLog({
            sentBy: 'instructor',
            category: 'pickup_notice',
            emailType: 'letter_ready',
            status: 'sent',
            subject: emailContent.subject,
            recipients,
            recipientName: membersGreeting || row.student_name || null,
            capstoneTitle: row.capstone_title || row.team_name || null,
            studentId: row.student_id || studentRow?.id || null,
            bookingId: row.id,
            bodyPreview: emailContent.text,
        }, { emitRealtime: false });
    } catch (err) {
        console.error('Failed to send communication letter ready notification email:', err);
        await recordEmailLog({
            sentBy: 'instructor',
            category: 'pickup_notice',
            emailType: 'letter_ready',
            status: 'failed',
            subject: emailContent.subject,
            recipients,
            recipientName: membersGreeting || row.student_name || null,
            capstoneTitle: row.capstone_title || row.team_name || null,
            studentId: row.student_id || studentRow?.id || null,
            bookingId: row.id,
            bodyPreview: emailContent.text,
            errorMessage: err.message || String(err),
        });
        if (err.status) throw err;
        throw httpError(502, 'Could not send notification email right now. Please check your SMTP configuration and try again.');
    }

    const notifiedAt = new Date().toISOString();
    const { error: updateErr } = await db().from(TABLE).update({ notified_at: notifiedAt }).eq('id', row.id);
    if (updateErr) throw updateErr;
    await recordStudentPickupNotification({
        studentId: row.student_id,
        email: row.student_email,
        kind: 'letter_ready',
        notifiedAt,
    });
    const rtPromise = notifyRealtimeListeners({ type: 'letter_notified', bookingId: row.id, date: row.appointment_date });
    if (process.env.VERCEL) await rtPromise;
    res.json({ ok: true, notifiedAt, recipients });
});

// Manually send an email to a student group (including groupmate emails when enabled)
app.post('/api/admin/send-email', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const rawStudentId = String(body.studentId || '').trim();
    let studentRow = null;
    if (rawStudentId) {
        if (!/^[0-9a-f-]{36}$/i.test(rawStudentId)) {
            return res.status(400).json({ error: 'Invalid student group ID.' });
        }
        const { data, error: studentErr } = await db()
            .from(STUDENTS_TABLE)
            .select('*')
            .eq('id', rawStudentId)
            .maybeSingle();
        if (studentErr) return res.status(500).json({ error: studentErr.message });
        if (!data) return res.status(404).json({ error: 'Student group not found.' });
        studentRow = data;
    }

    const recipientEmail = normalizeEmail(body.email || studentRow?.email);
    if (!recipientEmail || recipientEmail.length > 254 || !EMAIL_RE.test(recipientEmail)) {
        return res.status(400).json({ field: 'emailRecipientInput', error: 'Please enter a valid recipient email address.' });
    }

    const includeGroupmates = body.includeGroupmates !== false
        && Boolean(studentRow && recipientEmail === normalizeEmail(studentRow.email));
    const recipients = includeGroupmates
        ? getGroupRecipientEmails({ primaryEmail: recipientEmail, studentRow })
        : [recipientEmail];

    const baseName = cleanName(body.studentName || studentRow?.full_name || '').slice(0, 100);
    const groupNames = includeGroupmates && recipients.length > 1 && Array.isArray(studentRow?.members) && studentRow.members.length > 1
        ? studentRow.members.join(', ')
        : baseName;
    const capstoneTitle = cleanName(body.capstoneTitle || studentRow?.capstone_title || '').slice(0, 200);
    const template = ['manuscript_ready', 'letter_ready', 'schedule_reminder', 'custom'].includes(body.template)
        ? body.template
        : 'custom';
    const rawSubject = cleanName(body.subject || '');
    const rawMessage = String(body.message ?? '').trim();

    if (rawSubject.length > 200) {
        return res.status(400).json({ field: 'emailSubjectInput', error: 'Email subject must be 200 characters or fewer.' });
    }
    if (rawMessage.length > 3000) {
        return res.status(400).json({ field: 'emailMessageInput', error: 'Message must be 3000 characters or fewer.' });
    }
    if (template === 'custom') {
        if (!rawSubject) {
            return res.status(400).json({ field: 'emailSubjectInput', error: 'Please enter an email subject.' });
        }
        if (!rawMessage) {
            return res.status(400).json({ field: 'emailMessageInput', error: 'Please enter a message to send.' });
        }
    }

    const siteOrigin = resolveSiteOrigin(req) || `${req.protocol}://${req.get('host')}`;
    const emailContent = buildManualStudentEmail({
        template,
        studentName: groupNames,
        capstoneTitle,
        subject: rawSubject,
        message: rawMessage,
        siteOrigin,
    });

    const manualLogCategory = template === 'schedule_reminder'
        ? 'reminder'
        : (template === 'manuscript_ready' || template === 'letter_ready')
            ? 'pickup_notice'
            : 'custom';
    const sentAt = new Date().toISOString();
    let emailLog = null;

    try {
        await mailer().sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: recipients,
            subject: emailContent.subject,
            text: emailContent.text,
            html: emailContent.html,
        });
        emailLog = await recordEmailLog({
            sentBy: 'instructor',
            category: manualLogCategory,
            emailType: template,
            status: 'sent',
            subject: emailContent.subject,
            recipients,
            recipientName: groupNames || baseName || null,
            capstoneTitle: capstoneTitle || null,
            studentId: studentRow?.id || null,
            bookingId: null,
            bodyPreview: emailContent.text,
            createdAt: sentAt,
        }, { emitRealtime: !(template === 'manuscript_ready' || template === 'letter_ready') });
    } catch (err) {
        console.error('Failed to send manual student notification email:', err);
        await recordEmailLog({
            sentBy: 'instructor',
            category: manualLogCategory,
            emailType: template,
            status: 'failed',
            subject: emailContent.subject,
            recipients,
            recipientName: groupNames || baseName || null,
            capstoneTitle: capstoneTitle || null,
            studentId: studentRow?.id || null,
            bookingId: null,
            bodyPreview: emailContent.text,
            errorMessage: err.message || String(err),
            createdAt: sentAt,
        });
        if (err.status) throw err;
        throw httpError(502, 'Could not send notification email right now. Please check your SMTP configuration and try again.');
    }

    if (template === 'manuscript_ready' || template === 'letter_ready') {
        const updatedStudent = await recordStudentPickupNotification({
            studentId: studentRow?.id || null,
            email: recipientEmail,
            kind: template,
            notifiedAt: sentAt,
        });
        const rtPromise = notifyRealtimeListeners({
            type: 'student_pickup_notified',
            studentId: updatedStudent?.id || studentRow?.id || null,
            template,
        });
        if (process.env.VERCEL) await rtPromise;
    }

    res.json({
        ok: true,
        to: recipients.join(', '),
        recipients,
        sentAt,
        emailLog,
    });
});

// Schedule (or reschedule) a Capstone / Thesis defense directly as Admin / Panel
app.post('/api/admin/defenses', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const rawStudentId = String(body.studentId || '').trim();
    const rawReplaceId = String(body.replaceBookingId || '').trim();
    const replaceBookingId = rawReplaceId ? rawReplaceId : null;

    if (replaceBookingId && !/^[0-9a-f-]{36}$/i.test(replaceBookingId)) {
        return res.status(400).json({ error: 'Invalid existing appointment ID.' });
    }

    let studentRow = null;
    if (rawStudentId) {
        if (!/^[0-9a-f-]{36}$/i.test(rawStudentId)) {
            return res.status(400).json({ error: 'Invalid student group ID.' });
        }
        const { data, error: stuErr } = await db()
            .from(STUDENTS_TABLE)
            .select('*')
            .eq('id', rawStudentId)
            .maybeSingle();
        if (stuErr) return res.status(500).json({ error: stuErr.message });
        if (!data) return res.status(404).json({ error: 'Selected student group not found.' });
        studentRow = data;
    }

    let existingBookingRow = null;
    if (replaceBookingId) {
        const { data: repData, error: repErr } = await db()
            .from(TABLE)
            .select('*')
            .eq('id', replaceBookingId)
            .maybeSingle();
        if (repErr) return res.status(500).json({ error: repErr.message });
        if (!repData) return res.status(404).json({ error: 'Existing defense appointment not found.' });
        if (repData.status === 'cancelled') {
            return res.status(400).json({ error: 'Cancelled appointments cannot be rescheduled — please schedule a new defense instead.' });
        }
        if (repData.status === 'completed' || repData.status === 'no_show') {
            return res.status(400).json({ error: 'Completed or recorded appointments cannot be moved — please schedule a new defense instead.' });
        }
        existingBookingRow = repData;
        if (!studentRow && existingBookingRow.student_id) {
            const { data: linkedStu } = await db()
                .from(STUDENTS_TABLE)
                .select('*')
                .eq('id', existingBookingRow.student_id)
                .maybeSingle();
            if (linkedStu) studentRow = linkedStu;
        }
    }

    const rawPrimaryEmail = normalizeEmail(body.studentEmail || studentRow?.email || existingBookingRow?.student_email || '');
    if (rawPrimaryEmail && (rawPrimaryEmail.length > 254 || !EMAIL_RE.test(rawPrimaryEmail))) {
        return res.status(400).json({
            field: 'defGroupEmailInput',
            error: 'Please enter a valid email address or leave it blank.',
        });
    }

    if (!studentRow && rawPrimaryEmail) {
        studentRow = await findStudentByEmail(rawPrimaryEmail).catch(() => null);
    }

    const defenseLevel = normalizeDefenseLevel(body.defenseLevel)
        || normalizeDefenseLevel(studentRow?.project_level)
        || normalizeDefenseLevel(existingBookingRow?.defense_level);
    if (!defenseLevel) {
        return res.status(400).json({
            field: 'defLevelField',
            error: 'Please select the defense course level (Capstone 1, Capstone 2, Thesis 1, or Thesis 2).',
        });
    }

    const durationMinutes = DEFENSE_LEVELS[defenseLevel].durationMinutes;
    const capstoneTitle = cleanName(
        body.capstoneTitle
        || studentRow?.capstone_title
        || existingBookingRow?.capstone_title
        || existingBookingRow?.team_name
        || ''
    );
    if (capstoneTitle.length < 2 || capstoneTitle.length > 200) {
        return res.status(400).json({
            field: 'defCapstoneInput',
            error: 'Please enter the Capstone / Thesis title (2–200 characters).',
        });
    }

    let members = [];
    if (Array.isArray(body.members) && body.members.some((m) => cleanName(m))) {
        members = body.members.map(cleanName).filter(Boolean).slice(0, MAX_MEMBERS);
    } else if (studentRow) {
        members = (Array.isArray(studentRow.members) && studentRow.members.length
            ? studentRow.members
            : [studentRow.full_name])
            .map(cleanName)
            .filter(Boolean)
            .slice(0, MAX_MEMBERS);
    } else if (existingBookingRow && Array.isArray(existingBookingRow.members) && existingBookingRow.members.length) {
        members = existingBookingRow.members.map(cleanName).filter(Boolean).slice(0, MAX_MEMBERS);
    }

    if (studentRow && members.length) {
        // If registered group is selected and members weren't explicitly overridden, ensure rep is first
        if (!Array.isArray(body.members) || !body.members.length) {
            members[0] = studentRow.full_name;
        }
    }

    if (members.length < MIN_MEMBERS) {
        return res.status(400).json({
            field: 'defMembersWrap',
            error: 'Please enter at least 1 group member name.',
        });
    }
    if (members.length > MAX_MEMBERS) {
        return res.status(400).json({
            field: 'defMembersWrap',
            error: `Only up to ${MAX_MEMBERS} members are allowed in a Capstone / Thesis group.`,
        });
    }
    if (members.some((m) => m.length < 2 || m.length > 100)) {
        return res.status(400).json({
            field: 'defMembersWrap',
            error: 'Each member name must be 2–100 characters long.',
        });
    }

    const instructorRole = body.instructorRole === 'adviser'
        ? 'adviser'
        : body.instructorRole === 'panel'
            ? 'panel'
            : (studentRow?.instructor_role || existingBookingRow?.instructor_role || 'panel');

    const date = String(body.date ?? '').trim();
    if (!parseDate(date)) {
        return res.status(400).json({ field: 'defDateInput', error: 'Please select a valid defense date.' });
    }

    const now = nowInTz();
    if (date < now.date) {
        return res.status(400).json({
            field: 'defDateInput',
            error: 'Please select today or a future date for the defense.',
        });
    }

    const startMinute = Number(body.startMinute);
    if (!Number.isInteger(startMinute) || startMinute < 0 || startMinute >= 1440) {
        return res.status(400).json({ field: 'defStartTimeInput', error: 'Please enter a valid start time.' });
    }
    const slotStart = startMinute;
    const slotEnd = slotStart + durationMinutes;
    if (slotEnd > 1440) {
        return res.status(400).json({
            field: 'defStartTimeInput',
            error: `A ${DEFENSE_LEVELS[defenseLevel].durationLabel} defense starting at ${formatMinute(slotStart)} would extend past midnight. Please choose an earlier start time.`,
        });
    }

    let rawReason = String(body.reason ?? '').trim();
    if (!rawReason) {
        rawReason = existingBookingRow?.reason
            || `${DEFENSE_LEVELS[defenseLevel].label} defense (scheduled by panel).`;
    }
    if (rawReason.length < 5) {
        rawReason = `${DEFENSE_LEVELS[defenseLevel].label} defense — ${rawReason}`;
    }
    if (rawReason.length > 1000) {
        return res.status(400).json({
            field: 'defReasonInput',
            error: 'Notes / details must be 1000 characters or fewer.',
        });
    }

    if (existingBookingRow
        && existingBookingRow.appointment_date === date
        && Number(existingBookingRow.start_minute) === slotStart
        && Number(existingBookingRow.duration_minutes) === durationMinutes
        && existingBookingRow.defense_level === defenseLevel
        && existingBookingRow.reason === rawReason) {
        return res.status(400).json({
            error: 'This defense is already scheduled for that exact date, time, and course level.',
        });
    }

    // Check against active timed appointments on the target date so no double-booking occurs
    const { data: dayRows, error: dayErr } = await db()
        .from(TABLE)
        .select('*')
        .eq('appointment_date', date);
    if (dayErr) return res.status(500).json({ error: dayErr.message });

    const conflictingRows = (dayRows || []).filter((r) => {
        if (!isActiveRow(r) || !isTimedRow(r)) return false;
        if (existingBookingRow && r.id === existingBookingRow.id) return false;
        const [rs, re] = rowInterval(r);
        return slotStart < re && slotEnd > rs;
    });

    if (conflictingRows.length > 0) {
        const firstConflict = conflictingRows[0];
        const [cs, ce] = rowInterval(firstConflict);
        const conflictTitle = firstConflict.capstone_title || firstConflict.team_name || firstConflict.student_name || 'existing appointment';
        const conflictType = formatConsultationTitle(firstConflict.consultation_type, firstConflict.defense_level);
        return res.status(409).json({
            code: 'SLOT_OVERLAP',
            field: 'defStartTimeInput',
            error: `${formatMinute(slotStart)} – ${formatMinute(slotEnd)} overlaps with ${conflictType} (${conflictTitle}, ${formatMinute(cs)} – ${formatMinute(ce)}). Please choose another time or cancel/move that appointment first.`,
        });
    }

    let savedRow = null;
    let previousBooking = null;

    if (existingBookingRow) {
        previousBooking = toBooking(existingBookingRow, now, studentRow);
        const [prevStart] = rowInterval(existingBookingRow);
        const timeChanged = existingBookingRow.appointment_date !== date || prevStart !== slotStart;
        const rescheduledAt = timeChanged ? new Date().toISOString() : (existingBookingRow.rescheduled_at || null);
        const nextCount = timeChanged
            ? (Number(existingBookingRow.rescheduled_count) || 0) + 1
            : (Number(existingBookingRow.rescheduled_count) || 0);

        const updatePayload = {
            student_name: members[0],
            team_name: capstoneTitle,
            capstone_title: capstoneTitle,
            members,
            reason: rawReason,
            appointment_date: date,
            start_hour: Math.floor(slotStart / 60),
            start_minute: slotStart,
            duration_minutes: durationMinutes,
            consultation_type: 'defense',
            defense_level: defenseLevel,
            instructor_role: instructorRole,
            student_id: studentRow?.id || existingBookingRow.student_id || null,
            student_email: rawPrimaryEmail || studentRow?.email || existingBookingRow.student_email || null,
            reminder_sent_at: null,
            student_reminder_sent_at: null,
            ...(timeChanged ? {
                previous_date: existingBookingRow.appointment_date,
                previous_start_minute: prevStart,
                rescheduled_at: rescheduledAt,
                rescheduled_count: nextCount,
            } : {}),
        };

        let { data: upd, error: updErr } = await db()
            .from(TABLE)
            .update(updatePayload)
            .eq('id', existingBookingRow.id)
            .select('*')
            .maybeSingle();

        if (updErr && ['42703', 'PGRST204'].includes(updErr.code)) {
            const {
                previous_date: _pd,
                previous_start_minute: _pm,
                rescheduled_at: _ra,
                rescheduled_count: _rc,
                ...corePayload
            } = updatePayload;
            const retry = await db()
                .from(TABLE)
                .update(corePayload)
                .eq('id', existingBookingRow.id)
                .select('*')
                .maybeSingle();
            upd = retry.data;
            updErr = retry.error;
        }

        if (updErr) {
            if (updErr.code === '23505' || updErr.code === '23P01') {
                return res.status(409).json({
                    code: 'SLOT_OVERLAP',
                    error: `${formatMinute(slotStart)} – ${formatMinute(slotEnd)} overlaps with an existing appointment on ${date}. Please choose another time.`,
                });
            }
            if (['23514', '42703', 'PGRST204'].includes(updErr.code)) {
                return res.status(500).json({
                    error: 'Database schema needs updating: please run supabase/schema.sql in your Supabase SQL Editor.',
                });
            }
            return res.status(500).json({ error: updErr.message });
        }
        if (!upd) return res.status(404).json({ error: 'Appointment could not be updated.' });

        remindedAppointmentIds.delete(existingBookingRow.id);
        remindedStudentAppointmentIds.delete(existingBookingRow.id);
        savedRow = upd;
    } else {
        const insertPayload = {
            student_name: members[0],
            team_name: capstoneTitle,
            capstone_title: capstoneTitle,
            members,
            reason: rawReason,
            appointment_date: date,
            start_hour: Math.floor(slotStart / 60),
            start_minute: slotStart,
            duration_minutes: durationMinutes,
            consultation_type: 'defense',
            defense_level: defenseLevel,
            instructor_role: instructorRole,
            student_id: studentRow?.id || null,
            student_email: rawPrimaryEmail || studentRow?.email || null,
        };

        const { data: ins, error: insErr } = await db()
            .from(TABLE)
            .insert([insertPayload])
            .select('*')
            .single();

        if (insErr) {
            if (insErr.code === '23505' || insErr.code === '23P01') {
                return res.status(409).json({
                    code: 'SLOT_OVERLAP',
                    error: `${formatMinute(slotStart)} – ${formatMinute(slotEnd)} overlaps with an existing appointment on ${date}. Please choose another time.`,
                });
            }
            if (['23514', '42703', 'PGRST204'].includes(insErr.code)) {
                return res.status(500).json({
                    error: 'Database schema needs updating: please run supabase/schema.sql in your Supabase SQL Editor.',
                });
            }
            return res.status(500).json({ error: insErr.message });
        }
        savedRow = ins;
    }

    // Keep the registered group's project_level in sync if changed
    if (studentRow && studentRow.project_level !== defenseLevel) {
        const { data: updatedStu, error: lvlErr } = await db()
            .from(STUDENTS_TABLE)
            .update({ project_level: defenseLevel })
            .eq('id', studentRow.id)
            .select('*')
            .maybeSingle();
        if (!lvlErr && updatedStu) {
            studentRow = updatedStu;
        }
    }

    const booking = toBooking(savedRow, now, studentRow);

    // Build recipient list if sendEmail is enabled
    const sendEmail = body.sendEmail !== false;
    const includeGroupmates = body.includeGroupmates !== false;
    const extraCustomEmails = Array.isArray(body.extraEmails)
        ? body.extraEmails.map(normalizeEmail).filter((e) => e && e.length <= 254 && EMAIL_RE.test(e))
        : [];

    let recipients = [];
    if (sendEmail) {
        if (includeGroupmates) {
            recipients = getGroupRecipientEmails({
                primaryEmail: rawPrimaryEmail || studentRow?.email || null,
                memberEmails: extraCustomEmails,
                studentRow,
                booking,
            });
        } else {
            const single = normalizeEmail(rawPrimaryEmail || studentRow?.email || booking.studentEmail || '');
            if (single && EMAIL_RE.test(single)) recipients = [single];
            extraCustomEmails.forEach((e) => {
                if (!recipients.includes(e)) recipients.push(e);
            });
        }
    }

    let emailSent = false;
    let emailError = null;
    const siteOrigin = resolveSiteOrigin(req);

    const rtPromise = notifyRealtimeListeners({
        type: existingBookingRow ? 'booking_rescheduled' : 'booking_created',
        date: booking.date,
        ...(previousBooking?.date ? { previousDate: previousBooking.date } : {}),
        bookingId: booking.id,
        by: 'admin',
    });

    if (sendEmail && recipients.length > 0) {
        try {
            if (existingBookingRow) {
                await sendStudentRescheduleEmail(booking, previousBooking, siteOrigin, {
                    scheduledByAdmin: true,
                    recipientsOverride: recipients,
                });
            } else {
                await sendStudentBookingConfirmationEmail(booking, siteOrigin, {
                    scheduledByAdmin: true,
                    recipientsOverride: recipients,
                });
            }
            emailSent = true;
        } catch (err) {
            console.error('Failed to send admin-scheduled defense email:', err.message || err);
            emailError = err.message || 'Could not send email notification.';
        }
    }

    if (process.env.VERCEL) {
        await rtPromise;
    }

    res.status(existingBookingRow ? 200 : 201).json({
        ok: true,
        rescheduled: Boolean(existingBookingRow),
        booking,
        previousBooking,
        emailSent,
        emailError,
        recipients,
    });
});

// Fetch the student account linked to a booking row so serialized bookings retain student-level metadata & groupmate emails.
async function fetchStudentForBooking(row) {
    if (!row) return null;
    if (row.student_id) {
        const { data, error } = await db()
            .from(STUDENTS_TABLE)
            .select('*')
            .eq('id', row.student_id)
            .maybeSingle();
        if (!error && data) return data;
    }
    if (row.student_email) {
        return findStudentByEmail(normalizeEmail(row.student_email)).catch(() => null);
    }
    return null;
}

async function buildStudentLookupForRows(rows = []) {
    const byId = new Map();
    const byEmail = new Map();
    const ids = [...new Set((rows || []).map((r) => r?.student_id).filter(Boolean))];
    const emails = [...new Set((rows || []).map((r) => normalizeEmail(r?.student_email)).filter(Boolean))];
    try {
        if (ids.length) {
            const { data } = await db().from(STUDENTS_TABLE).select('*').in('id', ids);
            for (const s of data || []) {
                byId.set(s.id, s);
                if (s.email) byEmail.set(s.email.toLowerCase(), s);
            }
        }
        const missingEmails = emails.filter((e) => !byEmail.has(e));
        if (missingEmails.length) {
            const { data } = await db().from(STUDENTS_TABLE).select('*').in('email', missingEmails);
            for (const s of data || []) {
                byId.set(s.id, s);
                if (s.email) byEmail.set(s.email.toLowerCase(), s);
            }
        }
    } catch {
        // Ignore transient lookup errors and fall back to row.student_email
    }
    return { byId, byEmail };
}

// Cancel an appointment with an instructor reason visible in the student's profile
app.post('/api/admin/bookings/:id/cancel', requireAdmin, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });

    const reason = String(req.body?.reason ?? '').trim();
    if (reason.length < 3 || reason.length > 500) {
        return res.status(400).json({
            field: 'cancelReason',
            error: 'Please enter a reason for cancellation (3–500 characters) so the student can see it in their profile.',
        });
    }

    const cancelledAt = new Date().toISOString();
    const { data, error } = await db()
        .from(TABLE)
        .update({
            status: 'cancelled',
            cancellation_reason: reason,
            cancelled_at: cancelledAt,
        })
        .eq('id', req.params.id)
        .select('*')
        .maybeSingle();

    if (error) {
        if (['23514', '42703', 'PGRST204'].includes(error.code)) {
            return res.status(500).json({
                error: 'Database schema needs updating: please run supabase/schema.sql in your Supabase SQL Editor.',
            });
        }
        return res.status(500).json({ error: error.message });
    }
    if (!data) return res.status(404).json({ error: 'Booking not found.' });

    const studentRow = await fetchStudentForBooking(data);
    const booking = toBooking(data, nowInTz(), studentRow);
    const emailPromise = sendStudentCancellationEmail(booking, resolveSiteOrigin(req), { cancelledBy: 'instructor' }).catch((err) => {
        console.error('Failed to send student cancellation email:', err.message || err);
    });
    const rtPromise = notifyRealtimeListeners({
        type: 'booking_cancelled',
        date: booking.date,
        bookingId: booking.id,
        by: 'admin',
    });
    if (process.env.VERCEL) {
        await Promise.all([emailPromise, rtPromise]);
    }

    res.json({ ok: true, booking });
});

// Save consultation status (scheduled / completed / no_show), member attendance, revision checklist & notes
async function handleAdminBookingNotesUpdate(req, res) {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });

    const { data: row, error: fetchErr } = await db()
        .from(TABLE)
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!row) return res.status(404).json({ error: 'Booking not found.' });
    if (row.status === 'cancelled') {
        return res.status(400).json({ error: 'Cancelled appointments cannot be updated.' });
    }

    const body = req.body || {};

    let nextStatus = ['scheduled', 'completed', 'no_show'].includes(row.status) ? row.status : 'scheduled';
    if (Object.prototype.hasOwnProperty.call(body, 'status') && body.status !== undefined && body.status !== null) {
        const s = String(body.status).trim();
        if (!['scheduled', 'completed', 'no_show'].includes(s)) {
            return res.status(400).json({ error: 'Status must be scheduled, completed, or no_show.' });
        }
        nextStatus = s;
    }

    let nextAttended = Array.isArray(row.attended_members)
        ? row.attended_members.map(cleanName).filter(Boolean).slice(0, MAX_MEMBERS)
        : [];
    if (Object.prototype.hasOwnProperty.call(body, 'attendedMembers') && body.attendedMembers !== undefined) {
        if (!Array.isArray(body.attendedMembers)) {
            return res.status(400).json({ error: 'attendedMembers must be an array.' });
        }
        const seen = new Set();
        nextAttended = [];
        for (const rawName of body.attendedMembers) {
            const name = cleanName(rawName);
            if (!name || seen.has(name)) continue;
            seen.add(name);
            nextAttended.push(name);
            if (nextAttended.length >= MAX_MEMBERS) break;
        }
    }

    let nextNotes = typeof row.revision_notes === 'string' && row.revision_notes.trim()
        ? row.revision_notes.trim()
        : null;
    if (Object.prototype.hasOwnProperty.call(body, 'revisionNotes') && body.revisionNotes !== undefined) {
        const rawNotes = body.revisionNotes === null ? '' : String(body.revisionNotes).trim();
        if (rawNotes.length > 2000) {
            return res.status(400).json({
                field: 'revisionNotes',
                error: 'Consultation notes must be 2000 characters or fewer.',
            });
        }
        nextNotes = rawNotes || null;
    }

    let nextChecklist = Array.isArray(row.revision_checklist) ? row.revision_checklist : [];
    if (Object.prototype.hasOwnProperty.call(body, 'revisionChecklist') && body.revisionChecklist !== undefined) {
        if (!Array.isArray(body.revisionChecklist)) {
            return res.status(400).json({ error: 'revisionChecklist must be an array.' });
        }
        if (body.revisionChecklist.length > 30) {
            return res.status(400).json({ error: 'You can add up to 30 revision action items per consultation.' });
        }
        nextChecklist = [];
        for (let i = 0; i < body.revisionChecklist.length; i += 1) {
            const item = body.revisionChecklist[i];
            if (!item || typeof item !== 'object') continue;
            const text = String(item.text ?? '').trim();
            if (!text) continue;
            if (text.length > 300) {
                return res.status(400).json({ error: 'Each revision action item must be 300 characters or fewer.' });
            }
            nextChecklist.push({
                id: String(item.id || crypto.randomUUID()).trim().slice(0, 64) || `item-${i + 1}`,
                text,
                done: Boolean(item.done),
            });
        }
    }

    const nextCompletedAt = (nextStatus === 'completed' || nextStatus === 'no_show')
        ? (row.completed_at || new Date().toISOString())
        : null;

    const { data, error } = await db()
        .from(TABLE)
        .update({
            status: nextStatus,
            attended_members: nextAttended,
            revision_notes: nextNotes,
            revision_checklist: nextChecklist,
            completed_at: nextCompletedAt,
        })
        .eq('id', row.id)
        .select('*')
        .maybeSingle();

    if (error) {
        if (['23514', '42703', 'PGRST204'].includes(error.code)) {
            return res.status(500).json({
                error: 'Database schema needs updating: please run supabase/schema.sql in your Supabase SQL Editor.',
            });
        }
        return res.status(500).json({ error: error.message });
    }
    if (!data) return res.status(404).json({ error: 'Booking not found.' });

    const studentRow = await fetchStudentForBooking(data);
    const booking = toBooking(data, nowInTz(), studentRow);
    const rtPromise = notifyRealtimeListeners({
        type: 'booking_notes_updated',
        date: booking.date,
        bookingId: booking.id,
    });
    if (process.env.VERCEL) await rtPromise;

    res.json({ ok: true, booking });
}

app.post('/api/admin/bookings/:id/notes', requireAdmin, handleAdminBookingNotesUpdate);
app.patch('/api/admin/bookings/:id/notes', requireAdmin, handleAdminBookingNotesUpdate);

app.delete('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });
    const { error } = await db().from(TABLE).delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    const rtPromise = notifyRealtimeListeners({ type: 'booking_deleted', bookingId: req.params.id });
    if (process.env.VERCEL) await rtPromise;
    res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* 10-Minute Appointment Reminders (to Instructor Email)               */
/* ------------------------------------------------------------------ */
function formatLongDateStr(dateStr) {
    const dt = parseDate(dateStr);
    if (!dt) return String(dateStr || '');
    return dt.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
    });
}

function resolveSiteOrigin(req = null) {
    const configured = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
    if (configured) return configured;
    if (req && typeof req.get === 'function') {
        const host = req.get('host');
        if (host) {
            const proto = req.headers['x-forwarded-proto']
                ? String(req.headers['x-forwarded-proto']).split(',')[0].trim()
                : req.protocol;
            return `${proto}://${host}`;
        }
    }
    if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
        return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
    }
    if (process.env.VERCEL_URL) {
        return `https://${process.env.VERCEL_URL}`;
    }
    return '';
}

function formatTimeUntilLabel(minsUntil) {
    if (minsUntil <= 0) return 'less than a minute';
    if (minsUntil === 60) return '1 hour';
    return `${minsUntil} minute${minsUntil === 1 ? '' : 's'}`;
}

function buildBookingSummaryData(booking) {
    return {
        projectOrStudent: booking.capstoneTitle || booking.teamName || booking.name || 'Student Group',
        dateLabel: formatLongDateStr(booking.date),
        courseLabel: booking.projectLevelLabel || booking.defenseLevelLabel || '—',
        roleLabel: formatRoleLabel(booking.instructorRole),
        membersList: Array.isArray(booking.members) && booking.members.length
            ? booking.members.join(', ')
            : (booking.name || '—'),
    };
}

function buildBookingSummaryTextLines(booking, { includeStudentEmail = true } = {}) {
    const { projectOrStudent, dateLabel, courseLabel, roleLabel, membersList } = buildBookingSummaryData(booking);
    const lines = [
        `Type: ${booking.consultationTitle} (${booking.durationLabel})`,
        `Date: ${dateLabel}`,
        `Time: ${booking.label}`,
        `Location: ${CONFIG.location}`,
        `Capstone / Thesis Title: ${projectOrStudent}`,
        `Course: ${courseLabel}`,
        `Instructor (${TEACHER_NAME}): ${roleLabel}`,
        `Group Members: ${membersList}`,
    ];
    if (includeStudentEmail) {
        const allEmails = getGroupRecipientEmails({ booking });
        lines.push(`Student Email(s): ${allEmails.length ? allEmails.join(', ') : (booking.studentEmail || '—')}`);
    }
    lines.push(`Details: ${booking.reason || '—'}`);
    lines.push(`Reference: #${booking.reference}`);
    return lines;
}

function buildBookingSummaryHtmlCard(booking, { includeStudentEmail = true, accentColor = '#0f766e' } = {}) {
    const { projectOrStudent, dateLabel, courseLabel, roleLabel, membersList } = buildBookingSummaryData(booking);
    const allEmails = includeStudentEmail ? getGroupRecipientEmails({ booking }) : [];
    const emailDisplay = allEmails.length ? allEmails.join(', ') : (booking.studentEmail || '—');
    const studentEmailRow = includeStudentEmail
        ? `
                    <tr>
                        <td style="padding:4px 10px 4px 0;color:#64748b;vertical-align:top">${allEmails.length > 1 ? 'Group Emails' : 'Student Email'}</td>
                        <td style="padding:4px 0;color:#0f172a">${escapeHtml(emailDisplay)}</td>
                    </tr>`
        : '';

    return `
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px 18px;margin:16px 0">
                <div style="font-size:17px;font-weight:700;color:${escapeHtml(accentColor)};margin-bottom:4px">
                    ${escapeHtml(booking.consultationTitle)} · ${escapeHtml(booking.durationLabel)}
                </div>
                <div style="font-size:14px;color:#334155;margin-bottom:12px">
                    <strong>${escapeHtml(dateLabel)}</strong> · ${escapeHtml(booking.label)}
                </div>
                <table style="width:100%;border-collapse:collapse;font-size:14px">
                    <tr>
                        <td style="padding:4px 10px 4px 0;color:#64748b;vertical-align:top;width:155px">Location</td>
                        <td style="padding:4px 0;color:#0f172a">${escapeHtml(CONFIG.location)}</td>
                    </tr>
                    <tr>
                        <td style="padding:4px 10px 4px 0;color:#64748b;vertical-align:top">Capstone / Thesis</td>
                        <td style="padding:4px 0;color:#0f172a"><strong>${escapeHtml(projectOrStudent)}</strong></td>
                    </tr>
                    <tr>
                        <td style="padding:4px 10px 4px 0;color:#64748b;vertical-align:top">Course &amp; Role</td>
                        <td style="padding:4px 0;color:#0f172a">${escapeHtml(courseLabel)} · ${escapeHtml(roleLabel)}</td>
                    </tr>
                    <tr>
                        <td style="padding:4px 10px 4px 0;color:#64748b;vertical-align:top">Group Members</td>
                        <td style="padding:4px 0;color:#0f172a">${escapeHtml(membersList)}</td>
                    </tr>${studentEmailRow}
                    <tr>
                        <td style="padding:4px 10px 4px 0;color:#64748b;vertical-align:top">Details</td>
                        <td style="padding:4px 0;color:#0f172a">${escapeHtml(booking.reason || '—')}</td>
                    </tr>
                    <tr>
                        <td style="padding:4px 10px 4px 0;color:#64748b;vertical-align:top">Reference</td>
                        <td style="padding:4px 0;color:#0f172a"><code>#${escapeHtml(booking.reference)}</code></td>
                    </tr>
                </table>
            </div>`;
}

function studentPolicyReminderText(booking) {
    const rules = [];
    if (['system', 'defense'].includes(booking.consultationType)) {
        rules.push('All group members must be present during this schedule.');
    } else if (booking.consultationType === 'retrieval') {
        rules.push('At least 2 or all group members must be present during manuscript retrieval; otherwise, your group will not be accommodated.');
    } else if (booking.consultationType === 'letter') {
        rules.push("Please bring your printed communication letter that already bears Ma'am Melinda Beninsig's initial.");
    } else if (booking.consultationType === 'letter_pickup') {
        rules.push(`Please claim your signed communication letter at the ${CONFIG.location} during your scheduled 5-minute pickup slot.`);
    } else if (booking.isDropoff) {
        rules.push('Once your manuscript is checked, you will receive an email notification to schedule your 5-minute Retrieval of Manuscript.');
    }
    rules.push('If you need to reschedule or cancel, please do so in My Appointments at least 2 hours before the scheduled time.');
    return rules;
}

function buildEmailActionButtonsHtml(outlookCalUrl, appointmentsUrl = '') {
    const appointmentsBtnHtml = appointmentsUrl
        ? `<a href="${escapeHtml(appointmentsUrl)}" style="display:inline-block;background:#ffffff;color:#0f172a;border:1px solid #cbd5e1;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:8px;margin-bottom:8px">View My Appointments</a>`
        : '';
    return `
            <div style="margin:18px 0">
                <a href="${escapeHtml(outlookCalUrl)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:8px;margin-right:8px;margin-bottom:8px">Add to Outlook Calendar</a>
                ${appointmentsBtnHtml}
            </div>`;
}

function formatStudentGroupGreeting(booking, recipientsCount = 1) {
    if (recipientsCount > 1 && Array.isArray(booking?.members) && booking.members.length > 1) {
        return `Hi ${booking.members.join(', ')},`;
    }
    return `Hi ${booking?.name || 'Student'},`;
}

async function sendStudentBookingConfirmationEmail(
    booking,
    siteOrigin = '',
    { scheduledByAdmin = false, recipientsOverride = null } = {}
) {
    const recipients = Array.isArray(recipientsOverride) && recipientsOverride.length
        ? recipientsOverride
        : getGroupRecipientEmails({ booking });
    if (!recipients.length) return;
    const { dateLabel } = buildBookingSummaryData(booking);
    const greeting = formatStudentGroupGreeting(booking, recipients.length);
    const isDefense = booking.consultationType === 'defense';
    const subject = scheduledByAdmin && isDefense
        ? `Defense Scheduled: ${booking.consultationTitle} on ${dateLabel} (${booking.label}) — #${booking.reference}`
        : `Confirmed: ${booking.consultationTitle} on ${dateLabel} (${booking.label}) — #${booking.reference}`;
    const appointmentsUrl = siteOrigin ? `${siteOrigin}/appointments.html` : '';
    const outlookCalUrl = booking.outlookCalendarUrl || buildOutlookCalendarUrl(booking);
    const rules = studentPolicyReminderText(booking);
    const introText = scheduledByAdmin
        ? `Your ${booking.consultationTitle} has been scheduled by ${TEACHER_NAME} (${formatRoleLabel(booking.instructorRole)}).`
        : `Your ${booking.consultationTitle} with ${TEACHER_NAME} has been scheduled.`;
    const introHtml = scheduledByAdmin
        ? `Your <strong>${escapeHtml(booking.consultationTitle)}</strong> has been scheduled by <strong>${escapeHtml(TEACHER_NAME)}</strong> (${escapeHtml(formatRoleLabel(booking.instructorRole))}).`
        : `Your <strong>${escapeHtml(booking.consultationTitle)}</strong> with <strong>${escapeHtml(TEACHER_NAME)}</strong> is confirmed.`;
    const cardAccent = isDefense ? '#be123c' : '#0f766e';

    const textLines = [
        greeting,
        '',
        introText,
        '',
        ...buildBookingSummaryTextLines(booking, { includeStudentEmail: false }),
        '',
        'Reminders:',
        ...rules.map((r) => `• ${r}`),
        '',
        `Add to Outlook Calendar: ${outlookCalUrl}`,
        ...(appointmentsUrl ? [`View My Appointments: ${appointmentsUrl}`] : []),
        '',
        'A calendar file (.ics) is attached so you can save this event to your calendar app.',
    ];

    const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#0f172a;line-height:1.55">
            <p>${escapeHtml(greeting)}</p>
            <p>${introHtml}</p>
            ${buildBookingSummaryHtmlCard(booking, { includeStudentEmail: false, accentColor: cardAccent })}
            ${buildEmailActionButtonsHtml(outlookCalUrl, appointmentsUrl)}
            <div style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;padding:12px 14px;border-radius:8px;font-size:13px">
                <strong>Reminders:</strong>
                <ul style="margin:6px 0 0;padding-left:18px">
                    ${rules.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}
                </ul>
            </div>
            <p style="margin-top:16px;color:#64748b;font-size:13px">A calendar file (<code>.ics</code>) is attached so you can open and save this event directly in your device’s calendar app.</p>
        </div>`;

    const bodyText = textLines.join('\n');
    const recipientName = Array.isArray(booking.members) && booking.members.length ? booking.members.join(', ') : (booking.name || null);
    const capstoneTitle = booking.capstoneTitle || booking.teamName || null;
    const logSentBy = scheduledByAdmin ? 'instructor' : 'system';
    const logEmailType = scheduledByAdmin && isDefense ? 'defense_scheduled_admin' : 'booking_confirmed';

    try {
        await mailer().sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: recipients,
            subject,
            text: bodyText,
            html,
            attachments: [
                {
                    filename: `consultation-${booking.reference.toLowerCase()}.ics`,
                    content: buildBookingIcs(booking, { method: 'PUBLISH', status: 'CONFIRMED', sequence: 0 }),
                    contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
                },
            ],
        });
        await recordEmailLog({
            sentBy: logSentBy,
            category: 'booking',
            emailType: logEmailType,
            status: 'sent',
            subject,
            recipients,
            recipientName,
            capstoneTitle,
            studentId: booking.studentId || null,
            bookingId: booking.id || null,
            bodyPreview: bodyText,
        });
    } catch (err) {
        await recordEmailLog({
            sentBy: logSentBy,
            category: 'booking',
            emailType: logEmailType,
            status: 'failed',
            subject,
            recipients,
            recipientName,
            capstoneTitle,
            studentId: booking.studentId || null,
            bookingId: booking.id || null,
            bodyPreview: bodyText,
            errorMessage: err.message || String(err),
        });
        throw err;
    }
}

async function sendStudentRescheduleEmail(
    booking,
    previousBooking = null,
    siteOrigin = '',
    { scheduledByAdmin = false, recipientsOverride = null } = {}
) {
    const recipients = Array.isArray(recipientsOverride) && recipientsOverride.length
        ? recipientsOverride
        : getGroupRecipientEmails({ booking });
    if (!recipients.length) return;
    const { dateLabel } = buildBookingSummaryData(booking);
    const prevDateLabel = previousBooking?.date ? formatLongDateStr(previousBooking.date) : null;
    const prevSummary = prevDateLabel && previousBooking?.label
        ? `${prevDateLabel} (${previousBooking.label})`
        : null;
    const greeting = formatStudentGroupGreeting(booking, recipients.length);
    const isDefense = booking.consultationType === 'defense';
    const subject = `Rescheduled: ${booking.consultationTitle} moved to ${dateLabel} (${booking.label}) — #${booking.reference}`;
    const appointmentsUrl = siteOrigin ? `${siteOrigin}/appointments.html` : '';
    const outlookCalUrl = booking.outlookCalendarUrl || buildOutlookCalendarUrl(booking);
    const rules = studentPolicyReminderText(booking);
    const sequence = Math.max(1, booking.rescheduledCount || 1);
    const introText = scheduledByAdmin
        ? `Your ${booking.consultationTitle} has been rescheduled by ${TEACHER_NAME} (${formatRoleLabel(booking.instructorRole)}).`
        : `Your ${booking.consultationTitle} with ${TEACHER_NAME} has been rescheduled.`;
    const introHtml = scheduledByAdmin
        ? `Your <strong>${escapeHtml(booking.consultationTitle)}</strong> has been rescheduled by <strong>${escapeHtml(TEACHER_NAME)}</strong> (${escapeHtml(formatRoleLabel(booking.instructorRole))}).`
        : `Your <strong>${escapeHtml(booking.consultationTitle)}</strong> with <strong>${escapeHtml(TEACHER_NAME)}</strong> has been rescheduled.`;
    const cardAccent = isDefense ? '#be123c' : '#0f766e';

    const textLines = [
        greeting,
        '',
        introText,
        ...(prevSummary ? [`Moved from: ${prevSummary}`] : []),
        '',
        ...buildBookingSummaryTextLines(booking, { includeStudentEmail: false }),
        '',
        'Reminders:',
        ...rules.map((r) => `• ${r}`),
        '',
        `Add to Outlook Calendar: ${outlookCalUrl}`,
        ...(appointmentsUrl ? [`View My Appointments: ${appointmentsUrl}`] : []),
        '',
        'An updated calendar file (.ics) is attached so you can update this event in your calendar app.',
    ];

    const movedFromHtml = prevSummary
        ? `
            <div style="background:#f0fdfa;border:1px solid #99f6e4;color:#0f766e;padding:10px 14px;border-radius:8px;font-size:13px;margin:12px 0">
                <strong>Moved from:</strong> ${escapeHtml(prevSummary)}
            </div>`
        : '';

    const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#0f172a;line-height:1.55">
            <p>${escapeHtml(greeting)}</p>
            <p>${introHtml}</p>
            ${movedFromHtml}
            ${buildBookingSummaryHtmlCard(booking, { includeStudentEmail: false, accentColor: cardAccent })}
            ${buildEmailActionButtonsHtml(outlookCalUrl, appointmentsUrl)}
            <div style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;padding:12px 14px;border-radius:8px;font-size:13px">
                <strong>Reminders:</strong>
                <ul style="margin:6px 0 0;padding-left:18px">
                    ${rules.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}
                </ul>
            </div>
            <p style="margin-top:16px;color:#64748b;font-size:13px">An updated calendar file (<code>.ics</code>) is attached so you can update this event directly in your device’s calendar app.</p>
        </div>`;

    const bodyText = textLines.join('\n');
    const recipientName = Array.isArray(booking.members) && booking.members.length ? booking.members.join(', ') : (booking.name || null);
    const capstoneTitle = booking.capstoneTitle || booking.teamName || null;
    const logSentBy = scheduledByAdmin ? 'instructor' : 'system';
    const logEmailType = scheduledByAdmin && isDefense ? 'defense_rescheduled_admin' : 'booking_rescheduled';

    try {
        await mailer().sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: recipients,
            subject,
            text: bodyText,
            html,
            attachments: [
                {
                    filename: `consultation-${booking.reference.toLowerCase()}.ics`,
                    content: buildBookingIcs(booking, { method: 'PUBLISH', status: 'CONFIRMED', sequence }),
                    contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
                },
            ],
        });
        await recordEmailLog({
            sentBy: logSentBy,
            category: 'booking',
            emailType: logEmailType,
            status: 'sent',
            subject,
            recipients,
            recipientName,
            capstoneTitle,
            studentId: booking.studentId || null,
            bookingId: booking.id || null,
            bodyPreview: bodyText,
        });
    } catch (err) {
        await recordEmailLog({
            sentBy: logSentBy,
            category: 'booking',
            emailType: logEmailType,
            status: 'failed',
            subject,
            recipients,
            recipientName,
            capstoneTitle,
            studentId: booking.studentId || null,
            bookingId: booking.id || null,
            bodyPreview: bodyText,
            errorMessage: err.message || String(err),
        });
        throw err;
    }
}

async function sendStudentCancellationEmail(booking, siteOrigin = '', { cancelledBy = null } = {}) {
    const recipients = getGroupRecipientEmails({ booking });
    if (!recipients.length) return;
    const { dateLabel } = buildBookingSummaryData(booking);
    const greeting = formatStudentGroupGreeting(booking, recipients.length);
    const reason = booking.cancellationReason || 'Instructor unavailable.';
    const subject = `Cancelled: ${booking.consultationTitle} on ${dateLabel} (${booking.label}) — #${booking.reference}`;
    const bookingUrl = siteOrigin ? `${siteOrigin}/` : '';

    const textLines = [
        greeting,
        '',
        `Your scheduled ${booking.consultationTitle} with ${TEACHER_NAME} has been cancelled.`,
        '',
        `Reason for Cancellation: ${reason}`,
        '',
        'Original Appointment Details:',
        ...buildBookingSummaryTextLines(booking, { includeStudentEmail: false }),
        ...(bookingUrl ? ['', `Book a new consultation: ${bookingUrl}`] : []),
    ];

    const rebookBtnHtml = bookingUrl
        ? `<p style="margin:18px 0"><a href="${escapeHtml(bookingUrl)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:8px">Book a New Consultation</a></p>`
        : '';

    const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#0f172a;line-height:1.55">
            <p>${escapeHtml(greeting)}</p>
            <p>Your scheduled <strong>${escapeHtml(booking.consultationTitle)}</strong> with <strong>${escapeHtml(TEACHER_NAME)}</strong> has been cancelled.</p>
            <div style="background:#fff1f2;border:1px solid #fecdd3;color:#9f1239;padding:14px 16px;border-radius:10px;margin:16px 0">
                <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">Reason for Cancellation</div>
                <div style="font-size:14px;font-weight:600">${escapeHtml(reason)}</div>
            </div>
            ${buildBookingSummaryHtmlCard(booking, { includeStudentEmail: false, accentColor: '#be123c' })}
            ${rebookBtnHtml}
            <p style="color:#64748b;font-size:13px">An updated calendar cancellation (<code>.ics</code>) is attached so it is removed from your calendar if you added it previously.</p>
        </div>`;

    const bodyText = textLines.join('\n');
    const recipientName = Array.isArray(booking.members) && booking.members.length ? booking.members.join(', ') : (booking.name || null);
    const capstoneTitle = booking.capstoneTitle || booking.teamName || null;
    const isStudentCancel = cancelledBy === 'student' || (!cancelledBy && reason === 'Cancelled by student.');
    const cancelEmailType = isStudentCancel ? 'booking_cancelled_student' : 'booking_cancelled_admin';

    try {
        await mailer().sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: recipients,
            subject,
            text: bodyText,
            html,
            attachments: [
                {
                    filename: `consultation-${booking.reference.toLowerCase()}-cancelled.ics`,
                    content: buildBookingIcs(booking, {
                        method: 'CANCEL',
                        status: 'CANCELLED',
                        sequence: (booking.rescheduledCount || 0) + 1,
                    }),
                    contentType: 'text/calendar; charset=utf-8; method=CANCEL',
                },
            ],
        });
        await recordEmailLog({
            sentBy: 'system',
            category: 'cancellation',
            emailType: cancelEmailType,
            status: 'sent',
            subject,
            recipients,
            recipientName,
            capstoneTitle,
            studentId: booking.studentId || null,
            bookingId: booking.id || null,
            bodyPreview: bodyText,
        });
    } catch (err) {
        await recordEmailLog({
            sentBy: 'system',
            category: 'cancellation',
            emailType: cancelEmailType,
            status: 'failed',
            subject,
            recipients,
            recipientName,
            capstoneTitle,
            studentId: booking.studentId || null,
            bookingId: booking.id || null,
            bodyPreview: bodyText,
            errorMessage: err.message || String(err),
        });
        throw err;
    }
}

async function sendStudentReminderEmail(booking, minsUntil, siteOrigin = '') {
    const recipients = getGroupRecipientEmails({ booking });
    if (!recipients.length) return;
    const timeText = formatTimeUntilLabel(minsUntil);
    const outlookCalUrl = booking.outlookCalendarUrl || buildOutlookCalendarUrl(booking);
    const appointmentsUrl = siteOrigin ? `${siteOrigin}/appointments.html` : '';
    const greeting = formatStudentGroupGreeting(booking, recipients.length);
    const subject = `Reminder: Your ${booking.consultationTitle} is in ${timeText} (${booking.label}) — #${booking.reference}`;
    const rules = studentPolicyReminderText(booking);

    const textLines = [
        greeting,
        '',
        `This is a reminder that your ${booking.consultationTitle} with ${TEACHER_NAME} starts in ${timeText} at ${CONFIG.location}.`,
        '',
        ...buildBookingSummaryTextLines(booking, { includeStudentEmail: false }),
        '',
        'Reminders:',
        ...rules.map((r) => `• ${r}`),
        '',
        `Add to Outlook Calendar: ${outlookCalUrl}`,
        ...(appointmentsUrl ? [`View My Appointments: ${appointmentsUrl}`] : []),
    ];

    const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#0f172a;line-height:1.55">
            <p>${escapeHtml(greeting)}</p>
            <p>This is a reminder that your <strong>${escapeHtml(booking.consultationTitle)}</strong> with <strong>${escapeHtml(TEACHER_NAME)}</strong> starts in <strong>${escapeHtml(timeText)}</strong> at <strong>${escapeHtml(CONFIG.location)}</strong>.</p>
            ${buildBookingSummaryHtmlCard(booking, { includeStudentEmail: false })}
            ${buildEmailActionButtonsHtml(outlookCalUrl, appointmentsUrl)}
            <div style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;padding:12px 14px;border-radius:8px;font-size:13px">
                <strong>Reminders:</strong>
                <ul style="margin:6px 0 0;padding-left:18px">
                    ${rules.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}
                </ul>
            </div>
        </div>`;

    const bodyText = textLines.join('\n');
    const recipientName = Array.isArray(booking.members) && booking.members.length ? booking.members.join(', ') : (booking.name || null);
    const capstoneTitle = booking.capstoneTitle || booking.teamName || null;

    try {
        await mailer().sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: recipients,
            subject,
            text: bodyText,
            html,
            attachments: [
                {
                    filename: `consultation-${booking.reference.toLowerCase()}.ics`,
                    content: buildBookingIcs(booking, { method: 'PUBLISH', status: 'CONFIRMED', sequence: booking.rescheduledCount || 0 }),
                    contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
                },
            ],
        });
        await recordEmailLog({
            sentBy: 'system',
            category: 'reminder',
            emailType: 'student_reminder',
            status: 'sent',
            subject,
            recipients,
            recipientName,
            capstoneTitle,
            studentId: booking.studentId || null,
            bookingId: booking.id || null,
            bodyPreview: bodyText,
        }, { emitRealtime: false });
    } catch (err) {
        await recordEmailLog({
            sentBy: 'system',
            category: 'reminder',
            emailType: 'student_reminder',
            status: 'failed',
            subject,
            recipients,
            recipientName,
            capstoneTitle,
            studentId: booking.studentId || null,
            bookingId: booking.id || null,
            bodyPreview: bodyText,
            errorMessage: err.message || String(err),
        });
        throw err;
    }
}

async function sendTeacherReminderEmail(booking, minsUntil) {
    if (!TEACHER_EMAIL) {
        throw httpError(500, 'Server is missing TEACHER_EMAIL.');
    }
    const timeText = formatTimeUntilLabel(minsUntil);
    const { projectOrStudent } = buildBookingSummaryData(booking);
    const subject = `Reminder: ${booking.consultationTitle} in ${timeText} (${booking.label}) — ${projectOrStudent}`;

    const textLines = [
        `Hi ${TEACHER_NAME},`,
        '',
        `This is a reminder that you have an upcoming appointment in ${timeText}:`,
        '',
        ...buildBookingSummaryTextLines(booking, { includeStudentEmail: true }),
    ];

    const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#0f172a;line-height:1.55">
            <p>Hi ${escapeHtml(TEACHER_NAME)},</p>
            <p>This is a reminder that you have an upcoming appointment in <strong>${escapeHtml(timeText)}</strong>.</p>
            ${buildBookingSummaryHtmlCard(booking, { includeStudentEmail: true })}
        </div>`;

    const bodyText = textLines.join('\n');
    const capstoneTitle = booking.capstoneTitle || booking.teamName || null;

    try {
        await mailer().sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: TEACHER_EMAIL,
            subject,
            text: bodyText,
            html,
        });
        await recordEmailLog({
            sentBy: 'system',
            category: 'reminder',
            emailType: 'instructor_reminder',
            status: 'sent',
            subject,
            recipients: [TEACHER_EMAIL],
            recipientName: TEACHER_NAME,
            capstoneTitle,
            studentId: booking.studentId || null,
            bookingId: booking.id || null,
            bodyPreview: bodyText,
        }, { emitRealtime: false });
    } catch (err) {
        await recordEmailLog({
            sentBy: 'system',
            category: 'reminder',
            emailType: 'instructor_reminder',
            status: 'failed',
            subject,
            recipients: [TEACHER_EMAIL],
            recipientName: TEACHER_NAME,
            capstoneTitle,
            studentId: booking.studentId || null,
            bookingId: booking.id || null,
            bodyPreview: bodyText,
            errorMessage: err.message || String(err),
        });
        throw err;
    }
}

const remindedAppointmentIds = new Set();
const remindedStudentAppointmentIds = new Set();
let reminderCheckStartedAt = 0; // 0 = no check running

async function checkAndSendAppointmentReminders(siteOrigin = resolveSiteOrigin()) {
    const checkedAt = new Date().toISOString();
    // Skip only if another check is genuinely running right now. A flag older than 60s is
    // stale (e.g. a serverless instance was frozen mid-check) and is ignored.
    if (reminderCheckStartedAt && Date.now() - reminderCheckStartedAt < 60 * 1000) {
        return { checkedAt, skipped: 'another check is already running', sentCount: 0, sentIds: [], studentSentCount: 0, studentSentIds: [] };
    }
    reminderCheckStartedAt = Date.now();
    const sentIds = [];
    const studentSentIds = [];
    const appointments = [];

    try {
        const now = nowInTz();
        const { data, error } = await db()
            .from(TABLE)
            .select('*')
            .eq('appointment_date', now.date)
            .neq('status', 'cancelled');
        if (error) throw error;

        const studentLookup = await buildStudentLookupForRows(data || []);

        for (const r of data || []) {
            const [startMinute] = rowInterval(r);
            const minsUntil = minutesUntilBooking(r.appointment_date, startMinute, now);
            const info = { ref: String(r.id).slice(0, 8), type: r.consultation_type, time: formatMinute(startMinute), minsUntil };
            appointments.push(info);

            if (!isActiveRow(r)) { info.result = 'cancelled'; continue; }
            if (minsUntil < 0) { info.result = 'already started'; continue; }

            const booking = toBooking(r, now, studentLookup);
            const alreadyNotifiedTeacher = Boolean(r.reminder_sent_at || (!['dropoff', 'letter'].includes(r.consultation_type) && r.notified_at));

            // 1. Teacher reminder (10 minutes before)
            if (alreadyNotifiedTeacher) {
                info.result = 'already sent';
            } else if (minsUntil > REMINDER_MINUTES_BEFORE) {
                info.result = 'not yet';
            } else if (remindedAppointmentIds.has(r.id)) {
                info.result = 'sending';
            } else {
                remindedAppointmentIds.add(r.id);
                const sentAt = new Date().toISOString();
                let claimedColumn = 'reminder_sent_at';
                let claimRes = await db()
                    .from(TABLE)
                    .update({ reminder_sent_at: sentAt })
                    .eq('id', r.id)
                    .is('reminder_sent_at', null)
                    .select('id')
                    .maybeSingle();

                if (claimRes.error && ['42703', 'PGRST204'].includes(claimRes.error.code) && !['dropoff', 'letter'].includes(r.consultation_type)) {
                    claimedColumn = 'notified_at';
                    claimRes = await db()
                        .from(TABLE)
                        .update({ notified_at: sentAt })
                        .eq('id', r.id)
                        .is('notified_at', null)
                        .select('id')
                        .maybeSingle();
                }

                if (claimRes.error) {
                    remindedAppointmentIds.delete(r.id);
                    info.result = `claim failed: ${claimRes.error.message}`;
                    console.error(`Could not claim ${claimedColumn} for appointment ${r.id}:`, claimRes.error);
                } else if (!claimRes.data) {
                    info.result = 'already sent';
                } else {
                    try {
                        await sendTeacherReminderEmail(booking, minsUntil);
                        sentIds.push(r.id);
                        info.result = 'sent';
                    } catch (err) {
                        remindedAppointmentIds.delete(r.id);
                        await db()
                            .from(TABLE)
                            .update({ [claimedColumn]: null })
                            .eq('id', r.id)
                            .eq(claimedColumn, sentAt);
                        info.result = `send failed: ${err.message || err}`;
                        console.error(`Failed to send 10-minute reminder for appointment ${r.id}:`, err);
                    }
                }
            }

            // 2. Student reminder (STUDENT_REMINDER_MINUTES_BEFORE, fallback to 10-min window if column not migrated yet)
            if (r.student_email) {
                const hasStudentReminderCol = Object.prototype.hasOwnProperty.call(r, 'student_reminder_sent_at');
                const studentWindow = hasStudentReminderCol ? STUDENT_REMINDER_MINUTES_BEFORE : REMINDER_MINUTES_BEFORE;
                const alreadySentStudent = hasStudentReminderCol
                    ? Boolean(r.student_reminder_sent_at)
                    : alreadyNotifiedTeacher;

                if (alreadySentStudent) {
                    info.studentResult = 'already sent';
                } else if (minsUntil > studentWindow) {
                    info.studentResult = 'not yet';
                } else if (remindedStudentAppointmentIds.has(r.id)) {
                    info.studentResult = 'sending';
                } else {
                    remindedStudentAppointmentIds.add(r.id);
                    const stuSentAt = new Date().toISOString();
                    let stuClaimed = true;
                    if (hasStudentReminderCol) {
                        const { data: stuClaimData, error: stuClaimErr } = await db()
                            .from(TABLE)
                            .update({ student_reminder_sent_at: stuSentAt })
                            .eq('id', r.id)
                            .is('student_reminder_sent_at', null)
                            .select('id')
                            .maybeSingle();
                        if (stuClaimErr) {
                            remindedStudentAppointmentIds.delete(r.id);
                            info.studentResult = `claim failed: ${stuClaimErr.message}`;
                            console.error(`Could not claim student_reminder_sent_at for appointment ${r.id}:`, stuClaimErr);
                            stuClaimed = false;
                        } else if (!stuClaimData) {
                            info.studentResult = 'already sent';
                            stuClaimed = false;
                        }
                    }

                    if (stuClaimed) {
                        try {
                            await sendStudentReminderEmail(booking, minsUntil, siteOrigin);
                            studentSentIds.push(r.id);
                            info.studentResult = 'sent';
                        } catch (err) {
                            remindedStudentAppointmentIds.delete(r.id);
                            if (hasStudentReminderCol) {
                                await db()
                                    .from(TABLE)
                                    .update({ student_reminder_sent_at: null })
                                    .eq('id', r.id)
                                    .eq('student_reminder_sent_at', stuSentAt);
                            }
                            info.studentResult = `send failed: ${err.message || err}`;
                            console.error(`Failed to send student reminder for appointment ${r.id}:`, err);
                        }
                    }
                }
            }
        }

        if (sentIds.length > 0 || studentSentIds.length > 0) {
            const rtPromise = notifyRealtimeListeners({
                type: 'reminder_sent',
                sentIds,
                studentSentIds,
            });
            if (process.env.VERCEL) await rtPromise;
        }

        return {
            checkedAt,
            today: now.date,
            nowTime: formatMinute(now.minuteOfDay),
            sentCount: sentIds.length,
            sentIds,
            studentSentCount: studentSentIds.length,
            studentSentIds,
            appointments,
        };
    } finally {
        reminderCheckStartedAt = 0;
    }
}

// Called every minute by an external scheduler (e.g. cron-job.org).
// If CRON_SECRET is set, callers must send "Authorization: Bearer <CRON_SECRET>" (or ?secret=...)
// or a valid admin dashboard password header ("x-admin-password").
async function handleReminderCron(req, res) {
    const secret = process.env.CRON_SECRET;
    if (secret) {
        const auth = String(req.headers.authorization || '');
        const given = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.query.secret || '');
        const a = Buffer.from(given);
        const b = Buffer.from(secret);
        const matchesCronSecret = a.length === b.length && crypto.timingSafeEqual(a, b);

        const adminPw = process.env.ADMIN_PASSWORD;
        const givenAdminPw = String(req.get('x-admin-password') || '');
        const matchesAdminPw = Boolean(
            adminPw && givenAdminPw
            && crypto.timingSafeEqual(
                crypto.createHash('sha256').update(givenAdminPw).digest(),
                crypto.createHash('sha256').update(adminPw).digest()
            )
        );

        if (!matchesCronSecret && !matchesAdminPw) {
            return res.status(401).json({ ok: false, error: 'Unauthorized' });
        }
    }
    res.set('Cache-Control', 'no-store');
    try {
        const result = await checkAndSendAppointmentReminders(resolveSiteOrigin(req));
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error('Reminder cron failed:', err);
        res.status(500).json({ ok: false, error: err.message || String(err), code: err.code || null });
    }
}

app.get('/api/cron/reminders', handleReminderCron);
app.post('/api/cron/reminders', handleReminderCron);

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    if (!err.status || err.status >= 500) {
        console.error(err);
    }
    // Missing table / column -> the SQL in supabase/schema.sql hasn't been run yet
    if (['42P01', 'PGRST205', '42703', 'PGRST204'].includes(err.code)) {
        return res.status(500).json({
            error: 'Database schema needs updating: please run supabase/schema.sql in your Supabase SQL Editor.',
        });
    }
    if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
    res.status(err.status || 500).json({
        error: err.message || 'Something went wrong.',
        ...(err.field ? { field: err.field } : {}),
        ...(err.code ? { code: err.code } : {}),
    });
});

// Background 30-second reminder poller (only for long-lived Node servers, not Vercel)
if (!process.env.VERCEL) {
    const reminderInterval = setInterval(() => {
        checkAndSendAppointmentReminders().catch((err) => {
            console.error('Scheduled reminder check failed:', err.message || err);
        });
    }, 30 * 1000);
    if (reminderInterval.unref) reminderInterval.unref();
}

// Export the Express API for Vercel
module.exports = app;

// Listen locally if not running on Vercel
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
        startServerRealtimeSubscription();
        checkAndSendAppointmentReminders().catch((err) => {
            console.error('Startup reminder check failed:', err.message || err);
        });
    });
}
