const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json({ limit: '20kb' }));

// Serve the frontend (on Vercel, files in /public are served by the CDN automatically)
app.use(express.static(path.join(__dirname, 'public')));

// Opportunistic background reminder check on API traffic (throttled to once every 30s)
let lastApiReminderSweepAt = 0;
app.use('/api', (req, res, next) => {
    if (req.path !== '/cron/reminders') {
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

const hm = (h, m) => h * 60 + m;

const SYSTEM_DURATION = 15;   // 15 minutes for System Consultation
const DROPOFF_DURATION = 0;   // Drop-off only (takes 0 minutes off the schedule)
const RETRIEVAL_DURATION = 5; // 5 minutes for Manuscript Retrieval
const LETTER_DURATION = 5;    // 5 minutes for Communication Letter Signature
const OTHER_DURATION = 10;    // 10 minutes for Other Consultations

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
        note: 'All members must be present, otherwise you will not be accommodated.',
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

const CONFIG = {
    location: process.env.MEETING_LOCATION || 'Faculty Office',
    timezone: process.env.TIMEZONE || 'Asia/Manila',
    workingDays: [2, 3, 4],
    bookingEndDate: process.env.BOOKING_END_DATE || null, // defaults to Nov 30 of current year
};

const TABLE = 'appointments';
const BLOCKED_TABLE = 'blocked_schedules';

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
/* Student accounts (university email + OTP verification)              */
/* ------------------------------------------------------------------ */
const STUDENTS_TABLE = 'students';
const STUDENT_LOGS_TABLE = 'student_update_logs';
const OTP_TABLE = 'email_otps';
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

const publicStudent = (s) => ({
    id: s.id,
    name: s.full_name,
    email: s.email,
    capstoneTitle: s.capstone_title || null,
    instructorRole: s.instructor_role || null,
    projectLevel: normalizeDefenseLevel(s.project_level),
    members: Array.isArray(s.members) && s.members.length ? s.members : [s.full_name],
    updatedAt: s.updated_at || null,
    changeHistory: Array.isArray(s.change_history) ? s.change_history : [],
});

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

async function sendOtpEmail(to, code, purpose, name) {
    const isReset = purpose === 'reset';
    const isEmailChange = purpose === 'email_change';
    const subject = isReset
        ? `${code} is your password reset code`
        : isEmailChange
            ? `${code} is your email verification code`
            : `${code} is your verification code`;
    const intro = isReset
        ? `Use the code below to reset your password for booking consultations with ${TEACHER_NAME}.`
        : isEmailChange
            ? `Use the code below to verify your new university email address for booking consultations with ${TEACHER_NAME}.`
            : `Use the code below to verify your university email and finish creating your account for booking consultations with ${TEACHER_NAME}.`;
    const greeting = name ? `Hi ${name},` : 'Hi,';
    const footer = `This code expires in ${AUTH.otpMinutes} minutes. If you didn't request it, you can ignore this email.`;

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
    const rowData = {
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

    let { data: inserted, error: insertErr } = await db()
        .from(OTP_TABLE)
        .insert([rowData])
        .select('id')
        .single();
    if (insertErr && insertErr.code === '23514' && purpose === 'email_change') {
        const fallbackRes = await db()
            .from(OTP_TABLE)
            .insert([{ ...rowData, purpose: 'register' }])
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
    const novEnd = `${now.date.slice(0, 4)}-11-30`;
    if (CONFIG.bookingEndDate && CONFIG.bookingEndDate < novEnd) {
        return CONFIG.bookingEndDate;
    }
    return novEnd;
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
function generateDaySlots(dateStr, purpose = 'system') {
    const dt = parseDate(dateStr);
    if (!dt) return [];
    const normalized = normalizePurpose(purpose);
    if (normalized === 'defense') return []; // defenses use typed start times (see defenseDayAvailability)
    const windows = WINDOWS_BY_DAY[dt.getUTCDay()] || [];
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
        const dt = parseDate(r.appointment_date);
        const windows = (dt && WINDOWS_BY_DAY[dt.getUTCDay()]) || [];
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

/** Time windows open on a given date for this purpose (defenses use their own weekly schedule). */
function windowsForDate(dateStr, purpose = 'system') {
    const dt = parseDate(dateStr);
    if (!dt) return [];
    const table = purpose === 'defense' ? DEFENSE_WINDOWS_BY_DAY : WINDOWS_BY_DAY;
    return table[dt.getUTCDay()] || [];
}

/** Is this date one the teacher accepts bookings for at all? */
function isBookableDate(dateStr, now = nowInTz(), purpose = 'system') {
    const dt = parseDate(dateStr);
    if (!dt) return false;
    if (dt.getUTCMonth() !== 10) return false; // Only November (month index 10) is available for now
    if (!windowsForDate(dateStr, purpose).length) return false;
    if (dateStr < getFirstBookableDate(now)) return false;
    if (dateStr > getLastBookableDate(now)) return false;
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
    return data || [];
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
    return data || [];
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */
app.get('/api/config', (req, res) => {
    const now = nowInTz();
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
        allowedEmailDomains: AUTH.allowedDomains,
        maxActiveBookings: AUTH.maxActiveBookings,
        minGroupMembers: MIN_MEMBERS,
        maxGroupMembers: MAX_MEMBERS,
        cancelCutoffMinutes: CANCEL_CUTOFF_MINUTES,
        defenseLevels: DEFENSE_LEVELS,
        defenseStartStep: DEFENSE_START_STEP,
        consultationWindowsByDay: Object.fromEntries(
            Object.entries(WINDOWS_BY_DAY).map(([day, wins]) => [
                day,
                wins.map(([s, e]) => ({ startMinute: s, endMinute: e, label: `${formatMinute(s)} – ${formatMinute(e)}` })),
            ])
        ),
        defenseWindowsByDay: Object.fromEntries(
            Object.entries(DEFENSE_WINDOWS_BY_DAY).map(([day, wins]) => [
                day,
                wins.map(([s, e]) => ({ startMinute: s, endMinute: e, label: `${formatMinute(s)} – ${formatMinute(e)}` })),
            ])
        ),
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

    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ field: 'regPassword', error: pwError });

    if (await findStudentByEmail(email)) {
        return res.status(409).json({ field: 'regEmail', error: 'This email is already registered. Please log in instead.' });
    }

    // The account is only created after the code is verified, so keep the details with the code.
    const passwordHash = await hashPassword(password);
    const payload = { name, capstoneTitle, instructorRole, projectLevel, members, passwordHash };
    await issueOtp(email, 'register', { payload, name });
    res.json({ ok: true, email, expiresInMinutes: AUTH.otpMinutes, resendSeconds: AUTH.otpResendSeconds });
});

// Step 2 of registration: verify the code, create the account and log in
app.post('/api/auth/register/verify', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const row = await consumeOtp(email, 'register', req.body?.code);
    const { name, capstoneTitle, instructorRole, projectLevel, members, passwordHash } = row.payload || {};
    if (!name || !passwordHash) {
        return res.status(400).json({ error: 'Registration details were lost. Please register again.' });
    }

    const { data: student, error } = await db()
        .from(STUDENTS_TABLE)
        .insert([{
            email,
            full_name: name,
            capstone_title: capstoneTitle || null,
            instructor_role: instructorRole || null,
            project_level: normalizeDefenseLevel(projectLevel),
            members: Array.isArray(members) && members.length ? members : [name],
            password_hash: passwordHash,
            last_login_at: new Date().toISOString(),
        }])
        .select('*')
        .single();
    if (error) {
        if (error.code === '23505') {
            return res.status(409).json({ error: 'This email is already registered. Please log in instead.' });
        }
        throw error;
    }

    setSession(res, student);
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

    return {
        values: { name, email, capstoneTitle, instructorRole, projectLevel, members },
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

async function applyStudentProfileUpdate(
    currentStudentRow,
    { name, email, capstoneTitle, instructorRole, projectLevel, members },
    { verifiedViaOtp = false } = {}
) {
    const studentId = currentStudentRow.id;
    const normalizedMembers = Array.isArray(members) && members.length ? members : [name];
    const normalizedLevel = normalizeDefenseLevel(projectLevel);
    const diff = computeStudentProfileDiff(currentStudentRow, {
        name,
        email,
        capstoneTitle,
        instructorRole,
        projectLevel: normalizedLevel,
        members: normalizedMembers,
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

    const prevHistory = Array.isArray(currentStudentRow.change_history) ? currentStudentRow.change_history : [];
    const nextHistory = logEntry ? [logEntry, ...prevHistory].slice(0, 50) : prevHistory;

    let { data: updated, error } = await db()
        .from(STUDENTS_TABLE)
        .update(
            diff.hasChanges
                ? { ...coreUpdate, updated_at: nowIso, change_history: nextHistory }
                : coreUpdate
        )
        .eq('id', studentId)
        .select('*')
        .single();

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

    // Keep the student's appointments in sync with their updated email and group details
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
        .eq('student_id', studentId);

    return updated;
}

async function handleStudentProfileUpdate(req, res) {
    const student = req.student;
    const validation = validateStudentProfileFields(req.body);
    if (validation.error) {
        return res.status(400).json({ field: validation.field, error: validation.error });
    }

    const { name, email, capstoneTitle, instructorRole, projectLevel, members } = validation.values;
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
        },
        { verifiedViaOtp: false }
    );
    setSession(res, updated);
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
        },
        { verifiedViaOtp: true }
    );

    setSession(res, updated);
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

    const first = `${month}-01`;
    const firstDt = parseDate(first);
    const last = toDateStr(new Date(Date.UTC(firstDt.getUTCFullYear(), firstDt.getUTCMonth() + 1, 0)));

    const [{ data, error }, blockedRows] = await Promise.all([
        db()
            .from(TABLE)
            .select('*')
            .gte('appointment_date', first)
            .lte('appointment_date', last),
        fetchBlockedByDateRange(first, last),
    ]);
    if (error) return res.status(500).json({ error: error.message });

    const intervalsByDate = new Map();
    for (const r of data) {
        if (!isActiveRow(r) || !isTimedRow(r)) continue; // Cancelled & Drop-offs take 0 minutes off schedule
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
        if (!isBookableDate(d, now, purpose)) {
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
            const open = hasFullDayBlock ? 0 : countOpenDefenseRanges(d, defenseDuration, allBusyIntervals);
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
        const daySlots = generateDaySlots(d, purpose);
        const open = hasFullDayBlock
            ? 0
            : daySlots.filter(
                (s) => isFutureSlot(d, s.startMinute, now)
                    && (s.isDropoff
                        ? !isWindowFullyBlocked(s.startMinute, s.endMinute, blockedIntervals)
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

    const isDefense = purpose === 'defense';
    const level = isDefense ? (normalizeDefenseLevel(req.query.level) || 'capstone1') : null;
    const now = nowInTz();
    if (!isBookableDate(date, now, purpose)) {
        return res.json({ date, purpose, level, slots: [], windows: [] });
    }

    const [{ data, error }, dayBlocks] = await Promise.all([
        db().from(TABLE).select('*').eq('appointment_date', date),
        fetchBlockedByDate(date),
    ]);
    if (error) return res.status(500).json({ error: error.message });

    const bookedIntervals = data.filter((r) => isActiveRow(r) && isTimedRow(r)).map(rowInterval);
    const blockedIntervals = dayBlocks.map(blockInterval);
    const allBusyIntervals = [...bookedIntervals, ...blockedIntervals];
    const fullDayBlock = dayBlocks.find((b) => b.is_full_day) || null;
    const blockReason = fullDayBlock?.reason || dayBlocks.find((b) => b.reason)?.reason || null;

    if (isDefense) {
        const durationMinutes = DEFENSE_LEVELS[level].durationMinutes;
        const windows = defenseDayAvailability(date, durationMinutes, allBusyIntervals);
        const openRanges = windows.reduce((n, w) => n + w.free.filter((f) => f.fits).length, 0);
        const isDayBlocked = Boolean(fullDayBlock) || (openRanges === 0 && dayBlocks.length > 0);
        return res.json({
            date,
            purpose,
            level,
            durationMinutes,
            startStep: DEFENSE_START_STEP,
            blocked: isDayBlocked,
            blockReason,
            blocks: dayBlocks.map(toBlockedSchedule),
            windows,
            slots: [],
        });
    }

    const slots = generateDaySlots(date, purpose).map((s) => {
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
            label: s.label,
            endLabel: s.endLabel,
            windowLabel: s.windowLabel,
            blocked: blockedByAdmin,
            blockReason: matchedBlock?.reason || blockReason || null,
            available: isFutureSlot(date, s.startMinute, now)
                && !blockedByAdmin
                && (s.isDropoff || !hasOverlap(s.startMinute, s.endMinute, bookedIntervals)),
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

/** Shape a database row for the frontend. */
function toBooking(r, now, studentLookup = null) {
    const current = (now && typeof now === 'object' && now.date) ? now : nowInTz();
    const matchedStudent = studentLookup
        ? (studentLookup.byId.get(r.student_id) || studentLookup.byEmail.get(String(r.student_email || '').toLowerCase()) || null)
        : null;
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
    const status = r.status === 'cancelled' ? 'cancelled' : 'scheduled';
    const minutesUntilStart = minutesUntilBooking(r.appointment_date, startMinute, current);
    const canCancel = status === 'scheduled' && minutesUntilStart >= CANCEL_CUTOFF_MINUTES;
    const projectLevel = normalizeDefenseLevel(r.defense_level)
        || normalizeDefenseLevel(matchedStudent?.project_level)
        || null;
    const defenseLevel = consultationType === 'defense' ? projectLevel : null;
    return {
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
        studentEmail: r.student_email || matchedStudent?.email || null,
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
        cancellationReason: r.cancellation_reason || null,
        cancelledAt: r.cancelled_at || null,
        notifiedAt: r.notified_at || null,
        reminderSentAt: r.reminder_sent_at || (r.consultation_type !== 'dropoff' ? r.notified_at : null) || null,
        createdAt: r.created_at,
    };
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

    res.json({
        today: now.date,
        currentMinute: now.minuteOfDay,
        bookings: data.map((r) => toBooking(r, now)),
    });
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

    res.json({ ok: true, booking: toBooking(data, now) });
});

app.post('/api/bookings', requireStudent, async (req, res) => {
    const body = req.body || {};
    const student = req.student;
    const consultationType = normalizePurpose(body.consultationType);
    const typeInfo = CONSULTATION_TYPES[consultationType];
    const isDefense = consultationType === 'defense';
    const defenseLevel = isDefense
        ? (normalizeDefenseLevel(student.project_level) || normalizeDefenseLevel(body.defenseLevel) || 'capstone1')
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

    let rawReason = String(body.reason ?? '').trim();
    if (!rawReason && consultationType === 'dropoff') {
        rawReason = 'Manuscript drop-off for checking.';
    } else if (!rawReason && consultationType === 'retrieval') {
        rawReason = 'Retrieval of checked manuscript to discuss needed revisions.';
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

    let members;
    if (type === 'group') {
        const submittedMembers = (Array.isArray(body.members) ? body.members : []).map(cleanName).filter(Boolean);
        const fallbackMembers = Array.isArray(student.members) && student.members.length ? student.members : [student.full_name];
        members = submittedMembers.length ? submittedMembers : [...fallbackMembers];
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
        const validSlot = generateDaySlots(date, consultationType).find((s) => s.startMinute === startMinute);
        if (!isBookableDate(date, now) || !validSlot || !isFutureSlot(date, startMinute, now)) {
            return res.status(400).json({ error: 'That time slot is not available. Please choose another one.' });
        }
        slotStart = validSlot.startMinute;
        slotEnd = validSlot.endMinute;
    }

    // Check existing upcoming bookings for this student
    const { data: mine, error: mineErr } = await db()
        .from(TABLE)
        .select('*')
        .eq('student_id', student.id)
        .gte('appointment_date', now.date);
    if (mineErr) return res.status(500).json({ error: mineErr.message });

    const upcomingMine = mine.filter((r) => {
        if (!isActiveRow(r)) return false;
        const [, end] = rowInterval(r);
        return r.appointment_date > now.date || end > now.minuteOfDay;
    });

    if (isDefense) {
        // Defenses have their own limit and do not use up the group's consultation slots.
        const upcomingDefenses = upcomingMine.filter((r) => r.consultation_type === 'defense');
        if (upcomingDefenses.length >= MAX_UPCOMING_DEFENSES) {
            return res.status(409).json({
                code: 'BOOKING_LIMIT',
                error: 'Your group already has an upcoming defense scheduled. You can cancel it in My Appointments (at least 2 hours before the schedule) if you need to move it.',
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
    } else if (AUTH.maxActiveBookings > 0) {
        const upcomingTimed = upcomingMine.filter((r) => isTimedRow(r) && r.consultation_type !== 'defense');
        if (upcomingTimed.length >= AUTH.maxActiveBookings) {
            return res.status(409).json({
                code: 'BOOKING_LIMIT',
                error: AUTH.maxActiveBookings === 1
                    ? 'You already have an upcoming timed consultation. You can book again after it is done (or cancel it in My Appointments at least 2 hours before the schedule).'
                    : `You already have ${upcomingTimed.length} upcoming timed consultations (the limit is ${AUTH.maxActiveBookings}). You can book again after one of them is done or cancelled.`,
            });
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

    res.status(201).json({ booking: toBooking(data), student: updatedStudent });
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

app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
    const [{ data, error }, blockedRows, studentsRes, rawUpdateLogs] = await Promise.all([
        db()
            .from(TABLE)
            .select('*')
            .order('appointment_date', { ascending: true })
            .order('start_hour', { ascending: true }),
        fetchBlockedByDateRange('1970-01-01', '9999-12-31'),
        db()
            .from(STUDENTS_TABLE)
            .select('*')
            .order('created_at', { ascending: false }),
        fetchStudentUpdateLogs(),
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
            if (!h || (h.id && seenLogIds.has(h.id))) continue;
            if (h.id) seenLogIds.add(h.id);
            serializedLogs.push(h);
            if (!logsByStudentId.has(s.id)) logsByStudentId.set(s.id, []);
            logsByStudentId.get(s.id).push(h);
        }
    }
    serializedLogs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

    const now = nowInTz();
    const bookings = data.map((r) => toBooking(r, now, studentLookup)).sort(
        (a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute
    );
    const blockedSchedules = blockedRows.map(toBlockedSchedule).sort(
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
            lastLoginAt: s.last_login_at || null,
            updatedAt: s.updated_at || history[0]?.createdAt || null,
            createdAt: s.created_at || null,
            changeHistory: history,
        };
    });
    res.json({
        today: now.date,
        currentHour: now.hour,
        currentMinute: now.minuteOfDay,
        bookings,
        blockedSchedules,
        students,
        studentUpdateLogs: serializedLogs,
    });
});

// List all blocked dates / time ranges
app.get('/api/admin/blocks', requireAdmin, async (req, res) => {
    const blockedRows = await fetchBlockedByDateRange('1970-01-01', '9999-12-31');
    const blockedSchedules = blockedRows.map(toBlockedSchedule).sort(
        (a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute
    );
    res.json({ blockedSchedules });
});

// Block a date (or date range) or a specific time range on a date
app.post('/api/admin/blocks', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const date = String(body.date || '').trim();
    const endDate = body.endDate ? String(body.endDate).trim() : date;
    const isFullDay = body.isFullDay !== false;
    const startMinute = isFullDay ? null : Number(body.startMinute);
    const endMinute = isFullDay ? null : Number(body.endMinute);
    const rawReason = String(body.reason ?? '').trim();
    const reason = rawReason ? rawReason.slice(0, 500) : null;
    const cancelExisting = Boolean(body.cancelExisting);

    if (!parseDate(date)) {
        return res.status(400).json({ field: 'blockDate', error: 'Please select a valid date.' });
    }
    if (!parseDate(endDate) || endDate < date) {
        return res.status(400).json({ field: 'blockEndDate', error: 'End date must be on or after the start date.' });
    }
    const diffDays = Math.round((parseDate(endDate).getTime() - parseDate(date).getTime()) / 86400000);
    if (diffDays > 60) {
        return res.status(400).json({ field: 'blockEndDate', error: 'You can block at most 60 days at a time.' });
    }
    if (!isFullDay) {
        if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute)
            || startMinute < 0 || endMinute > 1440 || startMinute >= endMinute) {
            return res.status(400).json({
                field: 'blockTime',
                error: 'Please enter a valid start and end time (end time must be after start time).',
            });
        }
    }

    const rowsToInsert = [];
    for (let d = date; d <= endDate; d = addDays(d, 1)) {
        rowsToInsert.push({
            blocked_date: d,
            is_full_day: isFullDay,
            start_minute: isFullDay ? null : startMinute,
            end_minute: isFullDay ? null : endMinute,
            reason,
        });
    }

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
        const { data: activeRows, error: activeErr } = await db()
            .from(TABLE)
            .select('*')
            .gte('appointment_date', date)
            .lte('appointment_date', endDate)
            .neq('status', 'cancelled');
        if (!activeErr && Array.isArray(activeRows) && activeRows.length) {
            const bStart = isFullDay ? 0 : startMinute;
            const bEnd = isFullDay ? 1440 : endMinute;
            const toCancelIds = activeRows
                .filter((r) => {
                    if (!isActiveRow(r)) return false;
                    if (isFullDay) return true;
                    const [rs, re] = rowInterval(r);
                    return rs < bEnd && re > bStart;
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
                if (Array.isArray(updatedRows)) {
                    cancelledBookings = updatedRows.map((r) => toBooking(r, now));
                }
            }
        }
    }

    res.status(201).json({
        ok: true,
        blocks: (inserted || []).map(toBlockedSchedule),
        cancelledBookings,
    });
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
    res.json({ ok: true });
});

// Send email notification to student that their dropped-off manuscript has been checked
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

    const title = row.capstone_title || row.team_name || 'your Capstone / Thesis manuscript';
    const greeting = `Dear ${row.student_name},`;
    const siteOrigin = `${req.protocol}://${req.get('host')}`;
    const subject = `Manuscript Ready for Pickup — Please Schedule Your Retrieval`;
    const bodyText = [
        greeting,
        '',
        `Good day. This is to inform you that your manuscript (${title}) has been reviewed and is now ready for pickup.`,
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

    const bodyHtml = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:auto;color:#0f172a;line-height:1.6">
            <p>${escapeHtml(greeting)}</p>
            <p>Good day. This is to inform you that your manuscript (<strong>${escapeHtml(title)}</strong>) has been reviewed and is now <strong>ready for pickup</strong>.</p>
            <p>Kindly visit the consultation scheduling portal to book a <strong>Retrieval of Manuscript (5-minute)</strong> appointment so the necessary revisions and feedback can be discussed with your group:</p>
            <p style="margin:22px 0">
                <a href="${escapeHtml(siteOrigin)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px">
                    Schedule Manuscript Retrieval
                </a>
            </p>
            <div style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;padding:12px 14px;border-radius:8px;font-size:13px">
                <strong>Important Reminders:</strong>
                <ul style="margin:6px 0 0;padding-left:18px">
                    <li>Appointments must be scheduled at least <strong>one (1) day prior</strong> to your preferred consultation date.</li>
                    <li><strong>At least two (2) or all group members are required to be present</strong> during the manuscript retrieval; otherwise, your group will not be accommodated.</li>
                </ul>
            </div>
            <p style="margin-top:18px;color:#475569;font-size:14px">Thank you.</p>
        </div>`;

    await mailer().sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: row.student_email,
        subject,
        text: bodyText,
        html: bodyHtml,
    });

    const notifiedAt = new Date().toISOString();
    await db().from(TABLE).update({ notified_at: notifiedAt }).eq('id', row.id);
    res.json({ ok: true, notifiedAt });
});

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

    res.json({ ok: true, booking: toBooking(data) });
});

app.delete('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });
    const { error } = await db().from(TABLE).delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
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

async function sendTeacherReminderEmail(booking, minsUntil) {
    if (!TEACHER_EMAIL) {
        throw httpError(500, 'Server is missing TEACHER_EMAIL.');
    }
    const timeText = minsUntil <= 0
        ? 'less than a minute'
        : `${minsUntil} minute${minsUntil === 1 ? '' : 's'}`;
    const projectOrStudent = booking.capstoneTitle || booking.teamName || booking.name || 'Student Group';
    const dateLabel = formatLongDateStr(booking.date);
    const courseLabel = booking.projectLevelLabel || booking.defenseLevelLabel || '—';
    const roleLabel = formatRoleLabel(booking.instructorRole);
    const membersList = Array.isArray(booking.members) && booking.members.length
        ? booking.members.join(', ')
        : (booking.name || '—');

    const subject = `Reminder: ${booking.consultationTitle} in ${timeText} (${booking.label}) — ${projectOrStudent}`;

    const textLines = [
        `Hi ${TEACHER_NAME},`,
        '',
        `This is a reminder that you have an upcoming appointment in ${timeText}:`,
        '',
        `Type: ${booking.consultationTitle} (${booking.durationLabel})`,
        `Date: ${dateLabel}`,
        `Time: ${booking.label}`,
        `Location: ${CONFIG.location}`,
        `Capstone / Thesis Title: ${projectOrStudent}`,
        `Course: ${courseLabel}`,
        `Your Role: ${roleLabel}`,
        `Group Members: ${membersList}`,
        `Student Email: ${booking.studentEmail || '—'}`,
        `Details: ${booking.reason || '—'}`,
        `Reference: #${booking.reference}`,
    ];

    const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#0f172a;line-height:1.55">
            <p>Hi ${escapeHtml(TEACHER_NAME)},</p>
            <p>This is a reminder that you have an upcoming appointment in <strong>${escapeHtml(timeText)}</strong>.</p>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px 18px;margin:16px 0">
                <div style="font-size:17px;font-weight:700;color:#0f766e;margin-bottom:4px">
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
                    </tr>
                    <tr>
                        <td style="padding:4px 10px 4px 0;color:#64748b;vertical-align:top">Student Email</td>
                        <td style="padding:4px 0;color:#0f172a">${escapeHtml(booking.studentEmail || '—')}</td>
                    </tr>
                    <tr>
                        <td style="padding:4px 10px 4px 0;color:#64748b;vertical-align:top">Details</td>
                        <td style="padding:4px 0;color:#0f172a">${escapeHtml(booking.reason || '—')}</td>
                    </tr>
                    <tr>
                        <td style="padding:4px 10px 4px 0;color:#64748b;vertical-align:top">Reference</td>
                        <td style="padding:4px 0;color:#0f172a"><code>#${escapeHtml(booking.reference)}</code></td>
                    </tr>
                </table>
            </div>
        </div>`;

    await mailer().sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: TEACHER_EMAIL,
        subject,
        text: textLines.join('\n'),
        html,
    });
}

const remindedAppointmentIds = new Set();
let reminderCheckInFlight = false;

async function checkAndSendAppointmentReminders() {
    const checkedAt = new Date().toISOString();
    if (reminderCheckInFlight) {
        return { checkedAt, sentCount: 0, sentIds: [] };
    }
    reminderCheckInFlight = true;
    const sentIds = [];

    try {
        const now = nowInTz();
        const { data, error } = await db()
            .from(TABLE)
            .select('*')
            .eq('appointment_date', now.date)
            .neq('status', 'cancelled');
        if (error) throw error;

        for (const r of data || []) {
            if (!isActiveRow(r)) continue;
            if (r.reminder_sent_at || remindedAppointmentIds.has(r.id)) continue;
            if (r.consultation_type !== 'dropoff' && r.notified_at) continue;

            const [startMinute] = rowInterval(r);
            const minsUntil = minutesUntilBooking(r.appointment_date, startMinute, now);
            if (minsUntil < 0 || minsUntil > REMINDER_MINUTES_BEFORE) continue;

            remindedAppointmentIds.add(r.id);
            try {
                const booking = toBooking(r, now);
                await sendTeacherReminderEmail(booking, minsUntil);

                const sentAt = new Date().toISOString();
                const { error: updateErr } = await db()
                    .from(TABLE)
                    .update({ reminder_sent_at: sentAt })
                    .eq('id', r.id);

                if (updateErr && ['42703', 'PGRST204'].includes(updateErr.code) && r.consultation_type !== 'dropoff') {
                    await db().from(TABLE).update({ notified_at: sentAt }).eq('id', r.id);
                } else if (updateErr) {
                    console.error(`Could not record reminder_sent_at for appointment ${r.id}:`, updateErr);
                }
                sentIds.push(r.id);
            } catch (err) {
                remindedAppointmentIds.delete(r.id);
                console.error(`Failed to send 10-minute reminder for appointment ${r.id}:`, err);
            }
        }

        return { checkedAt, sentCount: sentIds.length, sentIds };
    } finally {
        reminderCheckInFlight = false;
    }
}

async function handleReminderCron(req, res) {
    const result = await checkAndSendAppointmentReminders();
    res.json({ ok: true, ...result });
}

app.get('/api/cron/reminders', handleReminderCron);
app.post('/api/cron/reminders', handleReminderCron);

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error(err);
    // Missing table / column -> the SQL in supabase/schema.sql hasn't been run yet
    if (['42P01', 'PGRST205', '42703', 'PGRST204'].includes(err.code)) {
        return res.status(500).json({
            error: 'Database schema needs updating: please run supabase/schema.sql in your Supabase SQL Editor.',
        });
    }
    if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
    res.status(err.status || 500).json({ error: err.message || 'Something went wrong.' });
});

// Background 30-second reminder poller (runs continuously in long-lived Node servers)
const reminderInterval = setInterval(() => {
    checkAndSendAppointmentReminders().catch((err) => {
        console.error('Scheduled reminder check failed:', err.message || err);
    });
}, 30 * 1000);
if (reminderInterval.unref) reminderInterval.unref();

// Export the Express API for Vercel
module.exports = app;

// Listen locally if not running on Vercel
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
        checkAndSendAppointmentReminders().catch((err) => {
            console.error('Startup reminder check failed:', err.message || err);
        });
    });
}
