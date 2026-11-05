(() => {
    'use strict';

    const $ = (sel) => document.querySelector(sel);
    const STORAGE_KEY = 'arnemie_admin_pw';

    const TYPE_BADGES = {
        system: { label: 'System · 15m', cls: 'teal' },
        dropoff: { label: 'Drop-off · 0m', cls: 'amber' },
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

    const isPast = (b) => {
        const endMin = b.endMinute ?? (b.hour + 1) * 60;
        return b.date < state.today || (b.date === state.today && endMin <= state.currentMinute);
    };
    const isNow = (b) => {
        const startMin = b.startMinute ?? b.hour * 60;
        const endMin = b.endMinute ?? (b.hour + 1) * 60;
        return b.date === state.today && state.currentMinute >= startMin && state.currentMinute < endMin;
    };

    async function cancelBooking(b, btn) {
        const title = b.capstoneTitle || b.teamName;
        const count = Array.isArray(b.members) ? b.members.length : 1;
        const who = title
            ? `${title} (${count} ${count === 1 ? 'member' : 'members'})`
            : b.name;
        if (!confirm(`Cancel the appointment with ${who} on ${longDate(b.date)} at ${b.label}?`)) return;
        btn.disabled = true;
        try {
            await api(`/api/admin/bookings/${b.id}`, { method: 'DELETE' });
            state.bookings = state.bookings.filter((x) => x.id !== b.id);
            render();
            toast('Appointment cancelled.', 'success');
        } catch (err) {
            btn.disabled = false;
            toast(err.message, 'error');
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
        if (b.reference.toLowerCase().includes(q)) return true;
        if (b.studentEmail && b.studentEmail.toLowerCase().includes(q)) return true;
        return false;
    }

    /* ---------------- render ---------------- */
    function render() {
        const upcoming = state.bookings.filter((b) => !isPast(b));
        const past = state.bookings.filter(isPast).reverse();
        const weekEnd = addDays(state.today, 7);

        $('#statToday').textContent = upcoming.filter((b) => b.date === state.today).length;
        $('#statWeek').textContent = upcoming.filter((b) => b.date < weekEnd).length;
        $('#statUpcoming').textContent = upcoming.length;
        $('#countUpcoming').textContent = upcoming.length;
        $('#countPast').textContent = past.length;

        const q = state.search.toLowerCase();
        const list = (state.tab === 'upcoming' ? upcoming : past).filter((b) => matchesSearch(b, q));

        const container = $('#bookingList');
        container.innerHTML = '';

        if (!list.length) {
            const empty = el('div', 'empty-state');
            empty.style.marginTop = '12px';
            empty.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';
            empty.appendChild(el('p', '', q ? 'No appointments match your search.' : state.tab === 'upcoming' ? 'No upcoming appointments yet.' : 'No past appointments.'));
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
                const isGroup = b.type === 'group' && Array.isArray(b.members) && b.members.length >= 2;
                const card = el('div', 'booking' + (isNow(b) ? ' now' : ''));
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

                const typeBadge = TYPE_BADGES[b.consultationType] || {
                    label: `${b.consultationTitle || 'Consultation'} · ${b.durationLabel || ''}`,
                    cls: 'teal',
                };
                header.appendChild(el('span', `badge ${typeBadge.cls}`, typeBadge.label));

                if (b.instructorRole === 'panel') {
                    header.appendChild(el('span', 'badge sky', 'Role: Panel Member'));
                } else if (b.instructorRole === 'adviser') {
                    header.appendChild(el('span', 'badge teal', 'Role: Adviser'));
                }
                if (isGroup) {
                    header.appendChild(el('span', 'badge amber', `Group · ${b.members.length}`));
                } else if (groupHeading) {
                    header.appendChild(el('span', 'badge amber', '1 member'));
                }
                if (b.notifiedAt) {
                    header.appendChild(el('span', 'badge teal', 'Checked email sent ✓'));
                }
                header.appendChild(el('code', '', b.reference));
                if (isNow(b)) header.appendChild(el('span', 'badge teal', 'In progress'));
                body.appendChild(header);

                if (Array.isArray(b.members) && b.members.length) {
                    const membersWrap = el('div', 'booking-members');
                    b.members.forEach((memberName) => {
                        membersWrap.appendChild(el('span', 'member-chip', memberName));
                    });
                    body.appendChild(membersWrap);
                }

                body.appendChild(el('p', 'booking-reason', b.reason));
                const bookedBy = b.studentEmail ? ` by ${b.studentEmail}` : '';
                body.appendChild(el('p', 'booking-meta', `Booked${bookedBy} · ${new Date(b.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`));

                const actions = el('div', 'booking-actions');
                if (b.consultationType === 'dropoff' && b.studentEmail) {
                    const notifyBtn = el(
                        'button',
                        'btn btn-ghost btn-sm',
                        b.notifiedAt ? 'Resend Checked Email' : 'Notify Checked'
                    );
                    notifyBtn.type = 'button';
                    notifyBtn.addEventListener('click', () => notifyManuscriptChecked(b, notifyBtn));
                    actions.appendChild(notifyBtn);
                }
                if (state.tab === 'upcoming') {
                    const btn = el('button', 'btn btn-danger-soft', 'Cancel');
                    btn.type = 'button';
                    btn.addEventListener('click', () => cancelBooking(b, btn));
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

    if (state.password) {
        showDashboard();
        loadBookings();
    } else {
        showLogin();
    }
})();
