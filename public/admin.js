(() => {
    'use strict';

    const $ = (sel) => document.querySelector(sel);
    const STORAGE_KEY = 'arnemie_admin_pw';

    const TYPE_BADGES = {
        system: { label: 'System · 15m', cls: 'teal' },
        dropoff: { label: 'Drop-off only', cls: 'amber' },
        retrieval: { label: 'Retrieval · 5m', cls: 'sky' },
        letter: { label: 'Comm. Letter · 5m', cls: 'violet' },
        other: { label: 'Other · 10m', cls: 'sky' },
    };

    const state = {
        password: sessionStorage.getItem(STORAGE_KEY) || '',
        bookings: [],
        blockedSchedules: [],
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
        state.bookings = [];
        state.blockedSchedules = [];
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
            state.students = data.students || [];
            state.studentUpdateLogs = data.studentUpdateLogs || [];
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
        setBlockFormError('');
    }

    function openBlockModal(defaultDate = '') {
        const startDefault = defaultDate || (state.today ? addDays(state.today, 1) : new Date().toISOString().slice(0, 10));
        const dateInput = $('#blockDateInput');
        if (dateInput) {
            dateInput.value = startDefault;
            if (state.today) dateInput.min = state.today;
        }
        if ($('#blockReasonInput')) $('#blockReasonInput').value = '';
        if ($('#blockCancelExistingInput')) $('#blockCancelExistingInput').checked = true;
        setBlockScope('full');
        setBlockFormError('');
        $('#blockModal')?.classList.remove('hidden');
        syncModalBodyLock();
        if (window.matchMedia('(hover: hover)').matches) {
            setTimeout(() => dateInput?.focus(), 40);
        }
    }

    function closeBlockModal() {
        if (state.blocking) return;
        $('#blockModal')?.classList.add('hidden');
        syncModalBodyLock();
        setBlockFormError('');
    }

    async function submitBlockSchedule(e) {
        e.preventDefault();
        if (state.blocking) return;
        setBlockFormError('');

        const date = ($('#blockDateInput')?.value || '').trim();
        const isFullDay = state.blockScope === 'full';
        const reason = ($('#blockReasonInput')?.value || '').trim();
        const cancelExisting = Boolean($('#blockCancelExistingInput')?.checked);

        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            setBlockFormError('Please select a date to block.');
            $('#blockDateInput')?.focus();
            return;
        }

        let startMinute = null;
        let endMinute = null;
        if (!isFullDay) {
            startMinute = timeValToMinute($('#blockStartTimeInput')?.value);
            endMinute = timeValToMinute($('#blockEndTimeInput')?.value);
            if (startMinute === null || endMinute === null || startMinute >= endMinute) {
                setBlockFormError('End time must be after start time.');
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
                    endDate: date,
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
            window.SchedulerRealtime?.notifyLocal({ type: 'block_created', date });

            const cancelledMsg = cancelledList.length
                ? ` (${cancelledList.length} appointment${cancelledList.length === 1 ? '' : 's'} cancelled)`
                : '';
            toast(
                `${isFullDay ? 'Date' : 'Time range'} blocked${cancelledMsg}.`,
                'success'
            );
        } catch (err) {
            setBlockFormError(err.message);
        } finally {
            state.blocking = false;
            if (confirmBtn) {
                confirmBtn.disabled = false;
                confirmBtn.querySelector('.spinner')?.classList.add('hidden');
                confirmBtn.querySelector('.btn-label').textContent = 'Block';
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
            window.SchedulerRealtime?.notifyLocal({ type: 'block_removed', date: blk.date });
            toast(`Unblocked ${shortDate(blk.date)}.`, 'success');
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

    const LEVEL_LABELS = {
        capstone1: 'Capstone 1',
        capstone2: 'Capstone 2',
        thesis1: 'Thesis 1',
        thesis2: 'Thesis 2',
    };

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
            footer.appendChild(el('strong', '', s.name));
            if (s.email) {
                footer.appendChild(el('span', 'muted small', s.email));
            }
            card.appendChild(footer);

            container.appendChild(card);
        });
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
                } else {
                    const [start, end] = blk.label.split(' – ');
                    time.appendChild(el('strong', '', start));
                    time.appendChild(el('span', '', `to ${end}`));
                }

                const body = el('div', 'booking-body');
                body.appendChild(el('span', 'booking-title', blk.reason || 'Unavailable'));

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
        const activeBlocks = state.blockedSchedules.filter(isActiveBlock);
        if ($('#countBlocked')) $('#countBlocked').textContent = activeBlocks.length;

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

                if (b.notifiedAt && (b.isDropoff || b.consultationType === 'dropoff')) {
                    header.appendChild(el('span', 'badge teal', 'Checked ✓'));
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

    // Block Date / Time modal bindings
    $('#openBlockModalBtn')?.addEventListener('click', () => openBlockModal());
    $('#closeBlockModalBtn')?.addEventListener('click', closeBlockModal);
    $('#cancelBlockModalBtn')?.addEventListener('click', closeBlockModal);
    $('#blockModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'blockModal') closeBlockModal();
    });
    document.querySelectorAll('input[name="blockScope"]').forEach((r) => {
        r.addEventListener('change', (e) => setBlockScope(e.target.value));
    });
    ['#blockDateInput', '#blockStartTimeInput', '#blockEndTimeInput'].forEach((sel) => {
        $(sel)?.addEventListener('input', () => setBlockFormError(''));
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
            const res = await fetch('/api/cron/reminders', { method: 'POST' });
            if (res.ok) {
                const data = await res.json().catch(() => null);
                if (data && data.sentCount > 0) {
                    loadBookings();
                }
            }
        } catch {
            // Ignore transient network errors during background polling
        }
    }, 60 * 1000);
})();
