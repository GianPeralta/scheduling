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

    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
    const monthKey = (y, m) => `${y}-${pad(m + 1)}`;

    const state = {
        config: null,
        student: null,
        bookings: [],
        serverToday: '',
        serverCurrentMinute: 0,
        tab: 'all',
        cancelTarget: null,
        cancelling: false,
        rescheduleTarget: null,
        rescheduleSubmitting: false,
        reschedViewYear: 0,
        reschedViewMonth: 0,
        reschedMonthDays: {},
        reschedSelectedDate: null,
        reschedSelectedSlot: null,
        reschedDefenseDay: null,
        reschedActiveWindowLabel: null,
        reschedMonthRequest: 0,
        reschedSlotsRequest: 0,
        reschedLoadingSlotsKey: null,
        reschedLoadedSlotsKey: null,
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

    function formatShortWeekdayDate(str) {
        return utcDate(str).toLocaleDateString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            timeZone: 'UTC',
        });
    }

    function formatMinute(totalMinutes) {
        const h = Math.floor(totalMinutes / 60) % 24;
        const m = totalMinutes % 60;
        const suffix = h >= 12 ? 'PM' : 'AM';
        const hr = h % 12 === 0 ? 12 : h % 12;
        return `${hr}:${pad(m)} ${suffix}`;
    }

    function syncModalBodyLock() {
        const anyOpen = Array.from(document.querySelectorAll('.modal-backdrop'))
            .some((el) => !el.classList.contains('hidden'));
        document.body.classList.toggle('modal-open', anyOpen);
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

    function canStudentModifyBooking(b, flagField = 'canCancel') {
        if (b.status === 'cancelled') return false;
        const cutoff = state.config?.cancelCutoffMinutes || CANCEL_CUTOFF_MINUTES;
        if (minutesUntilBooking(b) < cutoff) return false;
        if (typeof b[flagField] === 'boolean') return b[flagField];
        return true;
    }

    function canStudentCancelBooking(b) {
        return canStudentModifyBooking(b, 'canCancel');
    }

    function canStudentRescheduleBooking(b) {
        return canStudentModifyBooking(b, 'canReschedule');
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

            if (cat !== 'cancelled' && (b.rescheduledCount > 0 || b.rescheduledAt)) {
                const reschedBadge = document.createElement('span');
                reschedBadge.className = 'badge violet';
                reschedBadge.textContent = b.rescheduledCount > 1
                    ? `Rescheduled ×${b.rescheduledCount}`
                    : 'Rescheduled';
                if (b.previousDate && b.previousLabel) {
                    reschedBadge.title = `Moved from ${formatShortWeekdayDate(b.previousDate)} · ${b.previousLabel}`;
                }
                badges.appendChild(reschedBadge);
            }

            top.appendChild(badges);

            if (b.reference) {
                const refCode = document.createElement('code');
                refCode.textContent = `#${b.reference}`;
                top.appendChild(refCode);
            }

            const dateStrong = document.createElement('strong');
            dateStrong.textContent = `${formatLongDate(b.date)} · ${b.label}`;

            item.append(top, dateStrong);

            if (cat !== 'cancelled' && b.previousDate && b.previousLabel) {
                const movedNote = document.createElement('p');
                movedNote.className = 'muted small my-booking-rescheduled-note';
                movedNote.textContent = `Rescheduled from ${formatShortWeekdayDate(b.previousDate)} · ${b.previousLabel}`;
                item.appendChild(movedNote);
            }

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

                if (b.outlookCalendarUrl) {
                    const outlookLink = document.createElement('a');
                    outlookLink.href = b.outlookCalendarUrl;
                    outlookLink.target = '_blank';
                    outlookLink.rel = 'noopener noreferrer';
                    outlookLink.className = 'btn btn-ghost btn-sm';
                    outlookLink.textContent = 'Add to Outlook Calendar';
                    actionRow.appendChild(outlookLink);
                }

                const icsHref = b.icsUrl || (b.id ? `/api/bookings/${b.id}/ics` : '');
                if (icsHref) {
                    const icsLink = document.createElement('a');
                    icsLink.href = icsHref;
                    icsLink.download = `consultation-${String(b.reference || 'invite').toLowerCase()}.ics`;
                    icsLink.className = 'btn btn-ghost btn-sm';
                    icsLink.textContent = 'Add to Calendar';
                    actionRow.appendChild(icsLink);
                }

                const reschedBtn = document.createElement('button');
                reschedBtn.type = 'button';
                reschedBtn.className = 'btn btn-primary-soft btn-sm';
                reschedBtn.textContent = 'Reschedule';

                const cancelBtn = document.createElement('button');
                cancelBtn.type = 'button';
                cancelBtn.className = 'btn btn-danger-soft btn-sm';
                cancelBtn.textContent = 'Cancel appointment';

                const canResched = canStudentRescheduleBooking(b);
                const canCancel = canStudentCancelBooking(b);

                if (canResched) {
                    reschedBtn.addEventListener('click', () => openRescheduleModal(b));
                } else {
                    reschedBtn.disabled = true;
                    reschedBtn.title = 'Appointments can only be rescheduled at least 2 hours before the scheduled time.';
                }

                if (canCancel) {
                    cancelBtn.addEventListener('click', () => openCancelConfirmModal(b));
                } else {
                    cancelBtn.disabled = true;
                    cancelBtn.title = 'Appointments can only be cancelled at least 2 hours before the scheduled time.';
                }

                if (!canResched || !canCancel) {
                    const cutoffNote = document.createElement('small');
                    cutoffNote.className = 'muted cancel-cutoff-note';
                    cutoffNote.textContent = 'Changes locked (less than 2 hours before schedule)';
                    actionRow.append(cutoffNote, reschedBtn, cancelBtn);
                } else {
                    actionRow.append(reschedBtn, cancelBtn);
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
        syncModalBodyLock();
    }

    function closeCancelConfirmModal() {
        if (state.cancelling) return;
        state.cancelTarget = null;
        $('#cancelConfirmModal')?.classList.add('hidden');
        syncModalBodyLock();
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
            window.SchedulerRealtime?.notifyLocal({
                type: 'booking_cancelled',
                bookingId: b.id,
                date: b.date,
                by: 'student',
            });
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

    function setRescheduleError(msg = '') {
        const el = $('#rescheduleError');
        if (!el) return;
        el.textContent = msg;
        el.classList.toggle('hidden', !msg);
    }

    function getReschedPurpose() {
        return state.rescheduleTarget?.consultationType || 'system';
    }

    function getReschedDefenseLevel() {
        return state.rescheduleTarget?.defenseLevel || state.student?.defenseLevel || 'capstone1';
    }

    function updateReschedSelectionPreview() {
        const textEl = $('#reschedSelectionText');
        const confirmBtn = $('#confirmRescheduleBtn');
        const ready = Boolean(state.rescheduleTarget && state.reschedSelectedDate && state.reschedSelectedSlot);

        if (textEl) {
            if (!state.reschedSelectedDate) {
                textEl.textContent = 'Select a new date & time above';
            } else if (!state.reschedSelectedSlot) {
                textEl.textContent = `${formatShortWeekdayDate(state.reschedSelectedDate)} — pick a new time`;
            } else {
                const s = state.reschedSelectedSlot;
                const timeText = s.isDropoff || !s.endLabel || String(s.label).includes('–')
                    ? s.label
                    : `${s.label} – ${s.endLabel}`;
                textEl.textContent = `${formatLongDate(state.reschedSelectedDate)} · ${timeText}`;
            }
        }

        if (confirmBtn) {
            confirmBtn.disabled = state.rescheduleSubmitting || !ready;
        }
    }

    function hideReschedCalendarDayNotice() {
        const notice = $('#reschedCalendarDayNotice');
        if (!notice) return;
        notice.textContent = '';
        notice.className = 'calendar-day-notice hidden';
    }

    function showReschedCalendarDayNotice(ds) {
        const notice = $('#reschedCalendarDayNotice');
        if (!notice || !ds) return;
        const info = state.reschedMonthDays[ds];
        if (!info) return;

        const label = formatShortWeekdayDate(ds);
        if (info.blocked) {
            notice.textContent = info.blockReason
                ? `${label}: Unavailable — ${info.blockReason}`
                : `${label}: Unavailable (blocked by instructor).`;
            notice.className = 'calendar-day-notice is-blocked';
        } else {
            notice.textContent = `${label}: Fully booked — please choose another highlighted day.`;
            notice.className = 'calendar-day-notice';
        }
    }

    function openRescheduleModal(b) {
        if (!canStudentRescheduleBooking(b)) {
            toast('Appointments can only be rescheduled at least 2 hours before the scheduled time.', 'error');
            renderAppointments();
            return;
        }

        state.rescheduleTarget = b;
        state.rescheduleSubmitting = false;
        state.reschedSelectedDate = null;
        state.reschedSelectedSlot = null;
        state.reschedDefenseDay = null;
        state.reschedActiveWindowLabel = null;
        state.reschedMonthDays = {};
        state.reschedLoadingSlotsKey = null;
        state.reschedLoadedSlotsKey = null;

        setText('#rescheduleCurrentSummary', `${formatLongDate(b.date)} · ${b.label}`);
        const badge = $('#reschedulePurposeBadge');
        if (badge) {
            badge.className = `badge ${PURPOSE_COLORS[b.consultationType] || 'teal'}`;
            badge.textContent = `${b.consultationTitle} · ${b.durationLabel}`;
        }

        const anchorDate = b.date || state.serverToday || state.config?.today || '2026-11-15';
        const [y, m] = anchorDate.split('-').map(Number);
        state.reschedViewYear = y || 2026;
        state.reschedViewMonth = (m || 11) - 1;

        setText('#reschedSlotsTitle', 'Select a date');
        setText('#reschedSlotsSubtitle', 'Pick an available day on the calendar.');
        const tabsEl = $('#reschedWindowTabs');
        if (tabsEl) {
            tabsEl.innerHTML = '';
            tabsEl.classList.add('hidden');
        }
        const listEl = $('#reschedSlotList');
        if (listEl) {
            listEl.innerHTML = '<div class="empty-state"><p>Pick a highlighted day on the calendar.</p></div>';
        }

        setRescheduleError('');
        hideReschedCalendarDayNotice();
        updateReschedSelectionPreview();

        $('#rescheduleModal')?.classList.remove('hidden');
        syncModalBodyLock();
        loadRescheduleMonth(b.date);
    }

    function closeRescheduleModal() {
        if (state.rescheduleSubmitting) return;
        state.rescheduleTarget = null;
        state.reschedSelectedDate = null;
        state.reschedSelectedSlot = null;
        state.reschedDefenseDay = null;
        state.reschedActiveWindowLabel = null;
        state.reschedLoadingSlotsKey = null;
        state.reschedLoadedSlotsKey = null;
        setRescheduleError('');
        hideReschedCalendarDayNotice();
        $('#rescheduleModal')?.classList.add('hidden');
        syncModalBodyLock();
    }

    async function loadRescheduleMonth(initialDateToSelect = null) {
        const b = state.rescheduleTarget;
        if (!b) return;
        const reqId = ++state.reschedMonthRequest;
        renderRescheduleCalendar(true);

        const purpose = getReschedPurpose();
        const level = getReschedDefenseLevel();
        const key = monthKey(state.reschedViewYear, state.reschedViewMonth);
        const query = purpose === 'defense'
            ? `/api/month?month=${key}&purpose=defense&level=${encodeURIComponent(level)}&excludeBookingId=${encodeURIComponent(b.id)}`
            : `/api/month?month=${key}&purpose=${encodeURIComponent(purpose)}&excludeBookingId=${encodeURIComponent(b.id)}`;

        try {
            const data = await api(query);
            if (reqId !== state.reschedMonthRequest || !state.rescheduleTarget || state.rescheduleTarget.id !== b.id) {
                return;
            }
            state.reschedMonthDays = data.days || {};
            renderRescheduleCalendar(false);

            if (initialDateToSelect && initialDateToSelect.slice(0, 7) === key) {
                const info = state.reschedMonthDays[initialDateToSelect];
                if (info?.bookable && !info.blocked && (info.open > 0 || initialDateToSelect === b.date)) {
                    await selectRescheduleDate(initialDateToSelect, false);
                }
            }
        } catch (err) {
            if (reqId !== state.reschedMonthRequest || !state.rescheduleTarget || state.rescheduleTarget.id !== b.id) {
                return;
            }
            state.reschedMonthDays = {};
            renderRescheduleCalendar(false);
            setRescheduleError(err.message || 'Could not load calendar availability.');
        }
    }

    function renderRescheduleCalendar(loading) {
        const y = state.reschedViewYear;
        const m = state.reschedViewMonth;
        const b = state.rescheduleTarget;
        const config = state.config || {
            today: state.serverToday || '2026-11-14',
            firstBookableDate: '2026-11-01',
            lastBookableDate: '2026-11-30',
        };

        setText('#reschedMonthLabel', new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-US', {
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
        }));

        const minMonthKey = (config.firstBookableDate || config.today || '2026-11-01').slice(0, 7);
        const lastKey = `${(config.lastBookableDate || '2026-12-31').slice(0, 4)}-12`;
        const current = monthKey(y, m);
        const prevBtn = $('#reschedPrevMonth');
        const nextBtn = $('#reschedNextMonth');
        if (prevBtn) prevBtn.disabled = loading || current <= minMonthKey;
        if (nextBtn) nextBtn.disabled = loading || current >= lastKey;

        const container = $('#reschedDays');
        if (!container) return;
        container.classList.toggle('loading', loading);
        container.innerHTML = '';

        const firstDow = new Date(Date.UTC(y, m, 1)).getUTCDay();
        const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

        for (let i = 0; i < firstDow; i++) {
            const spacer = document.createElement('span');
            spacer.className = 'day-spacer';
            container.appendChild(spacer);
        }

        const purpose = getReschedPurpose();
        const today = state.serverToday || config.today || '';

        for (let d = 1; d <= daysInMonth; d++) {
            const ds = dateStr(y, m, d);
            const info = state.reschedMonthDays[ds];
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'day';
            btn.textContent = d;
            btn.dataset.date = ds;

            const isCurrentBookingDay = Boolean(b && b.date === ds);
            if (isCurrentBookingDay) btn.classList.add('current-booking-day');

            if (ds === today) {
                btn.classList.add('today');
                btn.title = 'Today — bookings must be made at least 1 day before the scheduled day';
            }

            if (loading) {
                btn.disabled = true;
            } else if (m !== 10 || !info || !info.bookable) {
                if (ds === today) {
                    btn.setAttribute('aria-disabled', 'true');
                    btn.addEventListener('click', () => {
                        toast('Schedules must be at least 1 day before the consultation day.', 'info');
                    });
                } else {
                    btn.disabled = true;
                }
            } else if (info.blocked && info.open === 0) {
                btn.classList.add('full', 'blocked');
                btn.setAttribute('aria-disabled', 'true');
                btn.title = info.blockReason ? `Unavailable — ${info.blockReason}` : 'Unavailable';
                btn.addEventListener('click', () => showReschedCalendarDayNotice(ds));
            } else if (info.open === 0 && isCurrentBookingDay) {
                btn.classList.add('full');
                btn.title = 'Your current appointment date (no other slots open)';
                btn.addEventListener('click', () => selectRescheduleDate(ds, true));
            } else if (info.open === 0) {
                btn.classList.add('full');
                btn.setAttribute('aria-disabled', 'true');
                btn.title = 'Fully booked';
                btn.addEventListener('click', () => showReschedCalendarDayNotice(ds));
            } else {
                btn.classList.add('available');
                const openTitle = purpose === 'dropoff'
                    ? 'Open for manuscript drop-off'
                    : purpose === 'defense'
                        ? `${info.open} defense window${info.open === 1 ? '' : 's'} available`
                        : `${info.open} slot${info.open === 1 ? '' : 's'} open`;
                const currentSuffix = isCurrentBookingDay ? ' · Current date' : '';
                btn.title = (info.hasBlocks && info.blockReason ? `${openTitle} (${info.blockReason})` : openTitle) + currentSuffix;
                btn.addEventListener('click', () => selectRescheduleDate(ds, true));
            }

            if (ds === state.reschedSelectedDate) btn.classList.add('selected');
            container.appendChild(btn);
        }

        if (!loading) {
            hideReschedCalendarDayNotice();
        }
    }

    function changeRescheduleMonth(delta) {
        state.reschedViewMonth += delta;
        if (state.reschedViewMonth < 0) {
            state.reschedViewMonth = 11;
            state.reschedViewYear -= 1;
        }
        if (state.reschedViewMonth > 11) {
            state.reschedViewMonth = 0;
            state.reschedViewYear += 1;
        }
        loadRescheduleMonth();
    }

    async function selectRescheduleDate(ds, userInitiated = true) {
        const b = state.rescheduleTarget;
        if (!b || !ds) return;

        const reqId = ++state.reschedSlotsRequest;
        state.reschedSelectedDate = ds;
        state.reschedSelectedSlot = null;
        state.reschedDefenseDay = null;
        if (userInitiated) {
            state.reschedActiveWindowLabel = null;
            setRescheduleError('');
        }
        hideReschedCalendarDayNotice();
        updateReschedSelectionPreview();

        document.querySelectorAll('#reschedDays .day').forEach((el) => {
            el.classList.toggle('selected', el.dataset.date === ds);
        });

        setText('#reschedSlotsTitle', formatLongDate(ds));
        setText('#reschedSlotsSubtitle', 'Loading available times…');

        const tabsEl = $('#reschedWindowTabs');
        if (tabsEl) {
            tabsEl.innerHTML = '';
            tabsEl.classList.add('hidden');
        }
        const listEl = $('#reschedSlotList');
        if (listEl) {
            listEl.innerHTML = '';
            for (let i = 0; i < 3; i++) {
                const sk = document.createElement('div');
                sk.className = 'slot skeleton';
                listEl.appendChild(sk);
            }
        }

        const purpose = getReschedPurpose();
        const level = getReschedDefenseLevel();
        state.reschedLoadingSlotsKey = `${ds}|${purpose}|${level}`;

        try {
            const url = purpose === 'defense'
                ? `/api/slots?date=${ds}&purpose=defense&level=${encodeURIComponent(level)}&excludeBookingId=${encodeURIComponent(b.id)}`
                : `/api/slots?date=${ds}&purpose=${encodeURIComponent(purpose)}&excludeBookingId=${encodeURIComponent(b.id)}`;
            const data = await api(url);
            if (reqId !== state.reschedSlotsRequest || !state.rescheduleTarget || state.rescheduleTarget.id !== b.id) {
                return;
            }
            state.reschedLoadingSlotsKey = null;
            state.reschedLoadedSlotsKey = `${ds}|${purpose}|${level}`;

            if (purpose === 'defense') {
                state.reschedDefenseDay = data;
                renderRescheduleDefenseSlots(data);
            } else {
                renderRescheduleSlots(data.slots || [], data);
            }
        } catch (err) {
            if (reqId !== state.reschedSlotsRequest || !state.rescheduleTarget || state.rescheduleTarget.id !== b.id) {
                return;
            }
            state.reschedLoadingSlotsKey = null;
            setText('#reschedSlotsSubtitle', err.message || 'Could not load time slots.');
            if (listEl) listEl.innerHTML = '<div class="empty-state"><p>Could not load available slots.</p></div>';
        }
    }

    function createRescheduleSlotButton(slot, index) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'slot';
        btn.style.animationDelay = `${Math.min(index, 8) * 35}ms`;

        const time = document.createElement('span');
        time.className = 'slot-time';
        time.textContent = slot.label;

        const range = document.createElement('span');
        range.className = 'slot-range';
        if (slot.currentBooking) {
            range.textContent = 'Current slot';
        } else if (!slot.available) {
            if (slot.blocked) {
                range.textContent = slot.blockReason ? `Unavailable — ${slot.blockReason}` : 'Unavailable';
            } else {
                range.textContent = 'Booked';
            }
        } else if (slot.isDropoff) {
            range.textContent = 'Drop-off window';
        } else {
            range.textContent = `until ${slot.endLabel}`;
        }
        btn.append(time, range);

        if (slot.currentBooking) {
            btn.disabled = true;
            btn.classList.add('slot-current');
        } else if (!slot.available) {
            btn.disabled = true;
            btn.classList.add('taken');
        } else {
            if (state.reschedSelectedSlot && state.reschedSelectedSlot.startMinute === slot.startMinute) {
                btn.classList.add('selected');
            }
            btn.addEventListener('click', () => {
                state.reschedSelectedSlot = slot;
                document.querySelectorAll('#reschedSlotList .slot.selected').forEach((el) => el.classList.remove('selected'));
                btn.classList.add('selected');
                setRescheduleError('');
                updateReschedSelectionPreview();
            });
        }
        return btn;
    }

    function renderRescheduleSlots(slots, data = null) {
        const list = $('#reschedSlotList');
        const tabsEl = $('#reschedWindowTabs');
        if (!list) return;
        list.innerHTML = '';
        if (tabsEl) {
            tabsEl.innerHTML = '';
            tabsEl.classList.add('hidden');
        }

        const openCount = slots.filter((s) => s.available).length;
        const b = state.rescheduleTarget;
        const purpose = getReschedPurpose();
        const hasBlocks = Boolean(data?.blocked || (data?.blocks && data.blocks.length > 0));

        if (!openCount && hasBlocks) {
            setText('#reschedSlotsSubtitle', data?.blockReason
                ? `Unavailable — ${data.blockReason}`
                : 'Unavailable on this date.');
        } else if (purpose === 'dropoff') {
            setText('#reschedSlotsSubtitle', openCount
                ? 'Select the new drop-off window below'
                : 'Drop-off is not available on this day.');
        } else {
            setText('#reschedSlotsSubtitle', openCount
                ? `${openCount} of ${slots.length} ${slots.length === 1 ? 'slot' : 'slots'} available · ${b?.durationLabel || 'consultation'} each`
                : 'No other open slots on this day.');
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

        if (windows.length > 1 && tabsEl && purpose !== 'dropoff') {
            if (!state.reschedActiveWindowLabel || !byWindow.has(state.reschedActiveWindowLabel)) {
                state.reschedActiveWindowLabel =
                    windows.find((w) => byWindow.get(w).some((s) => s.available)) || windows[0];
            }

            tabsEl.classList.remove('hidden');
            windows.forEach((w) => {
                const winSlots = byWindow.get(w);
                const winOpen = winSlots.filter((s) => s.available).length;
                const tab = document.createElement('button');
                tab.type = 'button';
                tab.className = 'window-tab'
                    + (w === state.reschedActiveWindowLabel ? ' active' : '')
                    + (winOpen === 0 ? ' window-tab-empty' : '');
                tab.textContent = `${w} (${winOpen})`;
                tab.addEventListener('click', () => {
                    if (state.reschedActiveWindowLabel === w) return;
                    state.reschedActiveWindowLabel = w;
                    renderRescheduleSlots(slots, data);
                    list.scrollTop = 0;
                });
                tabsEl.appendChild(tab);
            });

            const activeSlots = byWindow.get(state.reschedActiveWindowLabel) || [];
            activeSlots.forEach((slot, i) => list.appendChild(createRescheduleSlotButton(slot, i)));
            return;
        }

        slots.forEach((slot, i) => {
            list.appendChild(createRescheduleSlotButton(slot, i));
        });
    }

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
            if (hourNum >= 7 && hourNum <= 11) {
                candidates.push(amMin, pmMin);
            } else {
                candidates.push(pmMin, amMin);
            }
        } else {
            return { error: 'Please enter a valid hour (e.g. 11:30 AM or 2:30 PM).' };
        }

        const inWindow = candidates.find((m) =>
            windows.some((w) => m >= w.startMinute && m + durationMinutes <= w.endMinute)
        );
        const touchWindow = candidates.find((m) =>
            windows.some((w) => m >= w.startMinute && m < w.endMinute)
        );
        const chosen = inWindow ?? touchWindow ?? candidates[0];
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

        if (data.currentStartMinute !== null && data.currentStartMinute !== undefined && startMinute === Number(data.currentStartMinute)) {
            return {
                ok: false,
                startMinute,
                endMinute,
                error: 'This is already your current appointment time. Please pick a different time.',
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

        const blockConflict = (data.blocks || []).find((b) => {
            const bStart = b.isFullDay ? 0 : b.startMinute;
            const bEnd = b.isFullDay ? 1440 : b.endMinute;
            return startMinute < bEnd && endMinute > bStart;
        });
        if (blockConflict) {
            const reasonSuffix = (blockConflict.reason || data.blockReason)
                ? ` — ${blockConflict.reason || data.blockReason}`
                : '';
            return {
                ok: false,
                startMinute,
                endMinute,
                error: `${formatMinute(startMinute)} – ${formatMinute(endMinute)} falls within a time blocked by the instructor (${blockConflict.label}${reasonSuffix}). Please choose another time.`,
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

    function renderRescheduleDefenseSlots(data) {
        const list = $('#reschedSlotList');
        const tabsEl = $('#reschedWindowTabs');
        if (!list) return;
        list.innerHTML = '';
        if (tabsEl) {
            tabsEl.innerHTML = '';
            tabsEl.classList.add('hidden');
        }

        const levelKey = data.level || getReschedDefenseLevel();
        const levelInfo = DEFENSE_LEVELS[levelKey] || DEFENSE_LEVELS.capstone1;
        const duration = data.durationMinutes || levelInfo.durationMinutes;
        const windows = data.windows || [];
        const currentStart = data.currentStartMinute !== null && data.currentStartMinute !== undefined
            ? Number(data.currentStartMinute)
            : null;
        const fittingGaps = [];
        const busyLabels = [];
        windows.forEach((w) => {
            (w.busy || []).forEach((b) => busyLabels.push(b.label));
            (w.free || []).forEach((f) => {
                if (f.fits && (currentStart === null || f.latestStartMinute > f.earliestStartMinute || f.earliestStartMinute !== currentStart)) {
                    fittingGaps.push({ ...f, windowLabel: w.label });
                }
            });
        });

        if (fittingGaps.length) {
            setText('#reschedSlotsSubtitle', `Open: ${fittingGaps.map((f) => f.label).join(' · ')}`);
        } else if (data.blocked || (data.blocks && data.blocks.length > 0)) {
            setText('#reschedSlotsSubtitle', data.blockReason
                ? `Unavailable — ${data.blockReason}`
                : 'Unavailable on this date.');
        } else {
            setText('#reschedSlotsSubtitle', `No other ${levelInfo.durationLabel} defense slot open on this day.`);
        }

        if (!fittingGaps.length) {
            list.innerHTML = '<div class="empty-state"><p>No other available time on this day.</p></div>';
            return;
        }

        const suggestions = [];
        const seenStarts = new Set();
        fittingGaps.forEach((f) => {
            for (let m = f.earliestStartMinute; m <= f.latestStartMinute; m += 30) {
                if (m !== currentStart && !seenStarts.has(m)) {
                    seenStarts.add(m);
                    suggestions.push(m);
                }
            }
            if (f.latestStartMinute !== currentStart && !seenStarts.has(f.latestStartMinute)) {
                seenStarts.add(f.latestStartMinute);
                suggestions.push(f.latestStartMinute);
            }
        });

        const inputCard = document.createElement('div');
        inputCard.className = 'defense-input-card';

        if (currentStart !== null) {
            const curEl = document.createElement('div');
            curEl.className = 'defense-window-busy';
            curEl.textContent = `Current slot: ${formatMinute(currentStart)} – ${formatMinute(currentStart + duration)} (choose a different start time)`;
            inputCard.appendChild(curEl);
        }

        if (busyLabels.length) {
            const busyEl = document.createElement('div');
            busyEl.className = 'defense-window-busy';
            busyEl.textContent = `Other bookings: ${busyLabels.join(', ')}`;
            inputCard.appendChild(busyEl);
        }

        const label = document.createElement('label');
        label.className = 'field';
        const labelSpan = document.createElement('span');
        labelSpan.textContent = `New start time (${levelInfo.durationLabel})`;

        const timeInput = document.createElement('input');
        timeInput.type = 'text';
        timeInput.id = 'reschedDefenseStartInput';
        const firstSuggested = suggestions[0] ?? fittingGaps[0].earliestStartMinute;
        timeInput.placeholder = `e.g. ${formatMinute(firstSuggested)} or 2:30`;
        timeInput.autocomplete = 'off';

        label.append(labelSpan, timeInput);
        inputCard.appendChild(label);

        if (suggestions.length) {
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
                    applyTypedDefenseTime(timeInput.value);
                });
                chipsRow.appendChild(chip);
            });
            inputCard.appendChild(chipsRow);
        }

        const feedback = document.createElement('div');
        feedback.className = 'defense-time-feedback hidden';
        feedback.id = 'reschedDefenseTimeFeedback';
        inputCard.appendChild(feedback);

        function applyTypedDefenseTime(rawValue) {
            const raw = String(rawValue || '').trim();
            inputCard.querySelectorAll('.defense-time-chip').forEach((c) => c.classList.remove('active'));
            if (!raw) {
                state.reschedSelectedSlot = null;
                feedback.className = 'defense-time-feedback hidden';
                feedback.textContent = '';
                timeInput.classList.remove('input-invalid');
                updateReschedSelectionPreview();
                return;
            }

            const parsed = parseTypedDefenseTime(raw, windows, duration);
            if (parsed.error) {
                state.reschedSelectedSlot = null;
                feedback.className = 'defense-time-feedback is-error';
                feedback.textContent = parsed.error;
                timeInput.classList.add('input-invalid');
                updateReschedSelectionPreview();
                return;
            }

            const check = validateDefenseStartMinute(parsed.startMinute, data);
            if (!check.ok) {
                state.reschedSelectedSlot = null;
                feedback.className = 'defense-time-feedback is-error';
                feedback.textContent = check.error;
                timeInput.classList.add('input-invalid');
                updateReschedSelectionPreview();
                return;
            }

            timeInput.classList.remove('input-invalid');
            const matchingChip = inputCard.querySelector(`.defense-time-chip[data-minute="${check.startMinute}"]`);
            if (matchingChip) matchingChip.classList.add('active');

            const timeLabel = `${formatMinute(check.startMinute)} – ${formatMinute(check.endMinute)}`;
            state.reschedSelectedSlot = {
                startMinute: check.startMinute,
                endMinute: check.endMinute,
                durationMinutes: duration,
                isDropoff: false,
                label: timeLabel,
                endLabel: formatMinute(check.endMinute),
                windowLabel: check.windowLabel,
            };
            feedback.className = 'defense-time-feedback is-valid';
            feedback.textContent = `Available: ${timeLabel} (${levelInfo.durationLabel})`;
            setRescheduleError('');
            updateReschedSelectionPreview();
        }

        timeInput.addEventListener('input', () => applyTypedDefenseTime(timeInput.value));
        timeInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                applyTypedDefenseTime(timeInput.value);
                if (state.reschedSelectedSlot && !state.rescheduleSubmitting) {
                    confirmReschedule();
                }
            }
        });

        list.appendChild(inputCard);
    }

    async function refreshRescheduleAvailability() {
        const b = state.rescheduleTarget;
        if (!b || state.rescheduleSubmitting) return;
        const selectedDate = state.reschedSelectedDate;
        await loadRescheduleMonth(null);
        if (state.rescheduleTarget && state.rescheduleTarget.id === b.id && selectedDate) {
            await selectRescheduleDate(selectedDate, false);
        }
    }

    async function confirmReschedule() {
        if (state.rescheduleSubmitting || !state.rescheduleTarget || !state.reschedSelectedDate || !state.reschedSelectedSlot) {
            return;
        }
        const b = state.rescheduleTarget;
        if (!canStudentRescheduleBooking(b)) {
            setRescheduleError('Appointments can only be rescheduled at least 2 hours before the scheduled time.');
            await loadBookings(false);
            return;
        }

        const targetDate = state.reschedSelectedDate;
        const targetStartMinute = state.reschedSelectedSlot.startMinute;

        state.rescheduleSubmitting = true;
        const confirmBtn = $('#confirmRescheduleBtn');
        const keepBtn = $('#keepCurrentTimeBtn');
        const closeBtn = $('#closeRescheduleModalBtn');
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.querySelector('.spinner')?.classList.remove('hidden');
            const labelEl = confirmBtn.querySelector('.btn-label');
            if (labelEl) labelEl.textContent = 'Swapping slot…';
        }
        if (keepBtn) keepBtn.disabled = true;
        if (closeBtn) closeBtn.disabled = true;
        setRescheduleError('');

        try {
            await api(`/api/bookings/${encodeURIComponent(b.id)}/reschedule`, {
                method: 'POST',
                body: JSON.stringify({
                    date: targetDate,
                    startMinute: targetStartMinute,
                }),
            });
            state.rescheduleSubmitting = false;
            closeRescheduleModal();
            toast('Appointment rescheduled! Your new slot is confirmed.', 'success');
            await loadBookings(false);
        } catch (err) {
            state.rescheduleSubmitting = false;
            setRescheduleError(err.message || 'Could not reschedule appointment. Your current slot is still safe.');
            if (err.status === 409) {
                await refreshRescheduleAvailability();
            } else if (err.code === 'RESCHEDULE_WINDOW_PASSED') {
                await loadBookings(false);
            }
        } finally {
            state.rescheduleSubmitting = false;
            if (keepBtn) keepBtn.disabled = false;
            if (closeBtn) closeBtn.disabled = false;
            if (confirmBtn) {
                confirmBtn.querySelector('.spinner')?.classList.add('hidden');
                const labelEl = confirmBtn.querySelector('.btn-label');
                if (labelEl) labelEl.textContent = 'Confirm reschedule';
            }
            updateReschedSelectionPreview();
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

        $('#logoutBtn')?.addEventListener('click', logout);

        $('#closeCancelConfirmBtn')?.addEventListener('click', closeCancelConfirmModal);
        $('#keepBookingBtn')?.addEventListener('click', closeCancelConfirmModal);
        $('#confirmCancelBookingBtn')?.addEventListener('click', confirmCancelBooking);
        $('#cancelConfirmModal')?.addEventListener('click', (e) => {
            if (e.target.id === 'cancelConfirmModal') closeCancelConfirmModal();
        });

        $('#closeRescheduleModalBtn')?.addEventListener('click', closeRescheduleModal);
        $('#keepCurrentTimeBtn')?.addEventListener('click', closeRescheduleModal);
        $('#confirmRescheduleBtn')?.addEventListener('click', confirmReschedule);
        $('#reschedPrevMonth')?.addEventListener('click', () => changeRescheduleMonth(-1));
        $('#reschedNextMonth')?.addEventListener('click', () => changeRescheduleMonth(1));
        $('#rescheduleModal')?.addEventListener('click', (e) => {
            if (e.target.id === 'rescheduleModal') closeRescheduleModal();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeCancelConfirmModal();
                closeRescheduleModal();
            }
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
            window.SchedulerRealtime?.init(state.config);
            window.SchedulerRealtime?.subscribe(() => {
                if (!state.student) return;
                loadBookings(false);
                refreshRescheduleAvailability();
            });
            await loadBookings();
        } catch {
            showAuthGate();
        }
    }

    init();
})();

