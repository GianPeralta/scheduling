(() => {
    'use strict';

    const $ = (sel) => document.querySelector(sel);
    const MAX_MEMBERS = 10;
    const MIN_GROUP_MEMBERS = 2;

    const state = {
        config: null,
        currentStep: 1, // 1 = Type, 2 = Date & Time, 3 = Details, 4 = Confirmed
        viewYear: 0,
        viewMonth: 0, // 0-11
        monthDays: {}, // { 'YYYY-MM-DD': { bookable, open } }
        selectedDate: null,
        selectedSlot: null, // { startMinute, endMinute, durationMinutes, label, endLabel }
        consultationPurpose: null, // 'system' (1h 20m) | 'other' (6m)
        bookingType: 'individual', // 'individual' | 'group'
        monthRequest: 0,
        slotsRequest: 0,
        loadedMonthKey: null,
        loadingSlotsKey: null,
        loadedSlotsKey: null,
        activeWindowLabel: null,
        submitting: false,
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

    function purposeSummary(purpose = state.consultationPurpose) {
        if (!purpose) return '';
        return purpose === 'other'
            ? 'Other Consultation · 6 min'
            : 'System / Software / Web App · 1 hr 20 min';
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
        toastTimer = setTimeout(() => { el.className = 'toast'; }, 4000);
    }

    /* ---------------- steps ---------------- */
    function goToStep(n) {
        state.currentStep = n;
        ['#step1', '#step2', '#step3', '#step4'].forEach((id, i) => {
            $(id).classList.toggle('hidden', i + 1 !== n);
        });
        document.querySelectorAll('.step').forEach((el) => {
            const s = Number(el.dataset.step);
            el.classList.toggle('active', s === n);
            el.classList.toggle('done', s < n);
        });
        if (n === 3) {
            setTimeout(() => {
                const target = state.bookingType === 'group' ? $('#teamInput') : $('#nameInput');
                if (target) target.focus({ preventScroll: true });
            }, 50);
        }
        if (window.innerWidth <= 940) {
            const activePanel = $(['#step1', '#step2', '#step3', '#step4'][n - 1]);
            (activePanel || $('#scheduler')).scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    function updateSelectionBox() {
        const box = $('#selectionBox');
        if (!state.consultationPurpose) {
            box.classList.add('hidden');
            return;
        }
        $('#selectionPurpose').textContent = purposeSummary();
        if (state.selectedDate && state.selectedSlot) {
            $('#selectionDate').textContent = formatLongDate(state.selectedDate);
            $('#selectionTime').textContent = `${state.selectedSlot.label} – ${state.selectedSlot.endLabel}`;
        } else if (state.selectedDate) {
            $('#selectionDate').textContent = formatLongDate(state.selectedDate);
            $('#selectionTime').textContent = 'Select a time slot';
        } else {
            $('#selectionDate').textContent = 'Select a date & time';
            $('#selectionTime').textContent = '';
        }
        box.classList.remove('hidden');
    }

    function updateReasonPlaceholder() {
        const isGroup = state.bookingType === 'group';
        const isSystem = state.consultationPurpose !== 'other';
        if (isSystem) {
            $('#reasonInput').placeholder = isGroup
                ? "e.g. We'd like to consult about the system/web app our group built and review its features."
                : "e.g. I'd like to consult about the system/software/web app I made.";
        } else {
            $('#reasonInput').placeholder = isGroup
                ? "e.g. Quick group check-in regarding our topic and requirements."
                : "e.g. Quick question about project requirements or grading criteria.";
        }
    }

    function updatePurposeBanner() {
        const isOther = state.consultationPurpose === 'other';
        $('#bannerPurposeTitle').textContent = isOther
            ? 'Other Consultation'
            : 'System / Software / Web App';
        const badge = $('#bannerPurposeBadge');
        badge.textContent = isOther ? '6 minutes' : '1 hr 20 min';
        badge.className = 'badge ' + (isOther ? 'sky' : 'teal');
    }

    async function chooseConsultationPurpose(purpose) {
        const nextPurpose = purpose === 'other' ? 'other' : 'system';
        const purposeChanged = nextPurpose !== state.consultationPurpose;

        state.consultationPurpose = nextPurpose;
        document.querySelectorAll('.type-choice-card').forEach((card) => {
            card.classList.toggle('selected', card.dataset.purpose === nextPurpose);
        });

        $('#durationMeta').textContent = nextPurpose === 'other'
            ? '6 minutes (Other consultation)'
            : '1 hr 20 min (System / Software / Web App)';

        updatePurposeBanner();
        updateReasonPlaceholder();

        if (purposeChanged) {
            state.selectedSlot = null;
            state.loadingSlotsKey = null;
            state.loadedSlotsKey = null;
            state.activeWindowLabel = null;
        }
        updateSelectionBox();
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
                ? 'Member 1 — your full name'
                : `Member ${idx + 1} — full name`;
            const removeBtn = row.querySelector('.remove-member');
            removeBtn.disabled = rows.length <= MIN_GROUP_MEMBERS;
            removeBtn.title = rows.length <= MIN_GROUP_MEMBERS
                ? 'At least 2 members are required'
                : 'Remove member';
        });
        $('#memberCount').textContent = `(${rows.length}/${MAX_MEMBERS})`;
        $('#addMemberBtn').classList.toggle('hidden', rows.length >= MAX_MEMBERS);
    }

    function addMemberRow(initialValue = '', shouldFocus = false) {
        const list = $('#memberList');
        if (list.children.length >= MAX_MEMBERS) return;

        const row = document.createElement('div');
        row.className = 'member-row';

        const input = document.createElement('input');
        input.type = 'text';
        input.maxLength = 100;
        input.value = initialValue;

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'remove-member';
        removeBtn.setAttribute('aria-label', 'Remove member');
        removeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
        removeBtn.addEventListener('click', () => {
            if (list.children.length <= MIN_GROUP_MEMBERS) return;
            row.remove();
            syncMemberControls();
        });

        row.append(input, removeBtn);
        list.appendChild(row);
        syncMemberControls();
        if (shouldFocus) input.focus();
    }

    function resetMembers() {
        const list = $('#memberList');
        list.innerHTML = '';
        addMemberRow();
        addMemberRow();
    }

    function setBookingType(type) {
        state.bookingType = type === 'group' ? 'group' : 'individual';
        const isGroup = state.bookingType === 'group';
        $('#individualFields').classList.toggle('hidden', isGroup);
        $('#groupFields').classList.toggle('hidden', !isGroup);
        updateReasonPlaceholder();

        if (isGroup) {
            const firstMember = getMemberInputs()[0];
            const soloName = $('#nameInput').value.trim();
            if (firstMember && !firstMember.value.trim() && soloName) {
                firstMember.value = soloName;
            }
        }
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

        const todayKey = config.today.slice(0, 7);
        const lastKey = config.lastBookableDate.slice(0, 7);
        const current = monthKey(y, m);
        $('#prevMonth').disabled = loading || current <= todayKey;
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

            if (ds === config.today) btn.classList.add('today');

            if (loading || !info || !info.bookable) {
                btn.disabled = true;
            } else if (info.open === 0) {
                btn.classList.add('full');
                btn.disabled = true;
                btn.title = 'Fully booked';
            } else {
                btn.classList.add('available');
                btn.title = `${info.open} slot${info.open === 1 ? '' : 's'} open`;
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
        const todayKey = state.config.today.slice(0, 7);
        const lastKey = state.config.lastBookableDate.slice(0, 7);
        if (targetKey < todayKey || targetKey > lastKey) return Promise.resolve(false);

        state.viewMonth = m;
        state.viewYear = y;
        return loadMonth();
    }

    /* ---------------- slots ---------------- */
    async function selectDate(ds, fromUser = false, force = false) {
        const purpose = state.consultationPurpose || 'system';
        const key = `${ds}#${purpose}`;
        // Ignore duplicate / double clicks on the date that is already loaded or currently loading
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
        list.innerHTML = '<div class="slot skeleton"></div>'.repeat(4);

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
        btn.className = 'slot';
        btn.style.animationDelay = `${Math.min(i, 12) * 18}ms`;

        const time = document.createElement('span');
        time.className = 'slot-time';
        time.textContent = slot.label;
        const range = document.createElement('span');
        range.className = 'slot-range';
        range.textContent = slot.available ? `until ${slot.endLabel}` : 'Unavailable';
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
        next.textContent = 'Next →';
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
        const durText = state.consultationPurpose === 'other' ? '6 minutes each' : '1 hr 20 min each';
        $('#slotsSubtitle').textContent = openCount
            ? `${openCount} of ${slots.length} slots available · ${durText}`
            : 'No more open slots on this day.';

        if (!slots.length) {
            list.innerHTML = '<div class="empty-state"><p>No time slots on this day.</p></div>';
            return;
        }

        // For 6-minute consultations, group slots by 1h 20m block tabs pinned above the scroll list
        if (state.consultationPurpose === 'other') {
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

            if (windows.length > 1 && tabsEl) {
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
                    tab.title = `${w} · ${winOpen} open`;
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
        }

        // For 1 hr 20 min consultations (or single-window days), render the slots directly
        slots.forEach((slot, i) => {
            list.appendChild(createSlotButton(slot, i));
        });
    }

    function selectSlot(slot, btn) {
        // If already selected, clicking/double-clicking advances directly to Step 3 (Details)
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
    function setFormError(msg) {
        const el = $('#formError');
        el.textContent = msg || '';
        el.classList.toggle('hidden', !msg);
    }

    function setSubmitting(on) {
        state.submitting = on;
        const btn = $('#submitBtn');
        btn.disabled = on;
        btn.querySelector('.spinner').classList.toggle('hidden', !on);
        btn.querySelector('.btn-label').textContent = on ? 'Booking…' : 'Confirm booking';
    }

    async function submitBooking(e) {
        e.preventDefault();
        if (state.submitting) return;
        setFormError('');

        if (!state.consultationPurpose) {
            goToStep(1);
            return;
        }
        if (!state.selectedDate || !state.selectedSlot) {
            goToStep(2);
            return;
        }

        const reason = $('#reasonInput').value.trim();
        let payload;

        if (state.bookingType === 'group') {
            const teamName = $('#teamInput').value.trim();
            if (teamName.length < 2) {
                setFormError('Please enter your team name.');
                $('#teamInput').focus();
                return;
            }
            const inputs = getMemberInputs();
            const members = inputs.map((el) => el.value.trim()).filter(Boolean);
            if (members.length < MIN_GROUP_MEMBERS) {
                setFormError('Please enter at least 2 group member names.');
                const emptyInput = inputs.find((el) => el.value.trim().length < 2) || inputs[0];
                if (emptyInput) emptyInput.focus();
                return;
            }
            const invalidInput = inputs.find((el) => {
                const v = el.value.trim();
                return v.length > 0 && v.length < 2;
            });
            if (invalidInput) {
                setFormError('Each member needs a full name (at least 2 characters).');
                invalidInput.focus();
                return;
            }
            payload = {
                type: 'group',
                consultationType: state.consultationPurpose,
                teamName,
                members,
                reason,
                date: state.selectedDate,
                startMinute: state.selectedSlot.startMinute,
            };
        } else {
            const name = $('#nameInput').value.trim();
            if (name.length < 2) {
                setFormError('Please enter your full name.');
                $('#nameInput').focus();
                return;
            }
            payload = {
                type: 'individual',
                consultationType: state.consultationPurpose,
                name,
                reason,
                date: state.selectedDate,
                startMinute: state.selectedSlot.startMinute,
            };
        }

        if (reason.length < 5) {
            setFormError('Please tell me a bit more about the reason for the meeting.');
            $('#reasonInput').focus();
            return;
        }

        setSubmitting(true);
        try {
            const { booking } = await api('/api/bookings', {
                method: 'POST',
                body: JSON.stringify(payload),
            });
            showConfirmation(booking);
        } catch (err) {
            if (err.status === 409 || err.status === 400) {
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
        const isGroup = b.type === 'group' && b.teamName;
        $('#cPurpose').textContent = b.consultationType === 'other'
            ? `Other Consultation (${b.durationLabel || '6 min'})`
            : `System / Software / Web App (${b.durationLabel || '1 hr 20 min'})`;
        $('#cTeamRow').classList.toggle('hidden', !isGroup);
        if (isGroup) {
            $('#cTeam').textContent = b.teamName;
            $('#cNameLabel').textContent = `Members (${b.members.length})`;
            $('#cName').textContent = b.members.join(', ');
        } else {
            $('#cNameLabel').textContent = 'Name';
            $('#cName').textContent = b.name;
        }
        $('#cDate').textContent = formatLongDate(b.date);
        $('#cTime').textContent = b.label;
        $('#cLocation').textContent = state.config.location;
        $('#cReason').textContent = b.reason;
        $('#cRef').textContent = b.reference;
        goToStep(4);
    }

    function resetBooking() {
        $('#bookingForm').reset();
        $('#reasonCount').textContent = '0';
        resetMembers();
        setBookingType('individual');
        setFormError('');
        state.consultationPurpose = null;
        state.selectedSlot = null;
        state.loadedMonthKey = null;
        state.loadedSlotsKey = null;
        document.querySelectorAll('.type-choice-card').forEach((card) => card.classList.remove('selected'));
        $('#durationMeta').textContent = '1 hr 20 min or 6 min';
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

    /* ---------------- init ---------------- */
    async function init() {
        $('#year').textContent = new Date().getFullYear();

        resetMembers();
        document.querySelectorAll('.type-choice-card').forEach((card) => {
            card.addEventListener('click', () => chooseConsultationPurpose(card.dataset.purpose));
        });
        $('#changePurposeBtn').addEventListener('click', () => goToStep(1));

        document.querySelectorAll('input[name="bookingType"]').forEach((radio) => {
            radio.addEventListener('change', (e) => setBookingType(e.target.value));
        });
        $('#addMemberBtn').addEventListener('click', () => addMemberRow('', true));

        $('#prevMonth').addEventListener('click', () => changeMonth(-1));
        $('#nextMonth').addEventListener('click', () => changeMonth(1));
        $('#backBtn').addEventListener('click', () => goToStep(2));

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

        $('#bookingForm').addEventListener('submit', submitBooking);
        $('#bookAnother').addEventListener('click', resetBooking);
        $('#reasonInput').addEventListener('input', (e) => {
            $('#reasonCount').textContent = e.target.value.length;
        });

        try {
            state.config = await api('/api/config');
        } catch (err) {
            toast('Could not connect to the server. Please refresh the page.', 'error');
            return;
        }

        const c = state.config;
        $('#location').textContent = c.location;
        $('#timezone').textContent = c.timezone.replace(/_/g, ' ');
        if (c.lastBookableDate) {
            $('#deadlineMeta').textContent = `Bookings until ${formatShortDate(c.lastBookableDate)}`;
        }

        const [y, m] = c.today.split('-').map(Number);
        state.viewYear = y;
        state.viewMonth = m - 1;
    }

    init();
})();
