const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

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

const SYSTEM_DURATION = 15;   // 15 minutes for System Consultation
const DROPOFF_DURATION = 0;   // Drop-off only (takes 0 minutes off the schedule)
const RETRIEVAL_DURATION = 5; // 5 minutes for Manuscript Retrieval
const LETTER_DURATION = 5;    // 5 minutes for Communication Letter Signature

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
/* Student accounts (university email + OTP verification)              */
/* ------------------------------------------------------------------ */
const STUDENTS_TABLE = 'students';
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
    members: Array.isArray(s.members) && s.members.length ? s.members : [s.full_name],
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
    const subject = isReset
        ? `${code} is your password reset code`
        : `${code} is your verification code`;
    const intro = isReset
        ? `Use the code below to reset your password for booking consultations with ${TEACHER_NAME}.`
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
    const { data: existing, error } = await db()
        .from(OTP_TABLE)
        .select('id, created_at, status')
        .eq('email', email)
        .eq('purpose', purpose)
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
        .eq('purpose', purpose)
        .eq('status', 'pending');

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const now = Date.now();
    const { data: inserted, error: insertErr } = await db()
        .from(OTP_TABLE)
        .insert([{
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
        }])
        .select('id')
        .single();
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
    const { data: row, error } = await db()
        .from(OTP_TABLE)
        .select('*')
        .eq('email', email)
        .eq('purpose', purpose)
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
    return Object.prototype.hasOwnProperty.call(CONSULTATION_TYPES, purpose) ? purpose : 'system';
}

/** Generate all candidate slots for a date and consultation purpose. */
function generateDaySlots(dateStr, purpose = 'system') {
    const dt = parseDate(dateStr);
    if (!dt) return [];
    const windows = WINDOWS_BY_DAY[dt.getUTCDay()] || [];
    const normalized = normalizePurpose(purpose);
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

/** Is this date one the teacher accepts bookings for at all? */
function isBookableDate(dateStr, now = nowInTz()) {
    const dt = parseDate(dateStr);
    if (!dt) return false;
    const windows = WINDOWS_BY_DAY[dt.getUTCDay()];
    if (!windows || !windows.length) return false;
    if (dateStr < getFirstBookableDate(now)) return false;
    if (dateStr > getLastBookableDate(now)) return false;
    return true;
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
        firstBookableDate: getFirstBookableDate(now),
        lastBookableDate: getLastBookableDate(now),
        allowedEmailDomains: AUTH.allowedDomains,
        maxActiveBookings: AUTH.maxActiveBookings,
        minGroupMembers: MIN_MEMBERS,
        maxGroupMembers: MAX_MEMBERS,
        cancelCutoffMinutes: CANCEL_CUTOFF_MINUTES,
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
    const payload = { name, capstoneTitle, instructorRole, members, passwordHash };
    await issueOtp(email, 'register', { payload, name });
    res.json({ ok: true, email, expiresInMinutes: AUTH.otpMinutes, resendSeconds: AUTH.otpResendSeconds });
});

// Step 2 of registration: verify the code, create the account and log in
app.post('/api/auth/register/verify', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const row = await consumeOtp(email, 'register', req.body?.code);
    const { name, capstoneTitle, instructorRole, members, passwordHash } = row.payload || {};
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
    const purpose = req.body?.purpose === 'reset' ? 'reset' : 'register';

    const { data: row, error } = await db()
        .from(OTP_TABLE)
        .select('payload')
        .eq('email', email)
        .eq('purpose', purpose)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) throw error;

    if (purpose === 'register') {
        if (!row?.payload) {
            return res.status(400).json({ error: 'Your registration session expired. Please fill in the form again.' });
        }
        await issueOtp(email, 'register', { payload: row.payload, name: row.payload.name });
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
        if (!isActiveRow(r) || !isTimedRow(r)) continue; // Cancelled & Drop-offs take 0 minutes off schedule
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
            (s) => isFutureSlot(d, s.startMinute, now)
                && (s.isDropoff || !hasOverlap(s.startMinute, s.endMinute, bookedIntervals))
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

    const bookedIntervals = data.filter((r) => isActiveRow(r) && isTimedRow(r)).map(rowInterval);
    const slots = generateDaySlots(date, purpose).map((s) => ({
        startMinute: s.startMinute,
        endMinute: s.endMinute,
        durationMinutes: s.durationMinutes,
        isDropoff: Boolean(s.isDropoff),
        label: s.label,
        endLabel: s.endLabel,
        windowLabel: s.windowLabel,
        available: isFutureSlot(date, s.startMinute, now)
            && (s.isDropoff || !hasOverlap(s.startMinute, s.endMinute, bookedIntervals)),
    }));

    res.json({ date, purpose, slots });
});

const cleanName = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');

function formatDurationLabel(consultationType, durationMinutes) {
    if (consultationType === 'dropoff' || durationMinutes === 0) return 'Drop-off only';
    if (durationMinutes === 80) return '1 hr 20 min';
    return `${durationMinutes} min`;
}

function formatConsultationTitle(consultationType) {
    if (CONSULTATION_TYPES[consultationType]) return CONSULTATION_TYPES[consultationType].title;
    if (consultationType === 'other') return 'Other Consultation';
    return 'Consultation';
}

/** Shape a database row for the frontend. */
function toBooking(r, now) {
    const current = (now && typeof now === 'object' && now.date) ? now : nowInTz();
    const members = Array.isArray(r.members) && r.members.length ? r.members : [r.student_name];
    const timed = isTimedRow(r);
    const [startMinute, endMinute] = rowInterval(r);
    const durationMinutes = timed ? (endMinute - startMinute) : 0;
    const consultationType = r.consultation_type || 'system';
    const timeRange = `${formatMinute(startMinute)} – ${formatMinute(endMinute)}`;
    const status = r.status === 'cancelled' ? 'cancelled' : 'scheduled';
    const minutesUntilStart = minutesUntilBooking(r.appointment_date, startMinute, current);
    const canCancel = status === 'scheduled' && minutesUntilStart >= CANCEL_CUTOFF_MINUTES;
    return {
        id: r.id,
        reference: r.id.slice(0, 8).toUpperCase(),
        type: r.team_name || members.length >= 2 ? 'group' : 'individual',
        consultationType,
        consultationTitle: formatConsultationTitle(consultationType),
        isDropoff: !timed,
        durationMinutes,
        durationLabel: formatDurationLabel(consultationType, durationMinutes),
        name: r.student_name,
        studentEmail: r.student_email || null,
        capstoneTitle: r.capstone_title || r.team_name || null,
        instructorRole: r.instructor_role || null,
        teamName: r.team_name || null,
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
    const durationMinutes = typeInfo.durationMinutes;
    const isDropoff = consultationType === 'dropoff';
    const requiresAllMembers = consultationType === 'system' || consultationType === 'retrieval';
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
            error: 'Consultations must be scheduled at least 1 day before the consultation day.',
        });
    }

    const validSlot = generateDaySlots(date, consultationType).find((s) => s.startMinute === startMinute);
    if (!isBookableDate(date, now) || !validSlot || !isFutureSlot(date, startMinute, now)) {
        return res.status(400).json({ error: 'That time slot is not available. Please choose another one.' });
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

    if (isDropoff) {
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
        const upcomingTimed = upcomingMine.filter(isTimedRow);
        if (upcomingTimed.length >= AUTH.maxActiveBookings) {
            return res.status(409).json({
                code: 'BOOKING_LIMIT',
                error: AUTH.maxActiveBookings === 1
                    ? 'You already have an upcoming timed consultation. You can book again after it is done (or cancel it in your Profile at least 2 hours before the schedule).'
                    : `You already have ${upcomingTimed.length} upcoming timed consultations (the limit is ${AUTH.maxActiveBookings}). You can book again after one of them is done or cancelled.`,
            });
        }
    }

    // For timed consultations, check for any overlapping timed booking on the same date
    if (!isDropoff) {
        const { data: existingRows, error: existingErr } = await db()
            .from(TABLE)
            .select('*')
            .eq('appointment_date', date);
        if (existingErr) return res.status(500).json({ error: existingErr.message });

        const bookedIntervals = existingRows.filter((r) => isActiveRow(r) && isTimedRow(r)).map(rowInterval);
        if (hasOverlap(validSlot.startMinute, validSlot.endMinute, bookedIntervals)) {
            return res.status(409).json({ error: 'Sorry, someone just booked a slot that overlaps with that time. Please pick another time.' });
        }
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
            student_id: student.id,
            student_email: student.email,
            capstone_title: student.capstone_title || teamName || null,
            instructor_role: student.instructor_role || null,
        }])
        .select('*')
        .single();

    if (error) {
        if (error.code === '23505') {
            return res.status(409).json({ error: 'Sorry, someone just booked that slot. Please pick another time.' });
        }
        if (error.code === '23514' || error.code === '42703' || error.code === 'PGRST204') {
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
    const bookings = data.map((r) => toBooking(r, now)).sort(
        (a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute
    );
    res.json({
        today: now.date,
        currentHour: now.hour,
        currentMinute: now.minuteOfDay,
        bookings,
    });
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
    const greeting = `Hi ${row.student_name},`;
    const siteOrigin = `${req.protocol}://${req.get('host')}`;
    const subject = `Manuscript Checked — Schedule Your Retrieval (${TEACHER_NAME})`;
    const bodyText = [
        greeting,
        '',
        `Good day! Your manuscript (${title}) has been checked by ${TEACHER_NAME}.`,
        '',
        'Please return to the consultation scheduling website to schedule a "Retrieval of Manuscript" (5 minutes) slot so your instructor can discuss the needed changes with your group:',
        siteOrigin,
        '',
        'Important reminders:',
        '• Consultations must be booked at least 1 day before the consultation day.',
        '• All members must be present during Manuscript Retrieval, otherwise you will not be accommodated.',
    ].join('\n');

    const bodyHtml = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:auto;color:#0f172a;line-height:1.55">
            <p>${escapeHtml(greeting)}</p>
            <p>Good day! Your manuscript (<strong>${escapeHtml(title)}</strong>) has been checked by <strong>${escapeHtml(TEACHER_NAME)}</strong>.</p>
            <p>Please return to the consultation scheduling website and book a <strong>Retrieval of Manuscript (5 minutes)</strong> slot so your instructor can discuss the needed revisions with your group:</p>
            <p style="margin:20px 0">
                <a href="${escapeHtml(siteOrigin)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px">
                    Schedule Manuscript Retrieval
                </a>
            </p>
            <div style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;padding:12px 14px;border-radius:8px;font-size:13px">
                <strong>Important reminders:</strong>
                <ul style="margin:6px 0 0;padding-left:18px">
                    <li>Bookings must be made at least <strong>1 day before</strong> the consultation day.</li>
                    <li><strong>All members must be present</strong> during Manuscript Retrieval, otherwise you will not be accommodated.</li>
                </ul>
            </div>
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

// Export the Express API for Vercel
module.exports = app;

// Listen locally if not running on Vercel
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}
