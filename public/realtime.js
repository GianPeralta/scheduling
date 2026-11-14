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

    function createEl(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

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

    function formatShortTime(label) {
        return String(label || '').split(' – ')[0] || String(label || '');
    }

    function statePillLabel(queueState) {
        if (queueState === 'serving') return 'Now Serving';
        if (queueState === 'next') return 'Up Next';
        if (queueState === 'completed') return 'Done';
        return 'Waiting';
    }

    function buildSlotCard(boxClass, eyebrowText, item, emptyTitle, emptySub) {
        const box = createEl('div', `queue-slot-card ${boxClass}`);
        box.appendChild(createEl('span', 'queue-slot-eyebrow', eyebrowText));
        if (!item) {
            box.appendChild(createEl('strong', 'queue-slot-empty-title', emptyTitle));
            box.appendChild(createEl('p', 'muted small', emptySub));
            return box;
        }

        const topRow = createEl('div', 'queue-slot-top');
        const numBadge = createEl('span', 'queue-num-badge', `#${item.queueNumber}`);
        const timeEl = createEl('span', 'queue-slot-time', item.label);
        topRow.append(numBadge, timeEl);
        if (item.isMine) {
            topRow.appendChild(createEl('span', 'badge teal', 'You'));
        }
        box.appendChild(topRow);

        box.appendChild(createEl('strong', 'queue-slot-title', item.capstoneTitle || 'Student Group'));

        const metaRow = createEl('div', 'queue-slot-meta');
        metaRow.appendChild(createEl('span', 'badge muted-badge', item.consultationTitle || 'Consultation'));
        if (item.projectLevelLabel) {
            metaRow.appendChild(createEl('span', 'badge rose', item.projectLevelLabel));
        }
        box.appendChild(metaRow);
        return box;
    }

    function renderStudentQueueBoard(container, queue, options = {}) {
        if (!container) return;
        const hasTimed = Boolean(queue && queue.totalTimedCount > 0);
        const showEmpty = Boolean(options.showWhenEmpty);
        if (!queue || (!hasTimed && !showEmpty)) {
            container.innerHTML = '';
            container.classList.add('hidden');
            return;
        }

        container.classList.remove('hidden');
        container.innerHTML = '';

        const card = createEl('div', 'queue-board-card');

        const head = createEl('div', 'queue-board-head');
        const headLeft = createEl('div', 'queue-board-title-wrap');
        const liveTag = createEl('span', 'live-inline-badge is-live');
        liveTag.appendChild(createEl('span', 'live-dot'));
        liveTag.appendChild(document.createTextNode('Live Queue'));
        const headingText = queue.isToday
            ? 'Today’s Consultation Queue'
            : `Upcoming Queue · ${queue.queueDateLabel}`;
        headLeft.append(liveTag, createEl('h4', 'queue-board-title', headingText));

        const headMeta = createEl(
            'span',
            'muted small queue-board-meta',
            `${queue.waitingCount} waiting · ${queue.completedCount} done · ${queue.currentTimeLabel}`
        );
        head.append(headLeft, headMeta);
        card.appendChild(head);

        if (queue.myActiveItem) {
            const mine = queue.myActiveItem;
            const myBanner = createEl('div', `queue-my-banner is-${mine.queueState}`);
            const ahead = queue.items.filter(
                (it) => it.queueNumber < mine.queueNumber && (it.queueState === 'serving' || it.queueState === 'next' || it.queueState === 'waiting')
            ).length;
            let text;
            if (mine.queueState === 'serving') {
                text = `Your turn now (#${mine.queueNumber}) — Proceed to ${options.location || 'Faculty Office'} (${mine.label})`;
            } else if (mine.queueState === 'next') {
                text = `You’re up next (#${mine.queueNumber}) — Schedule: ${mine.label}`;
            } else if (mine.queueState === 'completed') {
                text = `Your session (#${mine.queueNumber}, ${mine.label}) has finished`;
            } else {
                text = `Your queue number: #${mine.queueNumber} (${mine.label}) · ${ahead} ${ahead === 1 ? 'group' : 'groups'} ahead`;
            }
            myBanner.appendChild(createEl('strong', '', text));
            card.appendChild(myBanner);
        }

        const grid = createEl('div', 'queue-grid');
        grid.appendChild(
            buildSlotCard(
                'now-serving-box',
                'NOW SERVING',
                queue.nowServing,
                queue.isToday ? 'Waiting to start' : 'Scheduled queue preview',
                queue.isToday
                    ? 'The instructor will call the next group shortly.'
                    : `Queue opens on ${queue.queueDateLabel}.`
            )
        );
        grid.appendChild(
            buildSlotCard(
                'up-next-box',
                'UP NEXT',
                queue.upNext,
                'No group waiting',
                'All remaining timed sessions on this day are finished.'
            )
        );
        card.appendChild(grid);

        if (Array.isArray(queue.items) && queue.items.length) {
            const strip = createEl('div', 'queue-strip');
            queue.items.forEach((item) => {
                const chip = createEl(
                    'div',
                    `queue-chip is-${item.queueState}${item.isMine ? ' is-mine' : ''}`
                );
                const chipTop = createEl('div', 'queue-chip-top');
                chipTop.appendChild(createEl('strong', '', `#${item.queueNumber} · ${formatShortTime(item.label)}`));
                chipTop.appendChild(createEl('span', `queue-chip-state is-${item.queueState}`, statePillLabel(item.queueState)));
                chip.appendChild(chipTop);
                chip.appendChild(createEl('div', 'queue-chip-name', item.isMine ? `${item.capstoneTitle} (You)` : item.capstoneTitle));
                strip.appendChild(chip);
            });
            card.appendChild(strip);
        }

        if (queue.dropoffCount > 0) {
            card.appendChild(
                createEl(
                    'p',
                    'muted small queue-dropoff-note',
                    `${queue.dropoffCount} drop-off manuscript${queue.dropoffCount === 1 ? '' : 's'} also scheduled on this day.`
                )
            );
        }

        container.appendChild(card);
    }

    window.SchedulerRealtime = {
        init,
        subscribe,
        notifyLocal,
        renderStudentQueueBoard,
    };
})();
