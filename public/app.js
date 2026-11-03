(() => {
    'use strict';

    const $ = (sel) => document.querySelector(sel);

    const state = {
        config: null,
        viewYear: 0,
        viewMonth: 0, // 0-11
        monthDays: {}, // { 'YYYY-MM-DD': { bookable, open } }
        selectedDate: null,
        selectedSlot: null, // { hour, label, endLabel }
        monthRequest: 0,
        slotsRequest: 0,
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
        ['#step1', '#step2', '#step3'].forEach((id, i) => {
            $(id).classList.toggle('hidden', i + 1 !== n);
        });
        document.querySelectorAll('.step').forEach((el) => {
            const s = Number(el.dataset.step);
            el.classList.toggle('active', s === n);
            el.classList.toggle('done', s < n);
        });
        if (n === 2) setTimeout(() => $('#nameInput').focus(), 50);
        if (window.innerWidth < 900) $('#scheduler').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function updateSelectionBox() {
        const box = $('#selectionBox');
        if (state.selectedDate && state.selectedSlot) {
            $('#selectionDate').textContent = formatLongDate(state.selectedDate);
            $('#selectionTime').textContent = `${state.selectedSlot.label} – ${state.selectedSlot.endLabel}`;
            box.classList.remove('hidden');
        } else {
            box.classList.add('hidden');
        }
    }

    /* ---------------- calendar ---------------- */
    async function loadMonth() {
        const reqId = ++state.monthRequest;
        const key = monthKey(state.viewYear, state.viewMonth);
        renderCalendar(true);
        try {
            const data = await api(`/api/month?month=${key}`);
            if (reqId !== state.monthRequest) return;
            state.monthDays = data.days;
        } catch (err) {
            if (reqId !== state.monthRequest) return;
            state.monthDays = {};
            toast(err.message, 'error');
        }
        renderCalendar(false);
    }

    function renderCalendar(loading) {
        const { viewYear: y, viewMonth: m, config } = state;
        $('#monthLabel').textContent = new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-US', {
            month: 'long', year: 'numeric', timeZone: 'UTC',
        });

        const todayKey = config.today.slice(0, 7);
        const lastKey = config.lastBookableDate.slice(0, 7);
        const current = monthKey(y, m);
        $('#prevMonth').disabled = current <= todayKey;
        $('#nextMonth').disabled = current >= lastKey;

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
                btn.addEventListener('click', () => selectDate(ds));
            }

            if (ds === state.selectedDate) btn.classList.add('selected');
            container.appendChild(btn);
        }
    }

    function changeMonth(delta) {
        let m = state.viewMonth + delta;
        let y = state.viewYear;
        if (m < 0) { m = 11; y--; }
        if (m > 11) { m = 0; y++; }
        state.viewMonth = m;
        state.viewYear = y;
        return loadMonth();
    }

    /* ---------------- slots ---------------- */
    async function selectDate(ds) {
        state.selectedDate = ds;
        state.selectedSlot = null;
        updateSelectionBox();
        document.querySelectorAll('.day.selected').forEach((el) => el.classList.remove('selected'));
        const btn = document.querySelector(`.day[data-date="${ds}"]`);
        if (btn) btn.classList.add('selected');

        $('#slotsTitle').textContent = formatLongDate(ds);
        $('#slotsSubtitle').textContent = 'Loading available times…';
        const list = $('#slotList');
        list.innerHTML = '<div class="slot skeleton"></div>'.repeat(5);

        const reqId = ++state.slotsRequest;
        try {
            const data = await api(`/api/slots?date=${ds}`);
            if (reqId !== state.slotsRequest) return;
            renderSlots(data.slots);
        } catch (err) {
            if (reqId !== state.slotsRequest) return;
            list.innerHTML = '';
            $('#slotsSubtitle').textContent = 'Could not load time slots.';
            toast(err.message, 'error');
        }
    }

    function renderSlots(slots) {
        const list = $('#slotList');
        list.innerHTML = '';
        const openCount = slots.filter((s) => s.available).length;
        $('#slotsSubtitle').textContent = openCount
            ? `${openCount} of ${slots.length} time slots available · 1 hour each`
            : 'No more open slots on this day.';

        if (!slots.length) {
            list.innerHTML = '<div class="empty-state"><p>No time slots on this day.</p></div>';
            return;
        }

        slots.forEach((slot, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'slot';
            btn.style.animationDelay = `${i * 35}ms`;

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
                btn.addEventListener('click', () => selectSlot(slot, btn));
            }
            list.appendChild(btn);
        });
    }

    function selectSlot(slot, btn) {
        const wasSelected = btn.classList.contains('selected');
        document.querySelectorAll('.slot.selected').forEach((el) => {
            el.classList.remove('selected');
            const next = el.querySelector('.slot-next');
            if (next) next.remove();
        });

        if (wasSelected) {
            state.selectedSlot = null;
            updateSelectionBox();
            return;
        }

        state.selectedSlot = slot;
        btn.classList.add('selected');
        updateSelectionBox();

        const next = document.createElement('span');
        next.className = 'slot-next';
        next.textContent = 'Next →';
        next.addEventListener('click', (e) => {
            e.stopPropagation();
            goToStep(2);
        });
        btn.appendChild(next);
    }

    /* ---------------- booking form ---------------- */
    function setFormError(msg) {
        const el = $('#formError');
        el.textContent = msg || '';
        el.classList.toggle('hidden', !msg);
    }

    function setSubmitting(on) {
        const btn = $('#submitBtn');
        btn.disabled = on;
        btn.querySelector('.spinner').classList.toggle('hidden', !on);
        btn.querySelector('.btn-label').textContent = on ? 'Booking…' : 'Confirm booking';
    }

    async function submitBooking(e) {
        e.preventDefault();
        setFormError('');

        const name = $('#nameInput').value.trim();
        const reason = $('#reasonInput').value.trim();

        if (name.length < 2) {
            setFormError('Please enter your full name.');
            $('#nameInput').focus();
            return;
        }
        if (reason.length < 5) {
            setFormError('Please tell me a bit more about the reason for the meeting.');
            $('#reasonInput').focus();
            return;
        }
        if (!state.selectedDate || !state.selectedSlot) {
            goToStep(1);
            return;
        }

        setSubmitting(true);
        try {
            const { booking } = await api('/api/bookings', {
                method: 'POST',
                body: JSON.stringify({
                    name,
                    reason,
                    date: state.selectedDate,
                    hour: state.selectedSlot.hour,
                }),
            });
            showConfirmation(booking);
        } catch (err) {
            if (err.status === 409 || err.status === 400) {
                toast(err.message, 'error');
                const date = state.selectedDate;
                state.selectedSlot = null;
                updateSelectionBox();
                goToStep(1);
                loadMonth().then(() => selectDate(date));
            } else {
                setFormError(err.message);
            }
        } finally {
            setSubmitting(false);
        }
    }

    function showConfirmation(b) {
        $('#cName').textContent = b.name;
        $('#cDate').textContent = formatLongDate(b.date);
        $('#cTime').textContent = b.label;
        $('#cLocation').textContent = state.config.location;
        $('#cReason').textContent = b.reason;
        $('#cRef').textContent = b.reference;
        goToStep(3);
    }

    function resetBooking() {
        $('#bookingForm').reset();
        $('#reasonCount').textContent = '0';
        setFormError('');
        state.selectedSlot = null;
        const date = state.selectedDate;
        updateSelectionBox();
        goToStep(1);
        loadMonth().then(() => {
            if (date && state.monthDays[date] && state.monthDays[date].open > 0) selectDate(date);
            else resetSlotsPanel();
        });
    }

    function resetSlotsPanel() {
        state.selectedDate = null;
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

        $('#prevMonth').addEventListener('click', () => changeMonth(-1));
        $('#nextMonth').addEventListener('click', () => changeMonth(1));
        $('#backBtn').addEventListener('click', () => goToStep(1));
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
        $('#teacherName').textContent = c.teacherName;
        $('#meetingTitle').textContent = c.meetingTitle;
        $('#location').textContent = c.location;
        $('#timezone').textContent = c.timezone.replace(/_/g, ' ');
        $('#avatar').textContent = c.teacherName
            .split(/\s+/)
            .filter((w) => /^[A-Za-z]/.test(w) && !/^(mr|mrs|ms|dr|prof|sir|ma'?am)\.?$/i.test(w))
            .slice(0, 2)
            .map((w) => w[0].toUpperCase())
            .join('') || 'T';
        document.title = `Book a Consultation · ${c.teacherName}`;

        const [y, m] = c.today.split('-').map(Number);
        state.viewYear = y;
        state.viewMonth = m - 1;
        await loadMonth();

        // Auto-select the first available day (moving to next month if needed)
        let firstOpen = Object.keys(state.monthDays).sort().find((d) => state.monthDays[d].open > 0);
        if (!firstOpen && monthKey(state.viewYear, state.viewMonth) < c.lastBookableDate.slice(0, 7)) {
            await changeMonth(1);
            firstOpen = Object.keys(state.monthDays).sort().find((d) => state.monthDays[d].open > 0);
        }
        if (firstOpen) selectDate(firstOpen);
    }

    init();
})();
