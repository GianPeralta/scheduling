(() => {
    'use strict';

    const $ = (sel) => document.querySelector(sel);
    const setText = (sel, val) => {
        const el = $(sel);
        if (el) el.textContent = val;
    };
    const MIN_MEMBERS = 1;
    const MAX_MEMBERS = 3;

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
            badge: 'Drop-off only · 0 min',
            summary: 'Drop-off Manuscript · 0 min',
            color: 'amber',
            requiresAllMembers: false,
            reasonOptional: true,
            bannerNote: 'Drop-off only (takes 0 minutes off schedule). You will be notified via school email once checked.',
            policyHtml: '<strong>Drop-off Only (0 min):</strong> No minutes are taken off the consultation schedule. Once your manuscript is checked, you will be notified through your registered school email (<strong data-student-email></strong>).',
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
    };

    const state = {
        config: null,
        configPromise: null,
        currentStep: 1, // 1 = Type, 2 = Date & Time, 3 = Sign in & Details, 4 = Confirmed
        viewYear: 0,
        viewMonth: 0, // 0-11
        monthDays: {}, // { 'YYYY-MM-DD': { bookable, open } }
        selectedDate: null,
        selectedSlot: null, // { startMinute, endMinute, durationMinutes, isDropoff, label, endLabel }
        consultationPurpose: null, // 'system' | 'dropoff' | 'retrieval' | 'letter'
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

    function getMeta(purpose = state.consultationPurpose) {
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
            $('#selectionTime').textContent = 'Select a time slot';
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
        $('#bannerPurposeTitle').textContent = meta.title;
        const badge = $('#bannerPurposeBadge');
        badge.textContent = meta.badge;
        badge.className = `badge ${meta.color}`;
        $('#bannerPurposeNote').textContent = meta.bannerNote;

        // Step 3 policy callout & form fields
        const policyEl = $('#bookingPolicyNotice');
        if (policyEl) {
            policyEl.className = `policy-callout ${meta.color}`;
            policyEl.innerHTML = meta.policyHtml;
            const emailSpan = policyEl.querySelector('[data-student-email]');
            if (emailSpan) {
                emailSpan.textContent = state.student?.email || 'your university email';
            }
        }

        // Attendance mode rules:
        // System & Retrieval require all members to be present (1, 2, or 3 members).
        // Solo (1-member) projects also skip the Representative vs All Members toggle.
        const toggleField = $('#attendanceToggleField');
        const registeredCount = Array.isArray(state.student?.members) ? state.student.members.length : 1;
        if (meta.requiresAllMembers) {
            toggleField.classList.add('hidden');
            setBookingType('group');
            setText(
                '#membersFieldLabel',
                registeredCount <= 1
                    ? 'Capstone / Thesis member (must be present)'
                    : 'Capstone / Thesis members (all members must be present)'
            );
        } else if (registeredCount <= 1) {
            toggleField.classList.add('hidden');
            setBookingType('group');
            setText('#membersFieldLabel', 'Capstone / Thesis member');
        } else {
            toggleField.classList.remove('hidden');
            setText('#membersFieldLabel', 'Attending group members');
        }

        setText('#reasonLabelText', meta.reasonLabel);
        setText('#reasonOptionalHint', meta.reasonOptional ? '(optional)' : '');
        $('#reasonInput').placeholder = meta.reasonPlaceholder;
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

    async function proceedWithConsultationPurpose(purpose) {
        const nextPurpose = Object.prototype.hasOwnProperty.call(PURPOSE_META, purpose) ? purpose : 'system';
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
        }
        updateSelectionBox();

        try {
            await ensureConfig();
        } catch {
            toast('Could not connect to the server. Please refresh the page.', 'error');
            return;
        }

        goToStep(2);

        const targetMonthLoadKey = `${monthKey(state.viewYear, state.viewMonth)}#${nextPurpose}`;
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
        const key = monthKey(state.viewYear, state.viewMonth);
        renderCalendar(true);
        try {
            const data = await api(`/api/month?month=${key}&purpose=${purpose}`);
            if (reqId !== state.monthRequest) return false;
            state.monthDays = data.days;
            state.loadedMonthKey = `${key}#${purpose}`;
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
                btn.title = 'Today — bookings must be made at least 1 day before the consultation day';
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
        const key = `${ds}#${purpose}`;
        if (!force && ds === state.selectedDate && (state.loadingSlotsKey === key || state.loadedSlotsKey === key)) {
            return;
        }

        state.selectedDate = ds;
        state.selectedSlot = null;
        state.loadingSlotsKey = key;
        state.loadedSlotsKey = null;
        state.activeWindowLabel = null;
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
        try {
            const data = await api(`/api/slots?date=${ds}&purpose=${purpose}`);
            if (reqId !== state.slotsRequest) return;
            state.loadingSlotsKey = null;
            state.loadedSlotsKey = key;
            renderSlots(data.slots);
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
            range.textContent = 'Drop-off window · 0 min deducted';
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
                ? 'Select the drop-off window below (takes 0 minutes off schedule)'
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
            const { booking } = await api('/api/bookings', {
                method: 'POST',
                body: JSON.stringify(payload),
            });
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
        const meta = getMeta(b.consultationType);
        const hasMultipleMembers = Array.isArray(b.members) && b.members.length >= 2;
        const capstone = b.capstoneTitle || b.teamName || state.student?.capstoneTitle || null;
        const role = b.instructorRole || state.student?.instructorRole || null;

        $('#confirmHeading').textContent = b.isDropoff ? 'Drop-off scheduled!' : "You're booked!";
        $('#confirmSubheading').textContent = b.isDropoff
            ? `Bring your printed manuscript to ${state.config?.location || 'the Faculty Office'} during the drop-off window.`
            : `Your consultation with ${state.config?.teacherName || 'Arnemie Gayyed'} is confirmed. Please arrive on time.`;

        const reminder = $('#cReminderNote');
        if (reminder) {
            reminder.className = `policy-callout ${meta.color}`;
            reminder.innerHTML = meta.confirmHtml;
        }

        $('#cPurpose').textContent = `${b.consultationTitle || meta.title} (${b.durationLabel || meta.badge})`;

        const roleRow = $('#cRoleRow');
        if (roleRow) {
            roleRow.classList.toggle('hidden', !role);
            if (role) {
                $('#cRole').textContent = role === 'panel' ? 'Panel Member' : 'Adviser';
            }
        }

        $('#cTeamRow').classList.toggle('hidden', !capstone);
        if (capstone) {
            $('#cTeam').textContent = capstone;
        }
        if (hasMultipleMembers) {
            $('#cNameLabel').textContent = `Attending (${b.members.length})`;
            $('#cName').textContent = b.members.join(', ');
        } else {
            $('#cNameLabel').textContent = 'Attending';
            $('#cName').textContent = b.members?.[0] || b.name;
        }
        $('#cDate').textContent = formatLongDate(b.date);
        $('#cTime').textContent = b.label;
        $('#cLocation').textContent = state.config?.location || 'Faculty Office';
        $('#cReason').textContent = b.reason;
        $('#cRef').textContent = b.reference;
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
        $('#slotsSubtitle').textContent = 'Available times will appear here.';
        $('#slotList').innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
                <p>Pick a highlighted day on the calendar to see open time slots.</p>
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
            .filter((b) => b.status === 'cancelled' && (!today || b.date >= today) && !dismissed.has(b.id))
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
        title.textContent = `Schedule cancelled: ${latest.consultationTitle} on ${formatLongDate(latest.date)} (${latest.label})`;

        const reasonLine = document.createElement('p');
        reasonLine.textContent = `Reason from ${state.config?.teacherName || 'Arnemie Gayyed'}: “${latest.cancellationReason || 'Please reschedule for another available slot.'}”`;

        body.append(title, reasonLine);

        const actions = document.createElement('div');
        actions.className = 'cancelled-alert-actions';

        const viewBtn = document.createElement('button');
        viewBtn.type = 'button';
        viewBtn.className = 'btn btn-ghost btn-sm';
        viewBtn.textContent = 'View in Profile';
        viewBtn.addEventListener('click', () => openMyBookingsModal('cancelled'));

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

        const allOrdered = [...upcoming, ...cancelled, ...past];

        setText('#pCountAll', allOrdered.length);
        setText('#pCountUpcoming', upcoming.length);
        setText('#pCountCancelled', cancelled.length);
        setText('#pCountPast', past.length);

        document.querySelectorAll('.profile-pill').forEach((pill) => {
            pill.classList.toggle('active', pill.dataset.pfilter === state.profileFilter);
        });

        const items = state.profileFilter === 'upcoming'
            ? upcoming
            : state.profileFilter === 'cancelled'
                ? cancelled
                : state.profileFilter === 'past'
                    ? past
                    : allOrdered;

        if (!items.length) {
            const emptyMsg = state.profileFilter === 'upcoming'
                ? 'You have no upcoming scheduled consultations.'
                : state.profileFilter === 'cancelled'
                    ? 'You have no cancelled consultations.'
                    : state.profileFilter === 'past'
                        ? 'No past consultations yet.'
                        : 'You have not scheduled any consultations yet.';
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            const p = document.createElement('p');
            p.textContent = emptyMsg;
            empty.appendChild(p);
            list.appendChild(empty);
            return;
        }

        const teacherName = state.config?.teacherName || 'Arnemie Gayyed';
        const location = state.config?.location || 'Faculty Office';

        items.forEach((b) => {
            const cat = bookingCategory(b);
            const meta = getMeta(b.consultationType);
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
                statusBadge.textContent = 'Cancelled by Instructor';
            } else if (cat === 'upcoming') {
                statusBadge.className = 'badge teal';
                statusBadge.textContent = 'Scheduled';
            } else {
                statusBadge.className = 'badge muted-badge';
                statusBadge.textContent = 'Completed';
            }
            badges.appendChild(statusBadge);

            const ref = document.createElement('code');
            ref.textContent = `Ref: ${b.reference}`;

            top.append(badges, ref);

            const dateStrong = document.createElement('strong');
            dateStrong.textContent = formatLongDate(b.date);

            const timeSpan = document.createElement('span');
            timeSpan.className = 'muted small';
            timeSpan.textContent = `${b.label} · ${location}`;

            item.append(top, dateStrong, timeSpan);

            if (b.reason) {
                const agenda = document.createElement('p');
                agenda.className = 'my-booking-agenda muted small';
                agenda.textContent = b.reason;
                item.appendChild(agenda);
            }

            if (cat === 'cancelled') {
                const reasonBox = document.createElement('div');
                reasonBox.className = 'cancel-reason-box';

                const reasonHeading = document.createElement('strong');
                reasonHeading.textContent = `Reason from ${teacherName}:`;

                const reasonText = document.createElement('p');
                reasonText.textContent = b.cancellationReason || 'No reason provided.';

                reasonBox.append(reasonHeading, reasonText);

                if (b.cancelledAt) {
                    const stamp = document.createElement('small');
                    stamp.className = 'muted';
                    stamp.textContent = `Cancelled ${new Date(b.cancelledAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`;
                    reasonBox.appendChild(stamp);
                }

                item.appendChild(reasonBox);
            }

            list.appendChild(item);
        });
    }

    async function openMyBookingsModal(initialFilter = null) {
        if (typeof initialFilter === 'string') {
            state.profileFilter = initialFilter;
        }
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
    function initials(name) {
        return String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
    }

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
                const roleBadge = $('#projectRoleBadge');
                if (roleBadge) {
                    const isPanel = state.student.instructorRole === 'panel';
                    roleBadge.textContent = isPanel ? 'Panel Member' : 'Adviser';
                    roleBadge.className = `badge ${isPanel ? 'sky' : 'teal'}`;
                    roleBadge.classList.toggle('hidden', !state.student.instructorRole);
                }
                setText('#projectTitleText', state.student.capstoneTitle || state.student.name);
                setText('#projectMembersText', `${count} ${count === 1 ? 'member' : 'members'} · ${state.student.members?.join(', ') || state.student.name}`);
                projBox.classList.remove('hidden');
            } else {
                projBox.classList.add('hidden');
            }
        }
    }

    function setStudent(student, navigateToStep1 = false) {
        state.student = student || null;
        const box = $('#accountBox');
        box.classList.toggle('hidden', !state.student);
        updateRoleVisibility();

        if (state.student) {
            $('#accountAvatar').textContent = initials(state.student.name);
            $('#accountName').textContent = state.student.name;
            $('#accountEmail').textContent = state.student.email;
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
        $('#nameInput').value = state.student.name;
        if (state.student.capstoneTitle && !$('#teamInput').value.trim()) {
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
            login: ['Sign in to schedule', 'Log in with your verified university account to view and book consultations.'],
            register: ['Create Capstone / Thesis account', 'Register once using your university email (1 to 3 members max).'],
            forgot: ['Reset your password', 'Enter your university email and we will send a 6-digit reset code.'],
            otp: state.otpPurpose === 'reset'
                ? ['Check your email', 'Enter the 6-digit code and choose your new password.']
                : ['Verify your university email', 'Enter the 6-digit code we sent to activate your account.'],
        };
        $('#authTitle').textContent = titles[mode][0];
        $('#authSubtitle').textContent = titles[mode][1];
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
                body: JSON.stringify({ name, email, capstoneTitle, instructorRole, members, password }),
            });
            showOtpStep('register', data.email, data.resendSeconds);
            toast('Verification code sent. Check your university email.', 'success');
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
            toast('A new verification code has been sent.', 'success');
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
        const example = `yourname@${domains[0]}`;
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
