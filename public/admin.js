(() => {
    'use strict';

    const $ = (sel) => document.querySelector(sel);
    const STORAGE_KEY = 'arnemie_admin_pw';

    const TYPE_BADGES = {
        system: { label: 'System · 15m', cls: 'teal' },
        dropoff: { label: 'Drop-off only', cls: 'amber' },
        retrieval: { label: 'Retrieval · 5m', cls: 'sky' },
        letter: { label: 'Comm. Letter · 5m', cls: 'violet' },
        other: { label: 'Other · 6m', cls: 'sky' },
    };

    const state = {
        password: sessionStorage.getItem(STORAGE_KEY) || '',
        bookings: [],
        today: '',
        currentHour: 0,
        currentMinute: 0,
        tab: 'upcoming',
        search: '',
        loggingIn: false,
        loadReqId: 0,
        cancelTarget: null,
        cancelling: false,
    };

    /* ---------------- helpers ---------------- */
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
        state.bookings = [];
        showLogin();
    }

    /* ---------------- data ---------------- */
    async function loadBookings() {
        const reqId = ++state.loadReqId;
        const refreshBtn = $('#refreshBtn');
        if (refreshBtn) refreshBtn.disabled = true;
        try {
            const data = await api('/api/admin/bookings');
            if (reqId !== state.loadReqId) return false;
            state.bookings = data.bookings.sort(
                (a, b) => a.date.localeCompare(b.date) || (a.startMinute ?? a.hour * 60) - (b.startMinute ?? b.hour * 60)
            );
            state.today = data.today;
            state.currentHour = data.currentHour;
            state.currentMinute = data.currentMinute ?? data.currentHour * 60;
            $('#todayLabel').textContent = `Today is ${longDate(data.today)}`;
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
        } finally {
            if (reqId === state.loadReqId && refreshBtn) {
                refreshBtn.disabled = false;
            }
        }
    }

    const isCancelled = (b) => b.status === 'cancelled';
    const isPast = (b) => {
        const endMin = b.endMinute ?? (b.hour + 1) * 60;
        return b.date < state.today || (b.date === state.today && endMin <= state.currentMinute);
    };
    const isNow = (b) => {
        if (isCancelled(b)) return false;
        const startMin = b.startMinute ?? b.hour * 60;
        const endMin = b.endMinute ?? (b.hour + 1) * 60;
        return b.date === state.today && state.currentMinute >= startMin && state.currentMinute < endMin;
    };

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
        setTimeout(() => input?.focus(), 40);
    }

    function closeCancelModal() {
        if (state.cancelling) return;
        state.cancelTarget = null;
        $('#cancelModal')?.classList.add('hidden');
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
        if (!confirm(`Send "Manuscript Checked — Please Schedule Retrieval" email${again} to ${target}?`)) return;
        btn.disabled = true;
        const prevText = btn.textContent;
        btn.textContent = 'Sending…';
        try {
            const { notifiedAt } = await api(`/api/admin/bookings/${b.id}/notify-checked`, { method: 'POST' });
            b.notifiedAt = notifiedAt;
            render();
            toast(`Notification emailed to ${target}.`, 'success');
        } catch (err) {
            btn.disabled = false;
            btn.textContent = prevText;
            toast(err.message, 'error');
        }
    }

    function matchesSearch(b, q) {
        if (!q) return true;
        if (b.name.toLowerCase().includes(q)) return true;
        if (b.teamName && b.teamName.toLowerCase().includes(q)) return true;
        if (b.capstoneTitle && b.capstoneTitle.toLowerCase().includes(q)) return true;
        if (b.consultationTitle && b.consultationTitle.toLowerCase().includes(q)) return true;
        if (b.consultationType && b.consultationType.toLowerCase().includes(q)) return true;
        if (b.instructorRole && b.instructorRole.toLowerCase().includes(q)) return true;
        if (Array.isArray(b.members) && b.members.some((m) => m.toLowerCase().includes(q))) return true;
        if (b.reason.toLowerCase().includes(q)) return true;
        if (b.cancellationReason && b.cancellationReason.toLowerCase().includes(q)) return true;
        if (b.reference.toLowerCase().includes(q)) return true;
        if (b.studentEmail && b.studentEmail.toLowerCase().includes(q)) return true;
        return false;
    }

    /* ---------------- render ---------------- */
    function render() {
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

        const q = state.search.toLowerCase();
        const source = state.tab === 'upcoming' ? upcoming : state.tab === 'cancelled' ? cancelled : past;
        const list = source.filter((b) => matchesSearch(b, q));

        const container = $('#bookingList');
        container.innerHTML = '';

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
                }

                const typeBadge = TYPE_BADGES[b.consultationType] || {
                    label: `${b.consultationTitle || 'Consultation'} · ${b.durationLabel || ''}`,
                    cls: 'teal',
                };
                header.appendChild(el('span', `badge ${typeBadge.cls}`, typeBadge.label));

                if (b.instructorRole === 'panel') {
                    header.appendChild(el('span', 'badge sky', 'Panel'));
                } else if (b.instructorRole === 'adviser') {
                    header.appendChild(el('span', 'badge teal', 'Adviser'));
                }
                if (b.notifiedAt) {
                    header.appendChild(el('span', 'badge teal', 'Checked ✓'));
                }
                body.appendChild(header);

                if (Array.isArray(b.members) && b.members.length) {
                    const membersWrap = el('div', 'booking-members');
                    b.members.forEach((memberName) => {
                        membersWrap.appendChild(el('span', 'member-chip', memberName));
                    });
                    body.appendChild(membersWrap);
                }

                if (b.reason) {
                    body.appendChild(el('p', 'booking-reason', b.reason));
                }

                if (isCancelled(b) && b.cancellationReason) {
                    const reasonBox = el('div', 'cancel-reason-box');
                    reasonBox.appendChild(el('strong', '', 'Reason:'));
                    reasonBox.appendChild(el('p', '', b.cancellationReason));
                    body.appendChild(reasonBox);
                }

                const actions = el('div', 'booking-actions');
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
                if (state.tab === 'upcoming' && !isCancelled(b)) {
                    const btn = el('button', 'btn btn-danger-soft', 'Cancel');
                    btn.type = 'button';
                    btn.addEventListener('click', () => openCancelModal(b));
                    actions.appendChild(btn);
                }

                card.append(time, body, actions);
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
    $('#refreshBtn').addEventListener('click', async () => {
        const ok = await loadBookings();
        if (ok) toast('Appointments refreshed.');
    });
    $('#searchInput').addEventListener('input', (e) => {
        state.search = e.target.value.trim();
        render();
    });
    document.querySelectorAll('.tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
            state.tab = tab.dataset.tab;
            render();
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
    document.querySelectorAll('.reason-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
            const input = $('#cancelReasonInput');
            if (!input) return;
            input.value = chip.dataset.reason || '';
            $('#cancelReasonCount').textContent = input.value.length;
            setCancelError('');
            input.focus();
        });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeCancelModal();
    });

    if (state.password) {
        showDashboard();
        loadBookings();
    } else {
        showLogin();
    }
})();
