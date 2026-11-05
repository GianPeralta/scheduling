(() => {
    'use strict';

    const $ = (sel) => document.querySelector(sel);
    const setText = (sel, val) => {
        const el = $(sel);
        if (el) el.textContent = val;
    };
    const MIN_MEMBERS = 1;
    const MAX_MEMBERS = 3;
    const CANCEL_CUTOFF_MINUTES = 120; // 2 hours before scheduled time

    const PURPOSE_META = {
        system: {
            title: 'System Consultation',
            badge: '15 minutes',
            summary: 'System Consultation · 15 min',
            color: 'teal',
            requiresAllMembers: true,
            reasonOptional: false,
            bannerNote: 'All members must be present during System Consultations.',
            policyHtml: '<strong>Attendance Requirement:</strong> All members must be present during your 15-minute System Consultation.',
            confirmHtml: '<strong>Reminder:</strong> All members must be present during your System Consultation.',
            reasonLabel: 'What will you present or consult about?',
            reasonPlaceholder: 'e.g. Present our completed modules, database workflow, and ask for feedback.',
        },
        dropoff: {
            title: 'Drop-off Manuscript',
            badge: 'Drop-off only',
            summary: 'Drop-off Manuscript',
            color: 'amber',
            requiresAllMembers: false,
            reasonOptional: true,
            bannerNote: 'Drop-off only. You will be notified via school email once checked.',
            policyHtml: '<strong>Drop-off Only:</strong> Once your manuscript is checked, you will be notified through your registered school email (<strong data-student-email></strong>).',
            confirmHtml: '<strong>What happens next:</strong> Once your manuscript is checked, you will receive an email at your registered school address. Return to this website afterward to book a <strong>5-minute Retrieval of Manuscript</strong>.',
            reasonLabel: 'Manuscript details / notes',
            reasonPlaceholder: 'e.g. Chapters 1–3 revised draft for checking (optional)',
        },
        retrieval: {
            title: 'Retrieval of Manuscript',
            badge: '5 minutes',
            summary: 'Retrieval of Manuscript · 5 min',
            color: 'sky',
            requiresAllMembers: true,
            reasonOptional: true,
            bannerNote: 'Schedule once notified by email. All members must be present.',
            policyHtml: '<strong>Attendance Requirement:</strong> Schedule this once you have received the email saying your manuscript is checked. <strong>All members must be present</strong>, otherwise you will not be accommodated.',
            confirmHtml: '<strong>Important:</strong> All members must be present during Manuscript Retrieval, otherwise you will not be accommodated.',
            reasonLabel: 'Notes for retrieval',
            reasonPlaceholder: 'e.g. Retrieving checked manuscript to discuss needed changes (optional)',
        },
        letter: {
            title: 'Communication Letter Signature',
            badge: '5 minutes',
            summary: 'Comm. Letter Signature · 5 min',
            color: 'violet',
            requiresAllMembers: false,
            adviserOnly: true,
            reasonOptional: false,
            bannerNote: 'Letter must already bear the initial of Ma’am Melinda Beninsig.',
            policyHtml: '<strong>Prerequisite Confirmed:</strong> Please bring your printed communication letter that already has the <strong>initial of Ma’am Melinda Beninsig</strong> before requesting your adviser’s signature.',
            confirmHtml: '<strong>Reminder:</strong> Bring your printed communication letter with Ma’am Melinda Beninsig’s initial to your appointment.',
            reasonLabel: 'Purpose of the communication letter',
            reasonPlaceholder: 'e.g. Request letter to conduct survey / data gathering with target respondents.',
        },
        defense: {
            title: 'Defense',
            badge: '1–2 hours',
            summary: 'Defense',
            color: 'rose',
            requiresAllMembers: true,
            reasonOptional: true,
            bannerNote: 'All members must be present during the defense.',
            reasonLabel: 'Notes for your defense',
            reasonPlaceholder: 'e.g. Panel members attending, equipment you will bring, etc. (optional)',
        },
    };

    // Capstone / Thesis level -> defense length (kept in sync with the server's DEFENSE_LEVELS)
    const DEFENSE_LEVELS = {
        capstone1: { label: 'Capstone 1', durationMinutes: 60, durationLabel: '1 hour' },
        capstone2: { label: 'Capstone 2', durationMinutes: 120, durationLabel: '2 hours' },
        thesis1: { label: 'Thesis 1', durationMinutes: 60, durationLabel: '1 hour' },
        thesis2: { label: 'Thesis 2', durationMinutes: 120, durationLabel: '2 hours' },
    };
    const isDefenseLevel = (v) => Object.prototype.hasOwnProperty.call(DEFENSE_LEVELS, v);

    const state = {
        config: null,
        configPromise: null,
        currentStep: 1, // 1 = Type, 2 = Date & Time, 3 = Sign in & Details, 4 = Confirmed
        viewYear: 0,
        viewMonth: 0, // 0-11
        monthDays: {}, // { 'YYYY-MM-DD': { bookable, open } }
        selectedDate: null,
        selectedSlot: null, // { startMinute, endMinute, durationMinutes, isDropoff, label, endLabel }
        consultationPurpose: null, // 'system' | 'dropoff' | 'retrieval' | 'letter' | 'defense'
        defenseLevel: null, // 'capstone1' | 'capstone2' | 'thesis1' | 'thesis2' (only for defenses)
        defenseDay: null, // last /api/slots response for a defense date (windows + free ranges)
        beninsigConfirmed: false,
        bookingType: 'group', // 'individual' | 'group'
        monthRequest: 0,
        slotsRequest: 0,
        loadedMonthKey: null,
        loadingSlotsKey: null,
        loadedSlotsKey: null,
        activeWindowLabel: null,
        submitting: false,
        student: null, // { id, name, email, capstoneTitle, instructorRole, members }
        myBookings: [],
        profileFilter: 'all', // 'all' | 'upcoming' | 'cancelled' | 'past'
        serverToday: '',
        serverCurrentMinute: 0,
        authMode: 'login', // 'login' | 'register' | 'forgot' | 'otp'
        otpPurpose: 'register', // 'register' | 'reset'
        otpEmail: '',
        resendTimer: null,
        authBusy: false,
    };

    /* ---------------- helpers ---------------- */
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
    const monthKey = (y, m) => `${y}-${pad(m + 1)}`;

    function utcDate(str) {
        const [y, m, d] = str.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d));
    }

    function formatLongDate(str) {
        return utcDate(str).toLocaleDateString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
        });
    }

    function formatShortDate(str) {
        return utcDate(str).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
        });
    }

    function formatMinute(totalMinutes) {
        const h = Math.floor(totalMinutes / 60) % 24;
        const m = totalMinutes % 60;
        const suffix = h >= 12 ? 'PM' : 'AM';
        const hr = h % 12 === 0 ? 12 : h % 12;
        return `${hr}:${pad(m)} ${suffix}`;
    }

    function getDefenseLevelInfo(level = state.defenseLevel || state.student?.projectLevel) {
        return DEFENSE_LEVELS[level] || null;
    }

    function getMeta(purpose = state.consultationPurpose, levelOverride = null) {
        if (purpose === 'defense') {
            const base = PURPOSE_META.defense;
            const info = getDefenseLevelInfo(levelOverride || state.defenseLevel);
            if (!info) return base;
            return {
                ...base,
                title: `${info.label} Defense`,
                badge: info.durationLabel,
                summary: `${info.label} Defense · ${info.durationLabel}`,
            };
        }
        return PURPOSE_META[purpose] || PURPOSE_META.system;
    }

    async function api(url, options = {}) {
        const res = await fetch(url, {
            headers: { 'Content-Type': 'application/json' },
            ...options,
        });
        let body = {};
        try { body = await res.json(); } catch { /* ignore */ }
        if (!res.ok) {
            const err = new Error(body.error || `Request failed (${res.status})`);
            err.status = res.status;
            err.code = body.code;
            err.field = body.field;
            throw err;
        }
        return body;
    }

    let toastTimer;
    function toast(message, type = 'info') {
        const el = $('#toast');
        el.textContent = message;
        el.className = `toast show ${type}`;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.className = 'toast'; }, 4200);
    }

    /* ---------------- inline field validation ---------------- */
    function findFieldContainer(target) {
        const el = typeof target === 'string' ? $(target) : target;
        if (!el) return null;
        return el.classList.contains('field') ? el : el.closest('.field');
    }

    function clearFieldError(target) {
        const field = findFieldContainer(target);
        if (!field) return;
        field.classList.remove('has-error');
        field.querySelectorAll('.input-invalid').forEach((inp) => {
            inp.classList.remove('input-invalid');
            inp.removeAttribute('aria-invalid');
        });
        const err = field.querySelector('.field-error');
        if (err) err.remove();
    }

    function clearFormFieldErrors(root) {
        const container = typeof root === 'string' ? $(root) : root;
        if (!container) return;
        container.querySelectorAll('.field.has-error').forEach((f) => clearFieldError(f));
    }

    /**
     * Highlights the specific invalid input AND places the error message directly underneath it,
     * scrolling both into view so the user never has to hunt at the bottom of the form.
     */
    function setFieldError(inputOrSelector, message, focusTarget = null) {
        const targetEl = typeof inputOrSelector === 'string' ? $(inputOrSelector) : inputOrSelector;
        const field = findFieldContainer(targetEl);
        if (!field) return false;

        clearFieldError(field);
        field.classList.add('has-error');

        const inputToMark = focusTarget
            || (targetEl.matches && targetEl.matches('input, textarea, select') ? targetEl : field.querySelector('input:not([readonly]), textarea'));
        if (inputToMark) {
            inputToMark.classList.add('input-invalid');
            inputToMark.setAttribute('aria-invalid', 'true');
        }

        const errEl = document.createElement('small');
        errEl.className = 'field-error';
        errEl.setAttribute('role', 'alert');
        errEl.textContent = message;
        field.appendChild(errEl);

        field.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (inputToMark) {
            setTimeout(() => inputToMark.focus({ preventScroll: true }), 120);
        }
        return true;
    }

    function showBannerError(selector, msg) {
        const el = $(selector);
        if (!el) return;
        el.textContent = msg || '';
        el.classList.toggle('hidden', !msg);
        if (msg) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    function setFormError(msg) {
        showBannerError('#formError', msg);
    }

    function setAuthError(msg) {
        showBannerError('#authError', msg);
    }

    /* ---------------- steps & auth gate ---------------- */
    function showAuthGate() {
        $('#bootPanel')?.classList.add('hidden');
        ['#step1', '#step2', '#step3', '#step4'].forEach((id) => $(id)?.classList.add('hidden'));
        $('#bookingSteps')?.classList.add('hidden');
        $('#selectionBox')?.classList.add('hidden');
        $('#studentProjectBox')?.classList.add('hidden');
        $('#authPanel')?.classList.remove('hidden');
    }

    function goToStep(n) {
        if (!state.student) {
            showAuthGate();
            return;
        }
        state.currentStep = n;
        $('#bootPanel')?.classList.add('hidden');
        $('#authPanel')?.classList.add('hidden');
        $('#bookingSteps')?.classList.remove('hidden');
        ['#step1', '#step2', '#step3', '#step4'].forEach((id, i) => {
            $(id)?.classList.toggle('hidden', i + 1 !== n);
        });
        document.querySelectorAll('.step').forEach((el) => {
            const s = Number(el.dataset.step);
            el.classList.toggle('active', s === n);
            el.classList.toggle('done', s < n);
        });
        if (n === 3) {
            renderStep3();
            setTimeout(() => {
                $('#reasonInput')?.focus({ preventScroll: true });
            }, 60);
        }
        if (window.innerWidth <= 960) {
            const activePanel = $(['#step1', '#step2', '#step3', '#step4'][n - 1]);
            (activePanel || $('#scheduler'))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    function updateSelectionBox() {
        const box = $('#selectionBox');
        if (!state.consultationPurpose) {
            box.classList.add('hidden');
            return;
        }
        const meta = getMeta();
        $('#selectionPurpose').textContent = meta.summary;
        if (state.selectedDate && state.selectedSlot) {
            $('#selectionDate').textContent = formatLongDate(state.selectedDate);
            $('#selectionTime').textContent = state.selectedSlot.isDropoff
                ? `${state.selectedSlot.label} (Drop-off)`
                : `${state.selectedSlot.label} – ${state.selectedSlot.endLabel}`;
        } else if (state.selectedDate) {
            $('#selectionDate').textContent = formatLongDate(state.selectedDate);
            $('#selectionTime').textContent = state.consultationPurpose === 'defense'
                ? 'Type or pick a start time'
                : 'Select a time slot';
        } else {
            $('#selectionDate').textContent = 'Select a date & time';
            $('#selectionTime').textContent = '';
        }
        box.classList.remove('hidden');
    }

    function updatePurposeUI() {
        if (!state.consultationPurpose) return;
        const meta = getMeta();

        // Step 2 banner
        setText('#bannerPurposeTitle', meta.title);
        const badge = $('#bannerPurposeBadge');
        if (badge) {
            badge.textContent = meta.badge;
            badge.className = `badge ${meta.color}`;
        }

        setBookingType('group');
        setText('#membersFieldLabel', 'Members');
        setText('#reasonLabelText', meta.reasonLabel);
        setText('#reasonOptionalHint', meta.reasonOptional ? '(optional)' : '');
        const reasonEl = $('#reasonInput');
        if (reasonEl) reasonEl.placeholder = meta.reasonPlaceholder;
    }

    async function ensureConfig() {
        if (state.config) return state.config;
        if (!state.configPromise) {
            state.configPromise = api('/api/config').then((c) => {
                state.config = c;
                setText('#location', c.location);
                if (c.lastBookableDate) {
                    setText('#deadlineMeta', `Tue–Thu · Until ${formatShortDate(c.lastBookableDate)}`);
                }
                const startRef = c.firstBookableDate || c.today;
                const [y, m] = startRef.split('-').map(Number);
                state.viewYear = y;
                state.viewMonth = m - 1;
                return c;
            }).catch((err) => {
                state.configPromise = null;
                throw err;
            });
        }
        return state.configPromise;
    }

    /* ---------------- Beninsig prerequisite modal for Communication Letter ---------------- */
    function openBeninsigModal() {
        $('#beninsigAskView').classList.remove('hidden');
        $('#beninsigNoView').classList.add('hidden');
        $('#beninsigModal').classList.remove('hidden');
        setTimeout(() => $('#beninsigYesBtn')?.focus(), 40);
    }

    function closeBeninsigModal() {
        $('#beninsigModal').classList.add('hidden');
    }

    function onClickConsultationCard(purpose) {
        if (purpose === 'letter') {
            if (state.student?.instructorRole !== 'adviser') {
                toast('Communication Letter Signature is only available when Arnemie Gayyed is your Adviser.', 'error');
                return;
            }
            if (!state.beninsigConfirmed) {
                openBeninsigModal();
                return;
            }
        }
        proceedWithConsultationPurpose(purpose);
    }

    function monthLoadKey(y = state.viewYear, m = state.viewMonth, purpose = state.consultationPurpose) {
        const base = `${monthKey(y, m)}#${purpose}`;
        const level = state.student?.projectLevel || state.defenseLevel || 'capstone1';
        return purpose === 'defense' ? `${base}#${level}` : base;
    }

    async function proceedWithConsultationPurpose(purpose) {
        const nextPurpose = Object.prototype.hasOwnProperty.call(PURPOSE_META, purpose) ? purpose : 'system';
        if (nextPurpose === 'defense') {
            state.defenseLevel = isDefenseLevel(state.student?.projectLevel) ? state.student.projectLevel : 'capstone1';
        }
        const purposeChanged = nextPurpose !== state.consultationPurpose;

        state.consultationPurpose = nextPurpose;
        document.querySelectorAll('.type-choice-card').forEach((card) => {
            card.classList.toggle('selected', card.dataset.purpose === nextPurpose);
        });

        updatePurposeUI();

        if (purposeChanged) {
            state.selectedSlot = null;
            state.loadingSlotsKey = null;
            state.loadedSlotsKey = null;
            state.activeWindowLabel = null;
            state.defenseDay = null;
        }
        updateSelectionBox();

        try {
            await ensureConfig();
        } catch {
            toast('Could not connect to the server. Please refresh the page.', 'error');
            return;
        }

        goToStep(2);

        const targetMonthLoadKey = monthLoadKey(state.viewYear, state.viewMonth, nextPurpose);
        if (!purposeChanged && state.loadedMonthKey === targetMonthLoadKey && state.selectedDate) {
            return;
        }

        const currentSelectedDate = state.selectedDate;
        const ok = await loadMonth();
        if (!ok) return;

        if (currentSelectedDate && state.monthDays[currentSelectedDate]?.bookable && state.monthDays[currentSelectedDate].open > 0) {
            await selectDate(currentSelectedDate, false, true);
        } else {
            let firstOpen = Object.keys(state.monthDays).sort().find((d) => state.monthDays[d].open > 0);
            if (!firstOpen && state.config && monthKey(state.viewYear, state.viewMonth) < state.config.lastBookableDate.slice(0, 7)) {
                const changed = await changeMonth(1);
                if (!changed) return;
                firstOpen = Object.keys(state.monthDays).sort().find((d) => state.monthDays[d].open > 0);
            }
            if (firstOpen) await selectDate(firstOpen, false, true);
            else resetSlotsPanel();
        }
    }

    /* ---------------- group members UI ---------------- */
    function getMemberInputs() {
        return Array.from(document.querySelectorAll('#memberList input'));
    }

    function syncMemberControls() {
        const rows = Array.from(document.querySelectorAll('#memberList .member-row'));
        rows.forEach((row, idx) => {
            const input = row.querySelector('input');
            input.placeholder = idx === 0
                ? 'Member 1 (You)'
                : `Member ${idx + 1} — full name`;
            const removeBtn = row.querySelector('.remove-member');
            const isSelf = idx === 0 && Boolean(state.student);
            input.readOnly = isSelf;
            if (isSelf) input.value = state.student.name;
            removeBtn.disabled = isSelf || rows.length <= MIN_MEMBERS;
            removeBtn.title = isSelf
                ? 'You are always Member 1 on your booking'
                : 'Remove member';
        });
        setText('#memberCount', `(${rows.length}/${MAX_MEMBERS})`);
        $('#addMemberBtn')?.classList.toggle('hidden', rows.length >= MAX_MEMBERS);
    }

    function addMemberRow(initialValue = '', shouldFocus = false) {
        const list = $('#memberList');
        if (!list || list.children.length >= MAX_MEMBERS) return;

        const row = document.createElement('div');
        row.className = 'member-row';

        const input = document.createElement('input');
        input.type = 'text';
        input.maxLength = 100;
        input.value = initialValue;
        input.addEventListener('input', () => clearFieldError('#bookingMembersField'));

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'remove-member';
        removeBtn.setAttribute('aria-label', 'Remove member');
        removeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
        removeBtn.addEventListener('click', () => {
            if (list.children.length <= MIN_MEMBERS) return;
            row.remove();
            clearFieldError('#bookingMembersField');
            syncMemberControls();
        });

        row.append(input, removeBtn);
        list.appendChild(row);
        syncMemberControls();
        if (shouldFocus) input.focus();
    }

    function resetMembers() {
        const list = $('#memberList');
        if (!list) return;
        list.innerHTML = '';
        const savedMembers = state.student?.members;
        if (Array.isArray(savedMembers) && savedMembers.length >= MIN_MEMBERS) {
            savedMembers.slice(0, MAX_MEMBERS).forEach((m) => addMemberRow(m));
        } else {
            addMemberRow(state.student?.name || '');
        }
        if (state.student?.capstoneTitle && $('#teamInput') && !$('#teamInput').value.trim()) {
            $('#teamInput').value = state.student.capstoneTitle;
        }
    }

    function setBookingType(type) {
        const registeredCount = Array.isArray(state.student?.members) ? state.student.members.length : 1;
        const forcedGroup = (state.consultationPurpose && getMeta().requiresAllMembers) || registeredCount <= 1;
        state.bookingType = (forcedGroup || type === 'group') ? 'group' : 'individual';
        const isGroup = state.bookingType === 'group';
        const radio = document.querySelector(`input[name="bookingType"][value="${state.bookingType}"]`);
        if (radio) radio.checked = true;
        $('#individualFields')?.classList.toggle('hidden', isGroup);
        $('#groupFields')?.classList.toggle('hidden', !isGroup);
        syncMemberControls();
        clearFormFieldErrors('#bookingForm');
        setFormError('');
    }

    /* ---------------- calendar ---------------- */
    async function loadMonth() {
        const reqId = ++state.monthRequest;
        const purpose = state.consultationPurpose || 'system';
        const level = purpose === 'defense' ? (state.defenseLevel || state.student?.projectLevel || 'capstone1') : '';
        const key = monthKey(state.viewYear, state.viewMonth);
        const query = purpose === 'defense'
            ? `/api/month?month=${key}&purpose=defense&level=${encodeURIComponent(level)}`
            : `/api/month?month=${key}&purpose=${purpose}`;
        renderCalendar(true);
        try {
            const data = await api(query);
            if (reqId !== state.monthRequest) return false;
            state.monthDays = data.days;
            state.loadedMonthKey = monthLoadKey(state.viewYear, state.viewMonth, purpose);
        } catch (err) {
            if (reqId !== state.monthRequest) return false;
            state.monthDays = {};
            state.loadedMonthKey = null;
            toast(err.message, 'error');
        }
        renderCalendar(false);
        return true;
    }

    function renderCalendar(loading) {
        const { viewYear: y, viewMonth: m, config } = state;
        $('#monthLabel').textContent = new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-US', {
            month: 'long', year: 'numeric', timeZone: 'UTC',
        });

        const minMonthKey = (config.firstBookableDate || config.today).slice(0, 7);
        const lastKey = config.lastBookableDate.slice(0, 7);
        const current = monthKey(y, m);
        $('#prevMonth').disabled = loading || current <= minMonthKey;
        $('#nextMonth').disabled = loading || current >= lastKey;

        const container = $('#days');
        container.classList.toggle('loading', loading);
        container.innerHTML = '';

        const firstDow = new Date(Date.UTC(y, m, 1)).getUTCDay();
        const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

        for (let i = 0; i < firstDow; i++) {
            const spacer = document.createElement('span');
            spacer.className = 'day-spacer';
            container.appendChild(spacer);
        }

        for (let d = 1; d <= daysInMonth; d++) {
            const ds = dateStr(y, m, d);
            const info = state.monthDays[ds];
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'day';
            btn.textContent = d;
            btn.dataset.date = ds;

            if (ds === config.today) {
                btn.classList.add('today');
                btn.title = 'Today — bookings must be made at least 1 day before the scheduled day';
            }

            if (loading || !info || !info.bookable) {
                btn.disabled = true;
            } else if (info.open === 0) {
                btn.classList.add('full');
                btn.disabled = true;
                btn.title = 'Fully booked';
            } else {
                btn.classList.add('available');
                btn.title = state.consultationPurpose === 'dropoff'
                    ? 'Open for manuscript drop-off'
                    : state.consultationPurpose === 'defense'
                        ? `${info.open} defense window${info.open === 1 ? '' : 's'} available`
                        : `${info.open} slot${info.open === 1 ? '' : 's'} open`;
                btn.addEventListener('click', () => selectDate(ds, true));
            }

            if (ds === state.selectedDate) btn.classList.add('selected');
            container.appendChild(btn);
        }
    }

    function changeMonth(delta) {
        if (!state.config) return Promise.resolve(false);
        let m = state.viewMonth + delta;
        let y = state.viewYear;
        if (m < 0) { m = 11; y--; }
        if (m > 11) { m = 0; y++; }

        const targetKey = monthKey(y, m);
        const minKey = (state.config.firstBookableDate || state.config.today).slice(0, 7);
        const lastKey = state.config.lastBookableDate.slice(0, 7);
        if (targetKey < minKey || targetKey > lastKey) return Promise.resolve(false);

        state.viewMonth = m;
        state.viewYear = y;
        return loadMonth();
    }

    /* ---------------- slots ---------------- */
    async function selectDate(ds, fromUser = false, force = false) {
        const purpose = state.consultationPurpose || 'system';
        const level = purpose === 'defense' ? (state.defenseLevel || state.student?.projectLevel || 'capstone1') : '';
        const key = purpose === 'defense' ? `${ds}#defense#${level}` : `${ds}#${purpose}`;
        if (!force && ds === state.selectedDate && (state.loadingSlotsKey === key || state.loadedSlotsKey === key)) {
            return;
        }

        state.selectedDate = ds;
        state.selectedSlot = null;
        state.loadingSlotsKey = key;
        state.loadedSlotsKey = null;
        state.activeWindowLabel = null;
        state.defenseDay = null;
        updateSelectionBox();

        document.querySelectorAll('.day.selected').forEach((el) => el.classList.remove('selected'));
        const btn = document.querySelector(`.day[data-date="${ds}"]`);
        if (btn) btn.classList.add('selected');

        $('#slotsTitle').textContent = formatLongDate(ds);
        $('#slotsSubtitle').textContent = 'Loading available times…';
        const tabsEl = $('#windowTabs');
        if (tabsEl) {
            tabsEl.innerHTML = '';
            tabsEl.classList.add('hidden');
        }
        const list = $('#slotList');
        list.innerHTML = '<div class="slot skeleton"></div>'.repeat(purpose === 'dropoff' ? 1 : 4);

        const reqId = ++state.slotsRequest;
        const query = purpose === 'defense'
            ? `/api/slots?date=${ds}&purpose=defense&level=${encodeURIComponent(level)}`
            : `/api/slots?date=${ds}&purpose=${purpose}`;
        try {
            const data = await api(query);
            if (reqId !== state.slotsRequest) return;
            state.loadingSlotsKey = null;
            state.loadedSlotsKey = key;
            if (purpose === 'defense') {
                state.defenseDay = data;
                renderDefenseSlots(data);
            } else {
                renderSlots(data.slots);
            }
            if (fromUser && window.innerWidth <= 680) {
                $('.slots').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        } catch (err) {
            if (reqId !== state.slotsRequest) return;
            state.loadingSlotsKey = null;
            list.innerHTML = '';
            $('#slotsSubtitle').textContent = 'Could not load time slots.';
            toast(err.message, 'error');
        }
    }

    /**
     * Parse a typed start time like "2:30", "2:30 PM", "11:30am", or "14:30".
     * If AM/PM is omitted (e.g. "2:30"), we check which meridiem fits the day's defense windows
     * (and in school hours 7:00–11:59 defaults to AM while 12:00–6:59 defaults to PM).
     */
    function parseTypedDefenseTime(raw, windows = [], durationMinutes = 60) {
        const str = String(raw || '').trim();
        if (!str) return { error: 'Please type your preferred start time (e.g. 2:30 PM).' };

        const match = str.match(/^(\d{1,2})\s*:\s*(\d{2})\s*(am|pm|a\.m\.|p\.m\.|a|p)?$/i);
        if (!match) {
            return { error: 'Use H:MM format, for example 11:30 AM or 2:30 PM.' };
        }
        const hourNum = parseInt(match[1], 10);
        const minNum = parseInt(match[2], 10);
        const merRaw = (match[3] || '').toLowerCase().replace(/\./g, '');

        if (minNum < 0 || minNum > 59) {
            return { error: 'Minutes must be between 00 and 59.' };
        }

        const candidates = [];
        if (merRaw) {
            if (hourNum < 1 || hourNum > 12) {
                return { error: 'Hour must be between 1 and 12 when using AM/PM.' };
            }
            const isPm = merRaw.startsWith('p');
            const h24 = (hourNum % 12) + (isPm ? 12 : 0);
            candidates.push(h24 * 60 + minNum);
        } else if (hourNum >= 13 && hourNum <= 23) {
            candidates.push(hourNum * 60 + minNum);
        } else if (hourNum >= 1 && hourNum <= 12) {
            const amMin = (hourNum % 12) * 60 + minNum;
            const pmMin = ((hourNum % 12) + 12) * 60 + minNum;
            // School schedule heuristic: 7:00–11:55 is morning first, 12:00 and 1:00–6:55 is afternoon first
            if (hourNum >= 7 && hourNum <= 11) {
                candidates.push(amMin, pmMin);
            } else {
                candidates.push(pmMin, amMin);
            }
        } else {
            return { error: 'Please enter a valid hour (e.g. 11:30 AM or 2:30 PM).' };
        }

        // Prefer a candidate that falls inside one of today's defense windows
        const inWindow = candidates.find((m) =>
            windows.some((w) => m >= w.startMinute && m + durationMinutes <= w.endMinute)
        );
        const TouchWindow = candidates.find((m) =>
            windows.some((w) => m >= w.startMinute && m < w.endMinute)
        );
        const chosen = inWindow ?? TouchWindow ?? candidates[0];
        return { startMinute: chosen };
    }

    function validateDefenseStartMinute(startMinute, data) {
        const duration = data.durationMinutes || 60;
        const step = data.startStep || 5;
        const endMinute = startMinute + duration;
        const windows = data.windows || [];

        if (startMinute % step !== 0) {
            return {
                ok: false,
                startMinute,
                endMinute,
                error: `Start times must be in ${step}-minute increments (for example ${formatMinute(Math.floor(startMinute / step) * step)}).`,
            };
        }

        const matchingWin = windows.find((w) => startMinute >= w.startMinute && startMinute < w.endMinute);
        if (!matchingWin) {
            const winLabels = windows.map((w) => w.label).join(', ');
            return {
                ok: false,
                startMinute,
                endMinute,
                error: `${formatMinute(startMinute)} is outside the defense schedule on this day (${winLabels}).`,
            };
        }

        if (endMinute > matchingWin.endMinute) {
            const latestStart = matchingWin.endMinute - duration;
            return {
                ok: false,
                startMinute,
                endMinute,
                error: `${formatMinute(startMinute)} – ${formatMinute(endMinute)} goes past the end of the ${matchingWin.label} window.${latestStart >= matchingWin.startMinute ? ` Latest start in this window is ${formatMinute(latestStart)}.` : ' This window is shorter than your defense duration.'}`,
            };
        }

        const conflict = (matchingWin.busy || []).find((b) => startMinute < b.endMinute && endMinute > b.startMinute);
        if (conflict) {
            return {
                ok: false,
                startMinute,
                endMinute,
                error: `${formatMinute(startMinute)} – ${formatMinute(endMinute)} overlaps with an existing booking (${conflict.label}). Please choose another time.`,
            };
        }

        return {
            ok: true,
            startMinute,
            endMinute,
            windowLabel: matchingWin.label,
        };
    }

    function renderDefenseSlots(data) {
        const list = $('#slotList');
        const tabsEl = $('#windowTabs');
        list.innerHTML = '';
        if (tabsEl) {
            tabsEl.innerHTML = '';
            tabsEl.classList.add('hidden');
        }

        const levelInfo = getDefenseLevelInfo(data.level) || DEFENSE_LEVELS.capstone1;
        const duration = data.durationMinutes || levelInfo.durationMinutes;
        const windows = data.windows || [];
        const fittingGaps = [];
        windows.forEach((w) => {
            (w.free || []).forEach((f) => {
                if (f.fits) fittingGaps.push({ ...f, windowLabel: w.label });
            });
        });

        $('#slotsSubtitle').textContent = fittingGaps.length
            ? `${levelInfo.label} (${levelInfo.durationLabel}) · Type a start time or pick a suggestion below`
            : `No open ${levelInfo.durationLabel} gap left on this day for ${levelInfo.label}.`;

        const wrap = document.createElement('div');
        wrap.className = 'defense-picker';

        // 1. Level bar (shows the student's registered course and defense duration)
        const levelBar = document.createElement('div');
        levelBar.className = 'defense-level-bar';
        const levelText = document.createElement('span');
        levelText.innerHTML = `Course: <strong>${levelInfo.label}</strong> (${levelInfo.durationLabel} defense)`;
        levelBar.appendChild(levelText);
        wrap.appendChild(levelBar);

        // 2. Windows & free/booked breakdown for this date
        const winBox = document.createElement('div');
        winBox.className = 'defense-windows-box';
        const winHeading = document.createElement('div');
        winHeading.className = 'defense-windows-heading';
        winHeading.textContent = 'Available defense windows on this day';
        winBox.appendChild(winHeading);

        windows.forEach((w) => {
            const row = document.createElement('div');
            row.className = 'defense-window-item';

            const top = document.createElement('div');
            top.className = 'defense-window-top';
            const title = document.createElement('strong');
            title.textContent = w.label;
            top.appendChild(title);

            const fitsAny = (w.free || []).some((f) => f.fits);
            const pill = document.createElement('span');
            pill.className = `badge ${fitsAny ? 'teal' : 'muted-badge'}`;
            if (fitsAny) {
                pill.textContent = 'Available';
            } else if (w.endMinute - w.startMinute < duration) {
                pill.textContent = `Window shorter than ${levelInfo.durationLabel}`;
            } else {
                pill.textContent = 'No room left';
            }
            top.appendChild(pill);
            row.appendChild(top);

            if (w.busy && w.busy.length) {
                const busyEl = document.createElement('div');
                busyEl.className = 'defense-window-busy';
                busyEl.textContent = `Already booked: ${w.busy.map((b) => b.label).join(', ')}`;
                row.appendChild(busyEl);
            }

            (w.free || []).filter((f) => f.fits).forEach((f) => {
                const hint = document.createElement('div');
                hint.className = 'defense-window-valid';
                if (f.earliestStartMinute === f.latestStartMinute) {
                    hint.textContent = `Open: ${f.label} — start at ${formatMinute(f.earliestStartMinute)}`;
                } else {
                    hint.textContent = `Open: ${f.label} — start any time from ${formatMinute(f.earliestStartMinute)} to ${formatMinute(f.latestStartMinute)}`;
                }
                row.appendChild(hint);
            });

            winBox.appendChild(row);
        });
        wrap.appendChild(winBox);

        if (!fittingGaps.length) {
            list.appendChild(wrap);
            return;
        }

        // 3. Quick-pick suggested start times + custom typed start time
        const suggestions = [];
        const seenStarts = new Set();
        fittingGaps.forEach((f) => {
            for (let m = f.earliestStartMinute; m <= f.latestStartMinute; m += 30) {
                if (!seenStarts.has(m)) {
                    seenStarts.add(m);
                    suggestions.push(m);
                }
            }
            if (!seenStarts.has(f.latestStartMinute)) {
                seenStarts.add(f.latestStartMinute);
                suggestions.push(f.latestStartMinute);
            }
        });

        const inputCard = document.createElement('div');
        inputCard.className = 'defense-input-card';

        const label = document.createElement('label');
        label.className = 'field';
        const labelSpan = document.createElement('span');
        labelSpan.textContent = `Type your start time (${levelInfo.durationLabel} will be reserved automatically)`;

        const inputRow = document.createElement('div');
        inputRow.className = 'defense-time-input-row';

        const timeInput = document.createElement('input');
        timeInput.type = 'text';
        timeInput.id = 'defenseStartInput';
        timeInput.placeholder = `e.g. ${formatMinute(fittingGaps[0].earliestStartMinute)} or 2:30`;
        timeInput.autocomplete = 'off';

        inputRow.appendChild(timeInput);
        label.append(labelSpan, inputRow);
        inputCard.appendChild(label);

        if (suggestions.length) {
            const quickWrap = document.createElement('div');
            quickWrap.className = 'defense-quick-picks';
            const quickLabel = document.createElement('small');
            quickLabel.className = 'muted';
            quickLabel.textContent = 'Or tap a start time:';
            quickWrap.appendChild(quickLabel);

            const chipsRow = document.createElement('div');
            chipsRow.className = 'defense-chip-list';
            suggestions.forEach((m) => {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'defense-time-chip';
                chip.dataset.minute = String(m);
                chip.textContent = formatMinute(m);
                chip.addEventListener('click', () => {
                    timeInput.value = formatMinute(m);
                    applyTypedTime(timeInput.value, true);
                });
                chipsRow.appendChild(chip);
            });
            quickWrap.appendChild(chipsRow);
            inputCard.appendChild(quickWrap);
        }

        const feedback = document.createElement('div');
        feedback.className = 'defense-time-feedback hidden';
        feedback.id = 'defenseTimeFeedback';
        inputCard.appendChild(feedback);

        const continueBtn = document.createElement('button');
        continueBtn.type = 'button';
        continueBtn.className = 'btn btn-primary btn-block hidden';
        continueBtn.id = 'defenseContinueBtn';
        continueBtn.textContent = 'Continue →';
        continueBtn.addEventListener('click', () => {
            if (state.selectedSlot) goToStep(3);
        });
        inputCard.appendChild(continueBtn);

        function applyTypedTime(rawValue, fromChip = false) {
            const raw = String(rawValue || '').trim();
            document.querySelectorAll('.defense-time-chip').forEach((c) => c.classList.remove('active'));
            if (!raw) {
                state.selectedSlot = null;
                updateSelectionBox();
                feedback.className = 'defense-time-feedback hidden';
                feedback.textContent = '';
                continueBtn.classList.add('hidden');
                timeInput.classList.remove('input-invalid');
                return;
            }

            const parsed = parseTypedDefenseTime(raw, windows, duration);
            if (parsed.error) {
                state.selectedSlot = null;
                updateSelectionBox();
                feedback.className = 'defense-time-feedback is-error';
                feedback.textContent = parsed.error;
                continueBtn.classList.add('hidden');
                timeInput.classList.add('input-invalid');
                return;
            }

            const check = validateDefenseStartMinute(parsed.startMinute, data);
            if (!check.ok) {
                state.selectedSlot = null;
                updateSelectionBox();
                feedback.className = 'defense-time-feedback is-error';
                feedback.textContent = check.error;
                continueBtn.classList.add('hidden');
                timeInput.classList.add('input-invalid');
                return;
            }

            timeInput.classList.remove('input-invalid');
            const matchingChip = document.querySelector(`.defense-time-chip[data-minute="${check.startMinute}"]`);
            if (matchingChip) matchingChip.classList.add('active');
            if (fromChip) timeInput.value = formatMinute(check.startMinute);

            state.selectedSlot = {
                startMinute: check.startMinute,
                endMinute: check.endMinute,
                durationMinutes: duration,
                isDropoff: false,
                label: formatMinute(check.startMinute),
                endLabel: formatMinute(check.endMinute),
                windowLabel: check.windowLabel,
            };
            updateSelectionBox();

            feedback.className = 'defense-time-feedback is-valid';
            feedback.innerHTML = `<strong>${formatMinute(check.startMinute)} – ${formatMinute(check.endMinute)}</strong> (${levelInfo.durationLabel} · ${levelInfo.label} Defense) is available.`;
            continueBtn.textContent = `Continue with ${formatMinute(check.startMinute)} – ${formatMinute(check.endMinute)} →`;
            continueBtn.classList.remove('hidden');
        }

        timeInput.addEventListener('input', () => applyTypedTime(timeInput.value, false));
        timeInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                applyTypedTime(timeInput.value, true);
                if (state.selectedSlot) goToStep(3);
            }
        });

        wrap.appendChild(inputCard);
        list.appendChild(wrap);

        if (state.selectedSlot) {
            timeInput.value = state.selectedSlot.label;
            applyTypedTime(timeInput.value, true);
        }
    }

    function createSlotButton(slot, i) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'slot' + (slot.isDropoff ? ' slot-dropoff' : '');
        btn.style.animationDelay = `${Math.min(i, 12) * 18}ms`;

        const time = document.createElement('span');
        time.className = 'slot-time';
        time.textContent = slot.label;

        const range = document.createElement('span');
        range.className = 'slot-range';
        if (!slot.available) {
            range.textContent = 'Unavailable';
        } else if (slot.isDropoff) {
            range.textContent = 'Drop-off window';
        } else {
            range.textContent = `until ${slot.endLabel}`;
        }
        btn.append(time, range);

        if (!slot.available) {
            btn.disabled = true;
            btn.classList.add('taken');
        } else {
            if (state.selectedSlot && state.selectedSlot.startMinute === slot.startMinute) {
                btn.classList.add('selected');
                btn.appendChild(createNextBadge());
            }
            btn.addEventListener('click', () => selectSlot(slot, btn));
        }
        return btn;
    }

    function createNextBadge() {
        const next = document.createElement('span');
        next.className = 'slot-next';
        next.textContent = 'Continue →';
        next.addEventListener('click', (e) => {
            e.stopPropagation();
            goToStep(3);
        });
        return next;
    }

    function renderSlots(slots) {
        const list = $('#slotList');
        const tabsEl = $('#windowTabs');
        list.innerHTML = '';
        if (tabsEl) {
            tabsEl.innerHTML = '';
            tabsEl.classList.add('hidden');
        }

        const openCount = slots.filter((s) => s.available).length;
        const meta = getMeta();

        if (state.consultationPurpose === 'dropoff') {
            $('#slotsSubtitle').textContent = openCount
                ? 'Select the drop-off window below'
                : 'Drop-off is not available on this day.';
        } else {
            $('#slotsSubtitle').textContent = openCount
                ? `${openCount} of ${slots.length} ${slots.length === 1 ? 'slot' : 'slots'} available · ${meta.badge} each`
                : 'No more open slots on this day.';
        }

        if (!slots.length) {
            list.innerHTML = '<div class="empty-state"><p>No time slots on this day.</p></div>';
            return;
        }

        const windows = [];
        const byWindow = new Map();
        slots.forEach((s) => {
            const w = s.windowLabel || 'All times';
            if (!byWindow.has(w)) {
                byWindow.set(w, []);
                windows.push(w);
            }
            byWindow.get(w).push(s);
        });

        if (windows.length > 1 && tabsEl && state.consultationPurpose !== 'dropoff') {
            if (!state.activeWindowLabel || !byWindow.has(state.activeWindowLabel)) {
                state.activeWindowLabel =
                    windows.find((w) => byWindow.get(w).some((s) => s.available)) || windows[0];
            }

            tabsEl.classList.remove('hidden');
            windows.forEach((w) => {
                const winSlots = byWindow.get(w);
                const winOpen = winSlots.filter((s) => s.available).length;
                const tab = document.createElement('button');
                tab.type = 'button';
                tab.className = 'window-tab' + (w === state.activeWindowLabel ? ' active' : '');
                tab.textContent = `${w} (${winOpen})`;
                tab.disabled = winOpen === 0;
                tab.addEventListener('click', () => {
                    if (state.activeWindowLabel === w) return;
                    state.activeWindowLabel = w;
                    renderSlots(slots);
                    list.scrollTop = 0;
                });
                tabsEl.appendChild(tab);
            });

            const activeSlots = byWindow.get(state.activeWindowLabel) || [];
            activeSlots.forEach((slot, i) => list.appendChild(createSlotButton(slot, i)));
            return;
        }

        slots.forEach((slot, i) => {
            list.appendChild(createSlotButton(slot, i));
        });
    }

    function selectSlot(slot, btn) {
        if (btn.classList.contains('selected')) {
            goToStep(3);
            return;
        }

        document.querySelectorAll('.slot.selected').forEach((el) => {
            el.classList.remove('selected');
            const next = el.querySelector('.slot-next');
            if (next) next.remove();
        });

        state.selectedSlot = slot;
        btn.classList.add('selected');
        updateSelectionBox();
        btn.appendChild(createNextBadge());
    }

    /* ---------------- booking form ---------------- */
    function setSubmitting(on) {
        state.submitting = on;
        const btn = $('#submitBtn');
        btn.disabled = on;
        btn.querySelector('.spinner').classList.toggle('hidden', !on);
        btn.querySelector('.btn-label').textContent = on ? 'Scheduling…' : 'Confirm booking';
    }

    async function submitBooking(e) {
        e.preventDefault();
        if (state.submitting) return;
        clearFormFieldErrors('#bookingForm');
        setFormError('');

        if (!state.student) {
            showAuthGate();
            return;
        }
        if (!state.consultationPurpose) {
            goToStep(1);
            return;
        }
        if (state.consultationPurpose === 'letter') {
            if (state.student.instructorRole !== 'adviser') {
                toast('Communication Letter Signature is only available when Arnemie Gayyed is your Adviser.', 'error');
                resetBooking();
                return;
            }
            if (!state.beninsigConfirmed) {
                openBeninsigModal();
                return;
            }
        }
        if (!state.selectedDate || !state.selectedSlot) {
            goToStep(2);
            return;
        }

        const meta = getMeta();
        const teamName = $('#teamInput').value.trim();
        if (teamName.length < 2) {
            setFieldError('#teamInput', 'Please enter your Capstone / Thesis title (at least 2 characters).');
            return;
        }

        const reason = $('#reasonInput').value.trim();
        let payload;

        if (state.bookingType === 'group' || meta.requiresAllMembers) {
            const inputs = getMemberInputs();
            const emptyInput = inputs.find((el) => el.value.trim().length === 0);
            if (emptyInput) {
                setFieldError(
                    '#bookingMembersField',
                    'Please enter this member’s full name, or click × to remove the empty row.',
                    emptyInput
                );
                return;
            }
            const shortInput = inputs.find((el) => el.value.trim().length < 2);
            if (shortInput) {
                setFieldError('#bookingMembersField', 'Each member needs a full name (at least 2 characters).', shortInput);
                return;
            }
            const members = inputs.map((el) => el.value.trim()).filter(Boolean).slice(0, MAX_MEMBERS);
            payload = {
                type: 'group',
                consultationType: state.consultationPurpose,
                defenseLevel: state.consultationPurpose === 'defense' ? state.defenseLevel : undefined,
                beninsigInitialConfirmed: state.beninsigConfirmed,
                teamName,
                members,
                reason,
                date: state.selectedDate,
                startMinute: state.selectedSlot.startMinute,
            };
        } else {
            payload = {
                type: 'individual',
                consultationType: state.consultationPurpose,
                defenseLevel: state.consultationPurpose === 'defense' ? state.defenseLevel : undefined,
                beninsigInitialConfirmed: state.beninsigConfirmed,
                teamName,
                reason,
                date: state.selectedDate,
                startMinute: state.selectedSlot.startMinute,
            };
        }

        if (!meta.reasonOptional && reason.length < 5) {
            setFieldError('#reasonInput', 'Please provide brief details (at least 5 characters).');
            return;
        }
        if (meta.reasonOptional && reason.length > 0 && reason.length < 5) {
            setFieldError('#reasonInput', 'Please enter at least 5 characters, or leave this field blank.');
            return;
        }

        setSubmitting(true);
        try {
            const { booking, student: updatedStudent } = await api('/api/bookings', {
                method: 'POST',
                body: JSON.stringify(payload),
            });
            if (updatedStudent) {
                state.student = updatedStudent;
                updateRoleVisibility();
            }
            loadMyBookings();
            showConfirmation(booking);
        } catch (err) {
            if (err.status === 401) {
                setStudent(null);
                setAuthMode('login');
                setAuthError('Your session has expired. Please log in again to continue.');
            } else if (err.code === 'ADVISER_ONLY') {
                toast(err.message, 'error');
                resetBooking();
            } else if (err.code === 'BENINSIG_REQUIRED') {
                state.beninsigConfirmed = false;
                openBeninsigModal();
            } else if (err.field === 'teamName') {
                setFieldError('#teamInput', err.message);
            } else if (err.field === 'members') {
                setFieldError('#bookingMembersField', err.message);
            } else if (err.field === 'reason') {
                setFieldError('#reasonInput', err.message);
            } else if (err.code === 'BOOKING_LIMIT') {
                setFormError(err.message);
            } else if (err.status === 409 || err.status === 400) {
                toast(err.message, 'error');
                const date = state.selectedDate;
                state.selectedSlot = null;
                updateSelectionBox();
                goToStep(2);
                loadMonth().then((ok) => {
                    if (ok && date) selectDate(date, false, true);
                });
            } else {
                setFormError(err.message);
            }
        } finally {
            setSubmitting(false);
        }
    }

    function showConfirmation(b) {
        const meta = getMeta(b.consultationType, b.defenseLevel);
        const hasMultipleMembers = Array.isArray(b.members) && b.members.length >= 2;
        const capstone = b.capstoneTitle || b.teamName || state.student?.capstoneTitle || null;
        const isDefense = b.consultationType === 'defense';

        setText('#confirmHeading', b.isDropoff ? 'Drop-off scheduled!' : isDefense ? 'Defense scheduled!' : 'Scheduled!');
        setText('#cPurposeLabel', isDefense ? 'Defense' : 'Consultation');
        setText('#cPurpose', `${b.consultationTitle || meta.title} (${b.durationLabel || meta.badge})`);

        $('#cTeamRow')?.classList.toggle('hidden', !capstone);
        if (capstone) {
            setText('#cTeam', capstone);
        }
        if (hasMultipleMembers) {
            setText('#cNameLabel', `Members (${b.members.length})`);
            setText('#cName', b.members.join(', '));
        } else {
            setText('#cNameLabel', 'Member');
            setText('#cName', b.members?.[0] || b.name);
        }
        setText('#cDate', formatLongDate(b.date));
        setText('#cTime', b.label);
        setText('#cLocation', state.config?.location || 'Faculty Office');
        setText('#cReason', b.reason);
        setText('#cRef', b.reference);
        goToStep(4);
    }

    function resetBooking() {
        $('#bookingForm').reset();
        $('#reasonCount').textContent = '0';
        clearFormFieldErrors('#bookingForm');
        setFormError('');
        if (state.student?.capstoneTitle && $('#teamInput')) {
            $('#teamInput').value = state.student.capstoneTitle;
        }
        resetMembers();
        state.consultationPurpose = null;
        state.defenseLevel = isDefenseLevel(state.student?.projectLevel) ? state.student.projectLevel : null;
        state.defenseDay = null;
        state.beninsigConfirmed = false;
        state.selectedSlot = null;
        state.loadedMonthKey = null;
        state.loadedSlotsKey = null;
        setBookingType('group');
        document.querySelectorAll('.type-choice-card').forEach((card) => card.classList.remove('selected'));
        updateSelectionBox();
        goToStep(1);
    }

    function resetSlotsPanel() {
        state.selectedDate = null;
        state.loadingSlotsKey = null;
        state.loadedSlotsKey = null;
        const tabsEl = $('#windowTabs');
        if (tabsEl) {
            tabsEl.innerHTML = '';
            tabsEl.classList.add('hidden');
        }
        $('#slotsTitle').textContent = 'Select a date';
        $('#slotsSubtitle').textContent = 'Pick an available day on the calendar.';
        $('#slotList').innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
                <p>Pick a highlighted day on the calendar.</p>
            </div>`;
    }

    /* ---------------- student profile & bookings modal ---------------- */
    const DISMISSED_CANCEL_KEY = 'ag_dismissed_cancelled_v1';

    function getDismissedCancelled() {
        try {
            const parsed = JSON.parse(localStorage.getItem(DISMISSED_CANCEL_KEY) || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    function dismissCancelledNotice(id) {
        const current = new Set(getDismissedCancelled());
        current.add(id);
        try {
            localStorage.setItem(DISMISSED_CANCEL_KEY, JSON.stringify([...current].slice(-30)));
        } catch { /* ignore storage quota */ }
        renderCancelledAlertBanner();
    }

    function bookingCategory(b) {
        if (b.status === 'cancelled') return 'cancelled';
        const today = state.serverToday || state.config?.today || '';
        const curMin = state.serverCurrentMinute || 0;
        const endMin = b.endMinute ?? 1440;
        if (!today || b.date > today || (b.date === today && endMin > curMin)) {
            return 'upcoming';
        }
        return 'past';
    }

    function minutesUntilBooking(b) {
        const today = state.serverToday || state.config?.today || '';
        const curMin = state.serverCurrentMinute || 0;
        if (!today || !b.date) return Infinity;
        const targetDt = utcDate(b.date);
        const todayDt = utcDate(today);
        const diffDays = Math.round((targetDt.getTime() - todayDt.getTime()) / 86400000);
        const startMin = typeof b.startMinute === 'number' ? b.startMinute : (b.hour || 0) * 60;
        return diffDays * 1440 + (startMin - curMin);
    }

    function canStudentCancelBooking(b) {
        if (b.status === 'cancelled') return false;
        const cutoff = state.config?.cancelCutoffMinutes || CANCEL_CUTOFF_MINUTES;
        if (minutesUntilBooking(b) < cutoff) return false;
        if (typeof b.canCancel === 'boolean') return b.canCancel;
        return true;
    }

    async function cancelMyBooking(b, btn) {
        if (!canStudentCancelBooking(b)) {
            toast('Appointments can only be cancelled at least 2 hours before the scheduled time.', 'error');
            return;
        }
        if (!confirm(`Cancel your ${b.consultationTitle} appointment on ${formatLongDate(b.date)} (${b.label})?`)) {
            return;
        }
        btn.disabled = true;
        const prevText = btn.textContent;
        btn.textContent = 'Cancelling…';
        try {
            await api(`/api/bookings/${b.id}/cancel`, { method: 'POST' });
            dismissCancelledNotice(b.id);
            toast('Appointment cancelled.', 'success');
            await loadMyBookings();
            renderMyBookingsModal();
            if (state.currentStep === 2 && state.consultationPurpose) {
                const date = state.selectedDate;
                state.loadedMonthKey = null;
                state.loadedSlotsKey = null;
                loadMonth().then((ok) => {
                    if (ok && date) selectDate(date, false, true);
                });
            }
        } catch (err) {
            btn.disabled = false;
            btn.textContent = prevText;
            toast(err.message, 'error');
            await loadMyBookings();
            renderMyBookingsModal();
        }
    }

    function renderCancelledAlertBanner() {
        const banner = $('#cancelledAlertBanner');
        const dot = $('#profileCancelDot');
        if (!state.student) {
            banner?.classList.add('hidden');
            dot?.classList.add('hidden');
            return;
        }

        const today = state.serverToday || state.config?.today || '';
        const dismissed = new Set(getDismissedCancelled());
        const recentCancelled = state.myBookings
            .filter(
                (b) => b.status === 'cancelled'
                    && b.cancellationReason !== 'Cancelled by student.'
                    && (!today || b.date >= today)
                    && !dismissed.has(b.id)
            )
            .sort((a, b) => (b.cancelledAt || b.date).localeCompare(a.cancelledAt || a.date));

        dot?.classList.toggle('hidden', recentCancelled.length === 0);

        if (!banner) return;
        if (!recentCancelled.length) {
            banner.classList.add('hidden');
            banner.innerHTML = '';
            return;
        }

        const latest = recentCancelled[0];
        banner.innerHTML = '';

        const body = document.createElement('div');
        body.className = 'cancelled-alert-body';

        const title = document.createElement('strong');
        title.textContent = `Cancelled: ${latest.consultationTitle} on ${formatLongDate(latest.date)} (${latest.label})`;

        const reasonLine = document.createElement('p');
        reasonLine.textContent = `Reason: ${latest.cancellationReason || 'Please reschedule for another available slot.'}`;

        body.append(title, reasonLine);

        const actions = document.createElement('div');
        actions.className = 'cancelled-alert-actions';

        const viewBtn = document.createElement('button');
        viewBtn.type = 'button';
        viewBtn.className = 'btn btn-ghost btn-sm';
        viewBtn.textContent = 'View Profile';
        viewBtn.addEventListener('click', () => openMyBookingsModal());

        const dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.className = 'link-btn';
        dismissBtn.textContent = 'Dismiss';
        dismissBtn.addEventListener('click', () => dismissCancelledNotice(latest.id));

        actions.append(viewBtn, dismissBtn);
        banner.append(body, actions);
        banner.classList.remove('hidden');
    }

    function renderProfileSummary() {
        if (!state.student) return;
        const s = state.student;
        setText('#profileCapstoneTitle', s.capstoneTitle || s.name);
        setText('#profileRepName', s.name);
        setText('#profileRepEmail', s.email);

        const levelBadge = $('#profileLevelBadge');
        if (levelBadge) {
            const levelInfo = getDefenseLevelInfo(s.projectLevel);
            levelBadge.textContent = levelInfo ? levelInfo.label : '';
            levelBadge.classList.toggle('hidden', !levelInfo);
        }

        const roleBadge = $('#profileRoleBadge');
        if (roleBadge) {
            const isPanel = s.instructorRole === 'panel';
            roleBadge.textContent = isPanel ? 'Panel Member' : 'Adviser';
            roleBadge.className = `badge ${isPanel ? 'sky' : 'teal'}`;
            roleBadge.classList.toggle('hidden', !s.instructorRole);
        }

        const chipsWrap = $('#profileMemberChips');
        if (chipsWrap) {
            chipsWrap.innerHTML = '';
            const members = Array.isArray(s.members) && s.members.length ? s.members : [s.name];
            members.forEach((m, idx) => {
                const chip = document.createElement('span');
                chip.className = 'member-chip';
                chip.textContent = idx === 0 ? `${m} (Rep)` : m;
                chipsWrap.appendChild(chip);
            });
        }
    }

    async function loadMyBookings() {
        if (!state.student) {
            state.myBookings = [];
            $('#myBookingsBtn')?.classList.add('hidden');
            $('#profileCancelDot')?.classList.add('hidden');
            $('#cancelledAlertBanner')?.classList.add('hidden');
            return;
        }
        $('#myBookingsBtn')?.classList.remove('hidden');
        try {
            const data = await api('/api/my-bookings');
            state.myBookings = data.bookings || [];
            if (data.today) state.serverToday = data.today;
            if (typeof data.currentMinute === 'number') state.serverCurrentMinute = data.currentMinute;

            const upcomingCount = state.myBookings.filter((b) => bookingCategory(b) === 'upcoming').length;
            const countEl = $('#myBookingsCount');
            if (countEl) {
                countEl.textContent = upcomingCount;
                countEl.classList.toggle('hidden', upcomingCount === 0);
            }
            renderCancelledAlertBanner();
        } catch {
            /* ignore background fetch error */
        }
    }

    function renderMyBookingsModal() {
        renderProfileSummary();
        const list = $('#myBookingsList');
        if (!list) return;
        list.innerHTML = '';

        const upcoming = state.myBookings
            .filter((b) => bookingCategory(b) === 'upcoming')
            .sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute);
        const cancelled = state.myBookings
            .filter((b) => bookingCategory(b) === 'cancelled')
            .sort((a, b) => (b.cancelledAt || b.date).localeCompare(a.cancelledAt || a.date));
        const past = state.myBookings
            .filter((b) => bookingCategory(b) === 'past')
            .sort((a, b) => b.date.localeCompare(a.date) || b.startMinute - a.startMinute);

        const items = [...upcoming, ...cancelled, ...past];

        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            const p = document.createElement('p');
            p.textContent = 'No consultations scheduled yet.';
            empty.appendChild(p);
            list.appendChild(empty);
            return;
        }

        items.forEach((b) => {
            const cat = bookingCategory(b);
            const meta = getMeta(b.consultationType, b.defenseLevel);
            const item = document.createElement('div');
            item.className = 'my-booking-item' + (cat === 'cancelled' ? ' is-cancelled' : '');

            const top = document.createElement('div');
            top.className = 'my-booking-top';

            const badges = document.createElement('div');
            badges.className = 'my-booking-badges';

            const typeBadge = document.createElement('span');
            typeBadge.className = `badge ${meta.color}`;
            typeBadge.textContent = `${b.consultationTitle} · ${b.durationLabel}`;
            badges.appendChild(typeBadge);

            const statusBadge = document.createElement('span');
            if (cat === 'cancelled') {
                statusBadge.className = 'badge danger';
                statusBadge.textContent = 'Cancelled';
            } else if (cat === 'upcoming') {
                statusBadge.className = 'badge teal';
                statusBadge.textContent = 'Scheduled';
            } else {
                statusBadge.className = 'badge muted-badge';
                statusBadge.textContent = 'Completed';
            }
            badges.appendChild(statusBadge);

            top.appendChild(badges);

            const dateStrong = document.createElement('strong');
            dateStrong.textContent = `${formatLongDate(b.date)} · ${b.label}`;

            item.append(top, dateStrong);

            if (Array.isArray(b.members) && b.members.length) {
                const membersWrap = document.createElement('div');
                membersWrap.className = 'booking-members';
                b.members.forEach((m) => {
                    const chip = document.createElement('span');
                    chip.className = 'member-chip';
                    chip.textContent = m;
                    membersWrap.appendChild(chip);
                });
                item.appendChild(membersWrap);
            }

            if (cat === 'upcoming') {
                const actionRow = document.createElement('div');
                actionRow.className = 'my-booking-actions';

                const cancelBtn = document.createElement('button');
                cancelBtn.type = 'button';
                cancelBtn.className = 'btn btn-danger-soft btn-sm';
                cancelBtn.textContent = 'Cancel appointment';

                if (canStudentCancelBooking(b)) {
                    cancelBtn.addEventListener('click', () => cancelMyBooking(b, cancelBtn));
                    actionRow.appendChild(cancelBtn);
                } else {
                    cancelBtn.disabled = true;
                    cancelBtn.title = 'Appointments can only be cancelled at least 2 hours before the scheduled time.';
                    const cutoffNote = document.createElement('small');
                    cutoffNote.className = 'muted cancel-cutoff-note';
                    cutoffNote.textContent = 'Can no longer cancel (less than 2 hours before schedule)';
                    actionRow.append(cutoffNote, cancelBtn);
                }

                item.appendChild(actionRow);
            }

            if (cat === 'cancelled') {
                const reasonBox = document.createElement('div');
                reasonBox.className = 'cancel-reason-box';

                const reasonHeading = document.createElement('strong');
                reasonHeading.textContent = 'Reason for cancellation:';

                const reasonText = document.createElement('p');
                reasonText.textContent = b.cancellationReason || 'No reason provided.';

                reasonBox.append(reasonHeading, reasonText);
                item.appendChild(reasonBox);
            }

            list.appendChild(item);
        });
    }

    async function openMyBookingsModal() {
        renderProfileSummary();
        $('#myBookingsModal').classList.remove('hidden');
        $('#myBookingsList').innerHTML = '<div class="slot skeleton"></div>';
        await loadMyBookings();
        renderMyBookingsModal();
    }

    function closeMyBookingsModal() {
        $('#myBookingsModal').classList.add('hidden');
    }

    /* ---------------- student account ---------------- */
    function updateRoleVisibility() {
        const isAdviser = state.student?.instructorRole === 'adviser';
        const letterCard = $('#letterChoiceCard');
        if (letterCard) {
            letterCard.classList.toggle('hidden', !isAdviser);
        }
        if (!isAdviser && state.consultationPurpose === 'letter') {
            state.consultationPurpose = null;
            state.beninsigConfirmed = false;
            updateSelectionBox();
        }

        const projBox = $('#studentProjectBox');
        if (projBox) {
            if (state.student) {
                const count = Array.isArray(state.student.members) && state.student.members.length
                    ? state.student.members.length
                    : 1;
                const levelInfo = getDefenseLevelInfo(state.student.projectLevel);
                const levelBadge = $('#projectLevelBadge');
                if (levelBadge) {
                    levelBadge.textContent = levelInfo ? levelInfo.label : '';
                    levelBadge.classList.toggle('hidden', !levelInfo);
                }
                const defensePill = $('#defenseCardPill');
                if (defensePill) {
                    defensePill.textContent = levelInfo
                        ? `${levelInfo.label} · ${levelInfo.durationLabel}`
                        : '1–2 hours';
                }
                const roleBadge = $('#projectRoleBadge');
                if (roleBadge) {
                    const isPanel = state.student.instructorRole === 'panel';
                    roleBadge.textContent = isPanel ? 'Panel Member' : 'Adviser';
                    roleBadge.className = `badge ${isPanel ? 'sky' : 'teal'}`;
                    roleBadge.classList.toggle('hidden', !state.student.instructorRole);
                }
                setText('#projectTitleText', state.student.capstoneTitle || state.student.name);
                setText(
                    '#projectMembersText',
                    `${count} ${count === 1 ? 'member' : 'members'} · ${state.student.members?.join(', ') || state.student.name}`
                );
                projBox.classList.remove('hidden');
            } else {
                projBox.classList.add('hidden');
            }
        }
    }

    function setStudent(student, navigateToStep1 = false) {
        state.student = student || null;
        state.defenseLevel = isDefenseLevel(state.student?.projectLevel) ? state.student.projectLevel : null;
        const box = $('#accountBox');
        box?.classList.toggle('hidden', !state.student);
        updateRoleVisibility();

        if (state.student) {
            const myBookingsBtn = $('#myBookingsBtn');
            if (myBookingsBtn) {
                const membersStr = Array.isArray(state.student.members) && state.student.members.length
                    ? state.student.members.join(', ')
                    : state.student.name;
                myBookingsBtn.title = `Profile · Members: ${membersStr}`;
            }
            if (state.student.capstoneTitle && $('#teamInput')) {
                $('#teamInput').value = state.student.capstoneTitle;
            }
            resetMembers();
            setBookingType('group');
            loadMyBookings();
            if (navigateToStep1) {
                goToStep(1);
            }
        } else {
            $('#myBookingsBtn')?.classList.add('hidden');
            if ($('#teamInput')) $('#teamInput').value = '';
            state.consultationPurpose = null;
            state.beninsigConfirmed = false;
            state.selectedDate = null;
            state.selectedSlot = null;
            resetMembers();
            setBookingType('group');
            showAuthGate();
        }
        if (state.consultationPurpose) updatePurposeUI();
        syncMemberControls();
    }

    function renderStep3() {
        if (!state.student) {
            showAuthGate();
            return;
        }
        if (state.student.capstoneTitle && $('#teamInput') && !$('#teamInput').value.trim()) {
            $('#teamInput').value = state.student.capstoneTitle;
        }
        updatePurposeUI();
        syncMemberControls();
    }

    function setAuthMode(mode) {
        state.authMode = mode;
        setAuthError('');
        clearFormFieldErrors('#authView');
        $('#loginForm').classList.toggle('hidden', mode !== 'login');
        $('#registerForm').classList.toggle('hidden', mode !== 'register');
        $('#forgotForm').classList.toggle('hidden', mode !== 'forgot');
        $('#otpForm').classList.toggle('hidden', mode !== 'otp');
        $('#authTabs').classList.toggle('hidden', mode === 'otp' || mode === 'forgot');
        if (mode === 'login' || mode === 'register') {
            const radio = document.querySelector(`input[name="authMode"][value="${mode}"]`);
            if (radio) radio.checked = true;
        }

        const titles = {
            login: 'Sign in to schedule',
            register: 'Create account',
            forgot: 'Reset password',
            otp: state.otpPurpose === 'reset' ? 'Enter reset code' : 'Check email (and spam folder)',
        };
        setText('#authTitle', titles[mode]);
        $('#resetPasswordFields').classList.toggle('hidden', !(mode === 'otp' && state.otpPurpose === 'reset'));
    }

    function setButtonBusy(btn, busy, busyLabel) {
        const label = btn.querySelector('.btn-label');
        if (!btn.dataset.label) btn.dataset.label = label.textContent;
        btn.disabled = busy;
        btn.querySelector('.spinner').classList.toggle('hidden', !busy);
        label.textContent = busy ? busyLabel : btn.dataset.label;
    }

    const SERVER_FIELD_MAP = {
        regName: '#regName',
        regEmail: '#regEmail',
        regCapstone: '#regCapstone',
        regRole: '#regRoleField',
        regLevel: '#regLevelField',
        regMembers: '#regMembersField',
        regPassword: '#regPassword',
    };

    async function runAuth(btn, busyLabel, fn) {
        if (state.authBusy) return;
        state.authBusy = true;
        setAuthError('');
        setButtonBusy(btn, true, busyLabel);
        try {
            await fn();
        } catch (err) {
            if (err.field && SERVER_FIELD_MAP[err.field]) {
                setFieldError(SERVER_FIELD_MAP[err.field], err.message);
            } else {
                setAuthError(err.message);
            }
        } finally {
            state.authBusy = false;
            setButtonBusy(btn, false);
        }
    }

    function startResendCountdown(seconds = 60) {
        const btn = $('#resendBtn');
        clearInterval(state.resendTimer);
        let left = seconds;
        const tick = () => {
            btn.disabled = left > 0;
            btn.textContent = left > 0 ? `Resend code (${left}s)` : 'Resend code';
            if (left-- <= 0) clearInterval(state.resendTimer);
        };
        tick();
        state.resendTimer = setInterval(tick, 1000);
    }

    function showOtpStep(purpose, email, resendSeconds) {
        state.otpPurpose = purpose;
        state.otpEmail = email;
        $('#otpEmail').textContent = email;
        $('#otpCode').value = '';
        $('#resetPassword').value = '';
        setAuthMode('otp');
        startResendCountdown(resendSeconds || 60);
        setTimeout(() => $('#otpCode').focus(), 50);
    }

    function onSignedIn(student, message) {
        ['#loginPassword', '#regPassword', '#regPassword2', '#resetPassword', '#otpCode'].forEach((s) => {
            const el = $(s);
            if (el) el.value = '';
        });
        clearInterval(state.resendTimer);
        setAuthMode('login');
        setStudent(student, true);
        toast(message, 'success');
    }

    function handleLogin(e) {
        e.preventDefault();
        clearFormFieldErrors('#loginForm');
        setAuthError('');
        const email = $('#loginEmail').value.trim();
        const password = $('#loginPassword').value;
        if (!email) {
            setFieldError('#loginEmail', 'Please enter your university email.');
            return;
        }
        if (!password) {
            setFieldError('#loginPassword', 'Please enter your password.');
            return;
        }
        runAuth($('#loginBtn'), 'Logging in…', async () => {
            const { student } = await api('/api/auth/login', {
                method: 'POST',
                body: JSON.stringify({ email, password }),
            });
            onSignedIn(student, `Welcome back, ${student.name.split(' ')[0]}!`);
        });
    }

    /* ---------------- registration members UI (1 to 3 members) ---------------- */
    function getRegMemberInputs() {
        return Array.from(document.querySelectorAll('#regMemberList input'));
    }

    function syncRegMemberControls() {
        const rows = Array.from(document.querySelectorAll('#regMemberList .member-row'));
        const repName = $('#regName')?.value.trim() || '';
        rows.forEach((row, idx) => {
            const input = row.querySelector('input');
            const removeBtn = row.querySelector('.remove-member');
            if (idx === 0) {
                input.readOnly = true;
                input.value = repName;
                input.placeholder = 'Member 1 (You) — auto-filled from your name above';
                removeBtn.disabled = true;
                removeBtn.title = 'You are always Member 1';
            } else {
                input.readOnly = false;
                input.placeholder = `Member ${idx + 1} — full name`;
                removeBtn.disabled = false;
                removeBtn.title = 'Remove member';
            }
        });
        setText('#regMemberCount', `(${rows.length}/${MAX_MEMBERS})`);
        $('#regAddMemberBtn')?.classList.toggle('hidden', rows.length >= MAX_MEMBERS);
    }

    function addRegMemberRow(initialValue = '', shouldFocus = false) {
        const list = $('#regMemberList');
        if (!list || list.children.length >= MAX_MEMBERS) return;

        const row = document.createElement('div');
        row.className = 'member-row';

        const input = document.createElement('input');
        input.type = 'text';
        input.maxLength = 100;
        input.value = initialValue;
        input.addEventListener('input', () => clearFieldError('#regMembersField'));

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'remove-member';
        removeBtn.setAttribute('aria-label', 'Remove member');
        removeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
        removeBtn.addEventListener('click', () => {
            if (list.children.length <= MIN_MEMBERS) return;
            row.remove();
            clearFieldError('#regMembersField');
            syncRegMemberControls();
        });

        row.append(input, removeBtn);
        list.appendChild(row);
        syncRegMemberControls();
        if (shouldFocus) input.focus();
    }

    function resetRegMembers() {
        const list = $('#regMemberList');
        if (!list) return;
        list.innerHTML = '';
        addRegMemberRow($('#regName')?.value.trim() || '');
    }

    function handleRegister(e) {
        e.preventDefault();
        clearFormFieldErrors('#registerForm');
        setAuthError('');

        const name = $('#regName').value.trim();
        const email = $('#regEmail').value.trim().toLowerCase();
        const capstoneTitle = $('#regCapstone').value.trim();
        const instructorRole = document.querySelector('input[name="regRole"]:checked')?.value || 'adviser';
        const projectLevel = document.querySelector('input[name="regLevel"]:checked')?.value || '';
        const regInputs = getRegMemberInputs();
        const password = $('#regPassword').value;
        const password2 = $('#regPassword2').value;
        const domains = state.config?.allowedEmailDomains || [];

        if (name.length < 2) {
            setFieldError('#regName', 'Please enter your full name (at least 2 characters).');
            return;
        }
        if (!email || (domains.length && !domains.some((d) => email.endsWith(`@${d}`) || email.endsWith(`.${d}`)))) {
            const hint = domains.length ? ` (${domains.map((d) => '@' + d).join(' or ')})` : '';
            setFieldError('#regEmail', `Please enter your university email${hint}.`);
            return;
        }
        if (capstoneTitle.length < 3) {
            setFieldError('#regCapstone', 'Please enter your Capstone / Thesis title (at least 3 characters).');
            return;
        }
        if (!isDefenseLevel(projectLevel)) {
            setFieldError('#regLevelField', 'Please select your course: Capstone 1, Capstone 2, Thesis 1, or Thesis 2.');
            return;
        }

        const emptyExtra = regInputs.slice(1).find((el) => el.value.trim().length === 0);
        if (emptyExtra) {
            setFieldError(
                '#regMembersField',
                'Please enter this member’s full name, or click × to remove the extra row.',
                emptyExtra
            );
            return;
        }
        const shortExtra = regInputs.slice(1).find((el) => el.value.trim().length < 2);
        if (shortExtra) {
            setFieldError('#regMembersField', 'Each member needs a full name (at least 2 characters).', shortExtra);
            return;
        }
        const otherMembers = regInputs.slice(1).map((el) => el.value.trim()).filter(Boolean).slice(0, MAX_MEMBERS - 1);
        const members = [name, ...otherMembers];

        if (password.length < 8) {
            setFieldError('#regPassword', 'Password must be at least 8 characters long.');
            return;
        }
        if (password !== password2) {
            setFieldError('#regPassword2', 'Passwords do not match. Please re-enter your password.');
            return;
        }

        runAuth($('#registerBtn'), 'Sending code…', async () => {
            const data = await api('/api/auth/register/start', {
                method: 'POST',
                body: JSON.stringify({ name, email, capstoneTitle, instructorRole, projectLevel, members, password }),
            });
            showOtpStep('register', data.email, data.resendSeconds);
            toast('Verification code sent. Check your inbox or spam folder.', 'success');
        });
    }

    function handleForgot(e) {
        e.preventDefault();
        clearFormFieldErrors('#forgotForm');
        setAuthError('');
        const email = $('#forgotEmail').value.trim().toLowerCase();
        if (!email) {
            setFieldError('#forgotEmail', 'Please enter your university email.');
            return;
        }
        runAuth($('#forgotBtn'), 'Sending code…', async () => {
            const data = await api('/api/auth/forgot/start', {
                method: 'POST',
                body: JSON.stringify({ email }),
            });
            showOtpStep('reset', data.email, data.resendSeconds);
            toast('If that email is registered, a reset code is on its way.', 'success');
        });
    }

    function handleOtp(e) {
        e.preventDefault();
        clearFormFieldErrors('#otpForm');
        setAuthError('');
        const code = $('#otpCode').value.replace(/\D/g, '');
        if (code.length !== 6) {
            setFieldError('#otpCode', 'Please enter the 6-digit verification code from your email.');
            return;
        }

        if (state.otpPurpose === 'reset') {
            const password = $('#resetPassword').value;
            if (password.length < 8) {
                setFieldError('#resetPassword', 'New password must be at least 8 characters long.');
                return;
            }
            runAuth($('#otpBtn'), 'Verifying…', async () => {
                const { student } = await api('/api/auth/forgot/verify', {
                    method: 'POST',
                    body: JSON.stringify({ email: state.otpEmail, code, password }),
                });
                onSignedIn(student, 'Password updated. You are now logged in.');
            });
        } else {
            runAuth($('#otpBtn'), 'Verifying…', async () => {
                const { student } = await api('/api/auth/register/verify', {
                    method: 'POST',
                    body: JSON.stringify({ email: state.otpEmail, code }),
                });
                onSignedIn(student, 'Email verified! Your group account is ready.');
            });
        }
    }

    async function handleResend() {
        const btn = $('#resendBtn');
        if (btn.disabled) return;
        btn.disabled = true;
        setAuthError('');
        try {
            const data = await api('/api/auth/resend', {
                method: 'POST',
                body: JSON.stringify({ email: state.otpEmail, purpose: state.otpPurpose }),
            });
            toast('A new verification code has been sent. Check your inbox or spam folder.', 'success');
            startResendCountdown(data.resendSeconds || 60);
        } catch (err) {
            setAuthError(err.message);
            btn.disabled = false;
        }
    }

    async function logout() {
        try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
        setStudent(null);
        setAuthMode('login');
        toast('You have been logged out.');
    }

    async function loadCurrentStudent() {
        try {
            const { student } = await api('/api/auth/me');
            setStudent(student, Boolean(student));
        } catch {
            setStudent(null);
        }
    }

    function initPasswordToggles() {
        document.querySelectorAll('.pw-toggle').forEach((btn) => {
            btn.addEventListener('click', () => {
                const input = document.getElementById(btn.dataset.target);
                if (!input) return;
                const showing = input.type === 'text';
                input.type = showing ? 'password' : 'text';
                btn.textContent = showing ? 'Show' : 'Hide';
                btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
                input.focus({ preventScroll: true });
            });
        });
    }

    function initFieldAutoClear() {
        document.querySelectorAll('input, textarea').forEach((inp) => {
            inp.addEventListener('input', () => clearFieldError(inp));
        });
    }

    function initAuth() {
        document.querySelectorAll('input[name="authMode"]').forEach((radio) => {
            radio.addEventListener('change', (e) => setAuthMode(e.target.value));
        });
        $('#loginForm').addEventListener('submit', handleLogin);
        $('#registerForm').addEventListener('submit', handleRegister);
        $('#regName')?.addEventListener('input', syncRegMemberControls);
        $('#regAddMemberBtn')?.addEventListener('click', () => addRegMemberRow('', true));
        resetRegMembers();

        $('#forgotForm').addEventListener('submit', handleForgot);
        $('#otpForm').addEventListener('submit', handleOtp);
        $('#resendBtn').addEventListener('click', handleResend);
        $('#forgotLink').addEventListener('click', () => {
            $('#forgotEmail').value = $('#loginEmail').value;
            setAuthMode('forgot');
            $('#forgotEmail').focus();
        });
        $('#forgotCancel').addEventListener('click', () => setAuthMode('login'));
        $('#otpChangeEmail').addEventListener('click', () => {
            clearInterval(state.resendTimer);
            setAuthMode(state.otpPurpose === 'reset' ? 'forgot' : 'register');
        });
        $('#otpCode').addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
        });
        $('#logoutBtn').addEventListener('click', logout);
        setAuthMode('login');
    }

    function applyEmailHints(config) {
        const domains = config.allowedEmailDomains || [];
        if (!domains.length) return;
        const example = `youremail@${domains[0]}`;
        $('#loginEmail').placeholder = example;
        $('#regEmail').placeholder = example;
        $('#forgotEmail').placeholder = example;
        $('#regEmailHint').textContent = `Must end with ${domains.map((d) => '@' + d).join(' or ')}`;
    }

    /* ---------------- init ---------------- */
    async function init() {
        const now = new Date();
        state.viewYear = now.getFullYear();
        state.viewMonth = now.getMonth();
        setText('#year', now.getFullYear());

        resetMembers();
        document.querySelectorAll('.type-choice-card').forEach((card) => {
            card.addEventListener('click', () => onClickConsultationCard(card.dataset.purpose));
        });
        $('#changePurposeBtn')?.addEventListener('click', () => goToStep(1));

        // Ma'am Melinda Beninsig prerequisite modal events
        $('#beninsigYesBtn')?.addEventListener('click', () => {
            state.beninsigConfirmed = true;
            closeBeninsigModal();
            proceedWithConsultationPurpose('letter');
        });
        $('#beninsigNoBtn')?.addEventListener('click', () => {
            $('#beninsigAskView').classList.add('hidden');
            $('#beninsigNoView').classList.remove('hidden');
            $('#beninsigCloseBtn')?.focus();
        });
        $('#beninsigCloseBtn')?.addEventListener('click', closeBeninsigModal);
        $('#beninsigModal')?.addEventListener('click', (e) => {
            if (e.target.id === 'beninsigModal') closeBeninsigModal();
        });

        document.querySelectorAll('input[name="regLevel"]').forEach((r) => {
            r.addEventListener('change', () => clearFieldError('#regLevelField'));
        });

        // Student profile & bookings modal events
        $('#myBookingsBtn')?.addEventListener('click', () => openMyBookingsModal('all'));
        $('#accountProfileBtn')?.addEventListener('click', () => openMyBookingsModal('all'));
        $('#sidebarProfileBtn')?.addEventListener('click', () => openMyBookingsModal('all'));
        document.querySelectorAll('.profile-pill').forEach((pill) => {
            pill.addEventListener('click', () => {
                state.profileFilter = pill.dataset.pfilter || 'all';
                renderMyBookingsModal();
            });
        });
        $('#closeMyBookingsBtn')?.addEventListener('click', closeMyBookingsModal);
        $('#myBookingsModal')?.addEventListener('click', (e) => {
            if (e.target.id === 'myBookingsModal') closeMyBookingsModal();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeBeninsigModal();
                closeMyBookingsModal();
            }
        });

        document.querySelectorAll('input[name="bookingType"]').forEach((radio) => {
            radio.addEventListener('change', (e) => setBookingType(e.target.value));
        });
        $('#addMemberBtn')?.addEventListener('click', () => addMemberRow('', true));

        $('#prevMonth')?.addEventListener('click', () => changeMonth(-1));
        $('#nextMonth')?.addEventListener('click', () => changeMonth(1));
        $('#backBtn')?.addEventListener('click', () => goToStep(2));

        document.querySelectorAll('.step').forEach((stepEl) => {
            const targetStep = Number(stepEl.dataset.step);
            if (targetStep === 1 || targetStep === 2) {
                stepEl.style.cursor = 'pointer';
                stepEl.addEventListener('click', () => {
                    if (state.currentStep < 4 && targetStep < state.currentStep) {
                        goToStep(targetStep);
                    }
                });
            }
        });

        $('#bookingForm')?.addEventListener('submit', submitBooking);
        $('#bookAnother')?.addEventListener('click', resetBooking);
        $('#reasonInput')?.addEventListener('input', (e) => {
            setText('#reasonCount', e.target.value.length);
        });

        initPasswordToggles();
        initFieldAutoClear();
        initAuth();
        loadCurrentStudent();

        try {
            const config = await ensureConfig();
            applyEmailHints(config);
        } catch {
            toast('Could not connect to the server. Please refresh the page.', 'error');
        }
    }

    init();
})();
