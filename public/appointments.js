(() => {
    'use strict';

    const $ = (sel) => document.querySelector(sel);
    const setText = (sel, val) => {
        const el = $(sel);
        if (el) el.textContent = val;
    };

    const CANCEL_CUTOFF_MINUTES = 120; // 2 hours before scheduled time
    const DISMISSED_CANCEL_KEY = 'ag_dismissed_cancelled_v1';

    const PURPOSE_COLORS = {
        system: 'teal',
        dropoff: 'amber',
        retrieval: 'sky',
        letter: 'violet',
        other: 'sky',
        defense: 'rose',
    };

    const DEFENSE_LEVELS = {
        capstone1: { label: 'Capstone 1', durationMinutes: 60, durationLabel: '1 hour' },
        capstone2: { label: 'Capstone 2', durationMinutes: 120, durationLabel: '2 hours' },
        thesis1: { label: 'Thesis 1', durationMinutes: 60, durationLabel: '1 hour' },
        thesis2: { label: 'Thesis 2', durationMinutes: 120, durationLabel: '2 hours' },
    };

    const state = {
        config: null,
        student: null,
        bookings: [],
        serverToday: '',
        serverCurrentMinute: 0,
        tab: 'all',
        cancelTarget: null,
        cancelling: false,
    };

    function utcDate(str) {
        const [y, m, d] = str.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d));
    }

    function formatLongDate(str) {
        return utcDate(str).toLocaleDateString('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            year: 'numeric',
            timeZone: 'UTC',
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
            err.code = body.code;
            throw err;
        }
        return body;
    }

    let toastTimer;
    function toast(message, type = 'info') {
        const el = $('#toast');
        if (!el) return;
        el.textContent = message;
        el.className = `toast show ${type}`;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.className = 'toast'; }, 4200);
    }

    function dismissCancelledNotice(id) {
        try {
            const parsed = JSON.parse(localStorage.getItem(DISMISSED_CANCEL_KEY) || '[]');
            const current = new Set(Array.isArray(parsed) ? parsed : []);
            current.add(id);
            localStorage.setItem(DISMISSED_CANCEL_KEY, JSON.stringify([...current].slice(-30)));
        } catch { /* ignore storage quota */ }
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

    function renderStudentHeader() {
        const s = state.student;
        if (!s) return;
        setText('#studentGroupLabel', s.capstoneTitle || s.name);

        const levelBadge = $('#studentLevelBadge');
        if (levelBadge) {
            const levelInfo = DEFENSE_LEVELS[s.projectLevel];
            levelBadge.textContent = levelInfo ? levelInfo.label : '';
            levelBadge.classList.toggle('hidden', !levelInfo);
        }

        const roleBadge = $('#studentRoleBadge');
        if (roleBadge) {
            const isPanel = s.instructorRole === 'panel';
            roleBadge.textContent = isPanel ? 'Panel Member' : 'Adviser';
            roleBadge.className = `badge ${isPanel ? 'sky' : 'teal'}`;
            roleBadge.classList.toggle('hidden', !s.instructorRole);
        }
    }

    function renderAppointments() {
        const list = $('#appointmentsList');
        if (!list) return;
        list.innerHTML = '';

        const upcoming = state.bookings
            .filter((b) => bookingCategory(b) === 'upcoming')
            .sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute);
        const past = state.bookings
            .filter((b) => bookingCategory(b) === 'past')
            .sort((a, b) => b.date.localeCompare(a.date) || b.startMinute - a.startMinute);
        const cancelled = state.bookings
            .filter((b) => bookingCategory(b) === 'cancelled')
            .sort((a, b) => (b.cancelledAt || b.date).localeCompare(a.cancelledAt || a.date));
        const all = [...upcoming, ...cancelled, ...past];

        setText('#countAll', all.length);
        setText('#countUpcoming', upcoming.length);
        setText('#countPast', past.length);
        setText('#countCancelled', cancelled.length);

        const source = state.tab === 'upcoming'
            ? upcoming
            : state.tab === 'past'
                ? past
                : state.tab === 'cancelled'
                    ? cancelled
                    : all;

        if (!source.length) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.style.marginTop = '12px';
            empty.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';
            const p = document.createElement('p');
            p.textContent = state.tab === 'upcoming'
                ? 'No upcoming appointments scheduled.'
                : state.tab === 'past'
                    ? 'No completed appointments yet.'
                    : state.tab === 'cancelled'
                        ? 'No cancelled appointments.'
                        : 'No appointments scheduled yet.';
            empty.appendChild(p);
            list.appendChild(empty);
            return;
        }

        source.forEach((b) => {
            const cat = bookingCategory(b);
            const color = PURPOSE_COLORS[b.consultationType] || 'teal';
            const item = document.createElement('div');
            item.className = 'my-booking-item' + (cat === 'cancelled' ? ' is-cancelled' : '');

            const top = document.createElement('div');
            top.className = 'my-booking-top';

            const badges = document.createElement('div');
            badges.className = 'my-booking-badges';

            const typeBadge = document.createElement('span');
            typeBadge.className = `badge ${color}`;
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

            if (b.reference) {
                const refCode = document.createElement('code');
                refCode.textContent = `#${b.reference}`;
                top.appendChild(refCode);
            }

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

            if (b.reason) {
                const agenda = document.createElement('p');
                agenda.className = 'muted small my-booking-agenda';
                agenda.textContent = b.reason;
                item.appendChild(agenda);
            }

            if (cat === 'upcoming') {
                const actionRow = document.createElement('div');
                actionRow.className = 'my-booking-actions';

                const icsHref = b.icsUrl || (b.id ? `/api/bookings/${b.id}/ics` : '');
                if (icsHref) {
                    const icsLink = document.createElement('a');
                    icsLink.href = icsHref;
                    icsLink.download = `consultation-${String(b.reference || 'invite').toLowerCase()}.ics`;
                    icsLink.className = 'btn btn-ghost btn-sm';
                    icsLink.textContent = 'Add to Calendar';
                    actionRow.appendChild(icsLink);
                }

                const cancelBtn = document.createElement('button');
                cancelBtn.type = 'button';
                cancelBtn.className = 'btn btn-danger-soft btn-sm';
                cancelBtn.textContent = 'Cancel appointment';

                if (canStudentCancelBooking(b)) {
                    cancelBtn.addEventListener('click', () => openCancelConfirmModal(b));
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

    async function loadBookings(showToastOnRefresh = false) {
        const refreshBtn = $('#refreshBtn');
        if (refreshBtn) refreshBtn.disabled = true;
        try {
            const data = await api('/api/my-bookings');
            state.bookings = data.bookings || [];
            if (data.today) state.serverToday = data.today;
            if (typeof data.currentMinute === 'number') state.serverCurrentMinute = data.currentMinute;
            renderAppointments();
            if (showToastOnRefresh) toast('Appointments refreshed.');
        } catch (err) {
            if (err.status === 401) {
                showAuthGate();
            } else {
                toast(err.message, 'error');
            }
        } finally {
            if (refreshBtn) refreshBtn.disabled = false;
        }
    }

    function openCancelConfirmModal(b) {
        if (!canStudentCancelBooking(b)) {
            toast('Appointments can only be cancelled at least 2 hours before the scheduled time.', 'error');
            renderAppointments();
            return;
        }
        state.cancelTarget = b;
        const summary = $('#cancelTargetSummary');
        if (summary) {
            summary.innerHTML = '';
            const title = document.createElement('strong');
            title.textContent = `${b.consultationTitle} (${b.durationLabel})`;
            const sub = document.createElement('span');
            sub.className = 'muted small';
            sub.textContent = `${formatLongDate(b.date)} · ${b.label}`;
            summary.append(title, sub);
        }
        $('#cancelConfirmModal')?.classList.remove('hidden');
        document.body.classList.add('modal-open');
    }

    function closeCancelConfirmModal() {
        if (state.cancelling) return;
        state.cancelTarget = null;
        $('#cancelConfirmModal')?.classList.add('hidden');
        document.body.classList.remove('modal-open');
    }

    async function confirmCancelBooking() {
        if (state.cancelling || !state.cancelTarget) return;
        const b = state.cancelTarget;
        if (!canStudentCancelBooking(b)) {
            closeCancelConfirmModal();
            toast('Appointments can only be cancelled at least 2 hours before the scheduled time.', 'error');
            await loadBookings();
            return;
        }

        state.cancelling = true;
        const confirmBtn = $('#confirmCancelBookingBtn');
        const keepBtn = $('#keepBookingBtn');
        confirmBtn.disabled = true;
        if (keepBtn) keepBtn.disabled = true;
        confirmBtn.querySelector('.spinner')?.classList.remove('hidden');
        confirmBtn.querySelector('.btn-label').textContent = 'Cancelling…';

        try {
            await api(`/api/bookings/${b.id}/cancel`, { method: 'POST' });
            dismissCancelledNotice(b.id);
            state.cancelling = false;
            closeCancelConfirmModal();
            toast('Appointment cancelled.', 'success');
            await loadBookings();
        } catch (err) {
            state.cancelling = false;
            closeCancelConfirmModal();
            toast(err.message, 'error');
            await loadBookings();
        } finally {
            state.cancelling = false;
            confirmBtn.disabled = false;
            if (keepBtn) keepBtn.disabled = false;
            confirmBtn.querySelector('.spinner')?.classList.add('hidden');
            confirmBtn.querySelector('.btn-label').textContent = 'Yes, cancel';
        }
    }

    function showAuthGate() {
        state.student = null;
        $('#bootView')?.classList.add('hidden');
        $('#appointmentsView')?.classList.add('hidden');
        $('#accountBox')?.classList.add('hidden');
        $('#authGateView')?.classList.remove('hidden');
    }

    async function logout() {
        try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
        window.location.href = '/';
    }

    async function init() {
        setText('#year', new Date().getFullYear());

        document.querySelectorAll('.tab').forEach((tab) => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
                state.tab = tab.dataset.tab || 'all';
                renderAppointments();
            });
        });

        $('#refreshBtn')?.addEventListener('click', () => loadBookings(true));
        $('#logoutBtn')?.addEventListener('click', logout);

        $('#closeCancelConfirmBtn')?.addEventListener('click', closeCancelConfirmModal);
        $('#keepBookingBtn')?.addEventListener('click', closeCancelConfirmModal);
        $('#confirmCancelBookingBtn')?.addEventListener('click', confirmCancelBooking);
        $('#cancelConfirmModal')?.addEventListener('click', (e) => {
            if (e.target.id === 'cancelConfirmModal') closeCancelConfirmModal();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeCancelConfirmModal();
        });

        try {
            const [{ student }, config] = await Promise.all([
                api('/api/auth/me'),
                api('/api/config').catch(() => null),
            ]);
            state.config = config;
            if (!student) {
                showAuthGate();
                return;
            }
            state.student = student;
            $('#bootView')?.classList.add('hidden');
            $('#authGateView')?.classList.add('hidden');
            $('#accountBox')?.classList.remove('hidden');
            $('#appointmentsView')?.classList.remove('hidden');
            renderStudentHeader();
            await loadBookings();
        } catch {
            showAuthGate();
        }
    }

    init();
})();

