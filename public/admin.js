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
        blockedSchedules: [],
        config: null,
        today: '',
        currentHour: 0,
        currentMinute: 0,
        tab: 'upcoming',
        search: '',
        loggingIn: false,
        loadReqId: 0,
        cancelTarget: null,
        cancelling: false,
        blockScope: 'full', // 'full' | 'time'
        blocking: false,
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
        state.blockedSchedules = [];
        showLogin();
    }

    /* ---------------- data ---------------- */
    async function ensureConfig() {
        if (state.config) return state.config;
        try {
            const res = await fetch('/api/config');
            if (res.ok) state.config = await res.json();
        } catch { /* ignore */ }
        return state.config;
    }

    async function loadBookings() {
        const reqId = ++state.loadReqId;
        const refreshBtn = $('#refreshBtn');
        if (refreshBtn) refreshBtn.disabled = true;
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
    const isActiveBlock = (blk) => {
        if (!state.today) return true;
        return blk.date > state.today || (blk.date === state.today && (blk.endMinute ?? 1440) > state.currentMinute);
    };

    /* ---------------- block date / time modal ---------------- */
    function setBlockFormError(msg) {
        const errEl = $('#blockFormError');
        if (!errEl) return;
        errEl.textContent = msg || '';
        errEl.classList.toggle('hidden', !msg);
    }

    function setBlockScope(scope) {
        state.blockScope = scope === 'time' ? 'time' : 'full';
        const isTime = state.blockScope === 'time';
        document.querySelectorAll('input[name="blockScope"]').forEach((r) => {
            r.checked = r.value === state.blockScope;
        });
        $('#blockTimeFields')?.classList.toggle('hidden', !isTime);
        $('#blockEndDateField')?.classList.toggle('hidden', isTime);
        $('#blockDateGrid')?.classList.toggle('single-col', isTime);
        const dateLabel = $('#blockDateLabel');
        if (dateLabel) dateLabel.textContent = isTime ? 'Date' : 'Start date';
        setBlockFormError('');
        updateBlockWindowChips();
        updateBlockConflictHint();
    }

    function updateBlockWindowChips() {
        const wrap = $('#blockWindowChipsWrap');
        const container = $('#blockWindowChips');
        if (!wrap || !container) return;
        container.innerHTML = '';

        const dateVal = $('#blockDateInput')?.value;
        if (!dateVal || !/^\d{4}-\d{2}-\d{2}$/.test(dateVal) || state.blockScope !== 'time') {
            wrap.classList.add('hidden');
            return;
        }

        const dow = utcDate(dateVal).getUTCDay();
        const consultWins = state.config?.consultationWindowsByDay?.[dow] || [];
        const defenseWins = state.config?.defenseWindowsByDay?.[dow] || [];

        const chips = [];
        consultWins.forEach((w) => {
            chips.push({ label: `Consultation: ${w.label}`, startMinute: w.startMinute, endMinute: w.endMinute });
        });
        defenseWins.forEach((w) => {
            if (!chips.some((c) => c.startMinute === w.startMinute && c.endMinute === w.endMinute)) {
                chips.push({ label: `Defense: ${w.label}`, startMinute: w.startMinute, endMinute: w.endMinute });
            }
        });

        if (!chips.length) {
            wrap.classList.add('hidden');
            return;
        }

        chips.forEach((c) => {
            const btn = el('button', 'reason-chip', c.label);
            btn.type = 'button';
            btn.addEventListener('click', () => {
                const startEl = $('#blockStartTimeInput');
                const endEl = $('#blockEndTimeInput');
                if (startEl) startEl.value = minuteToTimeVal(c.startMinute);
                if (endEl) endEl.value = minuteToTimeVal(c.endMinute);
                setBlockFormError('');
                updateBlockConflictHint();
            });
            container.appendChild(btn);
        });
        wrap.classList.remove('hidden');
    }

    function getConflictingBookingsForForm() {
        const dateVal = ($('#blockDateInput')?.value || '').trim();
        if (!dateVal || !/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) return [];
        const isFullDay = state.blockScope === 'full';
        const rawEnd = ($('#blockEndDateInput')?.value || '').trim();
        const endDate = (!isFullDay || !rawEnd || rawEnd < dateVal) ? dateVal : rawEnd;

        const bStart = isFullDay ? 0 : timeValToMinute($('#blockStartTimeInput')?.value);
        const bEnd = isFullDay ? 1440 : timeValToMinute($('#blockEndTimeInput')?.value);
        if (!isFullDay && (bStart === null || bEnd === null || bStart >= bEnd)) return [];

        return state.bookings.filter((b) => {
            if (isCancelled(b)) return false;
            if (b.date < dateVal || b.date > endDate) return false;
            if (isFullDay) return true;
            const rs = b.startMinute ?? b.hour * 60;
            const re = b.endMinute ?? (b.hour + 1) * 60;
            return rs < bEnd && re > bStart;
        });
    }

    function updateBlockConflictHint() {
        const hintEl = $('#blockConflictHint');
        if (!hintEl) return;
        const conflicts = getConflictingBookingsForForm();
        if (conflicts.length > 0) {
            hintEl.textContent = `${conflicts.length} scheduled appointment${conflicts.length === 1 ? '' : 's'} fall within this date/time and will be cancelled if checked.`;
            hintEl.classList.add('conflict-active');
        } else {
            hintEl.textContent = 'No existing scheduled appointments conflict with this date/time.';
            hintEl.classList.remove('conflict-active');
        }
    }

    function openBlockModal(defaultDate = '') {
        const startDefault = defaultDate || (state.today ? addDays(state.today, 1) : new Date().toISOString().slice(0, 10));
        const dateInput = $('#blockDateInput');
        const endDateInput = $('#blockEndDateInput');
        if (dateInput) {
            dateInput.value = startDefault;
            if (state.today) dateInput.min = state.today;
        }
        if (endDateInput) {
            endDateInput.value = '';
            if (state.today) endDateInput.min = startDefault;
        }
        if ($('#blockReasonInput')) $('#blockReasonInput').value = '';
        if ($('#blockCancelExistingInput')) $('#blockCancelExistingInput').checked = true;
        setBlockScope('full');
        setBlockFormError('');
        $('#blockModal')?.classList.remove('hidden');
        if (window.matchMedia('(hover: hover)').matches) {
            setTimeout(() => dateInput?.focus(), 40);
        }
    }

    function closeBlockModal() {
        if (state.blocking) return;
        $('#blockModal')?.classList.add('hidden');
        setBlockFormError('');
    }

    async function submitBlockSchedule(e) {
        e.preventDefault();
        if (state.blocking) return;
        setBlockFormError('');

        const date = ($('#blockDateInput')?.value || '').trim();
        const isFullDay = state.blockScope === 'full';
        const rawEndDate = ($('#blockEndDateInput')?.value || '').trim();
        const endDate = isFullDay && rawEndDate ? rawEndDate : date;
        const reason = ($('#blockReasonInput')?.value || '').trim();
        const cancelExisting = Boolean($('#blockCancelExistingInput')?.checked);

        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            setBlockFormError('Please select a date to block.');
            $('#blockDateInput')?.focus();
            return;
        }
        if (endDate < date) {
            setBlockFormError('End date must be on or after the start date.');
            $('#blockEndDateInput')?.focus();
            return;
        }

        let startMinute = null;
        let endMinute = null;
        if (!isFullDay) {
            startMinute = timeValToMinute($('#blockStartTimeInput')?.value);
            endMinute = timeValToMinute($('#blockEndTimeInput')?.value);
            if (startMinute === null || endMinute === null || startMinute >= endMinute) {
                setBlockFormError('Please enter a valid start and end time (end time must be after start time).');
                return;
            }
        }

        state.blocking = true;
        const confirmBtn = $('#confirmBlockBtn');
        const cancelBtn = $('#cancelBlockModalBtn');
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.querySelector('.spinner')?.classList.remove('hidden');
            confirmBtn.querySelector('.btn-label').textContent = 'Blocking…';
        }
        if (cancelBtn) cancelBtn.disabled = true;

        try {
            const res = await api('/api/admin/blocks', {
                method: 'POST',
                body: JSON.stringify({
                    date,
                    endDate,
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

            state.blocking = false;
            closeBlockModal();
            render();

            const cancelledMsg = cancelledList.length
                ? ` (${cancelledList.length} existing appointment${cancelledList.length === 1 ? '' : 's'} cancelled)`
                : '';
            toast(
                `${addedBlocks.length > 1 ? `${addedBlocks.length} dates` : isFullDay ? 'Date' : 'Time range'} marked unavailable${cancelledMsg}.`,
                'success'
            );
        } catch (err) {
            setBlockFormError(err.message);
        } finally {
            state.blocking = false;
            if (confirmBtn) {
                confirmBtn.disabled = false;
                confirmBtn.querySelector('.spinner')?.classList.add('hidden');
                confirmBtn.querySelector('.btn-label').textContent = 'Block schedule';
            }
            if (cancelBtn) cancelBtn.disabled = false;
        }
    }

    async function unblockSchedule(blk, btn) {
        if (btn) btn.disabled = true;
        try {
            await api(`/api/admin/blocks/${blk.id}`, { method: 'DELETE' });
            state.blockedSchedules = state.blockedSchedules.filter((x) => x.id !== blk.id);
            render();
            toast(`Unblocked ${shortDate(blk.date)} (${blk.label}).`, 'success');
        } catch (err) {
            if (btn) btn.disabled = false;
            toast(err.message, 'error');
        }
    }

    function renderActiveBlocksBanner() {
        const card = $('#activeBlocksCard');
        const listEl = $('#activeBlocksList');
        const countBlockedEl = $('#countBlocked');
        const activeBlocks = state.blockedSchedules.filter(isActiveBlock);
        if (countBlockedEl) countBlockedEl.textContent = activeBlocks.length;

        if (!card || !listEl) return;
        listEl.innerHTML = '';
        if (!activeBlocks.length) {
            card.classList.add('hidden');
            return;
        }

        activeBlocks.forEach((blk) => {
            const pill = el('div', 'blocked-pill');
            const info = el('div', 'blocked-pill-info');
            info.appendChild(el('strong', '', `${shortDate(blk.date)} · ${blk.label}`));
            if (blk.reason) {
                info.appendChild(el('span', 'muted small', `— ${blk.reason}`));
            }
            const removeBtn = el('button', 'blocked-pill-remove', 'Unblock');
            removeBtn.type = 'button';
            removeBtn.title = 'Allow students to schedule during this date/time again';
            removeBtn.addEventListener('click', () => unblockSchedule(blk, removeBtn));
            pill.append(info, removeBtn);
            listEl.appendChild(pill);
        });
        card.classList.remove('hidden');
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
        if (window.matchMedia('(hover: hover)').matches) {
            setTimeout(() => input?.focus(), 40);
        }
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
        if (b.defenseLevelLabel && b.defenseLevelLabel.toLowerCase().includes(q)) return true;
        if (b.instructorRole && b.instructorRole.toLowerCase().includes(q)) return true;
        if (Array.isArray(b.members) && b.members.some((m) => m.toLowerCase().includes(q))) return true;
        if (b.reason.toLowerCase().includes(q)) return true;
        if (b.cancellationReason && b.cancellationReason.toLowerCase().includes(q)) return true;
        if (b.reference.toLowerCase().includes(q)) return true;
        if (b.studentEmail && b.studentEmail.toLowerCase().includes(q)) return true;
        return false;
    }

    function matchesBlockSearch(blk, q) {
        if (!q) return true;
        if (blk.date.toLowerCase().includes(q)) return true;
        if (longDate(blk.date).toLowerCase().includes(q)) return true;
        if (blk.label && blk.label.toLowerCase().includes(q)) return true;
        if (blk.reason && blk.reason.toLowerCase().includes(q)) return true;
        return false;
    }

    function renderBlockedTab(container, q) {
        const blocks = state.blockedSchedules
            .filter((blk) => matchesBlockSearch(blk, q))
            .slice()
            .sort((a, b) => a.date.localeCompare(b.date) || (a.startMinute ?? 0) - (b.startMinute ?? 0));

        if (!blocks.length) {
            const empty = el('div', 'empty-state');
            empty.style.marginTop = '12px';
            empty.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/></svg>';
            empty.appendChild(el('p', '', q ? 'No blocked schedules match your search.' : 'No blocked dates or times.'));
            const addBtn = el('button', 'btn btn-primary btn-sm', 'Block a Date or Time');
            addBtn.type = 'button';
            addBtn.addEventListener('click', () => openBlockModal());
            empty.appendChild(addBtn);
            container.appendChild(empty);
            return;
        }

        const groups = new Map();
        blocks.forEach((blk) => {
            if (!groups.has(blk.date)) groups.set(blk.date, []);
            groups.get(blk.date).push(blk);
        });

        let i = 0;
        groups.forEach((items, date) => {
            const group = el('div', 'date-group');
            const title = el('div', 'date-group-title', longDate(date));
            if (date === state.today) title.appendChild(el('span', 'badge teal', 'Today'));
            else if (date === addDays(state.today, 1)) title.appendChild(el('span', 'badge sky', 'Tomorrow'));
            else if (date < state.today) title.appendChild(el('span', 'badge muted-badge', 'Past'));
            group.appendChild(title);

            items.forEach((blk) => {
                const card = el('div', 'booking booking-blocked');
                card.style.animationDelay = `${Math.min(i++, 12) * 25}ms`;

                const time = el('div', 'booking-time booking-time-blocked');
                if (blk.isFullDay) {
                    time.appendChild(el('strong', '', 'All Day'));
                    time.appendChild(el('span', '', 'Unavailable'));
                } else {
                    const [start, end] = blk.label.split(' – ');
                    time.appendChild(el('strong', '', start));
                    time.appendChild(el('span', '', `to ${end}`));
                }

                const body = el('div', 'booking-body');
                const header = el('div', 'booking-name');
                header.appendChild(el('span', 'booking-title', blk.isFullDay ? 'Entire Day Blocked' : `Blocked Time (${blk.label})`));
                header.appendChild(el('span', 'badge danger', 'Non-schedulable'));
                body.appendChild(header);

                body.appendChild(
                    el(
                        'p',
                        'booking-reason',
                        blk.reason || 'Students cannot schedule consultations, drop-offs, or defenses during this time.'
                    )
                );

                const actions = el('div', 'booking-actions');
                const unblockBtn = el('button', 'btn btn-ghost btn-sm', 'Unblock');
                unblockBtn.type = 'button';
                unblockBtn.addEventListener('click', () => unblockSchedule(blk, unblockBtn));
                actions.appendChild(unblockBtn);

                card.append(time, body, actions);
                group.appendChild(card);
            });

            container.appendChild(group);
        });
    }

    /* ---------------- render ---------------- */
    function render() {
        renderActiveBlocksBanner();

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
        const container = $('#bookingList');
        container.innerHTML = '';

        if (state.tab === 'blocked') {
            renderBlockedTab(container, q);
            return;
        }

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
                }

                const typeBadge = b.consultationType === 'defense'
                    ? { label: `${b.consultationTitle || 'Defense'} · ${b.durationLabel || ''}`, cls: 'rose' }
                    : TYPE_BADGES[b.consultationType] || {
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

    // Block Date / Time modal bindings
    $('#openBlockModalBtn')?.addEventListener('click', () => openBlockModal());
    $('#addAnotherBlockBtn')?.addEventListener('click', () => openBlockModal());
    $('#closeBlockModalBtn')?.addEventListener('click', closeBlockModal);
    $('#cancelBlockModalBtn')?.addEventListener('click', closeBlockModal);
    $('#blockModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'blockModal') closeBlockModal();
    });
    document.querySelectorAll('input[name="blockScope"]').forEach((r) => {
        r.addEventListener('change', (e) => setBlockScope(e.target.value));
    });
    $('#blockDateInput')?.addEventListener('change', () => {
        const dateVal = $('#blockDateInput').value;
        const endInput = $('#blockEndDateInput');
        if (endInput && dateVal) {
            endInput.min = dateVal;
            if (endInput.value && endInput.value < dateVal) endInput.value = dateVal;
        }
        setBlockFormError('');
        updateBlockWindowChips();
        updateBlockConflictHint();
    });
    ['#blockEndDateInput', '#blockStartTimeInput', '#blockEndTimeInput'].forEach((sel) => {
        $(sel)?.addEventListener('input', () => {
            setBlockFormError('');
            updateBlockConflictHint();
        });
    });
    document.querySelectorAll('.block-reason-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
            const input = $('#blockReasonInput');
            if (!input) return;
            input.value = chip.dataset.reason || '';
            setBlockFormError('');
            input.focus();
        });
    });
    $('#blockScheduleForm')?.addEventListener('submit', submitBlockSchedule);

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
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeCancelModal();
            closeBlockModal();
        }
    });

    if (state.password) {
        showDashboard();
        loadBookings();
    } else {
        showLogin();
    }
})();
