(() => {
    'use strict';

    const $ = (sel) => document.querySelector(sel);
    const STORAGE_KEY = 'arnemie_admin_pw';

    const state = {
        password: sessionStorage.getItem(STORAGE_KEY) || '',
        bookings: [],
        today: '',
        currentHour: 0,
        tab: 'upcoming',
        search: '',
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
        toastTimer = setTimeout(() => { el.className = 'toast'; }, 3500);
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
        setTimeout(() => $('#passwordInput').focus(), 50);
    }

    function showDashboard() {
        $('#loginView').classList.add('hidden');
        $('#dashView').classList.remove('hidden');
    }

    async function login(e) {
        e.preventDefault();
        const btn = $('#loginBtn');
        state.password = $('#passwordInput').value;
        btn.disabled = true;
        btn.querySelector('.spinner').classList.remove('hidden');
        try {
            await api('/api/admin/login', { method: 'POST' });
            sessionStorage.setItem(STORAGE_KEY, state.password);
            $('#passwordInput').value = '';
            showDashboard();
            await loadBookings();
        } catch (err) {
            state.password = '';
            showLogin(err.message);
        } finally {
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
        try {
            const data = await api('/api/admin/bookings');
            state.bookings = data.bookings.sort((a, b) => a.date.localeCompare(b.date) || a.hour - b.hour);
            state.today = data.today;
            state.currentHour = data.currentHour;
            $('#todayLabel').textContent = `Today is ${longDate(data.today)}`;
            render();
        } catch (err) {
            if (err.status === 401) {
                logout();
                showLogin('Session expired. Please sign in again.');
            } else {
                toast(err.message, 'error');
            }
        }
    }

    const isPast = (b) => b.date < state.today || (b.date === state.today && b.hour + 1 <= state.currentHour);
    const isNow = (b) => b.date === state.today && b.hour === state.currentHour;

    async function cancelBooking(b, btn) {
        const who = b.type === 'group' && b.teamName
            ? `${b.teamName} (${b.members.length} members)`
            : b.name;
        if (!confirm(`Cancel the appointment with ${who} on ${longDate(b.date)} at ${b.label}?`)) return;
        btn.disabled = true;
        try {
            await api(`/api/admin/bookings/${b.id}`, { method: 'DELETE' });
            state.bookings = state.bookings.filter((x) => x.id !== b.id);
            render();
            toast('Appointment cancelled. The slot is open again.', 'success');
        } catch (err) {
            btn.disabled = false;
            toast(err.message, 'error');
        }
    }

    function matchesSearch(b, q) {
        if (!q) return true;
        if (b.name.toLowerCase().includes(q)) return true;
        if (b.teamName && b.teamName.toLowerCase().includes(q)) return true;
        if (Array.isArray(b.members) && b.members.some((m) => m.toLowerCase().includes(q))) return true;
        if (b.reason.toLowerCase().includes(q)) return true;
        if (b.reference.toLowerCase().includes(q)) return true;
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
                const isGroup = b.type === 'group' && b.teamName;
                const card = el('div', 'booking' + (isNow(b) ? ' now' : ''));
                card.style.animationDelay = `${Math.min(i++, 12) * 25}ms`;

                const time = el('div', 'booking-time');
                const [start, end] = b.label.split(' – ');
                time.appendChild(el('strong', '', start));
                time.appendChild(el('span', '', `to ${end}`));

                const body = el('div', 'booking-body');
                const header = el('div', 'booking-name');
                header.appendChild(el('span', 'booking-title', isGroup ? b.teamName : b.name));
                if (isGroup) {
                    header.appendChild(el('span', 'badge amber', `Group · ${b.members.length}`));
                }
                header.appendChild(el('code', '', b.reference));
                if (isNow(b)) header.appendChild(el('span', 'badge teal', 'In progress'));
                body.appendChild(header);

                if (isGroup && Array.isArray(b.members) && b.members.length) {
                    const membersWrap = el('div', 'booking-members');
                    b.members.forEach((memberName) => {
                        membersWrap.appendChild(el('span', 'member-chip', memberName));
                    });
                    body.appendChild(membersWrap);
                }

                body.appendChild(el('p', 'booking-reason', b.reason));
                body.appendChild(el('p', 'booking-meta', `Booked ${new Date(b.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`));

                card.append(time, body);

                if (state.tab === 'upcoming') {
                    const btn = el('button', 'btn btn-danger-soft', 'Cancel');
                    btn.type = 'button';
                    btn.addEventListener('click', () => cancelBooking(b, btn));
                    card.appendChild(btn);
                } else {
                    card.appendChild(el('span'));
                }
                group.appendChild(card);
            });

            container.appendChild(group);
        });
    }

    /* ---------------- init ---------------- */
    $('#year').textContent = new Date().getFullYear();
    $('#loginForm').addEventListener('submit', login);
    $('#logoutBtn').addEventListener('click', logout);
    $('#refreshBtn').addEventListener('click', async () => {
        await loadBookings();
        toast('Appointments refreshed.');
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
