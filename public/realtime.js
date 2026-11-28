(() => {
    'use strict';

    const STORAGE_CHANNEL = 'ag_scheduler_realtime';
    const WS_SKIP_CACHE_KEY = 'ag_ws_unavailable_until_v1';
    const WS_SKIP_TTL_MS = 10 * 60 * 1000; // Remember unreachable WS for 10 min per session to avoid console spam
    const WS_CONNECT_TIMEOUT_MS = 5500;
    const PULSE_INTERVAL_MS = 8000;

    const listeners = new Set();

    let initialized = false;
    let configRef = null;
    let eventSource = null;
    let supabaseClient = null;
    let supabaseChannel = null;
    let wsConnectTimer = null;
    let broadcastChannel = null;
    let pulseTimer = null;
    let emitTimer = null;
    let lastVersion = 0;
    let lastPulseCheckAt = 0;
    let sseConnected = false;
    let wsConnected = false;
    let wsFailedOver = false;
    let pulseHealthy = false;

    function isWsTemporarilySkipped() {
        try {
            const raw = Number(sessionStorage.getItem(WS_SKIP_CACHE_KEY) || 0);
            return Number.isFinite(raw) && raw > Date.now();
        } catch {
            return false;
        }
    }

    function markWsTemporarilyUnavailable() {
        try {
            sessionStorage.setItem(WS_SKIP_CACHE_KEY, String(Date.now() + WS_SKIP_TTL_MS));
        } catch { /* ignore restricted sessionStorage */ }
    }

    function clearWsUnavailableMark() {
        try {
            sessionStorage.removeItem(WS_SKIP_CACHE_KEY);
        } catch { /* ignore */ }
    }

    function updateStatusIndicators() {
        const isOnline = sseConnected || wsConnected || pulseHealthy;
        const pill = document.getElementById('realtimeStatusPill');
        if (pill) {
            pill.classList.toggle('is-live', isOnline);
            pill.classList.toggle('is-reconnecting', !isOnline);
            const textEl = pill.querySelector('.live-status-text');
            if (textEl) textEl.textContent = isOnline ? 'Live' : 'Syncing…';
        }
        document.querySelectorAll('#slotsLiveBadge, #reschedLiveBadge').forEach((badge) => {
            badge.classList.toggle('is-live', isOnline);
            badge.classList.toggle('is-reconnecting', !isOnline);
        });
    }

    let pendingEvent = null;
    function scheduleEmit(event) {
        if (event && !event.fromLocalTab && typeof event.version === 'number' && event.version > lastVersion) {
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

    function startPulsePolling() {
        if (!pulseTimer) {
            pulseTimer = setInterval(checkPulse, PULSE_INTERVAL_MS);
        }
        checkPulse();
    }

    function teardownSupabaseWebSocket({ fallbackToPulse = true } = {}) {
        clearTimeout(wsConnectTimer);
        wsConnectTimer = null;
        wsConnected = false;

        const client = supabaseClient;
        const channel = supabaseChannel;
        supabaseClient = null;
        supabaseChannel = null;

        if (client) {
            try {
                if (channel && typeof client.removeChannel === 'function') {
                    Promise.resolve(client.removeChannel(channel)).catch(() => {});
                } else if (typeof client.removeAllChannels === 'function') {
                    Promise.resolve(client.removeAllChannels()).catch(() => {});
                }
            } catch { /* ignore */ }
            try {
                if (client.realtime && typeof client.realtime.disconnect === 'function') {
                    client.realtime.disconnect();
                }
            } catch { /* ignore */ }
        }

        if (fallbackToPulse && !wsFailedOver) {
            wsFailedOver = true;
            markWsTemporarilyUnavailable();
            startPulsePolling();
        }
        updateStatusIndicators();
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
        if (!rt?.supabaseUrl || !rt?.supabaseAnonKey || !window.supabase?.createClient || supabaseChannel || wsFailedOver) {
            if (!wsConnected) startPulsePolling();
            return;
        }

        if (isWsTemporarilySkipped()) {
            wsFailedOver = true;
            startPulsePolling();
            return;
        }

        try {
            supabaseClient = window.supabase.createClient(rt.supabaseUrl, rt.supabaseAnonKey, {
                auth: { persistSession: false, autoRefreshToken: false },
                realtime: {
                    // Prevent aggressive infinite retry loops when WSS is blocked by browser/firewall
                    reconnectAfterMs: (tries) => (tries > 1 ? 600000 : 2500),
                },
            });

            if (supabaseClient.realtime && typeof supabaseClient.realtime.onError === 'function') {
                supabaseClient.realtime.onError(() => {
                    if (!wsConnected) {
                        teardownSupabaseWebSocket({ fallbackToPulse: true });
                    }
                });
            }

            clearTimeout(wsConnectTimer);
            wsConnectTimer = setTimeout(() => {
                if (!wsConnected) {
                    teardownSupabaseWebSocket({ fallbackToPulse: true });
                }
            }, WS_CONNECT_TIMEOUT_MS);

            const channelName = rt.channel || 'scheduler-live';
            supabaseChannel = supabaseClient
                .channel(channelName, { config: { broadcast: { self: false } } })
                .on('broadcast', { event: 'schedule_change' }, ({ payload }) => {
                    scheduleEmit(payload || { type: 'ws_broadcast' });
                })
                .subscribe((status) => {
                    if (status === 'SUBSCRIBED') {
                        clearTimeout(wsConnectTimer);
                        wsConnectTimer = null;
                        wsConnected = true;
                        clearWsUnavailableMark();
                        updateStatusIndicators();
                    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                        teardownSupabaseWebSocket({ fallbackToPulse: true });
                    }
                });
        } catch {
            teardownSupabaseWebSocket({ fallbackToPulse: true });
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
        if (wsConnected || sseConnected) return;
        const now = Date.now();
        if (now - lastPulseCheckAt < 1500) return;
        lastPulseCheckAt = now;
        try {
            const res = await fetch('/api/realtime/pulse', { cache: 'no-store' });
            if (!res.ok) {
                pulseHealthy = false;
                updateStatusIndicators();
                return;
            }
            const pulse = await res.json();
            pulseHealthy = true;
            updateStatusIndicators();
            if (typeof pulse?.version === 'number') {
                if (lastVersion === 0) {
                    lastVersion = pulse.version;
                } else if (pulse.version > lastVersion) {
                    scheduleEmit(pulse.lastEvent || { type: 'pulse', version: pulse.version });
                }
            }
        } catch {
            pulseHealthy = false;
            updateStatusIndicators();
        }
    }

    function init(config = null) {
        if (config) configRef = config;
        connectBroadcastChannel();

        if (configRef) {
            connectSupabaseWebSocket(configRef);
            if (!configRef.realtime?.serverless) {
                connectEventSource();
            }
            startPulsePolling();
        }

        updateStatusIndicators();

        if (!initialized) {
            initialized = true;
            window.addEventListener('focus', checkPulse);
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') checkPulse();
            });
        }
    }

    function subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function notifyLocal(event = {}) {
        const payload = { timestamp: new Date().toISOString(), ...event };
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
