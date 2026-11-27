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
        tab: 'upcoming',
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
            setTimeout(() => pwInput.focus(), 50);
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
        state.bookings = [];
        state.blockedSchedules = [];
        state.letterPickupSchedules = [];
        state.scheduleConfig = null;
        state.schedInitialized = false;
        state.schedSelectedDates = new Set();
        state.students = [];
        state.studentUpdateLogs = [];
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

    function hasUpcomingLetterPickupWindow() {
        const fromConfig = (state.scheduleConfig?.openDates || []).some(
            (e) => e.category === 'letter_pickup'
                && (!state.today || e.date > state.today)
                && Array.isArray(e.effectiveWindows)
                && e.effectiveWindows.length > 0
        );
        return fromConfig || state.letterPickupSchedules.some(isActiveLetterPickup);
    }

    function countUpcomingOpenScheduleItems() {
        const openDates = state.scheduleConfig?.openDates || [];
        const uniqueDates = new Set(
            openDates
                .filter((e) => (!state.today || e.date >= state.today) && Array.isArray(e.effectiveWindows) && e.effectiveWindows.length > 0)
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

    function switchAdminTab(tabName, scrollIntoView = false) {
        state.tab = tabName;
        document.querySelectorAll('.tab[data-tab]').forEach((t) => {
            t.classList.toggle('active', t.dataset.tab === tabName);
        });
        render();
        if (scrollIntoView) {
            $('#mainBookingsCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
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
        const selectedCount = state.schedSelectedDates.size;
        if (hintTextEl) {
            if (state.schedSelectMode === 'range' && state.schedRangeAnchor) {
                hintTextEl.textContent = `Start date: ${shortDate(state.schedRangeAnchor)} — now click an end date on the calendar.`;
            } else if (selectedCount > 1) {
                hintTextEl.textContent = `${selectedCount} dates selected on calendar.`;
            } else if (selectedCount === 1) {
                const only = getSortedSelectedDates()[0];
                hintTextEl.textContent = `Selected: ${longDate(only)} (Shift+click another date to select a range).`;
            } else if (state.schedSelectMode === 'multi') {
                hintTextEl.textContent = 'Click multiple dates on the calendar to toggle them.';
            } else if (state.schedSelectMode === 'range') {
                hintTextEl.textContent = 'Click a start date, then click an end date on the calendar.';
            } else {
                hintTextEl.textContent = 'Click any date on the calendar to open or block it.';
            }
        }
        clearBtn?.classList.toggle('hidden', selectedCount <= 1 && !state.schedRangeAnchor);

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
                    tags.appendChild(el('span', `sched-day-tag ${meta.badgeCls}`, `${meta.shortTag}${shortHours ? ` · ${shortHours}` : ''}`));
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
                const apptBox = el('div', 'sched-appt-notice');
                apptBox.appendChild(el('span', '', `${dayAppts.length} scheduled appointment${dayAppts.length === 1 ? '' : 's'} on this date`));
                const viewBtn = el('button', 'link-btn', 'View in Upcoming →');
                viewBtn.type = 'button';
                viewBtn.addEventListener('click', () => {
                    state.search = ds;
                    if ($('#searchInput')) $('#searchInput').value = ds;
                    switchAdminTab(state.today && ds < state.today ? 'past' : 'upcoming');
                });
                apptBox.appendChild(viewBtn);
                currentListEl.appendChild(apptBox);
            }

            ['consultation', 'defense', 'letter_pickup'].forEach((cat) => {
                const meta = CATEGORY_META[cat];
                const entry = dayOpen[cat];
                const row = el('div', 'sched-status-row' + (entry ? ' is-open' : ''));
                const info = el('div', 'sched-status-row-info');
                const top = el('div', 'sched-status-row-top');
                top.appendChild(el('span', `badge ${entry ? meta.badgeCls : 'muted-badge'}`, meta.label));
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
                        ? `Open · ${entry.label}${entry.note ? ` (${entry.note})` : ''}`
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
            const dows = selected.length
                ? [...new Set(selected.map((d) => utcDate(d).getUTCDay()))].sort((a, b) => a - b)
                : [1, 2, 3, 4, 5, 6];
            const missingNames = [];
            const parts = [];
            dows.forEach((dow) => {
                const wins = hoursTable[dow] || hoursTable[String(dow)] || [];
                if (wins.length) {
                    parts.push(`${WEEKDAY_SHORT[dow]}: ${wins.map((w) => w.label).join(', ')}`);
                } else if (selected.length) {
                    missingNames.push(WEEKDAY_FULL[dow]);
                }
            });
            if (missingNames.length > 0) {
                regPreviewEl.textContent = `Note: ${missingNames.join(', ')} ${missingNames.length === 1 ? 'has' : 'have'} no regular ${isDefense ? 'Defense' : 'Consultation'} Hours set yet — edit below or pick 10:00 AM – 5:00 PM / Custom.`;
                regPreviewEl.classList.add('is-warning');
            } else if (parts.length > 0) {
                regPreviewEl.textContent = parts.join(' · ');
                regPreviewEl.classList.remove('is-warning');
            } else {
                regPreviewEl.textContent = 'No regular weekly hours set yet — configure them below.';
                regPreviewEl.classList.add('is-warning');
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
    }

    function renderRegularHoursSection() {
        const grid = $('#schedRegularGrid');
        if (!grid) return;
        grid.innerHTML = '';

        document.querySelectorAll('input[name="schedRegType"]').forEach((r) => {
            r.checked = r.value === state.schedRegType;
        });

        const isDefense = state.schedRegType === 'defense';
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
        if (state.tab !== 'schedule') return;
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
            if (unblockDates && res.unblockedCount > 0) {
                const dateSet = new Set(dates);
                state.blockedSchedules = state.blockedSchedules.filter((b) => !(dateSet.has(b.date) && b.isFullDay));
            }
            if ($('#schedOpenNoteInput')) $('#schedOpenNoteInput').value = '';
            state.schedBusy = false;
            updateHeaderDates();
            renderScheduleManager();
            window.SchedulerRealtime?.notifyLocal({ type: 'schedule_config_updated', dates });
            const catLabel = CATEGORY_META[state.schedCategory]?.label || 'Schedule';
            toast(
                `Opened ${catLabel} on ${dates.length === 1 ? shortDate(dates[0]) : `${dates.length} dates`}.`,
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

    async function notifyManuscriptChecked(b, btn) {
        const target = b.studentEmail || 'student';
        const again = b.notifiedAt ? ' again' : '';
        if (!confirm(`Send "Manuscript Ready for Pickup" notification email${again} to ${target}?`)) return;
        btn.disabled = true;
        const prevText = btn.textContent;
        btn.textContent = 'Sending…';
        try {
            const { notifiedAt } = await api(`/api/admin/bookings/${b.id}/notify-checked`, { method: 'POST' });
            b.notifiedAt = notifiedAt;
            render();
            window.SchedulerRealtime?.notifyLocal({ type: 'manuscript_checked', bookingId: b.id, date: b.date });
            toast(`Notification emailed to ${target}.`, 'success');
        } catch (err) {
            btn.disabled = false;
            btn.textContent = prevText;
            toast(err.message, 'error');
        }
    }

    async function notifyLetterReady(b, btn) {
        const target = b.studentEmail || 'student';
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
            const { notifiedAt } = await api(`/api/admin/bookings/${b.id}/notify-letter-ready`, { method: 'POST' });
            b.notifiedAt = notifiedAt;
            render();
            window.SchedulerRealtime?.notifyLocal({ type: 'letter_notified', bookingId: b.id, date: b.date });
            toast(
                hasOpenPickupWindows
                    ? `Notification emailed to ${target}.`
                    : `Notification emailed to ${target}. Open a Letter Pickup date in "Schedule & Availability" so they can book.`,
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

    function applySelectedEmailStudent(clearIfEmpty = false) {
        const select = $('#emailStudentSelect');
        if (!select) return;
        const selectedId = select.value;
        const student = state.students.find((s) => s.id === selectedId);
        if (student) {
            if ($('#emailRecipientInput')) $('#emailRecipientInput').value = student.email || '';
            if ($('#emailStudentNameInput')) $('#emailStudentNameInput').value = student.name || '';
            if ($('#emailCapstoneInput')) $('#emailCapstoneInput').value = student.capstoneTitle || '';
        } else if (clearIfEmpty) {
            if ($('#emailRecipientInput')) $('#emailRecipientInput').value = '';
            if ($('#emailStudentNameInput')) $('#emailStudentNameInput').value = '';
            if ($('#emailCapstoneInput')) $('#emailCapstoneInput').value = '';
        }
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
            const res = await api('/api/admin/send-email', {
                method: 'POST',
                body: JSON.stringify({
                    studentId: studentId || null,
                    email,
                    studentName,
                    capstoneTitle,
                    template,
                    subject,
                    message,
                }),
            });
            state.sendingEmail = false;
            closeSendEmailModal();
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
        return false;
    }

    const FIELD_LABELS = {
        full_name: 'Full name',
        email: 'University email',
        capstone_title: 'Capstone / Thesis title',
        instructor_role: 'Instructor role',
        project_level: 'Course',
        members: 'Group members',
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
            const membersSection = el('div', 'student-members-block');
            membersSection.appendChild(el('span', 'student-field-label', `Group Members (${members.length})`));
            const membersWrap = el('div', 'booking-members');
            members.forEach((m, mIdx) => {
                membersWrap.appendChild(el('span', 'member-chip', mIdx === 0 ? `${m} (Rep)` : m));
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
            const emailBtn = el('button', 'btn btn-primary-soft btn-sm', 'Send Email');
            emailBtn.type = 'button';
            emailBtn.addEventListener('click', () => openSendEmailModal(s));
            footer.appendChild(emailBtn);
            card.appendChild(footer);

            container.appendChild(card);
        });
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

        renderStudentsSection();

        const isScheduleTab = state.tab === 'schedule';
        $('#mainSearchLabel')?.classList.toggle('hidden', isScheduleTab);
        $('#scheduleManagerView')?.classList.toggle('hidden', !isScheduleTab);
        $('#bookingList')?.classList.toggle('hidden', isScheduleTab);

        if (isScheduleTab) {
            renderScheduleManager();
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
    document.querySelectorAll('.tab[data-tab]').forEach((tab) => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab[data-tab]').forEach((t) => t.classList.toggle('active', t === tab));
            state.tab = tab.dataset.tab;
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
    $('#openScheduleTabBtn')?.addEventListener('click', () => switchAdminTab('schedule', true));
    document.querySelectorAll('.sched-mode-pill[data-select-mode]').forEach((btn) => {
        btn.addEventListener('click', () => setSchedSelectMode(btn.dataset.selectMode));
    });
    $('#schedClearSelectionBtn')?.addEventListener('click', () => {
        state.schedRangeAnchor = null;
        state.schedSelectedDates = new Set();
        renderScheduleManager();
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
    ['#emailRecipientInput', '#emailSubjectInput'].forEach((sel) => {
        $(sel)?.addEventListener('input', () => setSendEmailError(''));
    });
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

    // Periodically trigger the 10-minute appointment reminder sweep while the dashboard is open
    setInterval(async () => {
        if (!state.password) return;
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
    }, 60 * 1000);
})();
