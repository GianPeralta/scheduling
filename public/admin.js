(() => {
    'use strict';

    const $ = (sel) => document.querySelector(sel);
    const STORAGE_KEY = 'arnemie_admin_pw';

    const TYPE_BADGES = {
        system: { label: 'System · 15m', cls: 'teal' },
        dropoff: { label: 'Drop-off only', cls: 'amber' },
        retrieval: { label: 'Retrieval · 5m', cls: 'sky' },
        letter: { label: 'Comm. Letter · 5m', cls: 'violet' },
        letter_pickup: { label: 'Letter Pickup · 5m', cls: 'violet' },
        other: { label: 'Other · 10m', cls: 'sky' },
    };

    const state = {
        password: sessionStorage.getItem(STORAGE_KEY) || '',
        bookings: [],
        blockedSchedules: [],
        letterPickupSchedules: [],
        students: [],
        studentUpdateLogs: [],
        config: null,
        today: '',
        currentHour: 0,
        currentMinute: 0,
        adminView: 'consultations', // 'consultations' | 'schedule' | 'students' | 'emails'
        tab: 'upcoming', // 'upcoming' | 'past' | 'cancelled'
        search: '',
        studentRoleFilter: 'all',
        studentSearch: '',
        loggingIn: false,
        loadReqId: 0,
        cancelTarget: null,
        cancelling: false,
        notesTarget: null,
        notesSaving: false,
        notesDraftChecklist: [],
        notesDraftAttended: new Set(),
        scheduleConfig: null,
        schedInitialized: false,
        schedViewYear: 0,
        schedViewMonth: 0, // 0-11
        schedSelectMode: 'single', // 'single' | 'multi' | 'range'
        schedRangeAnchor: null,
        schedLastClickedDate: null,
        schedSelectedDates: new Set(),
        schedActionMode: 'open', // 'open' | 'block'
        schedCategory: 'consultation', // 'consultation' | 'defense' | 'letter_pickup'
        schedHourMode: 'full_day', // 'full_day' | 'regular' | 'custom'
        schedCustomWindows: [{ start: '10:00', end: '17:00' }],
        schedBlockScope: 'full', // 'full' | 'time'
        schedRegType: 'consultation', // 'consultation' | 'defense'
        schedOverviewFilter: 'all', // 'all' | 'consultation' | 'defense' | 'letter_pickup' | 'blocked'
        schedBusy: false,
        bookingEndDate: '',
        sendingEmail: false,
        emailTemplate: 'manuscript_ready',
        emailLogs: [],
        emailSenderFilter: 'all', // 'all' | 'instructor' | 'system'
        emailCategoryFilter: 'all', // 'all' | 'reminder' | 'others' | 'pickup_notice' | 'booking_updates' | 'custom' | 'otp'
        emailSearch: '',
        emailVisibleLimit: 20,
        expandedEmailLogIds: new Set(),
        defModalOpen: false,
        defSaving: false,
        defExplicitRescheduleTarget: null,
        defAutoDetectedUpcomingDefense: null,
        defDraftMembers: [''],
        defCalYear: 0,
        defCalMonth: 0,
        schedSlotPreviewType: 'defense_1h',
    };

    const WEEKDAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const CATEGORY_META = {
        consultation: { label: 'Consultations', shortTag: 'Consult', badgeCls: 'teal' },
        defense: { label: 'Capstone / Thesis Defense', shortTag: 'Defense', badgeCls: 'rose' },
        letter_pickup: { label: 'Comm. Letter Pickup', shortTag: 'Pickup', badgeCls: 'violet' },
    };

    /* ---------------- helpers ---------------- */
    const pad2 = (n) => String(n).padStart(2, '0');
    const minuteToTimeVal = (min) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
    function timeValToMinute(val) {
        if (!val || typeof val !== 'string' || !/^\d{1,2}:\d{2}$/.test(val.trim())) return null;
        const [h, m] = val.trim().split(':').map(Number);
        if (h < 0 || h > 23 || m < 0 || m > 59) return null;
        return h * 60 + m;
    }
    function utcDate(str) {
        const [y, m, d] = str.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d));
    }
    function addDays(str, n) {
        const dt = utcDate(str);
        dt.setUTCDate(dt.getUTCDate() + n);
        return dt.toISOString().slice(0, 10);
    }
    const longDate = (str) =>
        utcDate(str).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const shortDate = (str) =>
        utcDate(str).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

    let toastTimer;
    function toast(message, type = 'info') {
        const el = $('#toast');
        el.textContent = message;
        el.className = `toast show ${type}`;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.className = 'toast'; }, 3800);
    }

    async function api(url, options = {}) {
        const res = await fetch(url, {
            ...options,
            headers: { 'Content-Type': 'application/json', 'x-admin-password': state.password },
        });
        let body = {};
        try { body = await res.json(); } catch { /* ignore */ }
        if (!res.ok) {
            const err = new Error(body.error || `Request failed (${res.status})`);
            err.status = res.status;
            throw err;
        }
        return body;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function syncModalBodyLock() {
        const anyOpen = Array.from(document.querySelectorAll('.modal-backdrop'))
            .some((m) => !m.classList.contains('hidden'));
        document.body.classList.toggle('modal-open', anyOpen);
    }

    /* ---------------- auth ---------------- */
    function showLogin(error) {
        $('#dashView').classList.add('hidden');
        $('#loginView').classList.remove('hidden');
        const errEl = $('#loginError');
        errEl.textContent = error || '';
        errEl.classList.toggle('hidden', !error);
        const pwInput = $('#passwordInput');
        if (pwInput) {
            pwInput.classList.toggle('input-invalid', Boolean(error));
            const focusPw = () => setTimeout(() => pwInput.focus(), 40);
            if (document.readyState === 'complete') {
                focusPw();
            } else {
                window.addEventListener('load', focusPw, { once: true });
            }
        }
    }

    function showDashboard() {
        $('#loginView').classList.add('hidden');
        $('#dashView').classList.remove('hidden');
    }

    async function login(e) {
        e.preventDefault();
        if (state.loggingIn) return;
        const pw = $('#passwordInput').value;
        if (!pw) {
            showLogin('Please enter your dashboard password.');
            return;
        }
        state.loggingIn = true;
        const btn = $('#loginBtn');
        state.password = pw;
        btn.disabled = true;
        btn.querySelector('.spinner').classList.remove('hidden');
        try {
            await api('/api/admin/login', { method: 'POST' });
            sessionStorage.setItem(STORAGE_KEY, state.password);
            $('#passwordInput').value = '';
            $('#passwordInput').classList.remove('input-invalid');
            showDashboard();
            await loadBookings();
        } catch (err) {
            state.password = '';
            showLogin(err.message);
        } finally {
            state.loggingIn = false;
            btn.disabled = false;
            btn.querySelector('.spinner').classList.add('hidden');
        }
    }

    function logout() {
        sessionStorage.removeItem(STORAGE_KEY);
        state.password = '';
        state.cancelling = false;
        state.notesSaving = false;
        state.schedBusy = false;
        state.sendingEmail = false;
        closeCancelModal();
        closeNotesModal();
        closeSendEmailModal();
        closeScheduleDefenseModal();
        state.bookings = [];
        state.blockedSchedules = [];
        state.letterPickupSchedules = [];
        state.scheduleConfig = null;
        state.schedInitialized = false;
        state.schedSelectedDates = new Set();
        state.students = [];
        state.studentUpdateLogs = [];
        state.emailLogs = [];
        state.expandedEmailLogIds = new Set();
        state.adminView = 'consultations';
        showLogin();
    }

    /* ---------------- data ---------------- */
    async function ensureConfig() {
        if (state.config) return state.config;
        try {
            const res = await fetch('/api/config');
            if (res.ok) {
                state.config = await res.json();
                window.SchedulerRealtime?.init(state.config);
            }
        } catch { /* ignore */ }
        return state.config;
    }

    async function loadBookings() {
        const reqId = ++state.loadReqId;
        try {
            const [data] = await Promise.all([
                api('/api/admin/bookings'),
                ensureConfig(),
            ]);
            if (reqId !== state.loadReqId) return false;
            state.bookings = data.bookings.sort(
                (a, b) => a.date.localeCompare(b.date) || (a.startMinute ?? a.hour * 60) - (b.startMinute ?? b.hour * 60)
            );
            state.blockedSchedules = (data.blockedSchedules || []).sort(
                (a, b) => a.date.localeCompare(b.date) || (a.startMinute ?? 0) - (b.startMinute ?? 0)
            );
            state.letterPickupSchedules = (data.letterPickupSchedules || []).sort(
                (a, b) => a.date.localeCompare(b.date) || (a.startMinute ?? 0) - (b.startMinute ?? 0)
            );
            state.scheduleConfig = data.scheduleConfig || state.scheduleConfig || {
                consultationHoursByDay: {},
                defenseHoursByDay: {},
                openDates: [],
            };
            state.students = data.students || [];
            state.studentUpdateLogs = data.studentUpdateLogs || [];
            state.emailLogs = data.emailLogs || [];
            state.today = data.today;
            state.currentHour = data.currentHour;
            state.currentMinute = data.currentMinute ?? data.currentHour * 60;
            state.bookingEndDate = data.bookingEndDate || state.config?.lastBookableDate || `${data.today.slice(0, 4)}-12-12`;
            if (!state.schedInitialized && data.today) {
                const [ty, tm] = data.today.split('-').map(Number);
                state.schedViewYear = ty;
                state.schedViewMonth = tm - 1;
                const tomorrow = addDays(data.today, 1);
                state.schedSelectedDates = new Set([tomorrow]);
                state.schedLastClickedDate = tomorrow;
                state.schedInitialized = true;
            }
            if (state.cancelTarget && !state.cancelling) {
                const updatedTarget = state.bookings.find((x) => x.id === state.cancelTarget.id);
                if (!updatedTarget || isCancelled(updatedTarget)) {
                    closeCancelModal();
                } else {
                    state.cancelTarget = updatedTarget;
                }
            }
            if (state.notesTarget && !state.notesSaving) {
                const updatedNotesTarget = state.bookings.find((x) => x.id === state.notesTarget.id);
                if (!updatedNotesTarget || isCancelled(updatedNotesTarget)) {
                    closeNotesModal();
                } else {
                    state.notesTarget = updatedNotesTarget;
                }
            }
            updateHeaderDates();
            render();
            return true;
        } catch (err) {
            if (reqId !== state.loadReqId) return false;
            if (err.status === 401) {
                logout();
                showLogin('Session expired. Please sign in again.');
            } else {
                toast(err.message, 'error');
            }
            return false;
        }
    }

    const isCancelled = (b) => b.status === 'cancelled';
    const isCompleted = (b) => b.status === 'completed';
    const isNoShow = (b) => b.status === 'no_show';
    const isPast = (b) => {
        if (isCompleted(b) || isNoShow(b)) return true;
        const endMin = b.endMinute ?? (b.hour + 1) * 60;
        return b.date < state.today || (b.date === state.today && endMin <= state.currentMinute);
    };
    const isNow = (b) => {
        if (isCancelled(b) || isCompleted(b) || isNoShow(b)) return false;
        const startMin = b.startMinute ?? b.hour * 60;
        const endMin = b.endMinute ?? (b.hour + 1) * 60;
        return b.date === state.today && state.currentMinute >= startMin && state.currentMinute < endMin;
    };
    const isActiveBlock = (blk) => {
        if (!state.today) return true;
        return blk.date > state.today || (blk.date === state.today && (blk.endMinute ?? 1440) > state.currentMinute);
    };
    const isActiveLetterPickup = (item) => {
        if (!state.today) return true;
        return item.date > state.today || (item.date === state.today && (item.endMinute ?? 1440) > state.currentMinute);
    };

    function getFullDayBlockedSet() {
        return new Set(
            (state.blockedSchedules || [])
                .filter((b) => b.isFullDay && isActiveBlock(b))
                .map((b) => b.date)
        );
    }

    function hasUpcomingLetterPickupWindow() {
        const fullBlocked = getFullDayBlockedSet();
        const fromConfig = (state.scheduleConfig?.openDates || []).some(
            (e) => e.category === 'letter_pickup'
                && (!state.today || e.date > state.today)
                && !fullBlocked.has(e.date)
                && Array.isArray(e.effectiveWindows)
                && e.effectiveWindows.length > 0
        );
        return fromConfig || state.letterPickupSchedules.some((item) => isActiveLetterPickup(item) && !fullBlocked.has(item.date));
    }

    function countUpcomingOpenScheduleItems() {
        const fullBlocked = getFullDayBlockedSet();
        const openDates = state.scheduleConfig?.openDates || [];
        const uniqueDates = new Set(
            openDates
                .filter(
                    (e) => (!state.today || e.date > state.today)
                        && !fullBlocked.has(e.date)
                        && Array.isArray(e.effectiveWindows)
                        && e.effectiveWindows.length > 0
                )
                .map((e) => e.date)
        );
        return uniqueDates.size;
    }

    function updateHeaderDates() {
        const todayText = state.today ? `Today is ${longDate(state.today)}` : '';
        const openDayCount = countUpcomingOpenScheduleItems();
        const openSummary = openDayCount > 0
            ? ` · ${openDayCount} open date${openDayCount === 1 ? '' : 's'} scheduled`
            : ' · No future dates open yet';
        if ($('#todayLabel')) {
            $('#todayLabel').textContent = `${todayText}${openSummary}`;
        }
    }

    /* ---------------- unified visual schedule & availability manager ---------------- */
    const formatMinute12 = (totalMinutes) => {
        const h = Math.floor(totalMinutes / 60) % 24;
        const m = totalMinutes % 60;
        const suffix = h >= 12 ? 'PM' : 'AM';
        const hr = h % 12 === 0 ? 12 : h % 12;
        return `${hr}:${pad2(m)} ${suffix}`;
    };

    const compactTime = (totalMinutes) => {
        const h = Math.floor(totalMinutes / 60) % 24;
        const m = totalMinutes % 60;
        const suffix = h >= 12 ? 'p' : 'a';
        const hr = h % 12 === 0 ? 12 : h % 12;
        return m === 0 ? `${hr}${suffix}` : `${hr}:${pad2(m)}${suffix}`;
    };

    const makeDateStr = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;

    const ADMIN_VIEW_TITLES = {
        consultations: 'Consultations',
        schedule: 'Schedule & Availability',
        students: 'Student Groups',
        emails: 'Email Activity',
    };

    function switchAdminView(viewName, scrollIntoView = false) {
        const normalized = Object.prototype.hasOwnProperty.call(ADMIN_VIEW_TITLES, viewName)
            ? viewName
            : 'consultations';
        state.adminView = normalized;
        document.querySelectorAll('.admin-view-btn[data-admin-view]').forEach((btn) => {
            const isActive = btn.dataset.adminView === normalized;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        if ($('#adminPageHeading')) {
            $('#adminPageHeading').textContent = ADMIN_VIEW_TITLES[normalized];
        }
        render();
        if (scrollIntoView) {
            $('#adminViewNav')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    function switchAdminTab(tabName, scrollIntoView = false) {
        if (tabName === 'schedule') {
            switchAdminView('schedule', scrollIntoView);
            return;
        }
        state.adminView = 'consultations';
        state.tab = ['upcoming', 'past', 'cancelled'].includes(tabName) ? tabName : 'upcoming';
        document.querySelectorAll('.tab[data-tab]').forEach((t) => {
            t.classList.toggle('active', t.dataset.tab === state.tab);
        });
        switchAdminView('consultations', scrollIntoView);
    }

    function getSortedSelectedDates() {
        return [...state.schedSelectedDates].sort();
    }

    function getOpenEntriesByDateMap() {
        const map = new Map();
        for (const entry of state.scheduleConfig?.openDates || []) {
            if (!Array.isArray(entry.effectiveWindows) || !entry.effectiveWindows.length) continue;
            if (!map.has(entry.date)) map.set(entry.date, {});
            map.get(entry.date)[entry.category] = entry;
        }
        return map;
    }

    function getBlocksByDateMap() {
        const map = new Map();
        for (const blk of state.blockedSchedules || []) {
            if (!map.has(blk.date)) map.set(blk.date, []);
            map.get(blk.date).push(blk);
        }
        return map;
    }

    function getActiveBookingsByDateMap() {
        const map = new Map();
        for (const b of state.bookings || []) {
            if (isCancelled(b)) continue;
            if (!map.has(b.date)) map.set(b.date, []);
            map.get(b.date).push(b);
        }
        return map;
    }

    function setSchedOpenError(msg = '') {
        const errEl = $('#schedOpenError');
        if (!errEl) return;
        errEl.textContent = msg;
        errEl.classList.toggle('hidden', !msg);
    }

    function setSchedBlockError(msg = '') {
        const errEl = $('#schedBlockError');
        if (!errEl) return;
        errEl.textContent = msg;
        errEl.classList.toggle('hidden', !msg);
    }

    function setSchedSelectMode(mode) {
        state.schedSelectMode = ['single', 'multi', 'range'].includes(mode) ? mode : 'single';
        state.schedRangeAnchor = null;
        if (state.schedSelectMode === 'single' && state.schedSelectedDates.size > 1) {
            const first = getSortedSelectedDates()[0];
            state.schedSelectedDates = new Set(first ? [first] : []);
        }
        document.querySelectorAll('.sched-mode-pill[data-select-mode]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.selectMode === state.schedSelectMode);
        });
        $('#schedRangeSkipSunWrap')?.classList.toggle('hidden', state.schedSelectMode !== 'range');
        renderScheduleManager();
    }

    function fillDateRangeSet(d1, d2, skipSundays = false) {
        const start = d1 <= d2 ? d1 : d2;
        const end = d1 <= d2 ? d2 : d1;
        const out = [];
        for (let cur = start; cur <= end; cur = addDays(cur, 1)) {
            if (skipSundays && start !== end && utcDate(cur).getUTCDay() === 0) continue;
            out.push(cur);
            if (out.length >= 120) break;
        }
        return out;
    }

    function onClickScheduleDay(ds, event) {
        setSchedOpenError('');
        setSchedBlockError('');

        if (event?.shiftKey && state.schedLastClickedDate) {
            const skipSun = Boolean($('#schedRangeSkipSun')?.checked) && state.schedSelectMode === 'range';
            const rangeDates = fillDateRangeSet(state.schedLastClickedDate, ds, skipSun);
            if (state.schedSelectMode === 'single') {
                state.schedSelectMode = 'multi';
                document.querySelectorAll('.sched-mode-pill[data-select-mode]').forEach((btn) => {
                    btn.classList.toggle('active', btn.dataset.selectMode === 'multi');
                });
            }
            rangeDates.forEach((d) => state.schedSelectedDates.add(d));
            state.schedLastClickedDate = ds;
            state.schedRangeAnchor = null;
            renderScheduleManager();
            return;
        }

        if (state.schedSelectMode === 'range') {
            if (!state.schedRangeAnchor) {
                state.schedRangeAnchor = ds;
                state.schedSelectedDates = new Set([ds]);
            } else {
                const skipSun = Boolean($('#schedRangeSkipSun')?.checked);
                const rangeDates = fillDateRangeSet(state.schedRangeAnchor, ds, skipSun);
                state.schedSelectedDates = new Set(rangeDates);
                state.schedRangeAnchor = null;
            }
            state.schedLastClickedDate = ds;
            renderScheduleManager();
            return;
        }

        if (state.schedSelectMode === 'multi') {
            if (state.schedSelectedDates.has(ds)) {
                state.schedSelectedDates.delete(ds);
            } else {
                state.schedSelectedDates.add(ds);
            }
            state.schedLastClickedDate = ds;
            renderScheduleManager();
            return;
        }

        // Single Date mode
        state.schedSelectedDates = new Set([ds]);
        state.schedLastClickedDate = ds;
        renderScheduleManager();
    }

    function changeSchedMonth(delta) {
        let m = state.schedViewMonth + delta;
        let y = state.schedViewYear;
        if (m < 0) { m = 11; y -= 1; }
        if (m > 11) { m = 0; y += 1; }
        state.schedViewYear = y;
        state.schedViewMonth = m;
        renderScheduleCalendar();
    }

    function jumpSchedToday() {
        const ref = state.today || new Date().toISOString().slice(0, 10);
        const [y, m] = ref.split('-').map(Number);
        state.schedViewYear = y;
        state.schedViewMonth = m - 1;
        const tomorrow = addDays(ref, 1);
        state.schedSelectMode = 'single';
        state.schedRangeAnchor = null;
        state.schedSelectedDates = new Set([tomorrow]);
        document.querySelectorAll('.sched-mode-pill[data-select-mode]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.selectMode === 'single');
        });
        $('#schedRangeSkipSunWrap')?.classList.add('hidden');
        renderScheduleManager();
    }

    function renderScheduleCalendar() {
        const y = state.schedViewYear || 2026;
        const m = state.schedViewMonth || 0;
        const monthLabelEl = $('#schedMonthLabel');
        if (monthLabelEl) {
            monthLabelEl.textContent = new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-US', {
                month: 'long',
                year: 'numeric',
                timeZone: 'UTC',
            });
        }

        const hintTextEl = $('#schedSelectionHintText');
        const clearBtn = $('#schedClearSelectionBtn');
        const jumpBtn = $('#schedJumpInspectorBtn');
        const selectedCount = state.schedSelectedDates.size;
        const isTouchOrCompact = window.innerWidth <= 1040 || window.matchMedia('(hover: none)').matches;
        if (hintTextEl) {
            if (state.schedSelectMode === 'range' && state.schedRangeAnchor) {
                hintTextEl.textContent = `Start date: ${shortDate(state.schedRangeAnchor)} — now tap an end date.`;
            } else if (selectedCount > 1) {
                hintTextEl.textContent = `${selectedCount} dates selected on calendar.`;
            } else if (selectedCount === 1) {
                const only = getSortedSelectedDates()[0];
                hintTextEl.textContent = isTouchOrCompact
                    ? `Selected: ${longDate(only)}`
                    : `Selected: ${longDate(only)} (Shift+click another date to select a range).`;
            } else if (state.schedSelectMode === 'multi') {
                hintTextEl.textContent = 'Tap multiple dates on the calendar to toggle them.';
            } else if (state.schedSelectMode === 'range') {
                hintTextEl.textContent = 'Tap a start date, then tap an end date on the calendar.';
            } else {
                hintTextEl.textContent = 'Tap any date on the calendar to open or block it.';
            }
        }
        clearBtn?.classList.toggle('hidden', selectedCount <= 1 && !state.schedRangeAnchor);
        jumpBtn?.classList.toggle('hidden', selectedCount === 0 || Boolean(state.schedRangeAnchor));

        const container = $('#schedDays');
        if (!container) return;
        container.innerHTML = '';

        const firstDow = new Date(Date.UTC(y, m, 1)).getUTCDay();
        const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        for (let i = 0; i < firstDow; i += 1) {
            container.appendChild(el('span', 'day-spacer'));
        }

        const openByDate = getOpenEntriesByDateMap();
        const blocksByDate = getBlocksByDateMap();
        const apptsByDate = getActiveBookingsByDateMap();

        for (let d = 1; d <= daysInMonth; d += 1) {
            const ds = makeDateStr(y, m, d);
            const dayOpen = openByDate.get(ds) || {};
            const dayBlocks = blocksByDate.get(ds) || [];
            const dayAppts = apptsByDate.get(ds) || [];
            const hasFullBlock = dayBlocks.some((b) => b.isFullDay);
            const hasAnyOpen = Boolean(dayOpen.consultation || dayOpen.defense || dayOpen.letter_pickup);

            const btn = el('button', 'sched-day');
            btn.type = 'button';
            btn.dataset.date = ds;
            if (state.today && ds <= state.today) btn.classList.add('is-past');
            if (ds === state.today) btn.classList.add('is-today');
            if (hasAnyOpen && !hasFullBlock) btn.classList.add('is-open-day');
            if (hasFullBlock) btn.classList.add('is-blocked-full');
            if (state.schedSelectedDates.has(ds)) btn.classList.add('is-selected');
            if (state.schedRangeAnchor === ds) btn.classList.add('is-range-anchor');

            const head = el('div', 'sched-day-head');
            head.appendChild(el('span', 'sched-day-num', String(d)));
            if (dayAppts.length > 0) {
                const apptBadge = el('span', 'sched-day-appts', String(dayAppts.length));
                apptBadge.title = `${dayAppts.length} scheduled appointment${dayAppts.length === 1 ? '' : 's'}`;
                head.appendChild(apptBadge);
            }
            btn.appendChild(head);

            const tags = el('div', 'sched-day-tags');
            const tooltipLines = [longDate(ds)];

            if (hasFullBlock) {
                const blk = dayBlocks.find((b) => b.isFullDay);
                tags.appendChild(el('span', 'sched-day-tag danger', 'Blocked'));
                tooltipLines.push(`Blocked all day${blk?.reason ? ` (${blk.reason})` : ''}`);
            } else {
                ['consultation', 'defense', 'letter_pickup'].forEach((cat) => {
                    const entry = dayOpen[cat];
                    if (!entry) return;
                    const meta = CATEGORY_META[cat];
                    const firstWin = entry.effectiveWindows[0];
                    const shortHours = entry.mode === 'full_day'
                        ? '10a–5p'
                        : entry.effectiveWindows.length > 1
                            ? `${entry.effectiveWindows.length} win`
                            : firstWin
                                ? `${compactTime(firstWin.startMinute)}–${compactTime(firstWin.endMinute)}`
                                : '';
                    const tagEl = el('span', `sched-day-tag ${meta.badgeCls}`);
                    tagEl.appendChild(el('span', 'sched-tag-name', meta.shortTag));
                    if (shortHours) {
                        tagEl.appendChild(el('span', 'sched-tag-hours', ` · ${shortHours}`));
                    }
                    tags.appendChild(tagEl);
                    tooltipLines.push(`${meta.label}: ${entry.label}`);
                });
                if (dayBlocks.length > 0) {
                    tags.appendChild(el('span', 'sched-day-tag danger', `Block (${dayBlocks.length})`));
                    dayBlocks.forEach((b) => tooltipLines.push(`Blocked: ${b.label}${b.reason ? ` (${b.reason})` : ''}`));
                }
            }

            if (tooltipLines.length === 1) {
                tooltipLines.push('Closed (click to open)');
            }
            btn.title = tooltipLines.join('\n');
            btn.appendChild(tags);
            btn.addEventListener('click', (e) => onClickScheduleDay(ds, e));
            container.appendChild(btn);
        }
    }

    function renderCustomWindowRows() {
        const wrap = $('#schedCustomWindowsWrap');
        const rowsContainer = $('#schedCustomWindowRows');
        if (!wrap || !rowsContainer) return;
        wrap.classList.toggle('hidden', state.schedHourMode !== 'custom');
        if (state.schedHourMode !== 'custom') return;

        rowsContainer.innerHTML = '';
        if (!state.schedCustomWindows.length) {
            state.schedCustomWindows = [{ start: '10:00', end: '17:00' }];
        }

        state.schedCustomWindows.forEach((win, idx) => {
            const row = el('div', 'sched-custom-win-row');
            const startInput = document.createElement('input');
            startInput.type = 'time';
            startInput.step = '300';
            startInput.value = win.start;
            startInput.setAttribute('aria-label', `Window ${idx + 1} start time`);
            startInput.addEventListener('input', () => {
                state.schedCustomWindows[idx].start = startInput.value;
                setSchedOpenError('');
            });

            const sep = el('span', 'sched-custom-win-sep', 'to');

            const endInput = document.createElement('input');
            endInput.type = 'time';
            endInput.step = '300';
            endInput.value = win.end;
            endInput.setAttribute('aria-label', `Window ${idx + 1} end time`);
            endInput.addEventListener('input', () => {
                state.schedCustomWindows[idx].end = endInput.value;
                setSchedOpenError('');
            });

            row.append(startInput, sep, endInput);
            if (state.schedCustomWindows.length > 1) {
                const rmBtn = el('button', 'remove-member');
                rmBtn.type = 'button';
                rmBtn.title = 'Remove window';
                rmBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
                rmBtn.addEventListener('click', () => {
                    state.schedCustomWindows.splice(idx, 1);
                    renderCustomWindowRows();
                });
                row.appendChild(rmBtn);
            }
            rowsContainer.appendChild(row);
        });

        $('#schedAddCustomWinBtn')?.classList.toggle('hidden', state.schedCustomWindows.length >= 4);
    }

    const ADMIN_SLOT_PREVIEW_META = {
        defense_1h: { label: 'Defense · 1h', category: 'defense', duration: 60, isDefense: true, defaultLevel: 'capstone1' },
        defense_2h: { label: 'Defense · 2h', category: 'defense', duration: 120, isDefense: true, defaultLevel: 'capstone2' },
        system: { label: 'System · 15m', category: 'consultation', duration: 15, isDefense: false },
        other: { label: 'Other · 10m', category: 'consultation', duration: 10, isDefense: false },
        retrieval: { label: 'Retrieval / Letter · 5m', category: 'consultation', duration: 5, isDefense: false },
        letter_pickup: { label: 'Comm. Letter Pickup · 5m', category: 'letter_pickup', duration: 5, isDefense: false },
    };

    const PANEL_WORKDAY_START = 7 * 60 + 30; // 7:30 AM
    const PANEL_WORKDAY_END = 18 * 60;       // 6:00 PM

    function getTimedBookingsOnDate(ds, excludeId = null) {
        return (state.bookings || []).filter((b) => {
            if (isCancelled(b) || b.date !== ds) return false;
            if (excludeId && b.id === excludeId) return false;
            if (b.isDropoff || b.consultationType === 'dropoff') return false;
            return (b.durationMinutes ?? 15) > 0;
        });
    }

    function computeFreeGapsInWindows(windows, busyIntervals, minDuration = 5) {
        const results = [];
        for (const [ws, we] of windows) {
            const clipped = busyIntervals
                .filter(([s, e]) => s < we && e > ws)
                .map(([s, e]) => [Math.max(s, ws), Math.min(e, we)])
                .sort((a, b) => a[0] - b[0]);

            const merged = [];
            for (const [s, e] of clipped) {
                const last = merged[merged.length - 1];
                if (last && s <= last[1]) last[1] = Math.max(last[1], e);
                else merged.push([s, e]);
            }

            const free = [];
            let cursor = ws;
            for (const [s, e] of merged) {
                if (s > cursor) free.push([cursor, s]);
                cursor = Math.max(cursor, e);
            }
            if (cursor < we) free.push([cursor, we]);

            for (const [fs, fe] of free) {
                const earliest = Math.ceil(fs / 5) * 5;
                const latest = Math.floor((fe - minDuration) / 5) * 5;
                if (latest >= earliest) {
                    results.push({
                        startMinute: fs,
                        endMinute: fe,
                        earliestStart: earliest,
                        latestStart: latest,
                        label: `${formatMinute12(fs)} – ${formatMinute12(fe)}`,
                    });
                }
            }
        }
        return results;
    }

    function buildSuggestedDefenseStarts(gaps, stepMinutes = 30) {
        const starts = [];
        const seen = new Set();
        gaps.forEach((g) => {
            // Start at earliest, then nice 30-min (or hour/half-hour) marks, plus latestStart
            const add = (m) => {
                if (!seen.has(m)) {
                    seen.add(m);
                    starts.push(m);
                }
            };
            add(g.earliestStart);
            const firstHalfHour = Math.ceil(g.earliestStart / stepMinutes) * stepMinutes;
            for (let m = firstHalfHour; m <= g.latestStart; m += stepMinutes) {
                add(m);
            }
            add(g.latestStart);
        });
        return starts.sort((a, b) => a - b);
    }

    function getOpenedCategoryWindowsOnDate(ds, category) {
        const openByDate = getOpenEntriesByDateMap();
        const entry = openByDate.get(ds)?.[category] || null;
        const wins = (entry?.effectiveWindows || []).map((w) => [w.startMinute, w.endMinute]);
        if (category === 'letter_pickup' && !wins.length) {
            const legacy = (state.letterPickupSchedules || [])
                .filter((p) => p.date === ds)
                .map((p) => [p.startMinute, p.endMinute]);
            return legacy;
        }
        return wins;
    }

    function renderScheduleSlotsPreviewCard(selectedDates) {
        const card = $('#schedSlotsCard');
        const body = $('#schedSlotsPreviewBody');
        const badge = $('#schedSlotsSummaryBadge');
        const titleEl = $('#schedSlotsTitle');
        if (!card || !body) return;

        if (!selectedDates || selectedDates.length !== 1) {
            card.classList.add('hidden');
            return;
        }

        const ds = selectedDates[0];
        card.classList.remove('hidden');

        const previewKey = Object.prototype.hasOwnProperty.call(ADMIN_SLOT_PREVIEW_META, state.schedSlotPreviewType)
            ? state.schedSlotPreviewType
            : 'defense_1h';
        state.schedSlotPreviewType = previewKey;
        const meta = ADMIN_SLOT_PREVIEW_META[previewKey];

        if (titleEl) {
            titleEl.textContent = `Available Times · ${shortDate(ds)}`;
        }

        document.querySelectorAll('#schedSlotsTypePills [data-slot-preview]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.slotPreview === previewKey);
        });

        body.innerHTML = '';

        const dayBookings = getTimedBookingsOnDate(ds);
        const dayBlocks = (state.blockedSchedules || []).filter((blk) => blk.date === ds);
        const fullBlock = dayBlocks.find((b) => b.isFullDay) || null;
        const bookedIntervals = dayBookings.map((b) => [
            b.startMinute ?? (b.hour || 0) * 60,
            b.endMinute ?? ((b.startMinute ?? (b.hour || 0) * 60) + (b.durationMinutes || 15)),
        ]);
        const blockedIntervals = dayBlocks.map((blk) => [
            blk.isFullDay ? 0 : (blk.startMinute ?? 0),
            blk.isFullDay ? 1440 : (blk.endMinute ?? 1440),
        ]);
        const allBusyIntervals = [...bookedIntervals, ...blockedIntervals];
        const openedWins = getOpenedCategoryWindowsOnDate(ds, meta.category);

        if (meta.isDefense) {
            // 1) Student-Bookable Defense Windows (if opened & not full-day blocked)
            const studentGaps = (!fullBlock && openedWins.length)
                ? computeFreeGapsInWindows(openedWins, allBusyIntervals, meta.duration)
                : [];
            // 2) Panel Free Windows (7:30 AM – 6:00 PM minus actual booked appointments, so admin can see all open gaps for panel scheduling)
            const panelGaps = computeFreeGapsInWindows([[PANEL_WORKDAY_START, PANEL_WORKDAY_END]], bookedIntervals, meta.duration);

            if (openedWins.length && !fullBlock) {
                if (badge) {
                    badge.className = `badge ${studentGaps.length ? 'rose' : 'muted-badge'}`;
                    badge.textContent = studentGaps.length
                        ? `${studentGaps.length} open window${studentGaps.length === 1 ? '' : 's'}`
                        : 'Full';
                }
                const box = el('div', 'admin-slots-section');
                const noteRow = el('div', 'admin-slots-note is-open');
                noteRow.textContent = studentGaps.length
                    ? `Open to students (${meta.duration === 120 ? '2-hour' : '1-hour'}): ${studentGaps.map((g) => g.label).join(' · ')}`
                    : `Defense hours are open on ${shortDate(ds)}, but no ${meta.duration === 120 ? '2-hour' : '1-hour'} gap remains.`;
                box.appendChild(noteRow);

                const starts = buildSuggestedDefenseStarts(studentGaps, 30);
                if (starts.length) {
                    box.appendChild(el('span', 'student-field-label', 'Tap a start time to schedule a group for defense:'));
                    const chips = el('div', 'defense-chip-list');
                    starts.forEach((m) => {
                        const chip = el('button', 'defense-time-chip', `${formatMinute12(m)} – ${formatMinute12(m + meta.duration)}`);
                        chip.type = 'button';
                        chip.addEventListener('click', () => {
                            openScheduleDefenseModal({
                                prefillDate: ds,
                                prefillTime: minuteToTimeVal(m),
                                prefillLevel: meta.defaultLevel,
                            });
                        });
                        chips.appendChild(chip);
                    });
                    box.appendChild(chips);
                }
                body.appendChild(box);
            } else {
                if (badge) {
                    badge.className = `badge ${panelGaps.length ? 'sky' : 'danger'}`;
                    badge.textContent = fullBlock
                        ? 'Blocked (Students)'
                        : panelGaps.length
                            ? `${panelGaps.length} panel gap${panelGaps.length === 1 ? '' : 's'}`
                            : 'Busy';
                }
                const closedBanner = el('div', 'admin-slots-note');
                closedBanner.textContent = fullBlock
                    ? `Blocked for student self-booking (${fullBlock.reason || 'Full day block'}). Panel free windows below ignore blocks and check only real appointments:`
                    : `Closed to student self-booking on ${shortDate(ds)}. Free gaps on your schedule (7:30 AM – 6:00 PM) for panel-assigned defenses:`;
                body.appendChild(closedBanner);

                if (panelGaps.length) {
                    const rangeSummary = el('p', 'small admin-free-summary', `Free: ${panelGaps.map((g) => g.label).join(' · ')}`);
                    body.appendChild(rangeSummary);
                    const starts = buildSuggestedDefenseStarts(panelGaps, 30);
                    if (starts.length) {
                        const chips = el('div', 'defense-chip-list');
                        starts.forEach((m) => {
                            const chip = el('button', 'defense-time-chip', `${formatMinute12(m)} – ${formatMinute12(m + meta.duration)}`);
                            chip.type = 'button';
                            chip.addEventListener('click', () => {
                                openScheduleDefenseModal({
                                    prefillDate: ds,
                                    prefillTime: minuteToTimeVal(m),
                                    prefillLevel: meta.defaultLevel,
                                });
                            });
                            chips.appendChild(chip);
                        });
                        body.appendChild(chips);
                    }
                } else {
                    body.appendChild(el('p', 'muted small', 'No free gap fits this defense duration between 7:30 AM and 6:00 PM.'));
                }
            }

            if (dayBookings.length > 0) {
                const busyWrap = el('div', 'admin-booked-summary');
                busyWrap.appendChild(el('span', 'student-field-label', `Booked on ${shortDate(ds)} (${dayBookings.length}):`));
                dayBookings.forEach((b) => {
                    const pill = el('div', 'def-day-appt-pill');
                    pill.appendChild(el('strong', '', b.label));
                    pill.appendChild(el('span', '', `${b.consultationTitle || 'Consultation'} · ${b.capstoneTitle || b.teamName || b.name}`));
                    busyWrap.appendChild(pill);
                });
                body.appendChild(busyWrap);
            }
            return;
        }

        // Consultation / Letter Pickup slot grid (mirrors student booking view)
        if (!openedWins.length) {
            if (badge) {
                badge.className = 'badge muted-badge';
                badge.textContent = 'Closed';
            }
            const emptyBox = el('div', 'admin-slots-closed');
            emptyBox.appendChild(el('p', 'muted small', `${CATEGORY_META[meta.category]?.label || 'Schedule'} are currently closed on ${shortDate(ds)}.`));
            const quickOpenBtn = el('button', 'btn btn-primary-soft btn-sm', `Open ${CATEGORY_META[meta.category]?.shortTag || 'Category'} in Form →`);
            quickOpenBtn.type = 'button';
            quickOpenBtn.addEventListener('click', () => {
                state.schedActionMode = 'open';
                state.schedCategory = meta.category;
                renderScheduleInspector();
                $('#schedActionCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            emptyBox.appendChild(quickOpenBtn);
            body.appendChild(emptyBox);
            return;
        }

        const slots = [];
        openedWins.forEach(([ws, we]) => {
            for (let m = ws; m + meta.duration <= we; m += meta.duration) {
                const sEnd = m + meta.duration;
                const matchedBooking = dayBookings.find((b) => {
                    const bs = b.startMinute ?? (b.hour || 0) * 60;
                    const be = b.endMinute ?? (bs + (b.durationMinutes || 15));
                    return m < be && sEnd > bs;
                }) || null;
                const matchedBlock = dayBlocks.find((blk) => {
                    const bs = blk.isFullDay ? 0 : (blk.startMinute ?? 0);
                    const be = blk.isFullDay ? 1440 : (blk.endMinute ?? 1440);
                    return m < be && sEnd > bs;
                }) || null;
                slots.push({
                    startMinute: m,
                    endMinute: sEnd,
                    label: `${formatMinute12(m)} – ${formatMinute12(sEnd)}`,
                    booking: matchedBooking,
                    block: matchedBlock,
                    available: !matchedBooking && !matchedBlock,
                });
            }
        });

        const openCount = slots.filter((s) => s.available).length;
        if (badge) {
            badge.className = `badge ${openCount > 0 ? 'teal' : 'danger'}`;
            badge.textContent = `${openCount}/${slots.length} open`;
        }

        if (!slots.length) {
            body.appendChild(el('p', 'muted small', 'Opened window is shorter than this slot duration.'));
            return;
        }

        const grid = el('div', 'admin-slot-grid');
        slots.forEach((s) => {
            const cls = s.available
                ? 'admin-slot-pill is-open'
                : s.booking
                    ? 'admin-slot-pill is-booked'
                    : 'admin-slot-pill is-blocked';
            const cardEl = el('div', cls);
            cardEl.appendChild(el('strong', 'admin-slot-time', s.label));
            const statusText = s.available
                ? 'Available'
                : s.booking
                    ? `Booked · ${s.booking.capstoneTitle || s.booking.teamName || s.booking.name}`
                    : `Blocked${s.block?.reason ? ` · ${s.block.reason}` : ''}`;
            cardEl.appendChild(el('span', 'admin-slot-status', statusText));
            cardEl.title = `${s.label} — ${statusText}`;
            grid.appendChild(cardEl);
        });
        body.appendChild(grid);
    }

    function renderScheduleInspector() {
        const selected = getSortedSelectedDates();
        const eyebrowEl = $('#schedStatusEyebrow');
        const titleEl = $('#schedSelectedTitle');
        const currentListEl = $('#schedCurrentList');
        if (!currentListEl) return;
        currentListEl.innerHTML = '';

        const openByDate = getOpenEntriesByDateMap();
        const blocksByDate = getBlocksByDateMap();
        const apptsByDate = getActiveBookingsByDateMap();

        if (!selected.length) {
            if (eyebrowEl) eyebrowEl.textContent = 'No Date Selected';
            if (titleEl) titleEl.textContent = 'Select a date on the calendar';
            currentListEl.appendChild(el('p', 'muted small', 'Click one date, multiple dates, or a date range on the calendar to inspect or update availability.'));
        } else if (selected.length === 1) {
            const ds = selected[0];
            if (eyebrowEl) {
                eyebrowEl.textContent = state.today && ds <= state.today
                    ? (ds === state.today ? 'Today (students book 1 day ahead)' : 'Past Date')
                    : 'Selected Date';
            }
            if (titleEl) titleEl.textContent = longDate(ds);

            const dayOpen = openByDate.get(ds) || {};
            const dayBlocks = blocksByDate.get(ds) || [];
            const dayAppts = apptsByDate.get(ds) || [];

            if (dayAppts.length > 0) {
                const hasUpcomingOnDay = dayAppts.some((b) => !isPast(b));
                const targetTab = hasUpcomingOnDay ? 'upcoming' : 'past';
                const apptBox = el('div', 'sched-appt-notice');
                apptBox.appendChild(el('span', '', `${dayAppts.length} scheduled appointment${dayAppts.length === 1 ? '' : 's'} on this date`));
                const viewBtn = el('button', 'link-btn', hasUpcomingOnDay ? 'View in Upcoming →' : 'View in Past →');
                viewBtn.type = 'button';
                viewBtn.addEventListener('click', () => {
                    state.search = ds;
                    if ($('#searchInput')) $('#searchInput').value = ds;
                    switchAdminTab(targetTab, true);
                });
                apptBox.appendChild(viewBtn);
                currentListEl.appendChild(apptBox);
            }

            const hasFullBlockOnDay = dayBlocks.some((b) => b.isFullDay);
            ['consultation', 'defense', 'letter_pickup'].forEach((cat) => {
                const meta = CATEGORY_META[cat];
                const entry = dayOpen[cat];
                const row = el('div', 'sched-status-row' + (entry && !hasFullBlockOnDay ? ' is-open' : ''));
                const info = el('div', 'sched-status-row-info');
                const top = el('div', 'sched-status-row-top');
                top.appendChild(el('span', `badge ${entry && !hasFullBlockOnDay ? meta.badgeCls : 'muted-badge'}`, meta.label));
                if (entry) {
                    const modeTag = entry.mode === 'full_day'
                        ? 'Full Day'
                        : entry.mode === 'regular'
                            ? 'Regular Hours'
                            : 'Custom';
                    top.appendChild(el('span', 'badge muted-badge', modeTag));
                }
                info.appendChild(top);
                info.appendChild(el(
                    'small',
                    '',
                    entry
                        ? (hasFullBlockOnDay
                            ? `Paused by full-day block · ${entry.label}${entry.note ? ` (${entry.note})` : ''}`
                            : `Open · ${entry.label}${entry.note ? ` (${entry.note})` : ''}`)
                        : 'Closed'
                ));
                row.appendChild(info);

                if (entry) {
                    const closeBtn = el('button', 'btn btn-danger-soft btn-sm', 'Close');
                    closeBtn.type = 'button';
                    closeBtn.addEventListener('click', () => closeScheduleDates([ds], [cat], closeBtn));
                    row.appendChild(closeBtn);
                }
                currentListEl.appendChild(row);
            });

            dayBlocks.forEach((blk) => {
                const row = el('div', 'sched-status-row is-blocked');
                const info = el('div', 'sched-status-row-info');
                const top = el('div', 'sched-status-row-top');
                top.appendChild(el('span', 'badge danger', `Blocked · ${blk.label}`));
                info.appendChild(top);
                info.appendChild(el('small', '', blk.reason || 'Instructor unavailable'));
                const unblockBtn = el('button', 'btn btn-ghost btn-sm', 'Unblock');
                unblockBtn.type = 'button';
                unblockBtn.addEventListener('click', () => unblockSchedule(blk, unblockBtn));
                row.append(info, unblockBtn);
                currentListEl.appendChild(row);
            });
            if (!state.today || ds >= state.today) {
                const quickDefRow = el('div', 'sched-quick-defense-row');
                const quickDefBtn = el('button', 'btn btn-rose-soft btn-sm btn-block', `Schedule Group for Defense on ${shortDate(ds)}`);
                quickDefBtn.type = 'button';
                quickDefBtn.addEventListener('click', () => openScheduleDefenseModal({ prefillDate: ds }));
                quickDefRow.appendChild(quickDefBtn);
                currentListEl.appendChild(quickDefRow);
            }
        } else {
            const first = selected[0];
            const last = selected[selected.length - 1];
            if (eyebrowEl) eyebrowEl.textContent = `${selected.length} Dates Selected`;
            if (titleEl) titleEl.textContent = `${shortDate(first)} – ${shortDate(last)}`;

            ['consultation', 'defense', 'letter_pickup'].forEach((cat) => {
                const meta = CATEGORY_META[cat];
                const openOnCount = selected.filter((d) => Boolean(openByDate.get(d)?.[cat])).length;
                const row = el('div', 'sched-status-row' + (openOnCount > 0 ? ' is-open' : ''));
                const info = el('div', 'sched-status-row-info');
                const top = el('div', 'sched-status-row-top');
                top.appendChild(el('span', `badge ${openOnCount > 0 ? meta.badgeCls : 'muted-badge'}`, meta.label));
                info.appendChild(top);
                info.appendChild(el('small', '', openOnCount > 0 ? `Open on ${openOnCount} of ${selected.length} selected dates` : 'Closed on all selected dates'));
                row.appendChild(info);
                if (openOnCount > 0) {
                    const closeBtn = el('button', 'btn btn-danger-soft btn-sm', 'Close all');
                    closeBtn.type = 'button';
                    closeBtn.addEventListener('click', () => closeScheduleDates(selected, [cat], closeBtn));
                    row.appendChild(closeBtn);
                }
                currentListEl.appendChild(row);
            });

            const blockedSelectedDates = selected.filter((d) => (blocksByDate.get(d) || []).length > 0);
            if (blockedSelectedDates.length > 0) {
                const row = el('div', 'sched-status-row is-blocked');
                const info = el('div', 'sched-status-row-info');
                const top = el('div', 'sched-status-row-top');
                top.appendChild(el('span', 'badge danger', 'Blocked'));
                info.appendChild(top);
                info.appendChild(el('small', '', `${blockedSelectedDates.length} of ${selected.length} selected dates have active blocks`));
                const unblockAllBtn = el('button', 'btn btn-ghost btn-sm', 'Unblock all');
                unblockAllBtn.type = 'button';
                unblockAllBtn.addEventListener('click', () => unblockSelectedDates(blockedSelectedDates, unblockAllBtn));
                row.append(info, unblockAllBtn);
                currentListEl.appendChild(row);
            }
        }

        // Sync Open vs Block form visibility
        document.querySelectorAll('input[name="schedActionMode"]').forEach((r) => {
            r.checked = r.value === state.schedActionMode;
        });
        $('#schedOpenForm')?.classList.toggle('hidden', state.schedActionMode !== 'open');
        $('#schedBlockForm')?.classList.toggle('hidden', state.schedActionMode !== 'block');

        // Sync Category cards
        document.querySelectorAll('.sched-cat-card[data-cat]').forEach((card) => {
            card.classList.toggle('active', card.dataset.cat === state.schedCategory);
        });

        // Sync Hour Mode options & live regular-hours preview for selected dates
        const isDefense = state.schedCategory === 'defense';
        const regTitleEl = $('#schedRegularModeTitle');
        if (regTitleEl) {
            regTitleEl.textContent = isDefense ? 'My Regular Defense Hours' : 'My Consultation Hours Only';
        }

        const regPreviewEl = $('#schedRegularModePreview');
        if (regPreviewEl) {
            const hoursTable = isDefense
                ? (state.scheduleConfig?.defenseHoursByDay || {})
                : (state.scheduleConfig?.consultationHoursByDay || {});
            const allConfiguredParts = [];
            [1, 2, 3, 4, 5, 6].forEach((dow) => {
                const wins = hoursTable[dow] || hoursTable[String(dow)] || [];
                if (wins.length) {
                    allConfiguredParts.push(`${WEEKDAY_SHORT[dow]}: ${wins.map((w) => w.label).join(', ')}`);
                }
            });
            const allSummary = allConfiguredParts.join(' · ');

            if (!selected.length) {
                if (allConfiguredParts.length > 0) {
                    regPreviewEl.textContent = `Preset: ${allSummary}`;
                    regPreviewEl.classList.remove('is-warning');
                } else {
                    regPreviewEl.textContent = 'No regular weekly hours set yet — configure them below.';
                    regPreviewEl.classList.add('is-warning');
                }
            } else {
                const matchingDates = [];
                const missingNamesSet = new Set();
                const selectedParts = [];
                const seenDows = new Set();

                selected.forEach((d) => {
                    const dow = utcDate(d).getUTCDay();
                    const wins = hoursTable[dow] || hoursTable[String(dow)] || [];
                    if (wins.length) {
                        matchingDates.push(d);
                        if (!seenDows.has(dow)) {
                            seenDows.add(dow);
                            selectedParts.push(`${WEEKDAY_SHORT[dow]}: ${wins.map((w) => w.label).join(', ')}`);
                        }
                    } else {
                        missingNamesSet.add(WEEKDAY_FULL[dow]);
                    }
                });

                const missingNames = [...missingNamesSet];
                if (matchingDates.length > 0 && missingNames.length === 0) {
                    regPreviewEl.textContent = selectedParts.join(' · ');
                    regPreviewEl.classList.remove('is-warning');
                } else if (matchingDates.length > 0 && missingNames.length > 0) {
                    regPreviewEl.textContent = `Opens ${matchingDates.length} matching date${matchingDates.length === 1 ? '' : 's'} (${selectedParts.join(' · ')}) and skips ${missingNames.join(', ')}.`;
                    regPreviewEl.classList.remove('is-warning');
                } else if (allConfiguredParts.length > 0) {
                    regPreviewEl.textContent = `Preset weekly hours: ${allSummary}. (${missingNames.join(', ')} ${missingNames.length === 1 ? 'has' : 'have'} none set — use 10:00 AM – 5:00 PM or Custom Time, or add ${missingNames.join('/')} below.)`;
                    regPreviewEl.classList.toggle('is-warning', state.schedHourMode === 'regular');
                } else {
                    regPreviewEl.textContent = 'No regular weekly hours set yet — configure them below or click Restore November Preset.';
                    regPreviewEl.classList.add('is-warning');
                }
            }
        }

        document.querySelectorAll('.sched-hour-option[data-hour-mode]').forEach((opt) => {
            const active = opt.dataset.hourMode === state.schedHourMode;
            opt.classList.toggle('is-selected', active);
            const radio = opt.querySelector('input[type="radio"]');
            if (radio) radio.checked = active;
        });

        renderCustomWindowRows();

        // Auto-unblock checkbox if any selected date currently has a full-day block
        const hasFullDayBlockOnSelected = selected.some((d) => (blocksByDate.get(d) || []).some((b) => b.isFullDay));
        $('#schedAutoUnblockWrap')?.classList.toggle('hidden', !hasFullDayBlockOnSelected);

        // Dynamic submit button labels
        const catLabel = CATEGORY_META[state.schedCategory]?.label || 'Schedule';
        const dateSuffix = selected.length === 0
            ? ''
            : selected.length === 1
                ? ` on ${shortDate(selected[0])}`
                : ` on ${selected.length} Dates`;
        if ($('#schedOpenSubmitLabel') && !state.schedBusy) {
            $('#schedOpenSubmitLabel').textContent = `Open ${catLabel}${dateSuffix}`;
        }
        if ($('#schedOpenSubmitBtn')) {
            $('#schedOpenSubmitBtn').disabled = state.schedBusy || selected.length === 0;
        }

        document.querySelectorAll('input[name="schedBlockScope"]').forEach((r) => {
            r.checked = r.value === state.schedBlockScope;
        });
        $('#schedBlockTimeSection')?.classList.toggle('hidden', state.schedBlockScope !== 'time');
        if ($('#schedBlockSubmitLabel') && !state.schedBusy) {
            $('#schedBlockSubmitLabel').textContent = selected.length === 1
                ? `Block ${shortDate(selected[0])}`
                : selected.length > 1
                    ? `Block ${selected.length} Dates`
                    : 'Block Selected Date(s)';
        }
        if ($('#schedBlockSubmitBtn')) {
            $('#schedBlockSubmitBtn').disabled = state.schedBusy || selected.length === 0;
        }

        renderScheduleSlotsPreviewCard(selected);
    }

    function renderRegularHoursSection() {
        const grid = $('#schedRegularGrid');
        if (!grid) return;
        grid.innerHTML = '';

        document.querySelectorAll('input[name="schedRegType"]').forEach((r) => {
            r.checked = r.value === state.schedRegType;
        });

        const isDefense = state.schedRegType === 'defense';
        const resetBtn = $('#schedResetPresetBtn');
        if (resetBtn) {
            resetBtn.textContent = isDefense
                ? 'Restore Nov Defense Preset'
                : 'Restore Nov Consultation Preset';
        }
        const source = isDefense
            ? (state.scheduleConfig?.defenseHoursByDay || {})
            : (state.scheduleConfig?.consultationHoursByDay || {});

        // Show Monday (1) through Saturday (6)
        [1, 2, 3, 4, 5, 6].forEach((dow) => {
            const wins = source[dow] || source[String(dow)] || [];
            const card = el('div', 'sched-weekday-card');

            const head = el('div', 'sched-weekday-head');
            head.appendChild(el('strong', '', WEEKDAY_FULL[dow]));
            head.appendChild(el(
                'span',
                `badge ${wins.length ? (isDefense ? 'rose' : 'teal') : 'muted-badge'}`,
                wins.length ? `${wins.length} window${wins.length === 1 ? '' : 's'}` : 'None set'
            ));
            card.appendChild(head);

            const chipsWrap = el('div', 'sched-weekday-chips');
            if (!wins.length) {
                chipsWrap.appendChild(el('span', 'muted small', 'No regular hours configured.'));
            } else {
                wins.forEach((w, idx) => {
                    const chip = el('span', 'sched-win-chip' + (isDefense ? ' rose' : ''));
                    chip.appendChild(el('span', '', w.label));
                    const rmBtn = el('button', '', '×');
                    rmBtn.type = 'button';
                    rmBtn.title = `Remove ${w.label}`;
                    rmBtn.addEventListener('click', () => removeRegularHourWindow(dow, idx, rmBtn));
                    chip.appendChild(rmBtn);
                    chipsWrap.appendChild(chip);
                });
            }
            card.appendChild(chipsWrap);

            const addRow = el('div', 'sched-weekday-add-row');
            const startInp = document.createElement('input');
            startInp.type = 'time';
            startInp.step = '300';
            startInp.value = isDefense ? '09:00' : '14:10';
            startInp.setAttribute('aria-label', `${WEEKDAY_FULL[dow]} start time`);

            const endInp = document.createElement('input');
            endInp.type = 'time';
            endInp.step = '300';
            endInp.value = isDefense ? '12:00' : '15:30';
            endInp.setAttribute('aria-label', `${WEEKDAY_FULL[dow]} end time`);

            const addBtn = el('button', 'btn btn-primary-soft btn-sm', '+ Add');
            addBtn.type = 'button';
            addBtn.addEventListener('click', () => addRegularHourWindow(dow, startInp.value, endInp.value, addBtn));

            addRow.append(startInp, el('span', 'muted small', '–'), endInp, addBtn);
            card.appendChild(addRow);

            grid.appendChild(card);
        });
    }

    async function saveRegularHoursMap(type, nextHoursMap, triggerBtn) {
        if (triggerBtn) triggerBtn.disabled = true;
        try {
            const payload = type === 'defense'
                ? { defenseHoursByDay: nextHoursMap }
                : { consultationHoursByDay: nextHoursMap };
            const { scheduleConfig } = await api('/api/admin/schedule/regular-hours', {
                method: 'PUT',
                body: JSON.stringify(payload),
            });
            state.scheduleConfig = scheduleConfig;
            renderScheduleManager();
            updateHeaderDates();
            window.SchedulerRealtime?.notifyLocal({ type: 'schedule_config_updated' });
            toast(`Saved ${type === 'defense' ? 'Defense' : 'Consultation'} regular hours.`, 'success');
        } catch (err) {
            if (triggerBtn) triggerBtn.disabled = false;
            toast(err.message, 'error');
        }
    }

    function cloneRawHoursMap(source) {
        const out = {};
        for (let d = 0; d <= 6; d += 1) {
            const arr = source?.[d] || source?.[String(d)] || [];
            out[d] = arr.map((w) => [w.startMinute, w.endMinute]);
        }
        return out;
    }

    async function addRegularHourWindow(dow, startStr, endStr, btn) {
        const s = timeValToMinute(startStr);
        const e = timeValToMinute(endStr);
        const isDefense = state.schedRegType === 'defense';
        if (s === null || e === null || s >= e) {
            toast('End time must be after start time.', 'error');
            return;
        }
        if (isDefense && e - s < 60) {
            toast('Defense hours must be at least 1 hour (60 minutes) long.', 'error');
            return;
        }
        if (!isDefense && e - s < 5) {
            toast('Consultation window must be at least 5 minutes long.', 'error');
            return;
        }
        const source = isDefense ? state.scheduleConfig?.defenseHoursByDay : state.scheduleConfig?.consultationHoursByDay;
        const nextMap = cloneRawHoursMap(source);
        nextMap[dow].push([s, e]);
        await saveRegularHoursMap(state.schedRegType, nextMap, btn);
    }

    async function removeRegularHourWindow(dow, idx, btn) {
        const isDefense = state.schedRegType === 'defense';
        const source = isDefense ? state.scheduleConfig?.defenseHoursByDay : state.scheduleConfig?.consultationHoursByDay;
        const nextMap = cloneRawHoursMap(source);
        nextMap[dow].splice(idx, 1);
        await saveRegularHoursMap(state.schedRegType, nextMap, btn);
    }

    async function resetRegularHoursToPreset(btn) {
        const isDefense = state.schedRegType === 'defense';
        const label = isDefense ? 'Defense Hours (Mon–Sat)' : 'Consultation Hours (Tue 2:10–3:30 PM, Wed 12:50–2:10 PM, Thu 2:10–3:30 PM)';
        if (btn) btn.disabled = true;
        try {
            const { scheduleConfig } = await api('/api/admin/schedule/regular-hours', {
                method: 'PUT',
                body: JSON.stringify({ resetPreset: isDefense ? 'defense' : 'consultation' }),
            });
            state.scheduleConfig = scheduleConfig;
            renderScheduleManager();
            updateHeaderDates();
            window.SchedulerRealtime?.notifyLocal({ type: 'schedule_config_updated' });
            toast(`Restored November preset for ${label}.`, 'success');
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    function renderScheduleOverview() {
        const list = $('#schedOverviewList');
        if (!list) return;
        list.innerHTML = '';

        document.querySelectorAll('#schedOverviewFilters [data-overview-filter]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.overviewFilter === state.schedOverviewFilter);
        });

        const filter = state.schedOverviewFilter || 'all';
        const items = [];

        if (filter !== 'blocked') {
            for (const entry of state.scheduleConfig?.openDates || []) {
                if (state.today && entry.date < state.today) continue;
                if (!Array.isArray(entry.effectiveWindows) || !entry.effectiveWindows.length) continue;
                if (filter !== 'all' && entry.category !== filter) continue;
                items.push({ kind: 'open', date: entry.date, entry });
            }
        }

        if (filter === 'all' || filter === 'blocked') {
            for (const blk of state.blockedSchedules || []) {
                if (!isActiveBlock(blk)) continue;
                items.push({ kind: 'block', date: blk.date, blk });
            }
        }

        items.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'block' ? 1 : -1));

        if (!items.length) {
            list.appendChild(el('p', 'muted small', 'No upcoming configured dates match this filter. Select dates on the calendar above to open or block them.'));
            return;
        }

        items.forEach((it) => {
            const row = el('div', 'sched-overview-item');
            const left = el('div', 'sched-overview-item-left');

            const dateBtn = el('button', 'sched-overview-date-btn', longDate(it.date));
            dateBtn.type = 'button';
            dateBtn.addEventListener('click', () => {
                const [y, m] = it.date.split('-').map(Number);
                state.schedViewYear = y;
                state.schedViewMonth = m - 1;
                state.schedSelectMode = 'single';
                state.schedRangeAnchor = null;
                state.schedSelectedDates = new Set([it.date]);
                document.querySelectorAll('.sched-mode-pill[data-select-mode]').forEach((b) => {
                    b.classList.toggle('active', b.dataset.selectMode === 'single');
                });
                $('#schedRangeSkipSunWrap')?.classList.add('hidden');
                renderScheduleManager();
                $('.sched-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            left.appendChild(dateBtn);

            if (it.kind === 'open') {
                const meta = CATEGORY_META[it.entry.category] || CATEGORY_META.consultation;
                left.appendChild(el('span', `badge ${meta.badgeCls}`, meta.label));
                left.appendChild(el('span', 'muted small', `${it.entry.label}${it.entry.note ? ` · ${it.entry.note}` : ''}`));
                const closeBtn = el('button', 'btn btn-danger-soft btn-sm', 'Close');
                closeBtn.type = 'button';
                closeBtn.addEventListener('click', () => closeScheduleDates([it.date], [it.entry.category], closeBtn));
                row.append(left, closeBtn);
            } else {
                left.appendChild(el('span', 'badge danger', `Blocked · ${it.blk.label}`));
                if (it.blk.reason) left.appendChild(el('span', 'muted small', it.blk.reason));
                const unblockBtn = el('button', 'btn btn-ghost btn-sm', 'Unblock');
                unblockBtn.type = 'button';
                unblockBtn.addEventListener('click', () => unblockSchedule(it.blk, unblockBtn));
                row.append(left, unblockBtn);
            }

            list.appendChild(row);
        });
    }

    function renderScheduleManager() {
        if ($('#countScheduleOpen')) {
            $('#countScheduleOpen').textContent = countUpcomingOpenScheduleItems();
        }
        if (state.adminView !== 'schedule') return;
        renderScheduleCalendar();
        renderScheduleInspector();
        renderRegularHoursSection();
        renderScheduleOverview();
    }

    async function submitOpenScheduleForm(e) {
        e.preventDefault();
        if (state.schedBusy) return;
        setSchedOpenError('');

        const dates = getSortedSelectedDates();
        if (!dates.length) {
            setSchedOpenError('Please select at least one date on the calendar first.');
            return;
        }

        let windows = [];
        if (state.schedHourMode === 'custom') {
            for (const w of state.schedCustomWindows) {
                const s = timeValToMinute(w.start);
                const end = timeValToMinute(w.end);
                if (s === null || end === null || s >= end) {
                    setSchedOpenError('Each custom time window must have an end time after its start time.');
                    return;
                }
                windows.push([s, end]);
            }
            if (state.schedCategory === 'defense' && !windows.some(([s, end]) => end - s >= 60)) {
                setSchedOpenError('Custom Defense windows must be at least 1 hour (60 minutes) long.');
                return;
            }
        }

        const note = ($('#schedOpenNoteInput')?.value || '').trim();
        const unblockDates = Boolean(!$('#schedAutoUnblockWrap')?.classList.contains('hidden') && $('#schedAutoUnblockInput')?.checked);

        state.schedBusy = true;
        const submitBtn = $('#schedOpenSubmitBtn');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.querySelector('.spinner')?.classList.remove('hidden');
            if ($('#schedOpenSubmitLabel')) $('#schedOpenSubmitLabel').textContent = 'Saving…';
        }

        try {
            const res = await api('/api/admin/schedule/open', {
                method: 'POST',
                body: JSON.stringify({
                    dates,
                    categories: [state.schedCategory],
                    mode: state.schedHourMode,
                    windows,
                    note,
                    unblockDates,
                }),
            });
            state.scheduleConfig = res.scheduleConfig;
            const openedDates = Array.isArray(res.openedDates) && res.openedDates.length ? res.openedDates : dates;
            const skippedDates = Array.isArray(res.skippedDates) ? res.skippedDates : [];
            if (unblockDates && res.unblockedCount > 0) {
                const dateSet = new Set(openedDates);
                state.blockedSchedules = state.blockedSchedules.filter((b) => !(dateSet.has(b.date) && b.isFullDay));
            }
            if ($('#schedOpenNoteInput')) $('#schedOpenNoteInput').value = '';
            state.schedBusy = false;
            updateHeaderDates();
            renderScheduleManager();
            window.SchedulerRealtime?.notifyLocal({ type: 'schedule_config_updated', dates: openedDates });
            const catLabel = CATEGORY_META[state.schedCategory]?.label || 'Schedule';
            const skippedNote = skippedDates.length
                ? ` (skipped ${skippedDates.length} day${skippedDates.length === 1 ? '' : 's'} with no regular hours)`
                : '';
            toast(
                `Opened ${catLabel} on ${openedDates.length === 1 ? shortDate(openedDates[0]) : `${openedDates.length} dates`}${skippedNote}.`,
                'success'
            );
        } catch (err) {
            setSchedOpenError(err.message);
        } finally {
            state.schedBusy = false;
            if (submitBtn) {
                submitBtn.querySelector('.spinner')?.classList.add('hidden');
            }
            renderScheduleInspector();
        }
    }

    async function closeScheduleDates(dates, categories, btn) {
        if (btn) btn.disabled = true;
        try {
            const res = await api('/api/admin/schedule/close', {
                method: 'POST',
                body: JSON.stringify({ dates, categories }),
            });
            state.scheduleConfig = res.scheduleConfig;
            if (categories.includes('letter_pickup')) {
                const dSet = new Set(dates);
                state.letterPickupSchedules = state.letterPickupSchedules.filter((x) => !dSet.has(x.date));
            }
            updateHeaderDates();
            renderScheduleManager();
            window.SchedulerRealtime?.notifyLocal({ type: 'schedule_config_updated', dates });
            toast(`Closed selected schedule on ${dates.length === 1 ? shortDate(dates[0]) : `${dates.length} dates`}.`, 'success');
        } catch (err) {
            if (btn) btn.disabled = false;
            toast(err.message, 'error');
        }
    }

    async function submitBlockScheduleForm(e) {
        e.preventDefault();
        if (state.schedBusy) return;
        setSchedBlockError('');

        const dates = getSortedSelectedDates();
        if (!dates.length) {
            setSchedBlockError('Please select at least one date on the calendar to block.');
            return;
        }

        const isFullDay = state.schedBlockScope === 'full';
        let startMinute = null;
        let endMinute = null;
        if (!isFullDay) {
            startMinute = timeValToMinute($('#schedBlockStartInput')?.value);
            endMinute = timeValToMinute($('#schedBlockEndInput')?.value);
            if (startMinute === null || endMinute === null || startMinute >= endMinute) {
                setSchedBlockError('End time must be after start time.');
                return;
            }
        }

        const reason = ($('#schedBlockReasonInput')?.value || '').trim();
        const cancelExisting = Boolean($('#schedBlockCancelExisting')?.checked);

        state.schedBusy = true;
        const submitBtn = $('#schedBlockSubmitBtn');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.querySelector('.spinner')?.classList.remove('hidden');
            if ($('#schedBlockSubmitLabel')) $('#schedBlockSubmitLabel').textContent = 'Blocking…';
        }

        try {
            const res = await api('/api/admin/blocks', {
                method: 'POST',
                body: JSON.stringify({
                    dates,
                    isFullDay,
                    startMinute,
                    endMinute,
                    reason,
                    cancelExisting,
                }),
            });

            const addedBlocks = res.blocks || [];
            state.blockedSchedules.push(...addedBlocks);
            state.blockedSchedules.sort(
                (a, b) => a.date.localeCompare(b.date) || (a.startMinute ?? 0) - (b.startMinute ?? 0)
            );

            const cancelledList = res.cancelledBookings || [];
            if (cancelledList.length) {
                const byId = new Map(cancelledList.map((c) => [c.id, c]));
                state.bookings.forEach((b) => {
                    if (byId.has(b.id)) Object.assign(b, byId.get(b.id));
                });
            }

            if ($('#schedBlockReasonInput')) $('#schedBlockReasonInput').value = '';
            state.schedBusy = false;
            render();
            window.SchedulerRealtime?.notifyLocal({ type: 'block_created', dates });

            const cancelledMsg = cancelledList.length
                ? ` (${cancelledList.length} appointment${cancelledList.length === 1 ? '' : 's'} cancelled)`
                : '';
            toast(
                `Blocked ${dates.length === 1 ? shortDate(dates[0]) : `${dates.length} dates`}${cancelledMsg}.`,
                'success'
            );
        } catch (err) {
            setSchedBlockError(err.message);
        } finally {
            state.schedBusy = false;
            if (submitBtn) {
                submitBtn.querySelector('.spinner')?.classList.add('hidden');
            }
            renderScheduleInspector();
        }
    }

    async function unblockSchedule(blk, btn) {
        if (btn) btn.disabled = true;
        try {
            await api(`/api/admin/blocks/${blk.id}`, { method: 'DELETE' });
            state.blockedSchedules = state.blockedSchedules.filter((x) => x.id !== blk.id);
            render();
            window.SchedulerRealtime?.notifyLocal({ type: 'block_removed', date: blk.date });
            toast(`Unblocked ${shortDate(blk.date)}.`, 'success');
        } catch (err) {
            if (btn) btn.disabled = false;
            toast(err.message, 'error');
        }
    }

    async function unblockSelectedDates(dates, btn) {
        if (btn) btn.disabled = true;
        try {
            await api('/api/admin/blocks/unblock-dates', {
                method: 'POST',
                body: JSON.stringify({ dates }),
            });
            const dSet = new Set(dates);
            state.blockedSchedules = state.blockedSchedules.filter((x) => !dSet.has(x.date));
            render();
            window.SchedulerRealtime?.notifyLocal({ type: 'block_removed', dates });
            toast(`Unblocked ${dates.length} date${dates.length === 1 ? '' : 's'}.`, 'success');
        } catch (err) {
            if (btn) btn.disabled = false;
            toast(err.message, 'error');
        }
    }

    /* ---------------- cancel modal ---------------- */
    function setCancelError(msg) {
        const input = $('#cancelReasonInput');
        const errEl = $('#cancelReasonError');
        if (input) input.classList.toggle('input-invalid', Boolean(msg));
        if (errEl) {
            errEl.textContent = msg || '';
            errEl.classList.toggle('hidden', !msg);
        }
    }

    function openCancelModal(b) {
        state.cancelTarget = b;
        const title = b.capstoneTitle || b.teamName || b.name;
        const summary = $('#cancelTargetSummary');
        if (summary) {
            summary.innerHTML = '';
            summary.appendChild(el('strong', '', title));
            summary.appendChild(el('span', 'muted small', `${b.consultationTitle || 'Consultation'} · ${longDate(b.date)} · ${b.label}`));
        }
        const input = $('#cancelReasonInput');
        if (input) {
            input.value = '';
            $('#cancelReasonCount').textContent = '0';
        }
        setCancelError('');
        $('#cancelModal')?.classList.remove('hidden');
        syncModalBodyLock();
        if (window.matchMedia('(hover: hover)').matches) {
            setTimeout(() => input?.focus(), 40);
        }
    }

    function closeCancelModal() {
        if (state.cancelling) return;
        state.cancelTarget = null;
        $('#cancelModal')?.classList.add('hidden');
        syncModalBodyLock();
        setCancelError('');
    }

    async function submitCancelBooking(e) {
        e.preventDefault();
        if (state.cancelling || !state.cancelTarget) return;

        const b = state.cancelTarget;
        const reason = ($('#cancelReasonInput')?.value || '').trim();
        if (reason.length < 3) {
            setCancelError('Please enter a reason (at least 3 characters) so the student can see why it was cancelled.');
            $('#cancelReasonInput')?.focus();
            return;
        }

        state.cancelling = true;
        const confirmBtn = $('#confirmCancelBtn');
        const keepBtn = $('#keepAppointmentBtn');
        confirmBtn.disabled = true;
        if (keepBtn) keepBtn.disabled = true;
        confirmBtn.querySelector('.spinner')?.classList.remove('hidden');
        confirmBtn.querySelector('.btn-label').textContent = 'Cancelling…';

        try {
            const { booking } = await api(`/api/admin/bookings/${b.id}/cancel`, {
                method: 'POST',
                body: JSON.stringify({ reason }),
            });
            Object.assign(b, booking);
            state.cancelling = false;
            closeCancelModal();
            render();
            window.SchedulerRealtime?.notifyLocal({ type: 'booking_cancelled', bookingId: b.id, date: b.date });
            toast('Consultation cancelled. Reason is now visible in the student’s profile.', 'success');
        } catch (err) {
            setCancelError(err.message);
        } finally {
            state.cancelling = false;
            confirmBtn.disabled = false;
            if (keepBtn) keepBtn.disabled = false;
            confirmBtn.querySelector('.spinner')?.classList.add('hidden');
            confirmBtn.querySelector('.btn-label').textContent = 'Cancel consultation';
        }
    }

    function getBookingRecipientEmails(b) {
        const seen = new Set();
        const list = [];
        [b?.studentEmail, ...(Array.isArray(b?.memberEmails) ? b.memberEmails : [])].forEach((raw) => {
            const clean = String(raw || '').trim().toLowerCase();
            if (clean && !seen.has(clean)) {
                seen.add(clean);
                list.push(clean);
            }
        });
        return list;
    }

    async function notifyManuscriptChecked(b, btn) {
        const recipients = getBookingRecipientEmails(b);
        const target = recipients.length ? recipients.join(', ') : (b.studentEmail || 'student');
        const again = b.notifiedAt ? ' again' : '';
        if (!confirm(`Send "Manuscript Ready for Pickup" notification email${again} to ${target}?`)) return;
        btn.disabled = true;
        const prevText = btn.textContent;
        btn.textContent = 'Sending…';
        try {
            const res = await api(`/api/admin/bookings/${b.id}/notify-checked`, { method: 'POST' });
            b.notifiedAt = res.notifiedAt;
            render();
            loadBookings();
            window.SchedulerRealtime?.notifyLocal({ type: 'manuscript_checked', bookingId: b.id, date: b.date });
            const sentList = Array.isArray(res.recipients) && res.recipients.length ? res.recipients.join(', ') : target;
            toast(`Notification emailed to ${sentList}.`, 'success');
        } catch (err) {
            btn.disabled = false;
            btn.textContent = prevText;
            toast(err.message, 'error');
        }
    }

    async function notifyLetterReady(b, btn) {
        const recipients = getBookingRecipientEmails(b);
        const target = recipients.length ? recipients.join(', ') : (b.studentEmail || 'student');
        const again = b.notifiedAt ? ' again' : '';
        const hasOpenPickupWindows = hasUpcomingLetterPickupWindow();
        const noWindowWarning = hasOpenPickupWindows
            ? ''
            : '\n\nNote: You currently have 0 upcoming Letter Pickup dates open. Remember to open a date for "Comm. Letter Pickup" in Schedule & Availability so the student can book a slot.';
        if (!confirm(`Send "Communication Letter Ready for Pickup" notification email${again} to ${target}?${noWindowWarning}`)) return;
        btn.disabled = true;
        const prevText = btn.textContent;
        btn.textContent = 'Sending…';
        try {
            const res = await api(`/api/admin/bookings/${b.id}/notify-letter-ready`, { method: 'POST' });
            b.notifiedAt = res.notifiedAt;
            render();
            loadBookings();
            window.SchedulerRealtime?.notifyLocal({ type: 'letter_notified', bookingId: b.id, date: b.date });
            const sentList = Array.isArray(res.recipients) && res.recipients.length ? res.recipients.join(', ') : target;
            toast(
                hasOpenPickupWindows
                    ? `Notification emailed to ${sentList}.`
                    : `Notification emailed to ${sentList}. Open a Letter Pickup date in "Schedule & Availability" so they can book.`,
                'success'
            );
        } catch (err) {
            btn.disabled = false;
            btn.textContent = prevText;
            toast(err.message, 'error');
        }
    }

    /* ---------------- manual send email modal ---------------- */
    const EMAIL_TEMPLATES = {
        manuscript_ready: {
            subject: 'Manuscript Ready for Pickup — Please Schedule Your Retrieval',
            hint: 'Tells the student their manuscript has been reviewed and is ready for pickup, and directs them to schedule a 5-minute Retrieval of Manuscript appointment online.',
            placeholder: 'Optional note or pickup instructions (e.g. bring all members, revisions summary)…',
            requiresMessage: false,
        },
        letter_ready: {
            subject: 'Communication Letter Ready for Pickup',
            hint: 'Tells the student their communication letter has been signed and is ready for pickup at your office.',
            placeholder: 'Optional note or pickup instructions (e.g. pick up during office hours)…',
            requiresMessage: false,
        },
        schedule_reminder: {
            subject: 'Reminder: Please Schedule Your Consultation / Drop-off Appointment Online',
            hint: 'Reminds the student group to book an appointment online (for Drop-off Manuscript, Communication Letter Signature, System Consultation, or Defense) at least 1 day ahead.',
            placeholder: 'Optional note specifying what they need to schedule (e.g. please book a Manuscript Drop-off or Comm. Letter signing)…',
            requiresMessage: false,
        },
        custom: {
            subject: '',
            hint: 'Write your own subject and custom message directly to the student.',
            placeholder: 'Write your message to the student…',
            requiresMessage: true,
        },
    };

    function setSendEmailError(msg) {
        const errEl = $('#sendEmailFormError');
        if (!errEl) return;
        errEl.textContent = msg || '';
        errEl.classList.toggle('hidden', !msg);
    }

    function populateEmailStudentOptions() {
        const select = $('#emailStudentSelect');
        if (!select) return;
        select.innerHTML = '';

        const manualOpt = document.createElement('option');
        manualOpt.value = '';
        manualOpt.textContent = 'Manual / Other email address';
        select.appendChild(manualOpt);

        const sorted = state.students
            .slice()
            .sort((a, b) => (a.capstoneTitle || a.name || '').localeCompare(b.capstoneTitle || b.name || ''));

        sorted.forEach((s) => {
            const studentBookings = state.bookings.filter(
                (b) => !isCancelled(b) && (
                    (b.studentId && b.studentId === s.id)
                    || (b.studentEmail && s.email && b.studentEmail.toLowerCase() === s.email.toLowerCase())
                )
            );
            const hasDropoff = studentBookings.some((b) => b.consultationType === 'dropoff');
            const hasLetter = studentBookings.some((b) => b.consultationType === 'letter');

            const tags = [];
            if (!studentBookings.length) {
                tags.push('No appointments');
            } else if (s.instructorRole === 'adviser' && !hasDropoff && !hasLetter) {
                tags.push('No drop-off/letter');
            } else if (!hasDropoff) {
                tags.push('No drop-off');
            }

            const title = s.capstoneTitle || s.name || 'Student Group';
            const rep = s.name && s.capstoneTitle ? ` — ${s.name}` : '';
            const emailPart = s.email ? ` (${s.email})` : '';
            const tagPart = tags.length ? ` [${tags.join(', ')}]` : '';

            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = `${title}${rep}${emailPart}${tagPart}`;
            select.appendChild(opt);
        });
    }

    function syncEmailGroupmatesOption() {
        const wrap = $('#emailGroupmatesWrap');
        const textEl = $('#emailGroupmatesText');
        const checkEl = $('#emailIncludeGroupmates');
        if (!wrap || !textEl || !checkEl) return;

        const selectedId = $('#emailStudentSelect')?.value || '';
        const student = state.students.find((s) => s.id === selectedId);
        const currentRecipient = ($('#emailRecipientInput')?.value || '').trim().toLowerCase();
        const extraEmails = (Array.isArray(student?.memberEmails) ? student.memberEmails.slice(1) : [])
            .map((e) => String(e || '').trim().toLowerCase())
            .filter((e) => e && e !== currentRecipient);

        if (student && currentRecipient === String(student.email || '').toLowerCase() && extraEmails.length > 0) {
            textEl.textContent = `Also send to groupmate${extraEmails.length > 1 ? 's' : ''} (${extraEmails.join(', ')})`;
            wrap.classList.remove('hidden');
        } else {
            wrap.classList.add('hidden');
        }
    }

    function applySelectedEmailStudent(clearIfEmpty = false) {
        const select = $('#emailStudentSelect');
        if (!select) return;
        const selectedId = select.value;
        const student = state.students.find((s) => s.id === selectedId);
        if (student) {
            if ($('#emailRecipientInput')) $('#emailRecipientInput').value = student.email || '';
            if ($('#emailStudentNameInput')) $('#emailStudentNameInput').value = student.name || '';
            if ($('#emailCapstoneInput')) $('#emailCapstoneInput').value = student.capstoneTitle || '';
            if ($('#emailIncludeGroupmates')) $('#emailIncludeGroupmates').checked = true;
        } else if (clearIfEmpty) {
            if ($('#emailRecipientInput')) $('#emailRecipientInput').value = '';
            if ($('#emailStudentNameInput')) $('#emailStudentNameInput').value = '';
            if ($('#emailCapstoneInput')) $('#emailCapstoneInput').value = '';
        }
        syncEmailGroupmatesOption();
        setSendEmailError('');
    }

    function setEmailTemplate(tpl, forceSubject = false) {
        const normalized = Object.prototype.hasOwnProperty.call(EMAIL_TEMPLATES, tpl) ? tpl : 'manuscript_ready';
        const prevMeta = EMAIL_TEMPLATES[state.emailTemplate] || EMAIL_TEMPLATES.manuscript_ready;
        const nextMeta = EMAIL_TEMPLATES[normalized];
        state.emailTemplate = normalized;

        document.querySelectorAll('input[name="emailTemplate"]').forEach((r) => {
            r.checked = r.value === normalized;
        });

        const hintEl = $('#emailTemplateHint');
        if (hintEl) {
            if (normalized === 'letter_ready' && !hasUpcomingLetterPickupWindow()) {
                hintEl.textContent = `${nextMeta.hint} (Tip: You currently have 0 upcoming Letter Pickup dates open — open one in "Schedule & Availability" so the student can book a slot.)`;
            } else {
                hintEl.textContent = nextMeta.hint;
            }
        }

        const msgLabel = $('#emailMessageLabel');
        if (msgLabel) {
            msgLabel.innerHTML = nextMeta.requiresMessage
                ? 'Message'
                : 'Additional note / remarks <small class="muted">(optional)</small>';
        }

        const msgInput = $('#emailMessageInput');
        if (msgInput) {
            msgInput.placeholder = nextMeta.placeholder;
            msgInput.required = nextMeta.requiresMessage;
        }

        const subjInput = $('#emailSubjectInput');
        if (subjInput) {
            const currentVal = subjInput.value.trim();
            if (forceSubject || !currentVal || currentVal === prevMeta.subject) {
                subjInput.value = nextMeta.subject;
            }
        }
        setSendEmailError('');
    }

    function openSendEmailModal(preselectedStudent = null, defaultTemplate = 'manuscript_ready') {
        populateEmailStudentOptions();
        const select = $('#emailStudentSelect');
        if (select) {
            select.value = preselectedStudent?.id || '';
        }

        if (preselectedStudent) {
            if ($('#emailRecipientInput')) $('#emailRecipientInput').value = preselectedStudent.email || '';
            if ($('#emailStudentNameInput')) $('#emailStudentNameInput').value = preselectedStudent.name || '';
            if ($('#emailCapstoneInput')) $('#emailCapstoneInput').value = preselectedStudent.capstoneTitle || '';
        } else {
            if ($('#emailRecipientInput')) $('#emailRecipientInput').value = '';
            if ($('#emailStudentNameInput')) $('#emailStudentNameInput').value = '';
            if ($('#emailCapstoneInput')) $('#emailCapstoneInput').value = '';
        }

        if ($('#emailMessageInput')) {
            $('#emailMessageInput').value = '';
            if ($('#emailMessageCount')) $('#emailMessageCount').textContent = '0';
        }

        if ($('#emailIncludeGroupmates')) $('#emailIncludeGroupmates').checked = true;
        syncEmailGroupmatesOption();
        setEmailTemplate(defaultTemplate, true);
        setSendEmailError('');
        $('#sendEmailModal')?.classList.remove('hidden');
        syncModalBodyLock();

        if (window.matchMedia('(hover: hover)').matches) {
            setTimeout(() => {
                if (preselectedStudent) $('#emailMessageInput')?.focus();
                else $('#emailStudentSelect')?.focus();
            }, 40);
        }
    }

    function closeSendEmailModal() {
        if (state.sendingEmail) return;
        $('#sendEmailModal')?.classList.add('hidden');
        syncModalBodyLock();
        setSendEmailError('');
    }

    async function submitSendEmail(e) {
        e.preventDefault();
        if (state.sendingEmail) return;
        setSendEmailError('');

        const studentId = ($('#emailStudentSelect')?.value || '').trim();
        const email = ($('#emailRecipientInput')?.value || '').trim().toLowerCase();
        const studentName = ($('#emailStudentNameInput')?.value || '').trim();
        const capstoneTitle = ($('#emailCapstoneInput')?.value || '').trim();
        const template = state.emailTemplate || 'manuscript_ready';
        const meta = EMAIL_TEMPLATES[template] || EMAIL_TEMPLATES.custom;
        const subject = ($('#emailSubjectInput')?.value || '').trim();
        const message = ($('#emailMessageInput')?.value || '').trim();

        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            setSendEmailError('Please enter a valid recipient email address.');
            $('#emailRecipientInput')?.focus();
            return;
        }
        if (!subject) {
            setSendEmailError('Please enter an email subject.');
            $('#emailSubjectInput')?.focus();
            return;
        }
        if (meta.requiresMessage && !message) {
            setSendEmailError('Please enter a message to send to the student.');
            $('#emailMessageInput')?.focus();
            return;
        }

        state.sendingEmail = true;
        const sendBtn = $('#confirmSendEmailBtn');
        const cancelBtn = $('#cancelSendEmailModalBtn');
        const closeBtn = $('#closeSendEmailModalBtn');
        if (sendBtn) {
            sendBtn.disabled = true;
            sendBtn.querySelector('.spinner')?.classList.remove('hidden');
            sendBtn.querySelector('.btn-label').textContent = 'Sending…';
        }
        if (cancelBtn) cancelBtn.disabled = true;
        if (closeBtn) closeBtn.disabled = true;

        try {
            const includeGroupmates = Boolean(
                !$('#emailGroupmatesWrap')?.classList.contains('hidden') && $('#emailIncludeGroupmates')?.checked
            );
            const res = await api('/api/admin/send-email', {
                method: 'POST',
                body: JSON.stringify({
                    studentId: studentId || null,
                    email,
                    includeGroupmates,
                    studentName,
                    capstoneTitle,
                    template,
                    subject,
                    message,
                }),
            });
            state.sendingEmail = false;
            closeSendEmailModal();
            if (res.emailLog) {
                state.emailLogs = [res.emailLog, ...state.emailLogs.filter((x) => x.id !== res.emailLog.id)];
                renderEmailLogsSection();
            }
            loadBookings();
            if (template === 'manuscript_ready' || template === 'letter_ready') {
                window.SchedulerRealtime?.notifyLocal({
                    type: 'student_pickup_notified',
                    studentId: studentId || null,
                    template,
                });
            }
            toast(`Email sent to ${res.to || email}.`, 'success');
        } catch (err) {
            setSendEmailError(err.message);
        } finally {
            state.sendingEmail = false;
            if (sendBtn) {
                sendBtn.disabled = false;
                sendBtn.querySelector('.spinner')?.classList.add('hidden');
                sendBtn.querySelector('.btn-label').textContent = 'Send email';
            }
            if (cancelBtn) cancelBtn.disabled = false;
            if (closeBtn) closeBtn.disabled = false;
        }
    }

    const LEVEL_LABELS = {
        capstone1: 'Capstone 1',
        capstone2: 'Capstone 2',
        thesis1: 'Thesis 1',
        thesis2: 'Thesis 2',
    };

    const DEFENSE_DURATIONS = {
        capstone1: { minutes: 60, label: '1 hour' },
        capstone2: { minutes: 120, label: '2 hours' },
        thesis1: { minutes: 60, label: '1 hour' },
        thesis2: { minutes: 120, label: '2 hours' },
    };

    /* ---------------- admin schedule group for defense modal ---------------- */
    function setDefenseFormError(msg = '', invalidFieldId = '') {
        document.querySelectorAll('#scheduleDefenseForm .input-invalid').forEach((inp) => {
            inp.classList.remove('input-invalid');
        });
        if (invalidFieldId) {
            const target = document.getElementById(invalidFieldId);
            if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
                target.classList.add('input-invalid');
            }
        }
        const errEl = $('#defFormError');
        if (!errEl) return;
        errEl.textContent = msg || '';
        errEl.classList.toggle('hidden', !msg);
    }

    function getSelectedDefenseLevel() {
        const checked = document.querySelector('input[name="defLevel"]:checked')?.value || 'capstone1';
        return Object.prototype.hasOwnProperty.call(DEFENSE_DURATIONS, checked) ? checked : 'capstone1';
    }

    function getSelectedDefenseRole() {
        const checked = document.querySelector('input[name="defRole"]:checked')?.value || 'panel';
        return checked === 'adviser' ? 'adviser' : 'panel';
    }

    function findUpcomingDefenseForStudent(student) {
        if (!student) return null;
        return state.bookings.find((b) => {
            if (isCancelled(b) || isPast(b) || b.consultationType !== 'defense') return false;
            if (b.studentId && student.id && b.studentId === student.id) return true;
            if (b.studentEmail && student.email && b.studentEmail.toLowerCase() === student.email.toLowerCase()) return true;
            return false;
        }) || null;
    }

    function getActiveReplaceDefenseBooking() {
        if (state.defExplicitRescheduleTarget) return state.defExplicitRescheduleTarget;
        if (state.defAutoDetectedUpcomingDefense && $('#defReplaceExistingCheck')?.checked) {
            return state.defAutoDetectedUpcomingDefense;
        }
        return null;
    }

    function populateDefenseStudentOptions() {
        const select = $('#defStudentSelect');
        if (!select) return;
        select.innerHTML = '';

        const manualOpt = document.createElement('option');
        manualOpt.value = '';
        manualOpt.textContent = 'Manual / Unregistered group (enter details below)';
        select.appendChild(manualOpt);

        // Sort Panel groups first since panel scheduling is the primary workflow, then alphabetical by title
        const sorted = state.students.slice().sort((a, b) => {
            const aPanel = a.instructorRole === 'panel' ? 0 : 1;
            const bPanel = b.instructorRole === 'panel' ? 0 : 1;
            if (aPanel !== bPanel) return aPanel - bPanel;
            return (a.capstoneTitle || a.name || '').localeCompare(b.capstoneTitle || b.name || '');
        });

        sorted.forEach((s) => {
            const upcomingDef = findUpcomingDefenseForStudent(s);
            const title = s.capstoneTitle || s.name || 'Student Group';
            const rep = s.name && s.capstoneTitle ? ` — ${s.name}` : '';
            const roleTag = s.instructorRole === 'panel'
                ? 'Panel'
                : s.instructorRole === 'adviser'
                    ? 'Adviser'
                    : '';
            const lvlTag = LEVEL_LABELS[s.projectLevel] || '';
            const metaTags = [lvlTag, roleTag].filter(Boolean).join(' · ');
            const defNote = upcomingDef ? ` [Defense: ${shortDate(upcomingDef.date)}]` : '';

            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = `${title}${rep}${metaTags ? ` (${metaTags})` : ''}${defNote}`;
            select.appendChild(opt);
        });
    }

    function renderDefenseMemberInputs() {
        const list = $('#defMemberList');
        if (!list) return;
        list.innerHTML = '';

        if (!Array.isArray(state.defDraftMembers) || !state.defDraftMembers.length) {
            state.defDraftMembers = [''];
        }
        state.defDraftMembers = state.defDraftMembers.slice(0, 3);

        state.defDraftMembers.forEach((val, idx) => {
            const row = el('div', 'member-row');
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.maxLength = 100;
            inp.value = val;
            inp.placeholder = idx === 0 ? 'Member 1 / Representative full name' : `Member ${idx + 1} full name`;
            inp.addEventListener('input', () => {
                state.defDraftMembers[idx] = inp.value;
                setDefenseFormError('');
            });
            row.appendChild(inp);

            if (state.defDraftMembers.length > 1) {
                const rmBtn = el('button', 'remove-member');
                rmBtn.type = 'button';
                rmBtn.title = `Remove member ${idx + 1}`;
                rmBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
                rmBtn.addEventListener('click', () => {
                    state.defDraftMembers.splice(idx, 1);
                    renderDefenseMemberInputs();
                });
                row.appendChild(rmBtn);
            }

            list.appendChild(row);
        });

        if ($('#defMembersCountLabel')) {
            $('#defMembersCountLabel').textContent = `(${state.defDraftMembers.length}/3)`;
        }
        $('#defAddMemberBtn')?.classList.toggle('hidden', state.defDraftMembers.length >= 3);
    }

    function syncDefenseEmailControls() {
        const selectedId = $('#defStudentSelect')?.value || '';
        const student = state.students.find((s) => s.id === selectedId) || null;
        const manualWrap = $('#defManualEmailsWrap');
        const groupmatesWrap = $('#defIncludeGroupmatesWrap');
        const groupmatesText = $('#defIncludeGroupmatesText');
        const sendLabel = $('#defSendEmailLabel');
        const sendCheck = $('#defSendEmailCheck');

        const isRescheduling = Boolean(getActiveReplaceDefenseBooking());
        const actionWord = isRescheduling ? 'reschedule update' : 'defense confirmation';

        if (student) {
            manualWrap?.classList.add('hidden');
            const extraEmails = (Array.isArray(student.memberEmails) ? student.memberEmails.slice(1) : [])
                .map((e) => String(e || '').trim().toLowerCase())
                .filter((e) => e && e !== String(student.email || '').toLowerCase());
            if (sendLabel) {
                sendLabel.textContent = student.email
                    ? `Send ${actionWord} email & calendar invite (.ics) to ${student.email}`
                    : `Send ${actionWord} email & calendar invite (.ics) to the group`;
            }
            if (extraEmails.length > 0 && sendCheck?.checked) {
                if (groupmatesText) {
                    groupmatesText.textContent = `Also send to groupmate${extraEmails.length > 1 ? 's' : ''} (${extraEmails.join(', ')})`;
                }
                groupmatesWrap?.classList.remove('hidden');
            } else {
                groupmatesWrap?.classList.add('hidden');
            }
        } else {
            manualWrap?.classList.remove('hidden');
            groupmatesWrap?.classList.add('hidden');
            const manualPrimary = ($('#defGroupEmailInput')?.value || '').trim().toLowerCase();
            const manualExtras = ($('#defExtraEmailsInput')?.value || '')
                .split(/[,;\s]+/)
                .map((e) => e.trim().toLowerCase())
                .filter(Boolean);
            const count = (manualPrimary ? 1 : 0) + manualExtras.length;
            if (sendLabel) {
                sendLabel.textContent = count > 0
                    ? `Send ${actionWord} email & calendar invite (.ics) (${count} email${count === 1 ? '' : 's'})`
                    : `Send ${actionWord} email & calendar invite (.ics) if an email is entered above`;
            }
        }
    }

    function syncDefenseSubmitLabel() {
        const replaceTarget = getActiveReplaceDefenseBooking();
        const badge = $('#scheduleDefenseModeBadge');
        const title = $('#scheduleDefenseModalTitle');
        if (state.defExplicitRescheduleTarget) {
            if (title) title.textContent = 'Reschedule Group Defense';
            if (badge) badge.textContent = 'Reschedule';
        } else {
            if (title) title.textContent = 'Schedule Group for Defense';
            if (badge) badge.textContent = replaceTarget ? 'Move Existing' : 'Panel Schedule';
        }
        if ($('#confirmScheduleDefenseLabel') && !state.defSaving) {
            $('#confirmScheduleDefenseLabel').textContent = replaceTarget
                ? 'Move & save defense'
                : 'Schedule defense';
        }
        syncDefenseEmailControls();
    }

    function syncDefenseExistingBox(student) {
        const box = $('#defExistingDefenseBox');
        const titleEl = $('#defExistingDefenseTitle');
        const textEl = $('#defExistingDefenseText');
        const replaceCheck = $('#defReplaceExistingCheck');
        if (!box || !textEl || !replaceCheck) return;

        if (state.defExplicitRescheduleTarget) {
            const b = state.defExplicitRescheduleTarget;
            state.defAutoDetectedUpcomingDefense = b;
            box.classList.remove('hidden');
            if (titleEl) titleEl.textContent = 'Rescheduling Scheduled Defense';
            textEl.textContent = `Current schedule: ${longDate(b.date)} · ${b.label} (#${b.reference}). Choose the new panel-agreed date and time below.`;
            replaceCheck.checked = true;
            replaceCheck.parentElement?.classList.add('hidden');
            syncDefenseSubmitLabel();
            return;
        }

        replaceCheck.parentElement?.classList.remove('hidden');
        const detected = findUpcomingDefenseForStudent(student);
        state.defAutoDetectedUpcomingDefense = detected;
        if (detected) {
            box.classList.remove('hidden');
            if (titleEl) titleEl.textContent = 'This group already has an upcoming defense';
            textEl.textContent = `Currently scheduled on ${longDate(detected.date)} · ${detected.label} (#${detected.reference}).`;
            replaceCheck.checked = true;
        } else {
            box.classList.add('hidden');
            replaceCheck.checked = false;
        }
        syncDefenseSubmitLabel();
    }

    function applySelectedDefenseStudent(clearIfEmpty = false) {
        const selectedId = $('#defStudentSelect')?.value || '';
        const student = state.students.find((s) => s.id === selectedId) || null;

        if (student) {
            if ($('#defCapstoneInput')) $('#defCapstoneInput').value = student.capstoneTitle || '';
            const level = Object.prototype.hasOwnProperty.call(DEFENSE_DURATIONS, student.projectLevel)
                ? student.projectLevel
                : getSelectedDefenseLevel();
            document.querySelectorAll('input[name="defLevel"]').forEach((r) => {
                r.checked = r.value === level;
            });
            const role = student.instructorRole === 'adviser' ? 'adviser' : 'panel';
            document.querySelectorAll('input[name="defRole"]').forEach((r) => {
                r.checked = r.value === role;
            });
            state.defDraftMembers = (Array.isArray(student.members) && student.members.length
                ? [...student.members]
                : [student.name || '']).slice(0, 3);
            if ($('#defGroupEmailInput')) $('#defGroupEmailInput').value = student.email || '';
            if ($('#defExtraEmailsInput')) {
                const extras = (Array.isArray(student.memberEmails) ? student.memberEmails.slice(1) : []).filter(Boolean);
                $('#defExtraEmailsInput').value = extras.join(', ');
            }
            if ($('#defIncludeGroupmatesCheck')) $('#defIncludeGroupmatesCheck').checked = true;
        } else if (clearIfEmpty) {
            if ($('#defCapstoneInput')) $('#defCapstoneInput').value = '';
            document.querySelectorAll('input[name="defRole"]').forEach((r) => {
                r.checked = r.value === 'panel';
            });
            state.defDraftMembers = [''];
            if ($('#defGroupEmailInput')) $('#defGroupEmailInput').value = '';
            if ($('#defExtraEmailsInput')) $('#defExtraEmailsInput').value = '';
        }

        renderDefenseMemberInputs();
        syncDefenseExistingBox(student);
        syncDefenseEmailControls();
        renderDefenseDayPreview();
        setDefenseFormError('');
    }

    function renderDefenseModalCalendar() {
        const daysEl = $('#defCalDays');
        const monthLabelEl = $('#defCalMonthLabel');
        if (!daysEl || !monthLabelEl) return;

        const selectedDate = ($('#defDateInput')?.value || '').trim();
        if ((!state.defCalYear || !Number.isInteger(state.defCalMonth)) && (selectedDate || state.today)) {
            const ref = selectedDate || state.today;
            const [ry, rm] = ref.split('-').map(Number);
            state.defCalYear = ry;
            state.defCalMonth = rm - 1;
        }

        const y = state.defCalYear || 2026;
        const m = Number.isInteger(state.defCalMonth) ? state.defCalMonth : 0;
        monthLabelEl.textContent = new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-US', {
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
        });

        const prevBtn = $('#defCalPrevBtn');
        if (prevBtn && state.today) {
            const [ty, tm] = state.today.split('-').map(Number);
            prevBtn.disabled = y < ty || (y === ty && m <= tm - 1);
        }

        daysEl.innerHTML = '';
        const firstDow = new Date(Date.UTC(y, m, 1)).getUTCDay();
        const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        for (let i = 0; i < firstDow; i += 1) {
            daysEl.appendChild(el('span', 'day-spacer'));
        }

        const level = getSelectedDefenseLevel();
        const durMinutes = (DEFENSE_DURATIONS[level] || DEFENSE_DURATIONS.capstone1).minutes;
        const replaceTarget = getActiveReplaceDefenseBooking();
        const openByDate = getOpenEntriesByDateMap();
        const blocksByDate = getBlocksByDateMap();

        for (let d = 1; d <= daysInMonth; d += 1) {
            const ds = makeDateStr(y, m, d);
            const btn = el('button', 'day', String(d));
            btn.type = 'button';
            btn.dataset.date = ds;

            if (state.today && ds < state.today) {
                btn.disabled = true;
                daysEl.appendChild(btn);
                continue;
            }

            if (ds === state.today) btn.classList.add('today');
            if (ds === selectedDate) btn.classList.add('selected');

            const dayBookings = getTimedBookingsOnDate(ds, replaceTarget?.id || null);
            const bookedIntervals = dayBookings.map((b) => [
                b.startMinute ?? (b.hour || 0) * 60,
                b.endMinute ?? ((b.startMinute ?? (b.hour || 0) * 60) + (b.durationMinutes || 15)),
            ]);
            const dayBlocks = blocksByDate.get(ds) || [];
            const hasFullBlock = dayBlocks.some((b) => b.isFullDay);
            const blockedIntervals = dayBlocks.map((blk) => [
                blk.isFullDay ? 0 : (blk.startMinute ?? 0),
                blk.isFullDay ? 1440 : (blk.endMinute ?? 1440),
            ]);

            const defEntry = openByDate.get(ds)?.defense || null;
            const defWins = (defEntry?.effectiveWindows || []).map((w) => [w.startMinute, w.endMinute]);
            const openDefenseGaps = (!hasFullBlock && defWins.length)
                ? computeFreeGapsInWindows(defWins, [...bookedIntervals, ...blockedIntervals], durMinutes)
                : [];
            const panelGaps = computeFreeGapsInWindows([[PANEL_WORKDAY_START, PANEL_WORKDAY_END]], bookedIntervals, durMinutes);

            if (openDefenseGaps.length > 0) {
                btn.classList.add('available');
                btn.title = `${longDate(ds)} — Open defense hours (${openDefenseGaps.map((g) => g.label).join(', ')})`;
            } else if (hasFullBlock || panelGaps.length === 0) {
                btn.classList.add('blocked');
                btn.title = hasFullBlock
                    ? `${longDate(ds)} — Blocked all day (tap to override for panel defense)`
                    : `${longDate(ds)} — No ${durMinutes / 60}h gap between 7:30 AM and 6:00 PM`;
            } else {
                btn.classList.add('panel-free');
                btn.title = `${longDate(ds)} — Free for panel schedule (${panelGaps.map((g) => g.label).join(', ')})`;
            }

            btn.addEventListener('click', () => {
                if ($('#defDateInput')) $('#defDateInput').value = ds;
                setDefenseFormError('');
                renderDefenseDayPreview();
            });
            daysEl.appendChild(btn);
        }
    }

    function changeDefenseCalMonth(delta) {
        let m = (Number.isInteger(state.defCalMonth) ? state.defCalMonth : 0) + delta;
        let y = state.defCalYear || 2026;
        if (m < 0) { m = 11; y -= 1; }
        if (m > 11) { m = 0; y += 1; }
        state.defCalYear = y;
        state.defCalMonth = m;
        renderDefenseModalCalendar();
    }

    function renderDefenseDayPreview() {
        const dateVal = ($('#defDateInput')?.value || '').trim();
        const timeVal = ($('#defStartTimeInput')?.value || '').trim();
        const level = getSelectedDefenseLevel();
        const durInfo = DEFENSE_DURATIONS[level] || DEFENSE_DURATIONS.capstone1;
        const startMin = timeValToMinute(timeVal);
        const endMin = startMin !== null ? startMin + durInfo.minutes : null;

        renderDefenseModalCalendar();

        const windowTextEl = $('#defCalculatedWindowText');
        if (windowTextEl) {
            if (startMin === null) {
                windowTextEl.textContent = `Select a start time (${durInfo.label})`;
            } else if (endMin > 1440) {
                windowTextEl.textContent = `${formatMinute12(startMin)} – extends past midnight (${durInfo.label})`;
            } else {
                windowTextEl.textContent = `${formatMinute12(startMin)} – ${formatMinute12(endMin)} · ${LEVEL_LABELS[level]} (${durInfo.label})`;
            }
        }

        const dateHeadingEl = $('#defSelectedDateHeading');
        const freeSummaryEl = $('#defFreeWindowsSummary');
        const chipsContainer = $('#defDynamicSlotChips');
        const statusBanner = $('#defDayStatusBanner');
        const apptsWrap = $('#defDayAppointmentsWrap');
        const apptsHeading = $('#defDayAppointmentsHeading');
        const apptsList = $('#defDayAppointmentsList');
        if (!statusBanner || !apptsWrap || !apptsList) return;

        statusBanner.className = 'def-day-preview-status';
        statusBanner.textContent = '';
        apptsList.innerHTML = '';
        if (chipsContainer) chipsContainer.innerHTML = '';

        if (!dateVal || !/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) {
            if (dateHeadingEl) dateHeadingEl.textContent = 'Select a date on the calendar';
            if (freeSummaryEl) freeSummaryEl.textContent = 'Pick a date to see available start times.';
            statusBanner.classList.add('is-neutral');
            statusBanner.textContent = 'Pick a date above to check your schedule for conflicts.';
            apptsWrap.classList.add('hidden');
            return;
        }

        if (dateHeadingEl) dateHeadingEl.textContent = longDate(dateVal);

        if (state.today && dateVal < state.today) {
            if (freeSummaryEl) freeSummaryEl.textContent = 'Past date — select today or a future date.';
            statusBanner.classList.add('is-conflict');
            statusBanner.textContent = `${longDate(dateVal)} is in the past — please pick today or a future date.`;
            apptsWrap.classList.add('hidden');
            return;
        }

        const replaceTarget = getActiveReplaceDefenseBooking();
        const timedDayBookings = getTimedBookingsOnDate(dateVal, replaceTarget?.id || null);
        const dayBlocks = (state.blockedSchedules || []).filter((blk) => blk.date === dateVal);
        const hasFullBlock = dayBlocks.some((b) => b.isFullDay);
        const bookedIntervals = timedDayBookings.map((b) => [
            b.startMinute ?? (b.hour || 0) * 60,
            b.endMinute ?? ((b.startMinute ?? (b.hour || 0) * 60) + (b.durationMinutes || 15)),
        ]);
        const blockedIntervals = dayBlocks.map((blk) => [
            blk.isFullDay ? 0 : (blk.startMinute ?? 0),
            blk.isFullDay ? 1440 : (blk.endMinute ?? 1440),
        ]);

        // Populate dynamic non-overlapping start-time chips (student-booking style!)
        const openedDefWins = getOpenedCategoryWindowsOnDate(dateVal, 'defense');
        const openedGaps = (!hasFullBlock && openedDefWins.length)
            ? computeFreeGapsInWindows(openedDefWins, [...bookedIntervals, ...blockedIntervals], durInfo.minutes)
            : [];
        const panelGaps = computeFreeGapsInWindows([[PANEL_WORKDAY_START, PANEL_WORKDAY_END]], bookedIntervals, durInfo.minutes);
        const activeGaps = openedGaps.length ? openedGaps : panelGaps;

        if (freeSummaryEl) {
            if (openedGaps.length) {
                freeSummaryEl.textContent = `Open Defense Hours: ${openedGaps.map((g) => g.label).join(' · ')}`;
            } else if (panelGaps.length) {
                freeSummaryEl.textContent = `Free on schedule: ${panelGaps.map((g) => g.label).join(' · ')}`;
            } else {
                freeSummaryEl.textContent = `No free ${durInfo.label} gap between 7:30 AM and 6:00 PM.`;
            }
        }

        if (chipsContainer) {
            const suggestedStarts = buildSuggestedDefenseStarts(activeGaps, 30);
            suggestedStarts.forEach((m) => {
                const tVal = minuteToTimeVal(m);
                const chip = el('button', 'reason-chip def-time-chip' + (tVal === timeVal ? ' is-active' : ''), formatMinute12(m));
                chip.type = 'button';
                chip.title = `${formatMinute12(m)} – ${formatMinute12(m + durInfo.minutes)} (${durInfo.label})`;
                chip.addEventListener('click', () => {
                    if ($('#defStartTimeInput')) $('#defStartTimeInput').value = tVal;
                    setDefenseFormError('');
                    renderDefenseDayPreview();
                });
                chipsContainer.appendChild(chip);
            });
        }

        let overlappingBooking = null;
        let overlappingBlock = null;

        if (startMin !== null && endMin !== null && endMin <= 1440) {
            overlappingBooking = timedDayBookings.find((b) => {
                const bs = b.startMinute ?? (b.hour || 0) * 60;
                const be = b.endMinute ?? (bs + (b.durationMinutes || 15));
                return startMin < be && endMin > bs;
            }) || null;

            overlappingBlock = dayBlocks.find((blk) => {
                const bs = blk.isFullDay ? 0 : (blk.startMinute ?? 0);
                const be = blk.isFullDay ? 1440 : (blk.endMinute ?? 1440);
                return startMin < be && endMin > bs;
            }) || null;
        }

        if (startMin === null || endMin === null) {
            statusBanner.classList.add('is-neutral');
            statusBanner.textContent = 'Enter a valid start time to check availability.';
        } else if (endMin > 1440) {
            statusBanner.classList.add('is-conflict');
            statusBanner.textContent = `A ${durInfo.label} defense starting at ${formatMinute12(startMin)} goes past midnight — pick an earlier start time.`;
        } else if (overlappingBooking) {
            const cTitle = overlappingBooking.capstoneTitle || overlappingBooking.teamName || overlappingBooking.name;
            statusBanner.classList.add('is-conflict');
            statusBanner.textContent = `Conflict: ${formatMinute12(startMin)} – ${formatMinute12(endMin)} overlaps with ${overlappingBooking.consultationTitle || 'Appointment'} (${cTitle}, ${overlappingBooking.label}).`;
        } else if (overlappingBlock) {
            statusBanner.classList.add('is-warning');
            statusBanner.textContent = `Note: ${longDate(dateVal)} has a block (${overlappingBlock.label}${overlappingBlock.reason ? ` — ${overlappingBlock.reason}` : ''}), but you can still schedule this panel defense here.`;
        } else {
            statusBanner.classList.add('is-clear');
            statusBanner.textContent = `Available ✓ — ${formatMinute12(startMin)} – ${formatMinute12(endMin)} is clear on ${shortDate(dateVal)}.`;
        }

        if (timedDayBookings.length > 0) {
            apptsWrap.classList.remove('hidden');
            if (apptsHeading) {
                apptsHeading.textContent = `${timedDayBookings.length} timed appointment${timedDayBookings.length === 1 ? '' : 's'} on ${shortDate(dateVal)}`;
            }
            timedDayBookings.forEach((b) => {
                const bs = b.startMinute ?? (b.hour || 0) * 60;
                const be = b.endMinute ?? (bs + (b.durationMinutes || 15));
                const isConflict = startMin !== null && endMin !== null && startMin < be && endMin > bs;
                const item = el('div', 'def-day-appt-pill' + (isConflict ? ' is-conflict' : ''));
                item.appendChild(el('strong', '', b.label));
                const gName = b.capstoneTitle || b.teamName || b.name;
                item.appendChild(el('span', '', `${b.consultationTitle || 'Consultation'} · ${gName}`));
                apptsList.appendChild(item);
            });
        } else {
            apptsWrap.classList.add('hidden');
        }
    }

    function openScheduleDefenseModal({
        student = null,
        bookingToReschedule = null,
        prefillDate = null,
        prefillTime = null,
        prefillLevel = null,
    } = {}) {
        state.defModalOpen = true;
        state.defExplicitRescheduleTarget = bookingToReschedule || null;
        state.defAutoDetectedUpcomingDefense = null;

        populateDefenseStudentOptions();

        const select = $('#defStudentSelect');
        let matchedStudent = student || null;
        if (!matchedStudent && bookingToReschedule) {
            matchedStudent = state.students.find(
                (s) => (bookingToReschedule.studentId && s.id === bookingToReschedule.studentId)
                    || (bookingToReschedule.studentEmail && s.email && s.email.toLowerCase() === bookingToReschedule.studentEmail.toLowerCase())
            ) || null;
        }

        if (select) {
            select.value = matchedStudent?.id || '';
            select.disabled = Boolean(bookingToReschedule);
        }

        const defaultDate = prefillDate
            || bookingToReschedule?.date
            || (state.today ? addDays(state.today, 1) : '');
        const dateInput = $('#defDateInput');
        if (dateInput) {
            if (state.today) dateInput.min = state.today;
            dateInput.value = defaultDate;
        }
        if (defaultDate && /^\d{4}-\d{2}-\d{2}$/.test(defaultDate)) {
            const [dy, dm] = defaultDate.split('-').map(Number);
            state.defCalYear = dy;
            state.defCalMonth = dm - 1;
        }

        const startInput = $('#defStartTimeInput');
        if (startInput) {
            startInput.value = prefillTime
                || (bookingToReschedule && Number.isFinite(bookingToReschedule.startMinute)
                    ? minuteToTimeVal(bookingToReschedule.startMinute)
                    : '09:00');
        }

        if (bookingToReschedule) {
            if ($('#defCapstoneInput')) {
                $('#defCapstoneInput').value = bookingToReschedule.capstoneTitle || bookingToReschedule.teamName || matchedStudent?.capstoneTitle || '';
            }
            const level = Object.prototype.hasOwnProperty.call(DEFENSE_DURATIONS, bookingToReschedule.defenseLevel || bookingToReschedule.projectLevel)
                ? (bookingToReschedule.defenseLevel || bookingToReschedule.projectLevel)
                : (matchedStudent?.projectLevel || 'capstone1');
            document.querySelectorAll('input[name="defLevel"]').forEach((r) => {
                r.checked = r.value === level;
            });
            const role = (bookingToReschedule.instructorRole || matchedStudent?.instructorRole) === 'adviser' ? 'adviser' : 'panel';
            document.querySelectorAll('input[name="defRole"]').forEach((r) => {
                r.checked = r.value === role;
            });
            state.defDraftMembers = (Array.isArray(bookingToReschedule.members) && bookingToReschedule.members.length
                ? [...bookingToReschedule.members]
                : [bookingToReschedule.name || '']).slice(0, 3);
            if ($('#defReasonInput')) {
                $('#defReasonInput').value = bookingToReschedule.reason || '';
            }
            if ($('#defGroupEmailInput')) {
                $('#defGroupEmailInput').value = bookingToReschedule.studentEmail || matchedStudent?.email || '';
            }
            if ($('#defExtraEmailsInput')) {
                const extras = (Array.isArray(bookingToReschedule.memberEmails) ? bookingToReschedule.memberEmails.slice(1) : []).filter(Boolean);
                $('#defExtraEmailsInput').value = extras.join(', ');
            }
            renderDefenseMemberInputs();
            syncDefenseExistingBox(matchedStudent);
        } else {
            if ($('#defReasonInput')) $('#defReasonInput').value = '';
            if (matchedStudent) {
                applySelectedDefenseStudent(false);
            } else {
                if ($('#defCapstoneInput')) $('#defCapstoneInput').value = '';
                const initLevel = Object.prototype.hasOwnProperty.call(DEFENSE_DURATIONS, prefillLevel)
                    ? prefillLevel
                    : 'capstone1';
                document.querySelectorAll('input[name="defLevel"]').forEach((r) => {
                    r.checked = r.value === initLevel;
                });
                document.querySelectorAll('input[name="defRole"]').forEach((r) => {
                    r.checked = r.value === 'panel';
                });
                state.defDraftMembers = [''];
                if ($('#defGroupEmailInput')) $('#defGroupEmailInput').value = '';
                if ($('#defExtraEmailsInput')) $('#defExtraEmailsInput').value = '';
                renderDefenseMemberInputs();
                syncDefenseExistingBox(null);
            }
        }

        if ($('#defSendEmailCheck')) $('#defSendEmailCheck').checked = true;
        if ($('#defIncludeGroupmatesCheck')) $('#defIncludeGroupmatesCheck').checked = true;
        syncDefenseEmailControls();
        renderDefenseDayPreview();
        setDefenseFormError('');

        $('#scheduleDefenseModal')?.classList.remove('hidden');
        syncModalBodyLock();

        if (window.matchMedia('(hover: hover)').matches) {
            setTimeout(() => {
                if (bookingToReschedule || matchedStudent) $('#defDateInput')?.focus();
                else $('#defStudentSelect')?.focus();
            }, 40);
        }
    }

    function closeScheduleDefenseModal() {
        if (state.defSaving) return;
        state.defModalOpen = false;
        state.defExplicitRescheduleTarget = null;
        state.defAutoDetectedUpcomingDefense = null;
        if ($('#defStudentSelect')) $('#defStudentSelect').disabled = false;
        $('#scheduleDefenseModal')?.classList.add('hidden');
        syncModalBodyLock();
        setDefenseFormError('');
    }

    async function submitScheduleDefense(e) {
        e.preventDefault();
        if (state.defSaving) return;
        setDefenseFormError('');

        const studentId = ($('#defStudentSelect')?.value || '').trim();
        const student = state.students.find((s) => s.id === studentId) || null;
        const capstoneTitle = ($('#defCapstoneInput')?.value || '').trim();
        const defenseLevel = getSelectedDefenseLevel();
        const instructorRole = getSelectedDefenseRole();
        const members = state.defDraftMembers.map((m) => String(m || '').trim()).filter(Boolean);
        const date = ($('#defDateInput')?.value || '').trim();
        const timeVal = ($('#defStartTimeInput')?.value || '').trim();
        const startMinute = timeValToMinute(timeVal);
        const reason = ($('#defReasonInput')?.value || '').trim();

        if (capstoneTitle.length < 2) {
            setDefenseFormError('Please enter the Capstone / Thesis title (at least 2 characters).', 'defCapstoneInput');
            $('#defCapstoneInput')?.focus();
            return;
        }
        if (!members.length || members.some((m) => m.length < 2)) {
            setDefenseFormError('Please enter the full name (at least 2 characters) for each listed group member.');
            return;
        }
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            setDefenseFormError('Please select a valid defense date.', 'defDateInput');
            $('#defDateInput')?.focus();
            return;
        }
        if (state.today && date < state.today) {
            setDefenseFormError('Please select today or a future date for the defense.', 'defDateInput');
            $('#defDateInput')?.focus();
            return;
        }
        if (startMinute === null) {
            setDefenseFormError('Please enter a valid start time.', 'defStartTimeInput');
            $('#defStartTimeInput')?.focus();
            return;
        }
        const durMinutes = DEFENSE_DURATIONS[defenseLevel].minutes;
        if (startMinute + durMinutes > 1440) {
            setDefenseFormError(`A ${DEFENSE_DURATIONS[defenseLevel].label} defense starting at ${formatMinute12(startMinute)} extends past midnight. Choose an earlier start time.`, 'defStartTimeInput');
            $('#defStartTimeInput')?.focus();
            return;
        }

        const primaryEmail = student
            ? (student.email || '')
            : ($('#defGroupEmailInput')?.value || '').trim().toLowerCase();
        if (primaryEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(primaryEmail)) {
            setDefenseFormError('Please enter a valid representative email address, or leave it blank.', 'defGroupEmailInput');
            $('#defGroupEmailInput')?.focus();
            return;
        }

        const extraEmails = student
            ? []
            : ($('#defExtraEmailsInput')?.value || '')
                .split(/[,;\s]+/)
                .map((x) => x.trim().toLowerCase())
                .filter(Boolean);
        const invalidExtra = extraEmails.find((x) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
        if (invalidExtra) {
            setDefenseFormError(`Invalid groupmate email "${invalidExtra}". Separate multiple emails with commas.`, 'defExtraEmailsInput');
            $('#defExtraEmailsInput')?.focus();
            return;
        }

        const replaceTarget = getActiveReplaceDefenseBooking();
        const sendEmail = Boolean($('#defSendEmailCheck')?.checked);
        const includeGroupmates = Boolean(
            !student || $('#defIncludeGroupmatesWrap')?.classList.contains('hidden') || $('#defIncludeGroupmatesCheck')?.checked
        );

        state.defSaving = true;
        const submitBtn = $('#confirmScheduleDefenseBtn');
        const cancelBtn = $('#cancelScheduleDefenseBtn');
        const closeBtn = $('#closeScheduleDefenseModalBtn');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.querySelector('.spinner')?.classList.remove('hidden');
            if ($('#confirmScheduleDefenseLabel')) {
                $('#confirmScheduleDefenseLabel').textContent = replaceTarget ? 'Moving…' : 'Scheduling…';
            }
        }
        if (cancelBtn) cancelBtn.disabled = true;
        if (closeBtn) closeBtn.disabled = true;

        try {
            const res = await api('/api/admin/defenses', {
                method: 'POST',
                body: JSON.stringify({
                    studentId: studentId || null,
                    replaceBookingId: replaceTarget?.id || null,
                    capstoneTitle,
                    defenseLevel,
                    instructorRole,
                    members,
                    date,
                    startMinute,
                    reason,
                    studentEmail: primaryEmail || null,
                    extraEmails,
                    sendEmail,
                    includeGroupmates,
                }),
            });

            state.defSaving = false;
            closeScheduleDefenseModal();
            await loadBookings();
            window.SchedulerRealtime?.notifyLocal({
                type: res.rescheduled ? 'booking_rescheduled' : 'booking_created',
                bookingId: res.booking?.id,
                date: res.booking?.date,
            });

            const emailNote = res.emailSent && Array.isArray(res.recipients) && res.recipients.length
                ? ` Email & calendar invite sent to ${res.recipients.join(', ')}.`
                : res.emailError
                    ? ` (Scheduled, but email could not be sent: ${res.emailError})`
                    : '';
            const actionLabel = res.rescheduled ? 'Rescheduled' : 'Scheduled';
            toast(
                `${actionLabel} ${LEVEL_LABELS[defenseLevel]} Defense for "${capstoneTitle}" on ${shortDate(date)} (${res.booking?.label || ''}).${emailNote}`,
                'success'
            );
        } catch (err) {
            setDefenseFormError(err.message);
        } finally {
            state.defSaving = false;
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.querySelector('.spinner')?.classList.add('hidden');
            }
            if (cancelBtn) cancelBtn.disabled = false;
            if (closeBtn) closeBtn.disabled = false;
            syncDefenseSubmitLabel();
        }
    }

    /* ---------------- consultation notes, revision checklist & attendance ---------------- */
    function bookingStudentKey(b) {
        return b.studentId || (b.studentEmail ? b.studentEmail.toLowerCase() : '');
    }

    function compareBookingsChrono(a, b) {
        return a.date.localeCompare(b.date)
            || (a.startMinute ?? (a.hour || 0) * 60) - (b.startMinute ?? (b.hour || 0) * 60)
            || String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    }

    function findPreviousConsultation(b) {
        if (!b || isCancelled(b)) return null;
        const key = bookingStudentKey(b);
        if (!key) return b.previousConsultation || null;

        const earlier = state.bookings
            .filter((x) => x.id !== b.id && !isCancelled(x) && bookingStudentKey(x) === key && compareBookingsChrono(x, b) < 0)
            .sort(compareBookingsChrono);

        if (!earlier.length) return b.previousConsultation || null;

        let lastWithRevisions = null;
        for (const prev of earlier) {
            const hasRevisions = (Array.isArray(prev.revisionChecklist) && prev.revisionChecklist.length > 0)
                || Boolean(prev.revisionNotes);
            if (hasRevisions) lastWithRevisions = prev;
        }
        if (lastWithRevisions) return lastWithRevisions;

        const immediatePrev = earlier[earlier.length - 1];
        const hasOutcome = isCompleted(immediatePrev)
            || isNoShow(immediatePrev)
            || (Array.isArray(immediatePrev.attendedMembers) && immediatePrev.attendedMembers.length > 0);
        return hasOutcome ? immediatePrev : (b.previousConsultation || null);
    }

    function requiredAttendanceSummary(b) {
        const members = Array.isArray(b.members) && b.members.length ? b.members : [b.name].filter(Boolean);
        const total = members.length || 1;
        if (b.consultationType === 'system' || b.consultationType === 'defense') {
            return { required: total, hint: 'All group members are required to be present.' };
        }
        if (b.consultationType === 'retrieval') {
            const minReq = total >= 2 ? 2 : 1;
            return {
                required: minReq,
                hint: total >= 2
                    ? 'At least 2 or all group members are required to be present.'
                    : 'Member presence is required.',
            };
        }
        return { required: 1, hint: 'Track which members attended this session.' };
    }

    function applyUpdatedBooking(target, updated) {
        if (!target || !updated) return;
        const preservedPrev = target.previousConsultation;
        Object.assign(target, updated);
        if (!updated.previousConsultation && preservedPrev) {
            target.previousConsultation = preservedPrev;
        }
    }

    async function toggleCardMemberAttendance(b, memberName, chipBtn) {
        if (!b || isCancelled(b)) return;
        const members = Array.isArray(b.members) && b.members.length ? b.members : [b.name].filter(Boolean);
        const currentSet = new Set(Array.isArray(b.attendedMembers) ? b.attendedMembers : []);
        if (currentSet.has(memberName)) currentSet.delete(memberName);
        else currentSet.add(memberName);
        const nextAttended = members.filter((m) => currentSet.has(m));
        if (chipBtn) chipBtn.disabled = true;
        try {
            const { booking } = await api(`/api/admin/bookings/${b.id}/notes`, {
                method: 'PATCH',
                body: JSON.stringify({ attendedMembers: nextAttended }),
            });
            applyUpdatedBooking(b, booking);
            window.SchedulerRealtime?.notifyLocal({
                type: 'booking_notes_updated',
                bookingId: b.id,
                date: b.date,
            });
            render();
        } catch (err) {
            if (chipBtn) chipBtn.disabled = false;
            toast(err.message, 'error');
        }
    }

    async function toggleChecklistItem(targetBooking, itemId, done, checkboxEl) {
        if (!targetBooking || isCancelled(targetBooking)) return;
        const prevChecklist = Array.isArray(targetBooking.revisionChecklist)
            ? targetBooking.revisionChecklist.map((item) => ({ ...item }))
            : [];
        const nextChecklist = prevChecklist.map((item) =>
            item.id === itemId ? { ...item, done: Boolean(done) } : item
        );
        if (checkboxEl) checkboxEl.disabled = true;
        try {
            const { booking } = await api(`/api/admin/bookings/${targetBooking.id}/notes`, {
                method: 'PATCH',
                body: JSON.stringify({ revisionChecklist: nextChecklist }),
            });
            applyUpdatedBooking(targetBooking, booking);
            window.SchedulerRealtime?.notifyLocal({
                type: 'booking_notes_updated',
                bookingId: targetBooking.id,
                date: targetBooking.date,
            });
            render();
        } catch (err) {
            if (checkboxEl) {
                checkboxEl.checked = !done;
                checkboxEl.disabled = false;
            }
            toast(err.message, 'error');
        }
    }

    function buildChecklistElement(targetBooking, items) {
        const list = el('div', 'revision-checklist');
        items.forEach((item) => {
            const row = el('label', 'revision-check-item' + (item.done ? ' is-done' : ''));
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = Boolean(item.done);
            cb.addEventListener('change', () => toggleChecklistItem(targetBooking, item.id, cb.checked, cb));
            const textSpan = el('span', '', item.text);
            row.append(cb, textSpan);
            list.appendChild(row);
        });
        return list;
    }

    function setNotesFormError(msg) {
        const errEl = $('#notesFormError');
        if (!errEl) return;
        errEl.textContent = msg || '';
        errEl.classList.toggle('hidden', !msg);
    }

    function renderNotesAttendanceList() {
        const container = $('#notesAttendanceList');
        const b = state.notesTarget;
        if (!container || !b) return;
        container.innerHTML = '';
        const members = Array.isArray(b.members) && b.members.length ? b.members : [b.name].filter(Boolean);
        members.forEach((memberName, idx) => {
            const isPresent = state.notesDraftAttended.has(memberName);
            const btn = el('button', 'attendance-toggle-btn' + (isPresent ? ' is-present' : ''));
            btn.type = 'button';
            btn.setAttribute('aria-pressed', isPresent ? 'true' : 'false');
            const nameText = idx === 0 && members.length > 1 ? `${memberName} (Rep)` : memberName;
            btn.appendChild(el('span', 'attendance-toggle-mark', isPresent ? '✓' : ''));
            btn.appendChild(el('span', 'attendance-toggle-name', nameText));
            btn.appendChild(el('span', 'attendance-toggle-state', isPresent ? 'Present' : 'Absent'));
            btn.addEventListener('click', () => {
                if (state.notesDraftAttended.has(memberName)) state.notesDraftAttended.delete(memberName);
                else state.notesDraftAttended.add(memberName);
                renderNotesAttendanceList();
            });
            container.appendChild(btn);
        });
    }

    function renderNotesChecklistList() {
        const container = $('#notesChecklistList');
        if (!container) return;
        container.innerHTML = '';
        if (!state.notesDraftChecklist.length) {
            container.appendChild(el('p', 'muted small checklist-empty-hint', 'No action items added yet.'));
            return;
        }
        state.notesDraftChecklist.forEach((item, idx) => {
            const row = el('div', 'revision-check-item revision-check-editable' + (item.done ? ' is-done' : ''));
            const label = el('label', 'revision-check-label');
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = Boolean(item.done);
            cb.addEventListener('change', () => {
                state.notesDraftChecklist[idx].done = cb.checked;
                renderNotesChecklistList();
            });
            label.append(cb, el('span', '', item.text));

            const removeBtn = el('button', 'icon-btn checklist-remove-btn');
            removeBtn.type = 'button';
            removeBtn.setAttribute('aria-label', 'Remove item');
            removeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
            removeBtn.addEventListener('click', () => {
                state.notesDraftChecklist.splice(idx, 1);
                renderNotesChecklistList();
            });

            row.append(label, removeBtn);
            container.appendChild(row);
        });
    }

    function addDraftChecklistItem() {
        const input = $('#notesChecklistInput');
        if (!input) return;
        const text = input.value.trim();
        if (!text) {
            input.focus();
            return;
        }
        if (state.notesDraftChecklist.length >= 30) {
            setNotesFormError('You can add up to 30 revision action items per consultation.');
            return;
        }
        setNotesFormError('');
        const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : `item-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
        state.notesDraftChecklist.push({ id, text: text.slice(0, 300), done: false });
        input.value = '';
        renderNotesChecklistList();
        input.focus();
    }

    function copyPrevUnfinishedToDraft() {
        if (!state.notesTarget) return;
        const prev = findPreviousConsultation(state.notesTarget);
        const items = Array.isArray(prev?.revisionChecklist) ? prev.revisionChecklist : [];
        const unfinished = items.filter((it) => !it.done);
        if (!unfinished.length) return;

        const existingTexts = new Set(state.notesDraftChecklist.map((it) => it.text.trim().toLowerCase()));
        let added = 0;
        for (const it of unfinished) {
            if (state.notesDraftChecklist.length >= 30) break;
            const norm = String(it.text || '').trim().toLowerCase();
            if (!norm || existingTexts.has(norm)) continue;
            existingTexts.add(norm);
            const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : `item-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
            state.notesDraftChecklist.push({ id, text: String(it.text).trim().slice(0, 300), done: false });
            added += 1;
        }
        renderNotesChecklistList();
        toast(added > 0 ? `Copied ${added} unfinished item${added === 1 ? '' : 's'}.` : 'All unfinished items are already in this checklist.', 'info');
    }

    function openNotesModal(b) {
        state.notesTarget = b;
        const title = b.capstoneTitle || b.teamName || b.name;
        const summary = $('#notesTargetSummary');
        if (summary) {
            summary.innerHTML = '';
            summary.appendChild(el('strong', '', title));
            summary.appendChild(el('span', 'muted small', `${b.consultationTitle || 'Consultation'} · ${longDate(b.date)} · ${b.label}`));
        }

        const prevBox = $('#notesPrevConsultationBox');
        const prev = findPreviousConsultation(b);
        const hasPrevRevisions = Boolean(
            prev && ((Array.isArray(prev.revisionChecklist) && prev.revisionChecklist.length > 0) || prev.revisionNotes)
        );
        if (prevBox) {
            if (hasPrevRevisions) {
                prevBox.classList.remove('hidden');
                $('#notesPrevConsultationTitle').textContent = `Last Consultation: ${prev.consultationTitle || 'Consultation'} (${shortDate(prev.date)})`;
                const prevItems = Array.isArray(prev.revisionChecklist) ? prev.revisionChecklist : [];
                const doneCount = prevItems.filter((it) => it.done).length;
                const statusEl = $('#notesPrevConsultationStatus');
                if (statusEl) {
                    if (prevItems.length) {
                        statusEl.textContent = `${doneCount}/${prevItems.length} fixed`;
                        statusEl.className = `badge ${doneCount === prevItems.length ? 'teal' : 'amber'}`;
                    } else if (isNoShow(prev)) {
                        statusEl.textContent = 'No-Show';
                        statusEl.className = 'badge danger';
                    } else {
                        statusEl.textContent = isCompleted(prev) ? 'Completed' : 'Recorded';
                        statusEl.className = 'badge muted-badge';
                    }
                }
                const previewWrap = $('#notesPrevChecklistPreview');
                if (previewWrap) {
                    previewWrap.innerHTML = '';
                    if (prevItems.length) {
                        const ul = el('ul', 'prev-checklist-preview');
                        prevItems.forEach((it) => {
                            const li = el('li', it.done ? 'is-done' : '', `${it.done ? '✓' : '○'} ${it.text}`);
                            ul.appendChild(li);
                        });
                        previewWrap.appendChild(ul);
                    }
                }
                const prevNotesEl = $('#notesPrevNotesText');
                if (prevNotesEl) {
                    prevNotesEl.textContent = prev.revisionNotes || '';
                    prevNotesEl.classList.toggle('hidden', !prev.revisionNotes);
                }
                const hasUnfinished = prevItems.some((it) => !it.done);
                $('#copyPrevUnfinishedBtn')?.classList.toggle('hidden', !hasUnfinished);
            } else {
                prevBox.classList.add('hidden');
            }
        }

        const currentStatus = ['scheduled', 'completed', 'no_show'].includes(b.status) ? b.status : 'scheduled';
        document.querySelectorAll('input[name="notesStatus"]').forEach((r) => {
            r.checked = r.value === currentStatus;
        });

        state.notesDraftAttended = new Set(Array.isArray(b.attendedMembers) ? b.attendedMembers : []);
        const ruleInfo = requiredAttendanceSummary(b);
        if ($('#notesAttendanceRuleHint')) $('#notesAttendanceRuleHint').textContent = ruleInfo.hint;
        renderNotesAttendanceList();

        state.notesDraftChecklist = Array.isArray(b.revisionChecklist)
            ? b.revisionChecklist.map((it) => ({ ...it }))
            : [];
        if ($('#notesChecklistInput')) $('#notesChecklistInput').value = '';
        renderNotesChecklistList();

        const notesInput = $('#revisionNotesInput');
        if (notesInput) {
            notesInput.value = b.revisionNotes || '';
            if ($('#revisionNotesCount')) $('#revisionNotesCount').textContent = String(notesInput.value.length);
        }

        setNotesFormError('');
        $('#notesModal')?.classList.remove('hidden');
        syncModalBodyLock();
    }

    function closeNotesModal() {
        if (state.notesSaving) return;
        state.notesTarget = null;
        $('#notesModal')?.classList.add('hidden');
        syncModalBodyLock();
        setNotesFormError('');
    }

    async function submitNotesForm(e) {
        e.preventDefault();
        if (state.notesSaving || !state.notesTarget) return;
        setNotesFormError('');

        const pendingItemText = ($('#notesChecklistInput')?.value || '').trim();
        if (pendingItemText && state.notesDraftChecklist.length < 30) {
            const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : `item-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
            state.notesDraftChecklist.push({ id, text: pendingItemText.slice(0, 300), done: false });
            if ($('#notesChecklistInput')) $('#notesChecklistInput').value = '';
        }

        const b = state.notesTarget;
        const members = Array.isArray(b.members) && b.members.length ? b.members : [b.name].filter(Boolean);
        const status = document.querySelector('input[name="notesStatus"]:checked')?.value || 'scheduled';
        const attendedMembers = members.filter((m) => state.notesDraftAttended.has(m));
        const revisionNotes = ($('#revisionNotesInput')?.value || '').trim();
        const revisionChecklist = state.notesDraftChecklist.map((it) => ({ ...it }));

        state.notesSaving = true;
        const saveBtn = $('#saveNotesBtn');
        const cancelBtn = $('#cancelNotesModalBtn');
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.querySelector('.spinner')?.classList.remove('hidden');
            saveBtn.querySelector('.btn-label').textContent = 'Saving…';
        }
        if (cancelBtn) cancelBtn.disabled = true;

        try {
            const { booking } = await api(`/api/admin/bookings/${b.id}/notes`, {
                method: 'POST',
                body: JSON.stringify({
                    status,
                    attendedMembers,
                    revisionNotes,
                    revisionChecklist,
                }),
            });
            applyUpdatedBooking(b, booking);
            state.notesSaving = false;
            closeNotesModal();
            render();
            window.SchedulerRealtime?.notifyLocal({
                type: 'booking_notes_updated',
                bookingId: b.id,
                date: b.date,
            });
            toast('Consultation notes and attendance saved.', 'success');
        } catch (err) {
            setNotesFormError(err.message);
        } finally {
            state.notesSaving = false;
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.querySelector('.spinner')?.classList.add('hidden');
                saveBtn.querySelector('.btn-label').textContent = 'Save notes & attendance';
            }
            if (cancelBtn) cancelBtn.disabled = false;
        }
    }

    function matchesSearch(b, q) {
        if (!q) return true;
        if (b.date) {
            if (b.date.toLowerCase().includes(q)) return true;
            if (longDate(b.date).toLowerCase().includes(q)) return true;
            if (shortDate(b.date).toLowerCase().includes(q)) return true;
        }
        if (b.label && b.label.toLowerCase().includes(q)) return true;
        if (b.name && b.name.toLowerCase().includes(q)) return true;
        if (b.teamName && b.teamName.toLowerCase().includes(q)) return true;
        if (b.capstoneTitle && b.capstoneTitle.toLowerCase().includes(q)) return true;
        if (b.consultationTitle && b.consultationTitle.toLowerCase().includes(q)) return true;
        if (b.consultationType && b.consultationType.toLowerCase().includes(q)) return true;
        const levelLabel = b.projectLevelLabel || b.defenseLevelLabel || LEVEL_LABELS[b.projectLevel || b.defenseLevel] || '';
        if (levelLabel && levelLabel.toLowerCase().includes(q)) return true;
        if (b.instructorRole && b.instructorRole.toLowerCase().includes(q)) return true;
        if (Array.isArray(b.members) && b.members.some((m) => m.toLowerCase().includes(q))) return true;
        if (b.reason && b.reason.toLowerCase().includes(q)) return true;
        if (b.cancellationReason && b.cancellationReason.toLowerCase().includes(q)) return true;
        if (b.status && (b.status.toLowerCase().includes(q) || b.status.replace('_', '-').toLowerCase().includes(q))) return true;
        if (b.revisionNotes && b.revisionNotes.toLowerCase().includes(q)) return true;
        if (Array.isArray(b.revisionChecklist) && b.revisionChecklist.some((item) => item.text && item.text.toLowerCase().includes(q))) return true;
        if (b.reference && b.reference.toLowerCase().includes(q)) return true;
        if (b.studentEmail && b.studentEmail.toLowerCase().includes(q)) return true;
        if (Array.isArray(b.memberEmails) && b.memberEmails.some((e) => e && e.toLowerCase().includes(q))) return true;
        return false;
    }

    const FIELD_LABELS = {
        full_name: 'Full name',
        email: 'University email',
        capstone_title: 'Capstone / Thesis title',
        instructor_role: 'Instructor role',
        project_level: 'Course',
        members: 'Group members',
        member_emails: 'Groupmate emails',
    };

    function formatTimestamp(iso) {
        if (!iso) return '';
        const dt = new Date(iso);
        if (Number.isNaN(dt.getTime())) return '';
        return dt.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        });
    }

    function extractLogChanges(log) {
        if (Array.isArray(log.changes) && log.changes.length) {
            return log.changes;
        }
        const prev = log.previousValues || {};
        const next = log.newValues || {};
        const fields = Array.isArray(log.changedFields) && log.changedFields.length
            ? log.changedFields
            : Object.keys({ ...prev, ...next });
        return fields.map((f) => ({
            field: f,
            label: FIELD_LABELS[f] || f,
            from: prev[f] ?? '—',
            to: next[f] ?? '—',
        }));
    }

    function matchesStudentSearch(s, q) {
        if (!q) return true;
        if (s.name && s.name.toLowerCase().includes(q)) return true;
        if (s.email && s.email.toLowerCase().includes(q)) return true;
        if (s.capstoneTitle && s.capstoneTitle.toLowerCase().includes(q)) return true;
        const levelLabel = s.projectLevelLabel || LEVEL_LABELS[s.projectLevel] || '';
        if (levelLabel && levelLabel.toLowerCase().includes(q)) return true;
        if (s.instructorRole && s.instructorRole.toLowerCase().includes(q)) return true;
        if (Array.isArray(s.members) && s.members.some((m) => m.toLowerCase().includes(q))) return true;
        if (Array.isArray(s.memberEmails) && s.memberEmails.some((e) => e && e.toLowerCase().includes(q))) return true;
        return false;
    }

    function matchesLogSearch(log, q) {
        if (!q) return true;
        if (log.studentName && log.studentName.toLowerCase().includes(q)) return true;
        if (log.studentEmail && log.studentEmail.toLowerCase().includes(q)) return true;
        if (log.changesSummary && log.changesSummary.toLowerCase().includes(q)) return true;
        return extractLogChanges(log).some(
            (c) => String(c.label).toLowerCase().includes(q)
                || String(c.from).toLowerCase().includes(q)
                || String(c.to).toLowerCase().includes(q)
        );
    }

    function renderStudentLogsView(container, q) {
        const logs = state.studentUpdateLogs.filter((l) => matchesLogSearch(l, q));
        if (!logs.length) {
            const empty = el('div', 'empty-state');
            empty.style.gridColumn = '1 / -1';
            empty.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
            empty.appendChild(el('p', '', q ? 'No update logs match your search.' : 'No student profile updates logged yet.'));
            container.appendChild(empty);
            return;
        }

        logs.forEach((log, idx) => {
            const card = el('div', 'student-group-card student-log-card');
            card.style.animationDelay = `${Math.min(idx, 12) * 20}ms`;

            const top = el('div', 'student-card-top');
            const badges = el('div', 'badge-row');
            badges.appendChild(el('span', 'badge teal', 'Profile Updated'));
            if (log.verifiedViaOtp) {
                badges.appendChild(el('span', 'badge violet', 'Email OTP Verified'));
            }
            const timeText = formatTimestamp(log.createdAt);
            if (timeText) {
                badges.appendChild(el('span', 'badge muted-badge', timeText));
            }
            top.appendChild(badges);

            const heading = el('h3', 'student-project-title', log.studentName || 'Student');
            card.append(top, heading);

            const changesList = el('div', 'student-log-diff-list');
            const changes = extractLogChanges(log);
            if (changes.length) {
                changes.forEach((c) => {
                    const row = el('div', 'student-log-diff-item');
                    row.appendChild(el('span', 'student-field-label', c.label));
                    const vals = el('div', 'student-log-diff-values');
                    vals.appendChild(el('span', 'diff-old', String(c.from)));
                    vals.appendChild(el('span', 'diff-arrow', '→'));
                    vals.appendChild(el('span', 'diff-new', String(c.to)));
                    row.appendChild(vals);
                    changesList.appendChild(row);
                });
            } else if (log.changesSummary) {
                changesList.appendChild(el('p', 'muted small', log.changesSummary));
            }
            card.appendChild(changesList);

            if (log.studentEmail) {
                const footer = el('div', 'student-card-footer');
                footer.appendChild(el('span', 'muted small', log.studentEmail));
                card.appendChild(footer);
            }

            container.appendChild(card);
        });
    }

    function renderStudentsSection() {
        const container = $('#studentList');
        if (!container) return;

        const allCount = state.students.length;
        const adviserCount = state.students.filter((s) => s.instructorRole === 'adviser').length;
        const panelCount = state.students.filter((s) => s.instructorRole === 'panel').length;
        const logsCount = state.studentUpdateLogs.length;

        if ($('#countStudentsAll')) $('#countStudentsAll').textContent = allCount;
        if ($('#countStudentsAdviser')) $('#countStudentsAdviser').textContent = adviserCount;
        if ($('#countStudentsPanel')) $('#countStudentsPanel').textContent = panelCount;
        if ($('#countStudentsLogs')) $('#countStudentsLogs').textContent = logsCount;

        const q = state.studentSearch.toLowerCase();
        container.innerHTML = '';

        if (state.studentRoleFilter === 'logs') {
            renderStudentLogsView(container, q);
            return;
        }

        const list = state.students.filter((s) => {
            if (state.studentRoleFilter !== 'all' && s.instructorRole !== state.studentRoleFilter) {
                return false;
            }
            return matchesStudentSearch(s, q);
        });

        if (!list.length) {
            const empty = el('div', 'empty-state');
            empty.style.gridColumn = '1 / -1';
            empty.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
            empty.appendChild(
                el('p', '', q || state.studentRoleFilter !== 'all' ? 'No student groups match your filter.' : 'No registered student groups yet.')
            );
            container.appendChild(empty);
            return;
        }

        list.forEach((s, idx) => {
            const card = el('div', 'student-group-card');
            card.style.animationDelay = `${Math.min(idx, 12) * 20}ms`;

            const top = el('div', 'student-card-top');
            const badges = el('div', 'badge-row');
            const levelText = s.projectLevelLabel || LEVEL_LABELS[s.projectLevel];
            if (levelText) {
                badges.appendChild(el('span', 'badge rose', levelText));
            }
            if (s.instructorRole === 'panel') {
                badges.appendChild(el('span', 'badge sky', 'Panel Member'));
            } else if (s.instructorRole === 'adviser') {
                badges.appendChild(el('span', 'badge teal', 'Adviser'));
            }

            const studentBookings = state.bookings.filter(
                (b) => (b.studentId && b.studentId === s.id)
                    || (b.studentEmail && s.email && b.studentEmail.toLowerCase() === s.email.toLowerCase())
            );
            const upcomingCount = studentBookings.filter((b) => !isCancelled(b) && !isPast(b)).length;
            if (upcomingCount > 0) {
                badges.appendChild(el('span', 'badge amber', `${upcomingCount} upcoming`));
            } else if (studentBookings.length > 0) {
                badges.appendChild(el('span', 'badge muted-badge', `${studentBookings.length} booking${studentBookings.length === 1 ? '' : 's'}`));
            }

            const editCount = Array.isArray(s.changeHistory) ? s.changeHistory.length : 0;
            if (editCount > 0) {
                badges.appendChild(el('span', 'badge violet', `${editCount} edit${editCount === 1 ? '' : 's'}`));
            }
            const latestRevisionBooking = studentBookings
                .filter((b) => !isCancelled(b) && ((Array.isArray(b.revisionChecklist) && b.revisionChecklist.length > 0) || b.revisionNotes))
                .sort(compareBookingsChrono)
                .pop();
            if (latestRevisionBooking) {
                const revItems = Array.isArray(latestRevisionBooking.revisionChecklist) ? latestRevisionBooking.revisionChecklist : [];
                const pendingRevCount = revItems.filter((it) => !it.done).length;
                if (pendingRevCount > 0) {
                    badges.appendChild(el('span', 'badge amber', `${pendingRevCount} revision${pendingRevCount === 1 ? '' : 's'} pending`));
                } else if (revItems.length > 0) {
                    badges.appendChild(el('span', 'badge teal', 'Revisions done ✓'));
                }
            }
            top.appendChild(badges);

            const projectTitle = el('h3', 'student-project-title', s.capstoneTitle || 'Untitled Project');
            card.append(top, projectTitle);

            const members = Array.isArray(s.members) && s.members.length ? s.members : [s.name];
            const memberEmails = Array.isArray(s.memberEmails) ? s.memberEmails : [];
            const membersSection = el('div', 'student-members-block');
            membersSection.appendChild(el('span', 'student-field-label', `Group Members (${members.length})`));
            const membersWrap = el('div', 'booking-members');
            members.forEach((m, mIdx) => {
                const labelBase = mIdx === 0 ? `${m} (Rep)` : m;
                const mEmail = mIdx > 0 ? (memberEmails[mIdx] || '') : '';
                const chip = el('span', 'member-chip', mEmail ? `${labelBase} · ${mEmail}` : labelBase);
                if (mEmail) chip.title = `Receives consultation email updates: ${mEmail}`;
                membersWrap.appendChild(chip);
            });
            membersSection.appendChild(membersWrap);
            card.appendChild(membersSection);

            if (latestRevisionBooking) {
                const revBox = el('div', 'student-card-log-box student-card-revision-box');
                const revTitle = `Revision items (${shortDate(latestRevisionBooking.date)}):`;
                revBox.appendChild(el('span', 'student-field-label', revTitle));
                const revItems = Array.isArray(latestRevisionBooking.revisionChecklist) ? latestRevisionBooking.revisionChecklist : [];
                const pendingItems = revItems.filter((it) => !it.done);
                if (pendingItems.length) {
                    const summaryText = pendingItems.slice(0, 2).map((it) => `• ${it.text}`).join('  ')
                        + (pendingItems.length > 2 ? ` (+${pendingItems.length - 2} more)` : '');
                    revBox.appendChild(el('p', 'small', summaryText));
                } else if (latestRevisionBooking.revisionNotes) {
                    revBox.appendChild(el('p', 'muted small', latestRevisionBooking.revisionNotes));
                } else if (revItems.length) {
                    revBox.appendChild(el('p', 'muted small', `All ${revItems.length} action item${revItems.length === 1 ? '' : 's'} completed.`));
                }
                card.appendChild(revBox);
            }

            if (editCount > 0) {
                const latestLog = s.changeHistory[0];
                const logBox = el('div', 'student-card-log-box');
                const logTitle = formatTimestamp(latestLog.createdAt)
                    ? `Latest update (${formatTimestamp(latestLog.createdAt)}):`
                    : 'Latest update:';
                logBox.appendChild(el('span', 'student-field-label', logTitle));
                logBox.appendChild(el('p', 'muted small', latestLog.changesSummary || 'Updated registration info'));
                card.appendChild(logBox);
            }

            const footer = el('div', 'student-card-footer');
            const identity = el('div', 'student-card-identity');
            identity.appendChild(el('strong', '', s.name));
            if (s.email) {
                identity.appendChild(el('span', 'muted small', s.email));
            }
            footer.appendChild(identity);
            const footerActions = el('div', 'student-card-actions');
            const defBtn = el('button', 'btn btn-rose-soft btn-sm', 'Schedule Defense');
            defBtn.type = 'button';
            defBtn.addEventListener('click', () => openScheduleDefenseModal({ student: s }));
            const emailBtn = el('button', 'btn btn-primary-soft btn-sm', 'Send Email');
            emailBtn.type = 'button';
            emailBtn.addEventListener('click', () => openSendEmailModal(s));
            footerActions.append(defBtn, emailBtn);
            footer.appendChild(footerActions);
            card.appendChild(footer);

            container.appendChild(card);
        });
    }

    /* ---------------- email activity & sent logs ---------------- */
    const EMAIL_TYPE_BADGES = {
        student_reminder: { label: 'Reminder · Student (1 hr)', cls: 'amber' },
        instructor_reminder: { label: 'Reminder · Instructor (10m)', cls: 'amber' },
        schedule_reminder: { label: 'Reminder · Set Appointment', cls: 'amber' },
        manuscript_ready: { label: 'Pickup · Manuscript Ready', cls: 'violet' },
        letter_ready: { label: 'Pickup · Comm. Letter Ready', cls: 'violet' },
        booking_confirmed: { label: 'Booking Confirmed', cls: 'teal' },
        defense_scheduled_admin: { label: 'Defense Scheduled (Panel)', cls: 'rose' },
        booking_rescheduled: { label: 'Booking Rescheduled', cls: 'sky' },
        defense_rescheduled_admin: { label: 'Defense Rescheduled (Panel)', cls: 'rose' },
        booking_cancelled_admin: { label: 'Cancelled (Instructor)', cls: 'rose' },
        booking_cancelled_student: { label: 'Cancelled (Student)', cls: 'rose' },
        booking_cancelled: { label: 'Cancellation Notice', cls: 'rose' },
        custom: { label: 'Custom Message', cls: 'sky' },
        otp_register: { label: 'Registration OTP', cls: 'muted-badge' },
        otp_reset: { label: 'Password Reset OTP', cls: 'muted-badge' },
        otp_email_change: { label: 'Email Change OTP', cls: 'muted-badge' },
    };

    const EMAIL_CATEGORY_FALLBACK = {
        reminder: { label: 'Reminder', cls: 'amber' },
        pickup_notice: { label: 'Pickup Notice', cls: 'violet' },
        booking: { label: 'Booking Update', cls: 'teal' },
        cancellation: { label: 'Cancellation Notice', cls: 'rose' },
        custom: { label: 'Custom Message', cls: 'sky' },
        otp: { label: 'Verification Code', cls: 'muted-badge' },
    };

    function matchesEmailCategoryFilter(log, catFilter) {
        if (!catFilter || catFilter === 'all') return true;
        if (catFilter === 'others') return log.category !== 'reminder';
        if (catFilter === 'booking_updates') return log.category === 'booking' || log.category === 'cancellation';
        return log.category === catFilter;
    }

    function matchesEmailSearch(log, q) {
        if (!q) return true;
        if (log.subject && log.subject.toLowerCase().includes(q)) return true;
        if (log.recipientName && log.recipientName.toLowerCase().includes(q)) return true;
        if (log.capstoneTitle && log.capstoneTitle.toLowerCase().includes(q)) return true;
        if (log.bodyPreview && log.bodyPreview.toLowerCase().includes(q)) return true;
        if (log.emailType && log.emailType.toLowerCase().includes(q)) return true;
        const typeLabel = EMAIL_TYPE_BADGES[log.emailType]?.label || EMAIL_CATEGORY_FALLBACK[log.category]?.label || '';
        if (typeLabel && typeLabel.toLowerCase().includes(q)) return true;
        if (Array.isArray(log.recipients) && log.recipients.some((r) => r && r.toLowerCase().includes(q))) return true;
        return false;
    }

    function renderEmailLogsSection() {
        const container = $('#emailLogsList');
        if (!container) return;

        const allLogs = Array.isArray(state.emailLogs) ? state.emailLogs : [];
        const meCount = allLogs.filter((l) => l.sentBy === 'instructor').length;
        const sysCount = allLogs.filter((l) => l.sentBy === 'system').length;

        if ($('#countEmailsAll')) $('#countEmailsAll').textContent = allLogs.length;
        if ($('#countEmailsMe')) $('#countEmailsMe').textContent = meCount;
        if ($('#countEmailsSystem')) $('#countEmailsSystem').textContent = sysCount;

        const bySender = state.emailSenderFilter === 'all'
            ? allLogs
            : allLogs.filter((l) => l.sentBy === state.emailSenderFilter);

        // Update category pill counts scoped to the active sender filter
        const catCounts = {
            all: bySender.length,
            reminder: bySender.filter((l) => l.category === 'reminder').length,
            others: bySender.filter((l) => l.category !== 'reminder').length,
            pickup_notice: bySender.filter((l) => l.category === 'pickup_notice').length,
            booking_updates: bySender.filter((l) => l.category === 'booking' || l.category === 'cancellation').length,
            custom: bySender.filter((l) => l.category === 'custom').length,
            otp: bySender.filter((l) => l.category === 'otp').length,
        };
        if ($('#countEmailCatAll')) $('#countEmailCatAll').textContent = catCounts.all;
        if ($('#countEmailCatReminder')) $('#countEmailCatReminder').textContent = catCounts.reminder;
        if ($('#countEmailCatOthers')) $('#countEmailCatOthers').textContent = catCounts.others;
        if ($('#countEmailCatPickup')) $('#countEmailCatPickup').textContent = catCounts.pickup_notice;
        if ($('#countEmailCatBooking')) $('#countEmailCatBooking').textContent = catCounts.booking_updates;
        if ($('#countEmailCatCustom')) $('#countEmailCatCustom').textContent = catCounts.custom;
        if ($('#countEmailCatOtp')) $('#countEmailCatOtp').textContent = catCounts.otp;

        document.querySelectorAll('.email-sender-tab[data-email-sender]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.emailSender === state.emailSenderFilter);
        });
        document.querySelectorAll('#emailCategoryFilters [data-email-cat]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.emailCat === state.emailCategoryFilter);
        });

        const q = state.emailSearch.toLowerCase();
        const filtered = bySender.filter(
            (l) => matchesEmailCategoryFilter(l, state.emailCategoryFilter) && matchesEmailSearch(l, q)
        );

        container.innerHTML = '';
        if (!filtered.length) {
            const empty = el('div', 'empty-state');
            empty.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>';
            const hasFilter = q || state.emailSenderFilter !== 'all' || state.emailCategoryFilter !== 'all';
            empty.appendChild(
                el('p', '', hasFilter ? 'No emails match your current filter.' : 'No sent emails recorded yet.')
            );
            if (hasFilter) {
                const resetBtn = el('button', 'btn btn-ghost btn-sm', 'Reset email filters');
                resetBtn.type = 'button';
                resetBtn.style.marginTop = '8px';
                resetBtn.addEventListener('click', () => {
                    state.emailSenderFilter = 'all';
                    state.emailCategoryFilter = 'all';
                    state.emailSearch = '';
                    state.emailVisibleLimit = 20;
                    if ($('#emailLogSearchInput')) $('#emailLogSearchInput').value = '';
                    renderEmailLogsSection();
                });
                empty.appendChild(resetBtn);
            }
            container.appendChild(empty);
            return;
        }

        const visible = filtered.slice(0, state.emailVisibleLimit);
        visible.forEach((log, idx) => {
            const item = el('div', 'email-log-item' + (log.status === 'failed' ? ' is-failed' : ''));
            item.style.animationDelay = `${Math.min(idx, 10) * 18}ms`;

            const top = el('div', 'email-log-top');
            const badges = el('div', 'badge-row');

            if (log.sentBy === 'instructor') {
                badges.appendChild(el('span', 'badge teal', 'Sent by You'));
            } else {
                badges.appendChild(el('span', 'badge sky', 'System'));
            }

            const typeMeta = EMAIL_TYPE_BADGES[log.emailType]
                || EMAIL_CATEGORY_FALLBACK[log.category]
                || { label: 'Notification', cls: 'muted-badge' };
            badges.appendChild(el('span', `badge ${typeMeta.cls}`, typeMeta.label));

            if (log.status === 'failed') {
                badges.appendChild(el('span', 'badge danger', 'Delivery Failed'));
            }

            const recipients = Array.isArray(log.recipients) ? log.recipients.filter(Boolean) : [];
            if (recipients.length > 1) {
                badges.appendChild(el('span', 'badge muted-badge', `${recipients.length} recipients`));
            }

            top.appendChild(badges);
            const timeText = formatTimestamp(log.createdAt);
            if (timeText) {
                top.appendChild(el('span', 'email-log-time muted small', timeText));
            }
            item.appendChild(top);

            const mainRow = el('div', 'email-log-main');
            const infoCol = el('div', 'email-log-info');
            infoCol.appendChild(el('strong', 'email-log-subject', log.subject || '(No subject)'));

            const metaLine = el('div', 'email-log-meta');
            const toText = recipients.length ? `To: ${recipients.join(', ')}` : 'To: —';
            metaLine.appendChild(el('span', 'email-log-to', toText));

            const groupParts = [];
            if (log.capstoneTitle) groupParts.push(log.capstoneTitle);
            if (log.recipientName && log.recipientName !== log.capstoneTitle) groupParts.push(log.recipientName);
            if (groupParts.length) {
                metaLine.appendChild(el('span', 'email-log-dot muted', '·'));
                metaLine.appendChild(el('span', 'email-log-group muted', groupParts.join(' — ')));
            }
            infoCol.appendChild(metaLine);
            mainRow.appendChild(infoCol);

            const isExpanded = state.expandedEmailLogIds.has(log.id);
            if (log.bodyPreview) {
                const toggleBtn = el('button', 'btn btn-ghost btn-sm email-preview-toggle', isExpanded ? 'Hide details' : 'View details');
                toggleBtn.type = 'button';
                toggleBtn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
                toggleBtn.addEventListener('click', () => {
                    if (state.expandedEmailLogIds.has(log.id)) {
                        state.expandedEmailLogIds.delete(log.id);
                    } else {
                        state.expandedEmailLogIds.add(log.id);
                    }
                    renderEmailLogsSection();
                });
                mainRow.appendChild(toggleBtn);
            }
            item.appendChild(mainRow);

            if (log.status === 'failed' && log.errorMessage) {
                const errBox = el('div', 'cancel-reason-box email-error-box');
                errBox.appendChild(el('strong', '', 'SMTP Error:'));
                errBox.appendChild(el('p', '', log.errorMessage));
                item.appendChild(errBox);
            }

            if (log.bodyPreview && isExpanded) {
                const previewBox = el('pre', 'email-log-preview', log.bodyPreview);
                item.appendChild(previewBox);
            }

            container.appendChild(item);
        });

        if (filtered.length > state.emailVisibleLimit) {
            const remaining = filtered.length - state.emailVisibleLimit;
            const moreWrap = el('div', 'email-log-more-wrap');
            const moreBtn = el(
                'button',
                'btn btn-ghost btn-sm',
                `Show more emails (${remaining} remaining)`
            );
            moreBtn.type = 'button';
            moreBtn.addEventListener('click', () => {
                state.emailVisibleLimit += 25;
                renderEmailLogsSection();
            });
            moreWrap.appendChild(moreBtn);
            container.appendChild(moreWrap);
        }
    }

    /* ---------------- render ---------------- */
    function render() {
        if ($('#countScheduleOpen')) {
            $('#countScheduleOpen').textContent = countUpcomingOpenScheduleItems();
        }

        const active = state.bookings.filter((b) => !isCancelled(b));
        const upcoming = active.filter((b) => !isPast(b));
        const past = active.filter(isPast).reverse();
        const cancelled = state.bookings
            .filter(isCancelled)
            .slice()
            .sort((a, b) => (b.cancelledAt || b.date).localeCompare(a.cancelledAt || a.date));
        const weekEnd = addDays(state.today, 7);

        $('#statToday').textContent = upcoming.filter((b) => b.date === state.today).length;
        $('#statWeek').textContent = upcoming.filter((b) => b.date < weekEnd).length;
        $('#statUpcoming').textContent = upcoming.length;
        $('#countUpcoming').textContent = upcoming.length;
        $('#countPast').textContent = past.length;
        if ($('#countCancelled')) $('#countCancelled').textContent = cancelled.length;
        if ($('#navCountConsultations')) $('#navCountConsultations').textContent = upcoming.length;
        if ($('#navCountStudents')) $('#navCountStudents').textContent = state.students.length;
        if ($('#navCountEmails')) $('#navCountEmails').textContent = state.emailLogs.length;

        document.querySelectorAll('.admin-view-btn[data-admin-view]').forEach((btn) => {
            const isActive = btn.dataset.adminView === state.adminView;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        if ($('#adminPageHeading')) {
            $('#adminPageHeading').textContent = ADMIN_VIEW_TITLES[state.adminView] || 'Consultations';
        }

        const isConsultationsView = state.adminView === 'consultations';
        const isScheduleView = state.adminView === 'schedule';
        const isStudentsView = state.adminView === 'students';
        const isEmailsView = state.adminView === 'emails';

        $('#mainBookingsCard')?.classList.toggle('hidden', !isConsultationsView && !isScheduleView);
        $('#consultationsToolbar')?.classList.toggle('hidden', !isConsultationsView);
        $('#bookingList')?.classList.toggle('hidden', !isConsultationsView);
        $('#scheduleManagerView')?.classList.toggle('hidden', !isScheduleView);
        $('#adminStudentsCard')?.classList.toggle('hidden', !isStudentsView);
        $('#adminEmailsCard')?.classList.toggle('hidden', !isEmailsView);

        renderEmailLogsSection();
        renderStudentsSection();
        if (state.defModalOpen && !state.defSaving) {
            renderDefenseDayPreview();
        }

        if (isScheduleView) {
            renderScheduleManager();
            return;
        }
        if (!isConsultationsView) {
            return;
        }

        const q = state.search.toLowerCase();
        const container = $('#bookingList');
        container.innerHTML = '';

        const source = state.tab === 'upcoming' ? upcoming : state.tab === 'cancelled' ? cancelled : past;
        const list = source.filter((b) => matchesSearch(b, q));

        if (!list.length) {
            const empty = el('div', 'empty-state');
            empty.style.marginTop = '12px';
            empty.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';
            const emptyMsg = q
                ? 'No appointments match your search.'
                : state.tab === 'upcoming'
                    ? 'No upcoming appointments yet.'
                    : state.tab === 'cancelled'
                        ? 'No cancelled appointments.'
                        : 'No past appointments.';
            empty.appendChild(el('p', '', emptyMsg));
            container.appendChild(empty);
            return;
        }

        // Group by date
        const groups = new Map();
        list.forEach((b) => {
            if (!groups.has(b.date)) groups.set(b.date, []);
            groups.get(b.date).push(b);
        });

        let i = 0;
        groups.forEach((items, date) => {
            const group = el('div', 'date-group');
            const title = el('div', 'date-group-title', longDate(date));
            if (date === state.today) title.appendChild(el('span', 'badge teal', 'Today'));
            else if (date === addDays(state.today, 1)) title.appendChild(el('span', 'badge sky', 'Tomorrow'));
            group.appendChild(title);

            items.forEach((b) => {
                const card = el('div', 'booking' + (isNow(b) ? ' now' : '') + (isCancelled(b) ? ' booking-cancelled' : ''));
                card.style.animationDelay = `${Math.min(i++, 12) * 25}ms`;

                const time = el('div', 'booking-time');
                const cleanRange = b.label.replace(' (Drop-off)', '');
                const [start, end] = cleanRange.split(' – ');
                if (b.isDropoff || b.consultationType === 'dropoff') {
                    time.appendChild(el('strong', '', 'Drop-off'));
                    time.appendChild(el('span', '', `${start} – ${end}`));
                } else {
                    time.appendChild(el('strong', '', start));
                    time.appendChild(el('span', '', `to ${end}`));
                }

                const body = el('div', 'booking-body');
                const header = el('div', 'booking-name');
                const groupHeading = b.capstoneTitle || b.teamName;
                const titleText = groupHeading ? `${groupHeading}` : b.name;
                header.appendChild(el('span', 'booking-title', titleText));

                if (isCancelled(b)) {
                    header.appendChild(el('span', 'badge danger', 'Cancelled'));
                } else if (isCompleted(b)) {
                    header.appendChild(el('span', 'badge teal', 'Completed ✓'));
                } else if (isNoShow(b)) {
                    header.appendChild(el('span', 'badge danger', 'No-Show'));
                }

                const typeBadge = b.consultationType === 'defense'
                    ? { label: `${b.consultationTitle || 'Defense'} · ${b.durationLabel || ''}`, cls: 'rose' }
                    : TYPE_BADGES[b.consultationType] || {
                        label: `${b.consultationTitle || 'Consultation'} · ${b.durationLabel || ''}`,
                        cls: 'teal',
                    };
                header.appendChild(el('span', `badge ${typeBadge.cls}`, typeBadge.label));

                const attendedList = Array.isArray(b.attendedMembers) ? b.attendedMembers : [];
                const attendedSet = new Set(attendedList);
                const membersArr = Array.isArray(b.members) && b.members.length ? b.members : [b.name].filter(Boolean);
                const hasAttendanceRecord = !isCancelled(b) && (attendedList.length > 0 || isCompleted(b) || isNoShow(b));
                if (hasAttendanceRecord) {
                    const presentCount = membersArr.filter((m) => attendedSet.has(m)).length;
                    const { required } = requiredAttendanceSummary(b);
                    const attCls = presentCount >= required ? 'sky' : 'amber';
                    header.appendChild(el('span', `badge ${attCls}`, `${presentCount}/${membersArr.length} Present`));
                }

                if (b.notifiedAt && (b.isDropoff || b.consultationType === 'dropoff')) {
                    header.appendChild(el('span', 'badge teal', 'Checked ✓'));
                }
                if (b.notifiedAt && b.consultationType === 'letter') {
                    header.appendChild(el('span', 'badge teal', 'Ready for Pickup ✓'));
                }
                if ((b.rescheduledCount > 0 || b.rescheduledAt) && !isCancelled(b)) {
                    const reschedBadge = el('span', 'badge violet', 'Rescheduled');
                    if (b.previousDate && b.previousLabel) {
                        reschedBadge.title = `Moved from ${shortDate(b.previousDate)} · ${b.previousLabel}`;
                    }
                    header.appendChild(reschedBadge);
                }
                if (b.reminderSentAt) {
                    header.appendChild(el('span', 'badge sky', 'Reminder sent ✓'));
                }
                body.appendChild(header);

                if (membersArr.length) {
                    const membersWrap = el('div', 'booking-members');
                    membersArr.forEach((memberName) => {
                        if (isCancelled(b)) {
                            membersWrap.appendChild(el('span', 'member-chip', memberName));
                        } else {
                            const isPresent = attendedSet.has(memberName);
                            const chipCls = 'member-chip is-interactive'
                                + (isPresent ? ' is-present' : hasAttendanceRecord ? ' is-absent' : '');
                            const chipBtn = el('button', chipCls, isPresent ? `✓ ${memberName}` : memberName);
                            chipBtn.type = 'button';
                            chipBtn.title = isPresent ? 'Present — click to unmark' : 'Click to mark present';
                            chipBtn.setAttribute('aria-pressed', isPresent ? 'true' : 'false');
                            chipBtn.addEventListener('click', () => toggleCardMemberAttendance(b, memberName, chipBtn));
                            membersWrap.appendChild(chipBtn);
                        }
                    });
                    body.appendChild(membersWrap);
                }

                if (b.reason) {
                    body.appendChild(el('p', 'booking-reason', b.reason));
                }

                if (!isCancelled(b)) {
                    const prev = findPreviousConsultation(b);
                    const canonicalPrev = prev ? (state.bookings.find((x) => x.id === prev.id) || prev) : null;
                    const prevItems = Array.isArray(canonicalPrev?.revisionChecklist) ? canonicalPrev.revisionChecklist : [];
                    const showPrevBox = Boolean(
                        canonicalPrev && (prevItems.length > 0 || canonicalPrev.revisionNotes || isCompleted(canonicalPrev) || isNoShow(canonicalPrev))
                    );
                    if (showPrevBox) {
                        const prevBox = el('div', 'prev-consultation-box');
                        const prevHead = el('div', 'prev-consultation-head');
                        prevHead.appendChild(el('strong', '', `From Last Consultation: ${canonicalPrev.consultationTitle || 'Consultation'} (${shortDate(canonicalPrev.date)})`));
                        if (prevItems.length) {
                            const doneCount = prevItems.filter((it) => it.done).length;
                            prevHead.appendChild(
                                el('span', `badge ${doneCount === prevItems.length ? 'teal' : 'amber'}`, `${doneCount}/${prevItems.length} fixed`)
                            );
                        } else if (isNoShow(canonicalPrev)) {
                            prevHead.appendChild(el('span', 'badge danger', 'No-Show'));
                        } else if (isCompleted(canonicalPrev)) {
                            prevHead.appendChild(el('span', 'badge muted-badge', 'Completed'));
                        }
                        prevBox.appendChild(prevHead);
                        if (prevItems.length) {
                            prevBox.appendChild(buildChecklistElement(canonicalPrev, prevItems));
                        }
                        if (canonicalPrev.revisionNotes) {
                            prevBox.appendChild(el('p', 'prev-consultation-notes', canonicalPrev.revisionNotes));
                        }
                        body.appendChild(prevBox);
                    }

                    const curItems = Array.isArray(b.revisionChecklist) ? b.revisionChecklist : [];
                    if (curItems.length || b.revisionNotes) {
                        const revBox = el('div', 'revision-notes-box');
                        revBox.appendChild(el('strong', '', 'Revision Action Items & Notes'));
                        if (curItems.length) {
                            revBox.appendChild(buildChecklistElement(b, curItems));
                        }
                        if (b.revisionNotes) {
                            revBox.appendChild(el('p', 'revision-notes-text', b.revisionNotes));
                        }
                        body.appendChild(revBox);
                    }
                }

                if (isCancelled(b) && b.cancellationReason) {
                    const reasonBox = el('div', 'cancel-reason-box');
                    reasonBox.appendChild(el('strong', '', 'Reason:'));
                    reasonBox.appendChild(el('p', '', b.cancellationReason));
                    body.appendChild(reasonBox);
                }

                const actions = el('div', 'booking-actions');
                if (!isCancelled(b)) {
                    const hasRecordedNotes = isCompleted(b)
                        || isNoShow(b)
                        || Boolean(b.revisionNotes)
                        || (Array.isArray(b.revisionChecklist) && b.revisionChecklist.length > 0)
                        || (Array.isArray(b.attendedMembers) && b.attendedMembers.length > 0);
                    const notesBtn = el(
                        'button',
                        'btn btn-primary-soft btn-sm',
                        hasRecordedNotes ? 'Edit Notes' : 'Notes & Attendance'
                    );
                    notesBtn.type = 'button';
                    notesBtn.addEventListener('click', () => openNotesModal(b));
                    actions.appendChild(notesBtn);
                }
                if (!isCancelled(b) && b.consultationType === 'dropoff' && b.studentEmail) {
                    const notifyBtn = el(
                        'button',
                        'btn btn-ghost btn-sm',
                        b.notifiedAt ? 'Resend Email' : 'Notify Checked'
                    );
                    notifyBtn.type = 'button';
                    notifyBtn.addEventListener('click', () => notifyManuscriptChecked(b, notifyBtn));
                    actions.appendChild(notifyBtn);
                }
                if (!isCancelled(b) && b.consultationType === 'letter' && b.studentEmail) {
                    const notifyLetterBtn = el(
                        'button',
                        'btn btn-ghost btn-sm',
                        b.notifiedAt ? 'Resend Email' : 'Notify Ready for Pickup'
                    );
                    notifyLetterBtn.type = 'button';
                    notifyLetterBtn.addEventListener('click', () => notifyLetterReady(b, notifyLetterBtn));
                    actions.appendChild(notifyLetterBtn);
                }
                if (state.tab === 'upcoming' && !isCancelled(b) && b.consultationType === 'defense') {
                    const reschedDefBtn = el('button', 'btn btn-rose-soft btn-sm', 'Reschedule');
                    reschedDefBtn.type = 'button';
                    reschedDefBtn.addEventListener('click', () => openScheduleDefenseModal({ bookingToReschedule: b }));
                    actions.appendChild(reschedDefBtn);
                }
                if (state.tab === 'upcoming' && !isCancelled(b)) {
                    const btn = el('button', 'btn btn-danger-soft', 'Cancel');
                    btn.type = 'button';
                    btn.addEventListener('click', () => openCancelModal(b));
                    actions.appendChild(btn);
                }

                if (actions.childNodes.length) {
                    card.append(time, body, actions);
                } else {
                    card.append(time, body);
                }
                group.appendChild(card);
            });

            container.appendChild(group);
        });
    }

    /* ---------------- init ---------------- */
    $('#year').textContent = new Date().getFullYear();
    $('#loginForm').addEventListener('submit', login);
    $('#passwordInput')?.addEventListener('input', () => {
        $('#passwordInput').classList.remove('input-invalid');
    });
    $('#logoutBtn').addEventListener('click', logout);
    $('#searchInput').addEventListener('input', (e) => {
        state.search = e.target.value.trim();
        render();
    });
    document.querySelectorAll('.admin-view-btn[data-admin-view]').forEach((btn) => {
        btn.addEventListener('click', () => switchAdminView(btn.dataset.adminView));
    });
    document.querySelectorAll('.tab[data-tab]').forEach((tab) => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab[data-tab]').forEach((t) => t.classList.toggle('active', t === tab));
            state.tab = tab.dataset.tab;
            state.adminView = 'consultations';
            render();
        });
    });
    $('#studentSearchInput')?.addEventListener('input', (e) => {
        state.studentSearch = e.target.value.trim();
        renderStudentsSection();
    });
    document.querySelectorAll('.student-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.student-tab').forEach((t) => t.classList.toggle('active', t === tab));
            state.studentRoleFilter = tab.dataset.role || 'all';
            renderStudentsSection();
        });
    });

    // Unified Schedule & Availability Manager bindings
    $('#openScheduleTabBtn')?.addEventListener('click', () => switchAdminView('schedule', true));
    document.querySelectorAll('.sched-mode-pill[data-select-mode]').forEach((btn) => {
        btn.addEventListener('click', () => setSchedSelectMode(btn.dataset.selectMode));
    });
    $('#schedClearSelectionBtn')?.addEventListener('click', () => {
        state.schedRangeAnchor = null;
        state.schedSelectedDates = new Set();
        renderScheduleManager();
    });
    $('#schedJumpInspectorBtn')?.addEventListener('click', () => {
        const slotsCard = $('#schedSlotsCard');
        const target = slotsCard && !slotsCard.classList.contains('hidden')
            ? slotsCard
            : $('#schedInspectorPanel');
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    document.querySelectorAll('#schedSlotsTypePills [data-slot-preview]').forEach((pill) => {
        pill.addEventListener('click', () => {
            state.schedSlotPreviewType = pill.dataset.slotPreview || 'defense_1h';
            renderScheduleSlotsPreviewCard(getSortedSelectedDates());
        });
    });
    $('#schedPrevMonth')?.addEventListener('click', () => changeSchedMonth(-1));
    $('#schedNextMonth')?.addEventListener('click', () => changeSchedMonth(1));
    $('#schedTodayBtn')?.addEventListener('click', jumpSchedToday);

    document.querySelectorAll('input[name="schedActionMode"]').forEach((r) => {
        r.addEventListener('change', (e) => {
            state.schedActionMode = e.target.value === 'block' ? 'block' : 'open';
            setSchedOpenError('');
            setSchedBlockError('');
            renderScheduleInspector();
        });
    });

    document.querySelectorAll('.sched-cat-card[data-cat]').forEach((card) => {
        card.addEventListener('click', () => {
            state.schedCategory = card.dataset.cat;
            setSchedOpenError('');
            renderScheduleInspector();
        });
    });

    document.querySelectorAll('input[name="schedHourMode"]').forEach((r) => {
        r.addEventListener('change', (e) => {
            state.schedHourMode = e.target.value;
            setSchedOpenError('');
            renderScheduleInspector();
        });
    });

    $('#schedAddCustomWinBtn')?.addEventListener('click', () => {
        if (state.schedCustomWindows.length >= 4) return;
        state.schedCustomWindows.push({ start: '13:00', end: '17:00' });
        renderCustomWindowRows();
    });

    document.querySelectorAll('.sched-open-preset').forEach((chip) => {
        chip.addEventListener('click', () => {
            const start = chip.dataset.start || '14:10';
            const end = chip.dataset.end || '15:30';
            state.schedCustomWindows = [{ start, end }];
            setSchedOpenError('');
            renderCustomWindowRows();
        });
    });

    $('#schedResetPresetBtn')?.addEventListener('click', (e) => resetRegularHoursToPreset(e.currentTarget));

    $('#schedOpenForm')?.addEventListener('submit', submitOpenScheduleForm);

    document.querySelectorAll('input[name="schedBlockScope"]').forEach((r) => {
        r.addEventListener('change', (e) => {
            state.schedBlockScope = e.target.value === 'time' ? 'time' : 'full';
            setSchedBlockError('');
            renderScheduleInspector();
        });
    });
    document.querySelectorAll('.sched-time-preset').forEach((chip) => {
        chip.addEventListener('click', () => {
            if ($('#schedBlockStartInput')) $('#schedBlockStartInput').value = chip.dataset.start || '12:00';
            if ($('#schedBlockEndInput')) $('#schedBlockEndInput').value = chip.dataset.end || '13:00';
            setSchedBlockError('');
        });
    });
    document.querySelectorAll('.block-reason-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
            const inp = $('#schedBlockReasonInput');
            if (!inp) return;
            inp.value = chip.dataset.blockReason || '';
            setSchedBlockError('');
            inp.focus();
        });
    });
    $('#schedBlockForm')?.addEventListener('submit', submitBlockScheduleForm);

    document.querySelectorAll('input[name="schedRegType"]').forEach((r) => {
        r.addEventListener('change', (e) => {
            state.schedRegType = e.target.value === 'defense' ? 'defense' : 'consultation';
            renderRegularHoursSection();
        });
    });

    document.querySelectorAll('#schedOverviewFilters [data-overview-filter]').forEach((btn) => {
        btn.addEventListener('click', () => {
            state.schedOverviewFilter = btn.dataset.overviewFilter || 'all';
            renderScheduleOverview();
        });
    });

    // Cancel modal bindings
    $('#cancelBookingForm')?.addEventListener('submit', submitCancelBooking);
    $('#closeCancelModalBtn')?.addEventListener('click', closeCancelModal);
    $('#keepAppointmentBtn')?.addEventListener('click', closeCancelModal);
    $('#cancelModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'cancelModal') closeCancelModal();
    });
    $('#cancelReasonInput')?.addEventListener('input', (e) => {
        $('#cancelReasonCount').textContent = e.target.value.length;
        setCancelError('');
    });
    document.querySelectorAll('.reason-chip:not(.block-reason-chip)').forEach((chip) => {
        chip.addEventListener('click', () => {
            const input = $('#cancelReasonInput');
            if (!input) return;
            input.value = chip.dataset.reason || '';
            $('#cancelReasonCount').textContent = input.value.length;
            setCancelError('');
            input.focus();
        });
    });
    // Notes, revision checklist & attendance modal bindings
    $('#notesForm')?.addEventListener('submit', submitNotesForm);
    $('#closeNotesModalBtn')?.addEventListener('click', closeNotesModal);
    $('#cancelNotesModalBtn')?.addEventListener('click', closeNotesModal);
    $('#notesModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'notesModal') closeNotesModal();
    });
    $('#markAllPresentBtn')?.addEventListener('click', () => {
        const b = state.notesTarget;
        if (!b) return;
        const members = Array.isArray(b.members) && b.members.length ? b.members : [b.name].filter(Boolean);
        state.notesDraftAttended = new Set(members);
        renderNotesAttendanceList();
    });
    $('#markAllAbsentBtn')?.addEventListener('click', () => {
        state.notesDraftAttended = new Set();
        renderNotesAttendanceList();
    });
    $('#addChecklistItemBtn')?.addEventListener('click', addDraftChecklistItem);
    $('#notesChecklistInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addDraftChecklistItem();
        }
    });
    $('#copyPrevUnfinishedBtn')?.addEventListener('click', copyPrevUnfinishedToDraft);
    $('#revisionNotesInput')?.addEventListener('input', (e) => {
        if ($('#revisionNotesCount')) $('#revisionNotesCount').textContent = String(e.target.value.length);
        setNotesFormError('');
    });

    // Email Activity & Sent Logs bindings
    document.querySelectorAll('.email-sender-tab[data-email-sender]').forEach((tab) => {
        tab.addEventListener('click', () => {
            state.emailSenderFilter = tab.dataset.emailSender || 'all';
            state.emailVisibleLimit = 20;
            renderEmailLogsSection();
        });
    });
    document.querySelectorAll('#emailCategoryFilters [data-email-cat]').forEach((pill) => {
        pill.addEventListener('click', () => {
            state.emailCategoryFilter = pill.dataset.emailCat || 'all';
            state.emailVisibleLimit = 20;
            renderEmailLogsSection();
        });
    });
    $('#emailLogSearchInput')?.addEventListener('input', (e) => {
        state.emailSearch = e.target.value.trim();
        state.emailVisibleLimit = 20;
        renderEmailLogsSection();
    });
    $('#composeEmailFromLogsBtn')?.addEventListener('click', () => openSendEmailModal());
    $('#jumpToEmailLogsBtn')?.addEventListener('click', () => {
        closeSendEmailModal();
        switchAdminView('emails', true);
    });

    // Admin Schedule Group for Defense modal bindings
    $('#openScheduleDefenseModalBtn')?.addEventListener('click', () => openScheduleDefenseModal());
    $('#scheduleDefenseFromStudentsBtn')?.addEventListener('click', () => openScheduleDefenseModal());
    $('#closeScheduleDefenseModalBtn')?.addEventListener('click', closeScheduleDefenseModal);
    $('#cancelScheduleDefenseBtn')?.addEventListener('click', closeScheduleDefenseModal);
    $('#scheduleDefenseModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'scheduleDefenseModal') closeScheduleDefenseModal();
    });
    $('#defStudentSelect')?.addEventListener('change', () => applySelectedDefenseStudent(true));
    $('#defReplaceExistingCheck')?.addEventListener('change', () => {
        syncDefenseSubmitLabel();
        renderDefenseDayPreview();
    });
    document.querySelectorAll('input[name="defLevel"]').forEach((r) => {
        r.addEventListener('change', () => {
            setDefenseFormError('');
            renderDefenseDayPreview();
        });
    });
    document.querySelectorAll('input[name="defRole"]').forEach((r) => {
        r.addEventListener('change', () => setDefenseFormError(''));
    });
    $('#defAddMemberBtn')?.addEventListener('click', () => {
        if (state.defDraftMembers.length >= 3) return;
        state.defDraftMembers.push('');
        renderDefenseMemberInputs();
        const inputs = document.querySelectorAll('#defMemberList input');
        inputs[inputs.length - 1]?.focus();
    });
    $('#defDateInput')?.addEventListener('input', () => {
        const val = ($('#defDateInput')?.value || '').trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
            const [vy, vm] = val.split('-').map(Number);
            state.defCalYear = vy;
            state.defCalMonth = vm - 1;
        }
        setDefenseFormError('');
        renderDefenseDayPreview();
    });
    $('#defStartTimeInput')?.addEventListener('input', () => {
        setDefenseFormError('');
        renderDefenseDayPreview();
    });
    $('#defCalPrevBtn')?.addEventListener('click', () => changeDefenseCalMonth(-1));
    $('#defCalNextBtn')?.addEventListener('click', () => changeDefenseCalMonth(1));
    $('#defCapstoneInput')?.addEventListener('input', () => setDefenseFormError(''));
    $('#defReasonInput')?.addEventListener('input', () => setDefenseFormError(''));
    $('#defGroupEmailInput')?.addEventListener('input', () => {
        setDefenseFormError('');
        syncDefenseEmailControls();
    });
    $('#defExtraEmailsInput')?.addEventListener('input', () => {
        setDefenseFormError('');
        syncDefenseEmailControls();
    });
    $('#defSendEmailCheck')?.addEventListener('change', () => syncDefenseEmailControls());
    $('#scheduleDefenseForm')?.addEventListener('submit', submitScheduleDefense);

    // Manual Send Email modal bindings
    $('#openSendEmailModalBtn')?.addEventListener('click', () => openSendEmailModal());
    $('#closeSendEmailModalBtn')?.addEventListener('click', closeSendEmailModal);
    $('#cancelSendEmailModalBtn')?.addEventListener('click', closeSendEmailModal);
    $('#sendEmailModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'sendEmailModal') closeSendEmailModal();
    });
    $('#emailStudentSelect')?.addEventListener('change', () => applySelectedEmailStudent(true));
    document.querySelectorAll('input[name="emailTemplate"]').forEach((r) => {
        r.addEventListener('change', (e) => setEmailTemplate(e.target.value));
    });
    $('#emailRecipientInput')?.addEventListener('input', () => {
        syncEmailGroupmatesOption();
        setSendEmailError('');
    });
    $('#emailSubjectInput')?.addEventListener('input', () => setSendEmailError(''));
    $('#emailMessageInput')?.addEventListener('input', (e) => {
        if ($('#emailMessageCount')) $('#emailMessageCount').textContent = String(e.target.value.length);
        setSendEmailError('');
    });
    $('#sendEmailForm')?.addEventListener('submit', submitSendEmail);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeCancelModal();
            closeNotesModal();
            closeSendEmailModal();
            closeScheduleDefenseModal();
        }
    });

    if (state.password) {
        showDashboard();
        loadBookings();
    } else {
        showLogin();
        ensureConfig();
    }

    window.SchedulerRealtime?.subscribe(() => {
        if (!state.password) return;
        loadBookings();
    });

    // Periodically trigger the 10-minute appointment reminder sweep while the dashboard is open and visible
    setInterval(async () => {
        if (!state.password || document.visibilityState === 'hidden') return;
        try {
            const res = await fetch('/api/cron/reminders', {
                method: 'POST',
                headers: { 'x-admin-password': state.password },
            });
            if (res.ok) {
                const data = await res.json().catch(() => null);
                if (data && (data.sentCount > 0 || data.studentSentCount > 0)) {
                    loadBookings();
                }
            }
        } catch {
            // Ignore transient network errors during background polling
        }
    }, 5 * 60 * 1000);
})();
