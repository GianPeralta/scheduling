(() => {
    'use strict';

    const STORAGE_CHANNEL = 'ag_scheduler_realtime';
    const listeners = new Set();

    let initialized = false;
    let configRef = null;
    let eventSource = null;
    let supabaseClient = null;
    let supabaseChannel = null;
    let broadcastChannel = null;
    let pulseTimer = null;
    let emitTimer = null;
    let lastVersion = 0;
    let lastPulseCheckAt = 0;
    let sseConnected = false;
    let wsConnected = false;

    function updateStatusIndicators() {
        const isOnline = sseConnected || wsConnected;
        const pill = document.getElementById('realtimeStatusPill');
        if (pill) {
            pill.classList.toggle('is-live', isOnline);
            pill.classList.toggle('is-reconnecting', !isOnline);
            const textEl = pill.querySelector('.live-status-text');
            if (textEl) textEl.textContent = isOnline ? 'Live' : 'Syncing…';
        }
        const badge = document.getElementById('slotsLiveBadge');
        if (badge) {
            badge.classList.toggle('is-live', isOnline);
            badge.classList.toggle('is-reconnecting', !isOnline);
        }
    }

    let pendingEvent = null;
    function scheduleEmit(event) {
        if (event && typeof event.version === 'number' && event.version > lastVersion) {
            lastVersion = event.version;
        }
        pendingEvent = { ...(pendingEvent || {}), ...(event || {}) };
        clearTimeout(emitTimer);
        emitTimer = setTimeout(() => {
            const payload = pendingEvent || { type: 'update' };
            pendingEvent = null;
            for (const fn of listeners) {
                try {
                    fn(payload);
                } catch (err) {
                    console.error('Realtime subscriber failed:', err);
                }
            }
        }, 160);
    }

    function connectEventSource() {
        if (typeof window.EventSource !== 'function' || eventSource) return;
        try {
            eventSource = new EventSource('/api/realtime/stream');
            eventSource.onopen = () => {
                sseConnected = true;
                updateStatusIndicators();
            };
            eventSource.onmessage = (e) => {
                sseConnected = true;
                updateStatusIndicators();
                let data = null;
                try { data = JSON.parse(e.data); } catch { return; }
                if (!data) return;
                if (typeof data.version === 'number' && lastVersion === 0) {
                    lastVersion = data.version;
                }
                if (data.type === 'connected') {
                    if (typeof data.version === 'number' && data.version > lastVersion) {
                        scheduleEmit(data.lastEvent || data);
                    }
                    return;
                }
                if (typeof data.version !== 'number' || data.version > lastVersion) {
                    scheduleEmit(data);
                }
            };
            eventSource.onerror = () => {
                sseConnected = false;
                updateStatusIndicators();
            };
        } catch {
            sseConnected = false;
            updateStatusIndicators();
        }
    }

    function connectSupabaseWebSocket(cfg) {
        const rt = cfg?.realtime;
        if (!rt?.supabaseUrl || !rt?.supabaseAnonKey || !window.supabase?.createClient || supabaseChannel) {
            return;
        }
        try {
            supabaseClient = window.supabase.createClient(rt.supabaseUrl, rt.supabaseAnonKey, {
                auth: { persistSession: false, autoRefreshToken: false },
            });
            const channelName = rt.channel || 'scheduler-live';
            supabaseChannel = supabaseClient
                .channel(channelName, { config: { broadcast: { self: false } } })
                .on('broadcast', { event: 'schedule_change' }, ({ payload }) => {
                    scheduleEmit(payload || { type: 'ws_broadcast' });
                })
                .on('postgres_changes', { event: '*', schema: 'public', table: 'appointments' }, (payload) => {
                    const row = payload?.new || payload?.old || {};
                    scheduleEmit({
                        type: 'ws_appointments',
                        date: row.appointment_date || null,
                        bookingId: row.id || null,
                    });
                })
                .on('postgres_changes', { event: '*', schema: 'public', table: 'blocked_schedules' }, (payload) => {
                    const row = payload?.new || payload?.old || {};
                    scheduleEmit({
                        type: 'ws_blocked',
                        date: row.blocked_date || null,
                    });
                })
                .subscribe((status) => {
                    wsConnected = status === 'SUBSCRIBED';
                    updateStatusIndicators();
                });
        } catch (err) {
            wsConnected = false;
            updateStatusIndicators();
            console.warn('Supabase browser WebSocket unavailable, using SSE/pulse fallback:', err.message || err);
        }
    }

    function connectBroadcastChannel() {
        if (typeof window.BroadcastChannel !== 'function' || broadcastChannel) return;
        try {
            broadcastChannel = new BroadcastChannel(STORAGE_CHANNEL);
            broadcastChannel.onmessage = (e) => {
                if (e?.data) scheduleEmit({ ...e.data, fromLocalTab: true });
            };
        } catch { /* ignore */ }
    }

    async function checkPulse() {
        if (document.visibilityState === 'hidden') return;
        const now = Date.now();
        if (now - lastPulseCheckAt < 1500) return;
        lastPulseCheckAt = now;
        try {
            const res = await fetch('/api/realtime/pulse', { cache: 'no-store' });
            if (!res.ok) return;
            const pulse = await res.json();
            if (typeof pulse?.version === 'number') {
                if (lastVersion === 0) {
                    lastVersion = pulse.version;
                } else if (pulse.version > lastVersion) {
                    scheduleEmit(pulse.lastEvent || { type: 'pulse', version: pulse.version });
                }
            }
        } catch { /* ignore transient pulse errors */ }
    }

    function init(config = null) {
        if (config) configRef = config;
        connectEventSource();
        connectSupabaseWebSocket(configRef);
        connectBroadcastChannel();
        updateStatusIndicators();

        if (!initialized) {
            initialized = true;
            pulseTimer = setInterval(checkPulse, 8000);
            window.addEventListener('focus', checkPulse);
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') checkPulse();
            });
            checkPulse();
        }
    }

    function subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function notifyLocal(event = {}) {
        const payload = { version: Date.now(), timestamp: new Date().toISOString(), ...event };
        lastVersion = Math.max(lastVersion, payload.version);
        if (broadcastChannel) {
            try { broadcastChannel.postMessage(payload); } catch { /* ignore */ }
        }
    }

    window.SchedulerRealtime = {
        init,
        subscribe,
        notifyLocal,
    };
})();
