(() => {
    'use strict';

    const $ = (sel) => document.querySelector(sel);
    const setText = (sel, val) => {
        const el = $(sel);
        if (el) el.textContent = val;
    };
    const MIN_MEMBERS = 1;
    const MAX_MEMBERS = 3;
    const CANCEL_CUTOFF_MINUTES = 120; // 2 hours before scheduled time

    const PURPOSE_META = {
        system: {
            title: 'System Consultation',
            badge: '15 minutes',
            summary: 'System Consultation · 15 min',
            color: 'teal',
            requiresAllMembers: true,
            reasonOptional: false,
            bannerNote: 'All members must be present during System Consultations.',
            policyHtml: '<strong>Attendance Requirement:</strong> All members must be present during your 15-minute System Consultation.',
            confirmHtml: '<strong>Reminder:</strong> All members must be present during your System Consultation.',
            reasonLabel: 'What will you present or consult about?',
            reasonPlaceholder: 'e.g. Present our completed modules, database workflow, and ask for feedback.',
        },
        dropoff: {
            title: 'Drop-off Manuscript',
            badge: 'Drop-off only',
            summary: 'Drop-off Manuscript',
            color: 'amber',
            requiresAllMembers: false,
            reasonOptional: true,
            bannerNote: 'Drop-off only. You will be notified via school email once checked.',
            policyHtml: '<strong>Drop-off Only:</strong> Once your manuscript is checked, you will be notified through your registered school email (<strong data-student-email></strong>).',
            confirmHtml: '<strong>What happens next:</strong> Once your manuscript is checked, you will receive an email at your registered school address. Return to this website afterward to book a <strong>5-minute Retrieval of Manuscript</strong>.',
            reasonLabel: 'Manuscript details / notes',
            reasonPlaceholder: 'e.g. Chapters 1–3 revised draft for checking (optional)',
        },
        retrieval: {
            title: 'Retrieval of Manuscript',
            badge: '5 minutes',
            summary: 'Retrieval of Manuscript · 5 min',
            color: 'sky',
            requiresAllMembers: true,
            reasonOptional: true,
            bannerNote: 'Schedule once notified by email. At least 2 or all members must be present.',
            policyHtml: '<strong>Attendance Requirement:</strong> Schedule this once you have received the email saying your manuscript is checked. <strong>At least 2 or all members must be present</strong>, otherwise you will not be accommodated.',
            confirmHtml: '<strong>Important:</strong> At least 2 or all members must be present during Manuscript Retrieval, otherwise you will not be accommodated.',
            reasonLabel: 'Notes for retrieval',
            reasonPlaceholder: 'e.g. Retrieving checked manuscript to discuss needed changes (optional)',
        },
        letter: {
            title: 'Communication Letter Signature',
            badge: '5 minutes',
            summary: 'Comm. Letter Signature · 5 min',
            color: 'violet',
            requiresAllMembers: false,
            adviserOnly: true,
            reasonOptional: false,
            bannerNote: 'Letter must already bear the initial of Ma’am Melinda Beninsig.',
            policyHtml: '<strong>Prerequisite Confirmed:</strong> Please bring your printed communication letter that already has the <strong>initial of Ma’am Melinda Beninsig</strong> before requesting your adviser’s signature.',
            confirmHtml: '<strong>Reminder:</strong> Bring your printed communication letter with Ma’am Melinda Beninsig’s initial to your appointment.',
            reasonLabel: 'Purpose of the communication letter',
            reasonPlaceholder: 'e.g. Request letter to conduct survey / data gathering with target respondents.',
        },
        letter_pickup: {
            title: 'Pickup of Communication Letter',
            badge: '5 minutes',
            summary: 'Comm. Letter Pickup · 5 min',
            color: 'violet',
            requiresAllMembers: false,
            adviserOnly: true,
            reasonOptional: true,
            bannerNote: 'Schedule once notified by email that your signed letter is ready.',
            policyHtml: '<strong>Ready for Pickup:</strong> Schedule this 5-minute slot after receiving the email notification that your communication letter is signed and ready.',
            confirmHtml: '<strong>Reminder:</strong> Please claim your signed communication letter at the Faculty Office during your scheduled 5-minute pickup slot.',
            reasonLabel: 'Notes for pickup',
            reasonPlaceholder: 'e.g. Picking up signed communication letter (optional)',
        },
        other: {
            title: 'Other Consultations',
            badge: '10 minutes',
            summary: 'Other Consultations · 10 min',
            color: 'sky',
            requiresAllMembers: false,
            reasonOptional: false,
            bannerNote: 'Available for all students (10 minutes).',
            policyHtml: '<strong>Other Consultations:</strong> Available for all students for other Capstone / Thesis concerns (10 minutes).',
            confirmHtml: '<strong>Reminder:</strong> Please come prepared with your questions or materials for your 10-minute consultation.',
            reasonLabel: 'What would you like to consult about?',
            reasonPlaceholder: 'e.g. Clarifications on evaluation comments, title or scope questions, or other concerns.',
        },
        defense: {
            title: 'Defense',
            badge: '1–2 hours',
            summary: 'Defense',
            color: 'rose',
            requiresAllMembers: true,
            reasonOptional: true,
            bannerNote: 'All members must be present during the defense.',
            policyHtml: '<strong>Attendance Requirement:</strong> All registered group members must be present during your Capstone / Thesis Defense.',
            confirmHtml: '<strong>Reminder:</strong> All group members must be present during your Capstone / Thesis Defense.',
            reasonLabel: 'Notes for your defense',
            reasonPlaceholder: 'e.g. Panel members attending, equipment you will bring, etc. (optional)',
        },
    };

    // Capstone / Thesis level -> defense length (kept in sync with the server's DEFENSE_LEVELS)
    const DEFENSE_LEVELS = {
        capstone1: { label: 'Capstone 1', durationMinutes: 60, durationLabel: '1 hour' },
        capstone2: { label: 'Capstone 2', durationMinutes: 120, durationLabel: '2 hours' },
        thesis1: { label: 'Thesis 1', durationMinutes: 60, durationLabel: '1 hour' },
        thesis2: { label: 'Thesis 2', durationMinutes: 120, durationLabel: '2 hours' },
    };
    const isDefenseLevel = (v) => Object.prototype.hasOwnProperty.call(DEFENSE_LEVELS, v);

    const state = {
        config: null,
        configPromise: null,
        currentStep: 1, // 1 = Type, 2 = Date & Time, 3 = Sign in & Details, 4 = Confirmed
        viewYear: 0,
        viewMonth: 0, // 0-11
        monthDays: {}, // { 'YYYY-MM-DD': { bookable, open } }
        selectedDate: null,
        selectedSlot: null, // { startMinute, endMinute, durationMinutes, isDropoff, label, endLabel }
        consultationPurpose: null, // 'system' | 'dropoff' | 'retrieval' | 'letter' | 'defense'
        defenseLevel: null, // 'capstone1' | 'capstone2' | 'thesis1' | 'thesis2' (only for defenses)
        defenseDay: null, // last /api/slots response for a defense date (windows + free ranges)
        beninsigConfirmed: false,
        retrievalNotifiedConfirmed: false,
        letterPickupNotifiedConfirmed: false,
        bookingType: 'group', // 'individual' | 'group'
        monthRequest: 0,
        slotsRequest: 0,
        loadedMonthKey: null,
        loadingSlotsKey: null,
        loadedSlotsKey: null,
        activeWindowLabel: null,
        submitting: false,
        lastBookedId: null,
        student: null, // { id, name, email, capstoneTitle, instructorRole, members }
        myBookings: [],
        pickupEligibility: null, // { manuscriptNotifiedAt, letterNotifiedAt, canBookRetrieval, canBookLetterPickup }
        profileFilter: 'all', // 'all' | 'upcoming' | 'cancelled' | 'past'
        serverToday: '',
        serverCurrentMinute: 0,
        authMode: 'login', // 'login' | 'register' | 'forgot' | 'otp'
        otpPurpose: 'register', // 'register' | 'reset'
        otpEmail: '',
        resendTimer: null,
        authBusy: false,
        profileView: 'summary', // 'summary' | 'edit' | 'otp'
        profileOtpEmail: '',
        profileResendTimer: null,
        profileBusy: false,
    };

    /* ---------------- helpers ---------------- */
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
    const monthKey = (y, m) => `${y}-${pad(m + 1)}`;

    function utcDate(str) {
        const [y, m, d] = str.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d));
    }

    function formatLongDate(str) {
        return utcDate(str).toLocaleDateString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
        });
    }

    function formatShortDate(str) {
        return utcDate(str).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
        });
    }

    function formatShortWeekdayDate(str) {
        return utcDate(str).toLocaleDateString('en-US', {
            weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
        });
    }

    function syncModalBodyLock() {
        const anyOpen = Array.from(document.querySelectorAll('.modal-backdrop'))
            .some((el) => !el.classList.contains('hidden'));
        document.body.classList.toggle('modal-open', anyOpen);
    }

    function formatMinute(totalMinutes) {
        const h = Math.floor(totalMinutes / 60) % 24;
        const m = totalMinutes % 60;
        const suffix = h >= 12 ? 'PM' : 'AM';
        const hr = h % 12 === 0 ? 12 : h % 12;
        return `${hr}:${pad(m)} ${suffix}`;
    }

    function getDefenseLevelInfo(level = state.defenseLevel || state.student?.projectLevel) {
        return DEFENSE_LEVELS[level] || null;
    }

    function getMeta(purpose = state.consultationPurpose, levelOverride = null) {
        if (purpose === 'defense') {
            const base = PURPOSE_META.defense;
            const info = getDefenseLevelInfo(levelOverride || state.defenseLevel);
            if (!info) return base;
            return {
                ...base,
                title: `${info.label} Defense`,
                badge: info.durationLabel,
                summary: `${info.label} Defense · ${info.durationLabel}`,
            };
        }
        return PURPOSE_META[purpose] || PURPOSE_META.system;
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
            err.field = body.field;
            throw err;
        }
        return body;
    }

    let toastTimer;
    function toast(message, type = 'info') {
        const el = $('#toast');
        el.textContent = message;
        el.className = `toast show ${type}`;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.className = 'toast'; }, 4200);
    }

    /* ---------------- inline field validation ---------------- */
    function findFieldContainer(target) {
        const el = typeof target === 'string' ? $(target) : target;
        if (!el) return null;
        return el.classList.contains('field') ? el : el.closest('.field');
    }

    function clearFieldError(target) {
        const field = findFieldContainer(target);
        if (!field) return;
        field.classList.remove('has-error');
        field.querySelectorAll('.input-invalid').forEach((inp) => {
            inp.classList.remove('input-invalid');
            inp.removeAttribute('aria-invalid');
        });
        const err = field.querySelector('.field-error');
        if (err) err.remove();
    }

    function clearFormFieldErrors(root) {
        const container = typeof root === 'string' ? $(root) : root;
        if (!container) return;
        container.querySelectorAll('.field.has-error').forEach((f) => clearFieldError(f));
    }

    /**
     * Highlights the specific invalid input AND places the error message directly underneath it,
     * scrolling both into view so the user never has to hunt at the bottom of the form.
     */
    function setFieldError(inputOrSelector, message, focusTarget = null) {
        const targetEl = typeof inputOrSelector === 'string' ? $(inputOrSelector) : inputOrSelector;
        const field = findFieldContainer(targetEl);
        if (!field) return false;

        clearFieldError(field);
        field.classList.add('has-error');

        const inputToMark = focusTarget
            || (targetEl.matches && targetEl.matches('input, textarea, select') ? targetEl : field.querySelector('input:not([readonly]), textarea'));
        if (inputToMark) {
            inputToMark.classList.add('input-invalid');
            inputToMark.setAttribute('aria-invalid', 'true');
        }

        const errEl = document.createElement('small');
        errEl.className = 'field-error';
        errEl.setAttribute('role', 'alert');
        errEl.textContent = message;
        field.appendChild(errEl);

        field.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (inputToMark) {
            setTimeout(() => inputToMark.focus({ preventScroll: true }), 120);
        }
        return true;
    }

    function showBannerError(selector, msg) {
        const el = $(selector);
        if (!el) return;
        el.textContent = msg || '';
        el.classList.toggle('hidden', !msg);
        if (msg) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    function setFormError(msg) {
        showBannerError('#formError', msg);
    }

    function setAuthError(msg) {
        showBannerError('#authError', msg);
    }

    /* ---------------- steps & auth gate ---------------- */
    function showAuthGate() {
        $('#bootPanel')?.classList.add('hidden');
        ['#step1', '#step2', '#step3', '#step4'].forEach((id) => $(id)?.classList.add('hidden'));
        $('#bookingSteps')?.classList.add('hidden');
        $('#selectionBox')?.classList.add('hidden');
        $('#studentProjectBox')?.classList.add('hidden');
        $('#authPanel')?.classList.remove('hidden');
    }

    function goToStep(n, shouldScroll = true) {
        if (!state.student) {
            showAuthGate();
            return;
        }
        state.currentStep = n;
        $('#bootPanel')?.classList.add('hidden');
        $('#authPanel')?.classList.add('hidden');
        $('#bookingSteps')?.classList.remove('hidden');
        ['#step1', '#step2', '#step3', '#step4'].forEach((id, i) => {
            $(id)?.classList.toggle('hidden', i + 1 !== n);
        });
        document.querySelectorAll('.step').forEach((el) => {
            const s = Number(el.dataset.step);
            el.classList.toggle('active', s === n);
            el.classList.toggle('done', s < n);
        });
        if (n === 3) {
            renderStep3();
            if (window.innerWidth > 960 && window.matchMedia('(hover: hover)').matches) {
                setTimeout(() => {
                    $('#reasonInput')?.focus({ preventScroll: true });
                }, 60);
            }
        }
        if (shouldScroll && window.innerWidth <= 960) {
            const activePanel = $(['#step1', '#step2', '#step3', '#step4'][n - 1]);
            (activePanel || $('#scheduler'))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    function updateSelectionBox() {
        const box = $('#selectionBox');
        if (!state.consultationPurpose) {
            box.classList.add('hidden');
            return;
        }
        const meta = getMeta();
        $('#selectionPurpose').textContent = meta.summary;
        if (state.selectedDate && state.selectedSlot) {
            $('#selectionDate').textContent = formatLongDate(state.selectedDate);
            $('#selectionTime').textContent = state.selectedSlot.isDropoff
                ? `${state.selectedSlot.label} (Drop-off)`
                : `${state.selectedSlot.label} – ${state.selectedSlot.endLabel}`;
        } else if (state.selectedDate) {
            $('#selectionDate').textContent = formatLongDate(state.selectedDate);
            $('#selectionTime').textContent = state.consultationPurpose === 'defense'
                ? 'Type or pick a start time'
                : 'Select a time slot';
        } else {
            $('#selectionDate').textContent = 'Select a date & time';
            $('#selectionTime').textContent = '';
        }
        box.classList.remove('hidden');
    }

    function updatePurposeUI() {
        if (!state.consultationPurpose) return;
        const meta = getMeta();

        // Step 2 banner
        setText('#bannerPurposeTitle', meta.title);
        const badge = $('#bannerPurposeBadge');
        if (badge) {
            badge.textContent = meta.badge;
            badge.className = `badge ${meta.color}`;
        }
        const bannerNoteEl = $('#bannerPurposeNote');
        if (bannerNoteEl) {
            if (state.consultationPurpose === 'defense') {
                bannerNoteEl.innerHTML = '';
                bannerNoteEl.appendChild(document.createTextNode(`${meta.bannerNote} Need to switch course level (1 hr vs 2 hrs)? `));
                const switchCourseBtn = document.createElement('button');
                switchCourseBtn.type = 'button';
                switchCourseBtn.className = 'link-btn';
                switchCourseBtn.textContent = 'Update course in Profile';
                switchCourseBtn.addEventListener('click', () => openMyBookingsModal(true));
                bannerNoteEl.appendChild(switchCourseBtn);
                bannerNoteEl.appendChild(document.createTextNode('.'));
                bannerNoteEl.classList.remove('hidden');
            } else if (meta.bannerNote) {
                bannerNoteEl.textContent = meta.bannerNote;
                bannerNoteEl.classList.remove('hidden');
            } else {
                bannerNoteEl.textContent = '';
                bannerNoteEl.classList.add('hidden');
            }
        }

        // Step 3 policy callout
        const policyEl = $('#step3PolicyCallout');
        if (policyEl) {
            if (meta.policyHtml) {
                policyEl.className = `policy-callout ${meta.color}`;
                policyEl.innerHTML = meta.policyHtml;
                const emailSlot = policyEl.querySelector('[data-student-email]');
                if (emailSlot) {
                    emailSlot.textContent = state.student?.email || 'your university email';
                }
            } else {
                policyEl.innerHTML = '';
                policyEl.classList.add('hidden');
            }
        }

        setBookingType('group');
        setText('#membersFieldLabel', 'Members attending');
        const membersHintEl = $('#membersFieldHint');
        if (membersHintEl) {
            const totalSaved = Array.isArray(state.student?.members) ? state.student.members.length : 1;
            if (meta.requiresAllMembers) {
                membersHintEl.textContent = state.consultationPurpose === 'retrieval'
                    ? 'Your registered group is listed below (at least 2 or all members must attend).'
                    : 'All registered group members are required to attend this schedule.';
            } else if (totalSaved > 1) {
                membersHintEl.textContent = 'Pre-filled with your group. Click × to remove any member who will not attend this session.';
            } else {
                membersHintEl.textContent = '';
            }
            membersHintEl.classList.toggle('hidden', !membersHintEl.textContent);
        }
        setText('#reasonLabelText', meta.reasonLabel);
        setText('#reasonOptionalHint', meta.reasonOptional ? '(optional)' : '');
        const reasonEl = $('#reasonInput');
        if (reasonEl) reasonEl.placeholder = meta.reasonPlaceholder;
    }

    async function ensureConfig() {
        if (state.config) return state.config;
        if (!state.configPromise) {
            state.configPromise = api('/api/config').then((c) => {
                state.config = c;
                setText('#location', c.location);
                if (c.lastBookableDate) {
                    setText('#deadlineMeta', `Until ${formatShortDate(c.lastBookableDate)}`);
                }
                const startRef = c.firstBookableDate || c.today;
                const [y, m] = startRef.split('-').map(Number);
                state.viewYear = y;
                state.viewMonth = m - 1;
                return c;
            }).catch((err) => {
                state.configPromise = null;
                throw err;
            });
        }
        return state.configPromise;
    }

    /* ---------------- Beninsig prerequisite modal for Communication Letter ---------------- */
    function openBeninsigModal() {
        $('#beninsigAskView').classList.remove('hidden');
        $('#beninsigNoView').classList.add('hidden');
        $('#beninsigModal').classList.remove('hidden');
        syncModalBodyLock();
        setTimeout(() => $('#beninsigYesBtn')?.focus(), 40);
    }

    function closeBeninsigModal() {
        $('#beninsigModal').classList.add('hidden');
        syncModalBodyLock();
    }

    /* ---------------- Email notification prerequisite modal for Retrieval of Manuscript ---------------- */
    function openRetrievalModal() {
        $('#retrievalAskView').classList.remove('hidden');
        $('#retrievalNoView').classList.add('hidden');
        $('#retrievalModal').classList.remove('hidden');
        syncModalBodyLock();
        setTimeout(() => $('#retrievalYesBtn')?.focus(), 40);
    }

    function applyPickupBlockedContent({ purpose, titleSel, textSel, linkSel, closeBtnSel }) {
        const status = getPickupEligibilityDetails(purpose);
        const titleEl = $(titleSel);
        const textEl = $(textSel);
        const linkEl = $(linkSel);
        const closeBtn = $(closeBtnSel);
        const isRetrieval = purpose === 'retrieval';

        if (status.hasUpcoming) {
            if (titleEl) titleEl.textContent = isRetrieval ? 'Retrieval already scheduled' : 'Letter pickup already scheduled';
            if (textEl) {
                textEl.innerHTML = isRetrieval
                    ? 'You already have an upcoming <strong>Retrieval of Manuscript</strong> appointment scheduled. Go to <strong>My Appointments</strong> if you need to reschedule or cancel it.'
                    : 'You already have an upcoming <strong>Pickup of Communication Letter</strong> appointment scheduled. Go to <strong>My Appointments</strong> if you need to reschedule or cancel it.';
            }
        } else if (status.alreadyBooked) {
            if (titleEl) titleEl.textContent = 'New email notification required';
            if (textEl) {
                textEl.innerHTML = isRetrieval
                    ? 'You have already scheduled a <strong>Retrieval of Manuscript</strong> for your latest manuscript-ready notification. Please wait for a new email notification after your next manuscript check.'
                    : 'You have already scheduled a <strong>Pickup of Communication Letter</strong> for your latest email notification. Please wait for a new email notification if you submitted another letter.';
            }
        } else {
            if (titleEl) titleEl.textContent = 'Email notification required';
            if (textEl) {
                textEl.innerHTML = isRetrieval
                    ? 'No manuscript-ready email notification has been sent to your account yet. You can only schedule a <strong>Retrieval of Manuscript</strong> after your instructor emails you confirming that your manuscript has been checked.'
                    : 'No communication-letter pickup email notification has been sent to your account yet. You can only schedule a <strong>Pickup of Communication Letter</strong> after your instructor emails you confirming that your signed letter is ready for pickup.';
            }
        }

        const showAppointmentsLink = status.hasUpcoming || status.alreadyBooked;
        if (linkEl) linkEl.classList.toggle('hidden', !showAppointmentsLink);
        if (closeBtn) {
            closeBtn.classList.toggle('btn-primary', !showAppointmentsLink);
            closeBtn.classList.toggle('btn-ghost', showAppointmentsLink);
        }
    }

    function openRetrievalBlockedModal() {
        applyPickupBlockedContent({
            purpose: 'retrieval',
            titleSel: '#retrievalNoTitle',
            textSel: '#retrievalNoText',
            linkSel: '#retrievalAppointmentsLink',
            closeBtnSel: '#retrievalCloseBtn',
        });
        $('#retrievalAskView').classList.add('hidden');
        $('#retrievalNoView').classList.remove('hidden');
        $('#retrievalModal').classList.remove('hidden');
        syncModalBodyLock();
        setTimeout(() => $('#retrievalCloseBtn')?.focus(), 40);
    }

    function closeRetrievalModal() {
        $('#retrievalModal').classList.add('hidden');
        syncModalBodyLock();
    }

    /* ---------------- Email notification prerequisite modal for Pickup of Communication Letter ---------------- */
    function openLetterPickupModal() {
        $('#letterPickupAskView').classList.remove('hidden');
        $('#letterPickupNoView').classList.add('hidden');
        $('#letterPickupModal').classList.remove('hidden');
        syncModalBodyLock();
        setTimeout(() => $('#letterPickupYesBtn')?.focus(), 40);
    }

    function openLetterPickupBlockedModal() {
        applyPickupBlockedContent({
            purpose: 'letter_pickup',
            titleSel: '#letterPickupNoTitle',
            textSel: '#letterPickupNoText',
            linkSel: '#letterPickupAppointmentsLink',
            closeBtnSel: '#letterPickupCloseBtn',
        });
        $('#letterPickupAskView').classList.add('hidden');
        $('#letterPickupNoView').classList.remove('hidden');
        $('#letterPickupModal').classList.remove('hidden');
        syncModalBodyLock();
        setTimeout(() => $('#letterPickupCloseBtn')?.focus(), 40);
    }

    function closeLetterPickupModal() {
        $('#letterPickupModal').classList.add('hidden');
        syncModalBodyLock();
    }

    function latestMsFromList(values) {
        let best = null;
        for (const v of values) {
            if (!v) continue;
            const ms = new Date(v).getTime();
            if (Number.isFinite(ms) && (best === null || ms > best)) best = ms;
        }
        return best;
    }

    function getPickupEligibilityDetails(purpose) {
        const active = (state.myBookings || []).filter((b) => b.status !== 'cancelled');
        const counted = active.filter((b) => b.status !== 'no_show');
        const today = state.serverToday || state.config?.today || '';
        const curMin = state.serverCurrentMinute || 0;
        const isUpcoming = (b) => b.status === 'scheduled'
            && (!today || b.date > today || (b.date === today && (b.endMinute ?? 1440) > curMin));

        if (purpose === 'retrieval') {
            const elig = state.pickupEligibility;
            const notifiedMs = elig?.manuscriptNotifiedAt
                ? new Date(elig.manuscriptNotifiedAt).getTime()
                : latestMsFromList([
                    state.student?.manuscriptNotifiedAt,
                    ...active.filter((b) => b.consultationType === 'dropoff' && b.notifiedAt).map((b) => b.notifiedAt),
                ]);
            const bookedMs = latestMsFromList(
                counted.filter((b) => b.consultationType === 'retrieval').map((b) => b.createdAt)
            );
            const hasUpcoming = typeof elig?.hasUpcomingRetrieval === 'boolean'
                ? elig.hasUpcomingRetrieval
                : active.some((b) => b.consultationType === 'retrieval' && isUpcoming(b));
            const hasUnclaimed = Boolean(notifiedMs !== null && (bookedMs === null || notifiedMs > bookedMs));
            const canBook = !hasUpcoming && (elig
                ? Boolean(elig.canBookRetrieval)
                : hasUnclaimed);
            const alreadyBooked = typeof elig?.retrievalAlreadyBookedForNotification === 'boolean'
                ? elig.retrievalAlreadyBookedForNotification
                : Boolean(!hasUnclaimed && notifiedMs !== null);
            return { canBook, alreadyBooked, hasUpcoming };
        }

        if (purpose === 'letter_pickup') {
            const elig = state.pickupEligibility;
            const notifiedMs = elig?.letterNotifiedAt
                ? new Date(elig.letterNotifiedAt).getTime()
                : latestMsFromList([
                    state.student?.letterNotifiedAt,
                    ...active.filter((b) => b.consultationType === 'letter' && b.notifiedAt).map((b) => b.notifiedAt),
                ]);
            const bookedMs = latestMsFromList(
                counted.filter((b) => b.consultationType === 'letter_pickup').map((b) => b.createdAt)
            );
            const hasUpcoming = typeof elig?.hasUpcomingLetterPickup === 'boolean'
                ? elig.hasUpcomingLetterPickup
                : active.some((b) => b.consultationType === 'letter_pickup' && isUpcoming(b));
            const hasUnclaimed = Boolean(notifiedMs !== null && (bookedMs === null || notifiedMs > bookedMs));
            const canBook = !hasUpcoming && (elig
                ? Boolean(elig.canBookLetterPickup)
                : hasUnclaimed);
            const alreadyBooked = typeof elig?.letterPickupAlreadyBookedForNotification === 'boolean'
                ? elig.letterPickupAlreadyBookedForNotification
                : Boolean(!hasUnclaimed && notifiedMs !== null);
            return { canBook, alreadyBooked, hasUpcoming };
        }

        return { canBook: true, alreadyBooked: false, hasUpcoming: false };
    }

    function hasPickupNotification(purpose) {
        return getPickupEligibilityDetails(purpose).canBook;
    }

    async function onClickConsultationCard(purpose) {
        if (purpose === 'letter') {
            if (state.student?.instructorRole !== 'adviser') {
                toast('Communication Letter Signature is only available when Arnemie Gayyed is your Adviser.', 'error');
                return;
            }
            if (!state.beninsigConfirmed) {
                openBeninsigModal();
                return;
            }
        }
        if (purpose === 'letter_pickup') {
            if (state.student?.instructorRole !== 'adviser') {
                toast('Pickup of Communication Letter is only available when Arnemie Gayyed is your Adviser.', 'error');
                return;
            }
            if (state.pickupEligibility === null) {
                await loadMyBookings();
            }
            if (!hasPickupNotification('letter_pickup')) {
                state.letterPickupNotifiedConfirmed = false;
                openLetterPickupBlockedModal();
                return;
            }
            state.letterPickupNotifiedConfirmed = true;
        }
        if (purpose === 'retrieval') {
            if (state.pickupEligibility === null) {
                await loadMyBookings();
            }
            if (!hasPickupNotification('retrieval')) {
                state.retrievalNotifiedConfirmed = false;
                openRetrievalBlockedModal();
                return;
            }
            state.retrievalNotifiedConfirmed = true;
        }
        proceedWithConsultationPurpose(purpose);
    }

    function monthLoadKey(y = state.viewYear, m = state.viewMonth, purpose = state.consultationPurpose) {
        const base = `${monthKey(y, m)}#${purpose}`;
        const level = state.student?.projectLevel || state.defenseLevel || 'capstone1';
        return purpose === 'defense' ? `${base}#${level}` : base;
    }

    function minMonthKey() {
        if (!state.config) return '';
        return (state.config.firstBookableDate || state.config.today).slice(0, 7);
    }

    function maxMonthKeyForPurpose(purpose = state.consultationPurpose) {
        if (!state.config) return '';
        const lastBookable = state.config.lastBookableDate || `${state.config.today.slice(0, 4)}-12-12`;
        if (purpose === 'letter_pickup') {
            const decFallback = `${lastBookable.slice(0, 4)}-12`;
            const latestPickupKey = state.config.latestLetterPickupDate
                ? state.config.latestLetterPickupDate.slice(0, 7)
                : '';
            return [lastBookable.slice(0, 7), decFallback, latestPickupKey].sort().pop() || decFallback;
        }
        return lastBookable.slice(0, 7);
    }

    async function proceedWithConsultationPurpose(purpose) {
        const nextPurpose = Object.prototype.hasOwnProperty.call(PURPOSE_META, purpose) ? purpose : 'system';
        if (nextPurpose === 'defense') {
            state.defenseLevel = isDefenseLevel(state.student?.projectLevel) ? state.student.projectLevel : 'capstone1';
        }
        const purposeChanged = nextPurpose !== state.consultationPurpose;

        state.consultationPurpose = nextPurpose;
        document.querySelectorAll('.type-choice-card').forEach((card) => {
            card.classList.toggle('selected', card.dataset.purpose === nextPurpose);
        });

        updatePurposeUI();

        if (purposeChanged) {
            state.selectedSlot = null;
            state.loadingSlotsKey = null;
            state.loadedSlotsKey = null;
            state.activeWindowLabel = null;
            state.defenseDay = null;
        }
        updateSelectionBox();

        try {
            await ensureConfig();
        } catch {
            toast('Could not connect to the server. Please refresh the page.', 'error');
            return;
        }

        const minKey = minMonthKey();
        const maxKey = maxMonthKeyForPurpose(nextPurpose);
        const categoryKey = nextPurpose === 'defense'
            ? 'defense'
            : nextPurpose === 'letter_pickup'
                ? 'letter_pickup'
                : 'consultation';
        const earliestOpenDate = state.config?.earliestOpenDates?.[categoryKey] || null;
        if (purposeChanged && earliestOpenDate && (!state.selectedDate || state.selectedDate.slice(0, 7) < earliestOpenDate.slice(0, 7))) {
            const [ey, em] = earliestOpenDate.split('-').map(Number);
            state.viewYear = ey;
            state.viewMonth = em - 1;
        }
        const currentKey = monthKey(state.viewYear, state.viewMonth);
        if (minKey && currentKey < minKey) {
            const [y, m] = minKey.split('-').map(Number);
            state.viewYear = y;
            state.viewMonth = m - 1;
        } else if (maxKey && currentKey > maxKey && (!minKey || maxKey >= minKey)) {
            const [y, m] = maxKey.split('-').map(Number);
            state.viewYear = y;
            state.viewMonth = m - 1;
        }

        goToStep(2);

        const targetMonthLoadKey = monthLoadKey(state.viewYear, state.viewMonth, nextPurpose);
        if (!purposeChanged && state.loadedMonthKey === targetMonthLoadKey && state.selectedDate) {
            return;
        }

        const currentSelectedDate = state.selectedDate;
        const ok = await loadMonth();
        if (!ok) return;

        if (currentSelectedDate && state.monthDays[currentSelectedDate]?.bookable && state.monthDays[currentSelectedDate].open > 0) {
            await selectDate(currentSelectedDate, false, true);
        } else {
            const bookableInCurrent = Object.keys(state.monthDays).sort().filter((d) => state.monthDays[d]?.bookable);
            let firstOpen = bookableInCurrent.find((d) => state.monthDays[d].open > 0);
            const autoAdvanceLimit = maxMonthKeyForPurpose(nextPurpose);
            if (!bookableInCurrent.length && state.config && monthKey(state.viewYear, state.viewMonth) < autoAdvanceLimit) {
                const changed = await changeMonth(1);
                if (!changed) return;
                firstOpen = Object.keys(state.monthDays).sort().find((d) => state.monthDays[d].open > 0);
            }
            if (firstOpen) await selectDate(firstOpen, false, true);
            else resetSlotsPanel();
        }
    }

    /* ---------------- group members UI ---------------- */
    function getMemberInputs() {
        return Array.from(document.querySelectorAll('#memberList input'));
    }

    function syncMemberControls() {
        const rows = Array.from(document.querySelectorAll('#memberList .member-row'));
        const requiresAll = Boolean(state.consultationPurpose && getMeta().requiresAllMembers);
        const savedMembers = Array.isArray(state.student?.members) && state.student.members.length
            ? state.student.members.slice(0, MAX_MEMBERS)
            : (state.student?.name ? [state.student.name] : []);
        rows.forEach((row, idx) => {
            const input = row.querySelector('input');
            input.placeholder = idx === 0
                ? 'Member 1 (You)'
                : `Member ${idx + 1} — full name`;
            const removeBtn = row.querySelector('.remove-member');
            const isSelf = idx === 0 && Boolean(state.student);
            const isLockedRegisteredMember = requiresAll && Boolean(state.student) && idx < savedMembers.length;
            input.readOnly = isSelf || isLockedRegisteredMember;
            if (isSelf) input.value = state.student.name;
            else if (isLockedRegisteredMember) input.value = savedMembers[idx];
            removeBtn.disabled = isSelf || isLockedRegisteredMember || rows.length <= MIN_MEMBERS;
            removeBtn.title = isSelf
                ? 'You are always Member 1 on your booking'
                : isLockedRegisteredMember
                    ? 'All registered group members are required for this schedule'
                    : 'Remove member';
        });
        setText('#memberCount', `(${rows.length}/${MAX_MEMBERS})`);
        const hideAddBtn = rows.length >= MAX_MEMBERS || (requiresAll && Boolean(state.student));
        $('#addMemberBtn')?.classList.toggle('hidden', hideAddBtn);
    }

    function addMemberRow(initialValue = '', shouldFocus = false) {
        const list = $('#memberList');
        if (!list || list.children.length >= MAX_MEMBERS) return;

        const row = document.createElement('div');
        row.className = 'member-row';

        const input = document.createElement('input');
        input.type = 'text';
        input.maxLength = 100;
        input.value = initialValue;
        input.addEventListener('input', () => clearFieldError('#bookingMembersField'));

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'remove-member';
        removeBtn.setAttribute('aria-label', 'Remove member');
        removeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
        removeBtn.addEventListener('click', () => {
            if (removeBtn.disabled || list.children.length <= MIN_MEMBERS) return;
            row.remove();
            clearFieldError('#bookingMembersField');
            syncMemberControls();
        });

        row.append(input, removeBtn);
        list.appendChild(row);
        syncMemberControls();
        if (shouldFocus) input.focus();
    }

    function resetMembers() {
        const list = $('#memberList');
        if (!list) return;
        list.innerHTML = '';
        const savedMembers = state.student?.members;
        if (Array.isArray(savedMembers) && savedMembers.length >= MIN_MEMBERS) {
            savedMembers.slice(0, MAX_MEMBERS).forEach((m) => addMemberRow(m));
        } else {
            addMemberRow(state.student?.name || '');
        }
        if (state.student?.capstoneTitle && $('#teamInput') && !$('#teamInput').value.trim()) {
            $('#teamInput').value = state.student.capstoneTitle;
        }
    }

    function setBookingType(type) {
        const registeredCount = Array.isArray(state.student?.members) ? state.student.members.length : 1;
        const forcedGroup = (state.consultationPurpose && getMeta().requiresAllMembers) || registeredCount <= 1;
        state.bookingType = (forcedGroup || type === 'group') ? 'group' : 'individual';
        const isGroup = state.bookingType === 'group';
        const radio = document.querySelector(`input[name="bookingType"][value="${state.bookingType}"]`);
        if (radio) radio.checked = true;
        $('#individualFields')?.classList.toggle('hidden', isGroup);
        $('#groupFields')?.classList.toggle('hidden', !isGroup);
        syncMemberControls();
        clearFormFieldErrors('#bookingForm');
        setFormError('');
    }

    /* ---------------- calendar ---------------- */
    async function loadMonth() {
        const reqId = ++state.monthRequest;
        const purpose = state.consultationPurpose || 'system';
        const level = purpose === 'defense' ? (state.defenseLevel || state.student?.projectLevel || 'capstone1') : '';
        const key = monthKey(state.viewYear, state.viewMonth);
        const query = purpose === 'defense'
            ? `/api/month?month=${key}&purpose=defense&level=${encodeURIComponent(level)}`
            : `/api/month?month=${key}&purpose=${purpose}`;
        renderCalendar(true);
        try {
            const data = await api(query);
            if (reqId !== state.monthRequest) return false;
            state.monthDays = data.days;
            state.loadedMonthKey = monthLoadKey(state.viewYear, state.viewMonth, purpose);
        } catch (err) {
            if (reqId !== state.monthRequest) return false;
            state.monthDays = {};
            state.loadedMonthKey = null;
            toast(err.message, 'error');
        }
        renderCalendar(false);
        return true;
    }

    function renderCalendar(loading) {
        const { viewYear: y, viewMonth: m, config } = state;
        $('#monthLabel').textContent = new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-US', {
            month: 'long', year: 'numeric', timeZone: 'UTC',
        });

        const minKey = minMonthKey();
        const lastKey = maxMonthKeyForPurpose(state.consultationPurpose);
        const current = monthKey(y, m);
        $('#prevMonth').disabled = loading || (Boolean(minKey) && current <= minKey);
        $('#nextMonth').disabled = loading || (Boolean(lastKey) && current >= lastKey);

        const container = $('#days');
        container.classList.toggle('loading', loading);
        container.innerHTML = '';

        const firstDow = new Date(Date.UTC(y, m, 1)).getUTCDay();
        const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

        for (let i = 0; i < firstDow; i++) {
            const spacer = document.createElement('span');
            spacer.className = 'day-spacer';
            container.appendChild(spacer);
        }

        for (let d = 1; d <= daysInMonth; d++) {
            const ds = dateStr(y, m, d);
            const info = state.monthDays[ds];
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'day';
            btn.textContent = d;
            btn.dataset.date = ds;

            if (ds === config.today) {
                btn.classList.add('today');
                btn.title = 'Today — bookings must be made at least 1 day before the scheduled day';
            }

            if (loading) {
                btn.disabled = true;
            } else if (!info || !info.bookable) {
                if (ds === config.today) {
                    btn.setAttribute('aria-disabled', 'true');
                    btn.addEventListener('click', () => {
                        toast('Bookings must be made at least 1 day before the consultation day.', 'info');
                    });
                } else {
                    btn.disabled = true;
                }
            } else if (info.blocked && info.open === 0) {
                btn.classList.add('full', 'blocked');
                btn.setAttribute('aria-disabled', 'true');
                btn.title = info.blockReason
                    ? `Unavailable — ${info.blockReason}`
                    : 'Unavailable';
                btn.addEventListener('click', () => showCalendarDayNotice(ds));
            } else if (info.open === 0) {
                btn.classList.add('full');
                btn.setAttribute('aria-disabled', 'true');
                btn.title = 'Fully booked';
                btn.addEventListener('click', () => showCalendarDayNotice(ds));
            } else {
                btn.classList.add('available');
                const openTitle = state.consultationPurpose === 'dropoff'
                    ? 'Open for manuscript drop-off'
                    : state.consultationPurpose === 'letter_pickup'
                        ? `${info.open} pickup slot${info.open === 1 ? '' : 's'} open`
                        : state.consultationPurpose === 'defense'
                            ? `${info.open} defense window${info.open === 1 ? '' : 's'} available`
                            : `${info.open} slot${info.open === 1 ? '' : 's'} open`;
                btn.title = info.hasBlocks && info.blockReason
                    ? `${openTitle} (${info.blockReason})`
                    : openTitle;
                btn.addEventListener('click', () => selectDate(ds, true));
            }

            if (ds === state.selectedDate) btn.classList.add('selected');
            container.appendChild(btn);
        }

        if (!loading) {
            hideCalendarDayNotice();
        }
    }

    function hideCalendarDayNotice() {
        const notice = $('#calendarDayNotice');
        if (!notice) return;
        notice.textContent = '';
        notice.className = 'calendar-day-notice hidden';
    }

    function showCalendarDayNotice(ds) {
        const notice = $('#calendarDayNotice');
        if (!notice || !ds) return;
        const info = state.monthDays[ds];
        if (!info) return;

        const label = formatShortWeekdayDate(ds);
        if (info.blocked) {
            notice.textContent = info.blockReason
                ? `${label} — Unavailable: ${info.blockReason}`
                : `${label} — Unavailable`;
            notice.className = 'calendar-day-notice is-blocked';
        } else {
            notice.textContent = `${label} — Fully booked`;
            notice.className = 'calendar-day-notice is-full';
        }
    }

    function changeMonth(delta) {
        if (!state.config) return Promise.resolve(false);
        let m = state.viewMonth + delta;
        let y = state.viewYear;
        if (m < 0) { m = 11; y--; }
        if (m > 11) { m = 0; y++; }

        const targetKey = monthKey(y, m);
        const minKey = minMonthKey();
        const lastKey = maxMonthKeyForPurpose(state.consultationPurpose);
        if ((minKey && targetKey < minKey) || (lastKey && targetKey > lastKey)) return Promise.resolve(false);

        state.viewMonth = m;
        state.viewYear = y;
        return loadMonth();
    }

    /* ---------------- slots ---------------- */
    async function selectDate(ds, fromUser = false, force = false) {
        const purpose = state.consultationPurpose || 'system';
        const level = purpose === 'defense' ? (state.defenseLevel || state.student?.projectLevel || 'capstone1') : '';
        const key = purpose === 'defense' ? `${ds}#defense#${level}` : `${ds}#${purpose}`;
        if (!force && ds === state.selectedDate && (state.loadingSlotsKey === key || state.loadedSlotsKey === key)) {
            return;
        }

        state.selectedDate = ds;
        state.selectedSlot = null;
        state.loadingSlotsKey = key;
        state.loadedSlotsKey = null;
        state.activeWindowLabel = null;
        state.defenseDay = null;
        updateSelectionBox();
        hideCalendarDayNotice();

        document.querySelectorAll('.day.selected').forEach((el) => el.classList.remove('selected'));
        const btn = document.querySelector(`.day[data-date="${ds}"]`);
        if (btn) btn.classList.add('selected');

        $('#slotsTitle').textContent = formatLongDate(ds);
        $('#slotsSubtitle').textContent = 'Loading available times…';
        const tabsEl = $('#windowTabs');
        if (tabsEl) {
            tabsEl.innerHTML = '';
            tabsEl.classList.add('hidden');
        }
        const list = $('#slotList');
        list.innerHTML = '<div class="slot skeleton"></div>'.repeat(purpose === 'dropoff' ? 1 : 4);

        const reqId = ++state.slotsRequest;
        const query = purpose === 'defense'
            ? `/api/slots?date=${ds}&purpose=defense&level=${encodeURIComponent(level)}`
            : `/api/slots?date=${ds}&purpose=${purpose}`;
        try {
            const data = await api(query);
            if (reqId !== state.slotsRequest) return;
            state.loadingSlotsKey = null;
            state.loadedSlotsKey = key;
            if (purpose === 'defense') {
                state.defenseDay = data;
                renderDefenseSlots(data);
            } else {
                renderSlots(data.slots, data);
            }
            if (fromUser && window.innerWidth <= 820) {
                $('.slots')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        } catch (err) {
            if (reqId !== state.slotsRequest) return;
            state.loadingSlotsKey = null;
            list.innerHTML = '';
            $('#slotsSubtitle').textContent = 'Could not load time slots.';
            toast(err.message, 'error');
        }
    }

    /**
     * Parse a typed start time like "2:30", "2:30 PM", "11:30am", or "14:30".
     * If AM/PM is omitted (e.g. "2:30"), we check which meridiem fits the day's defense windows
     * (and in school hours 7:00–11:59 defaults to AM while 12:00–6:59 defaults to PM).
     */
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
            // School schedule heuristic: 7:00–11:55 is morning first, 12:00 and 1:00–6:55 is afternoon first
            if (hourNum >= 7 && hourNum <= 11) {
                candidates.push(amMin, pmMin);
            } else {
                candidates.push(pmMin, amMin);
            }
        } else {
            return { error: 'Please enter a valid hour (e.g. 11:30 AM or 2:30 PM).' };
        }

        // Prefer a candidate that falls inside one of today's defense windows
        const inWindow = candidates.find((m) =>
            windows.some((w) => m >= w.startMinute && m + durationMinutes <= w.endMinute)
        );
        const TouchWindow = candidates.find((m) =>
            windows.some((w) => m >= w.startMinute && m < w.endMinute)
        );
        const chosen = inWindow ?? TouchWindow ?? candidates[0];
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

        const matchingWin = windows.find((w) => startMinute >= w.startMinute && startMinute < w.endMinute);
        if (!matchingWin) {
            const winLabels = windows.map((w) => w.label).join(', ');
            return {
                ok: false,
                startMinute,
                endMinute,
                error: winLabels
                    ? `${formatMinute(startMinute)} is outside the defense schedule on this day (${winLabels}).`
                    : 'No defense windows are available on this day.',
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

    function renderDefenseSlots(data) {
        const list = $('#slotList');
        const tabsEl = $('#windowTabs');
        list.innerHTML = '';
        if (tabsEl) {
            tabsEl.innerHTML = '';
            tabsEl.classList.add('hidden');
        }

        const levelInfo = getDefenseLevelInfo(data.level) || DEFENSE_LEVELS.capstone1;
        const duration = data.durationMinutes || levelInfo.durationMinutes;
        const windows = data.windows || [];
        const fittingGaps = [];
        const busyLabels = [];
        windows.forEach((w) => {
            (w.busy || []).forEach((b) => busyLabels.push(b.label));
            (w.free || []).forEach((f) => {
                if (f.fits) fittingGaps.push({ ...f, windowLabel: w.label });
            });
        });

        if (fittingGaps.length) {
            $('#slotsSubtitle').textContent = `Open: ${fittingGaps.map((f) => f.label).join(' · ')}`;
        } else if (data.blocked || (data.blocks && data.blocks.length > 0)) {
            $('#slotsSubtitle').textContent = data.blockReason
                ? `Unavailable — ${data.blockReason}`
                : 'Unavailable on this date.';
        } else {
            $('#slotsSubtitle').textContent = `No open ${levelInfo.durationLabel} slot left on this day.`;
        }

        if (!fittingGaps.length) {
            list.innerHTML = '<div class="empty-state"><p>No available time on this day.</p></div>';
            return;
        }

        const suggestions = [];
        const seenStarts = new Set();
        fittingGaps.forEach((f) => {
            for (let m = f.earliestStartMinute; m <= f.latestStartMinute; m += 30) {
                if (!seenStarts.has(m)) {
                    seenStarts.add(m);
                    suggestions.push(m);
                }
            }
            if (!seenStarts.has(f.latestStartMinute)) {
                seenStarts.add(f.latestStartMinute);
                suggestions.push(f.latestStartMinute);
            }
        });

        const inputCard = document.createElement('div');
        inputCard.className = 'defense-input-card';

        if (busyLabels.length) {
            const busyEl = document.createElement('div');
            busyEl.className = 'defense-window-busy';
            busyEl.textContent = `Booked: ${busyLabels.join(', ')}`;
            inputCard.appendChild(busyEl);
        }

        const label = document.createElement('label');
        label.className = 'field';
        const labelSpan = document.createElement('span');
        labelSpan.textContent = `Start time (${levelInfo.durationLabel})`;

        const helperHint = document.createElement('small');
        helperHint.className = 'muted field-hint';
        helperHint.textContent = `Tap a suggested time below, or type any start time in ${data.startStep || 5}-minute increments (e.g. ${formatMinute(fittingGaps[0].earliestStartMinute)}) that fits inside the open window.`;

        const timeInput = document.createElement('input');
        timeInput.type = 'text';
        timeInput.id = 'defenseStartInput';
        timeInput.placeholder = `e.g. ${formatMinute(fittingGaps[0].earliestStartMinute)} or 2:30`;
        timeInput.autocomplete = 'off';

        label.append(labelSpan, helperHint, timeInput);
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
                    applyTypedTime(timeInput.value, true);
                });
                chipsRow.appendChild(chip);
            });
            inputCard.appendChild(chipsRow);
        }

        const feedback = document.createElement('div');
        feedback.className = 'defense-time-feedback hidden';
        feedback.id = 'defenseTimeFeedback';
        inputCard.appendChild(feedback);

        const continueBtn = document.createElement('button');
        continueBtn.type = 'button';
        continueBtn.className = 'btn btn-primary btn-block hidden';
        continueBtn.id = 'defenseContinueBtn';
        continueBtn.textContent = 'Continue →';
        continueBtn.addEventListener('click', () => {
            if (state.selectedSlot) goToStep(3);
        });
        inputCard.appendChild(continueBtn);

        function applyTypedTime(rawValue, fromChip = false) {
            const raw = String(rawValue || '').trim();
            document.querySelectorAll('.defense-time-chip').forEach((c) => c.classList.remove('active'));
            if (!raw) {
                state.selectedSlot = null;
                updateSelectionBox();
                feedback.className = 'defense-time-feedback hidden';
                feedback.textContent = '';
                continueBtn.classList.add('hidden');
                timeInput.classList.remove('input-invalid');
                return;
            }

            const parsed = parseTypedDefenseTime(raw, windows, duration);
            if (parsed.error) {
                state.selectedSlot = null;
                updateSelectionBox();
                feedback.className = 'defense-time-feedback is-error';
                feedback.textContent = parsed.error;
                continueBtn.classList.add('hidden');
                timeInput.classList.add('input-invalid');
                return;
            }

            const check = validateDefenseStartMinute(parsed.startMinute, data);
            if (!check.ok) {
                state.selectedSlot = null;
                updateSelectionBox();
                feedback.className = 'defense-time-feedback is-error';
                feedback.textContent = check.error;
                continueBtn.classList.add('hidden');
                timeInput.classList.add('input-invalid');
                return;
            }

            timeInput.classList.remove('input-invalid');
            const matchingChip = document.querySelector(`.defense-time-chip[data-minute="${check.startMinute}"]`);
            if (matchingChip) matchingChip.classList.add('active');
            if (fromChip) timeInput.value = formatMinute(check.startMinute);

            state.selectedSlot = {
                startMinute: check.startMinute,
                endMinute: check.endMinute,
                durationMinutes: duration,
                isDropoff: false,
                label: formatMinute(check.startMinute),
                endLabel: formatMinute(check.endMinute),
                windowLabel: check.windowLabel,
            };
            updateSelectionBox();

            feedback.className = 'defense-time-feedback is-valid';
            feedback.innerHTML = `<strong>${formatMinute(check.startMinute)} – ${formatMinute(check.endMinute)}</strong> (${levelInfo.durationLabel})`;
            continueBtn.textContent = 'Continue →';
            continueBtn.classList.remove('hidden');
        }

        timeInput.addEventListener('input', () => applyTypedTime(timeInput.value, false));
        timeInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                applyTypedTime(timeInput.value, true);
                if (state.selectedSlot) goToStep(3);
            }
        });

        list.appendChild(inputCard);

        if (state.selectedSlot) {
            timeInput.value = state.selectedSlot.label;
            applyTypedTime(timeInput.value, true);
        }
    }

    function createSlotButton(slot, i) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'slot' + (slot.isDropoff ? ' slot-dropoff' : '');
        btn.style.animationDelay = `${Math.min(i, 12) * 18}ms`;

        const time = document.createElement('span');
        time.className = 'slot-time';
        time.textContent = slot.label;

        const range = document.createElement('span');
        range.className = 'slot-range';
        if (!slot.available) {
            if (slot.blocked) {
                range.textContent = slot.blockReason
                    ? `Unavailable — ${slot.blockReason}`
                    : 'Unavailable';
            } else {
                range.textContent = 'Booked';
            }
        } else if (slot.isDropoff) {
            range.textContent = 'Drop-off window';
        } else {
            range.textContent = `until ${slot.endLabel}`;
        }
        btn.append(time, range);

        if (!slot.available) {
            btn.disabled = true;
            btn.classList.add('taken');
        } else {
            if (state.selectedSlot && state.selectedSlot.startMinute === slot.startMinute) {
                btn.classList.add('selected');
                btn.appendChild(createNextBadge());
            }
            btn.addEventListener('click', () => selectSlot(slot, btn));
        }
        return btn;
    }

    function createNextBadge() {
        const next = document.createElement('span');
        next.className = 'slot-next';
        next.textContent = 'Continue →';
        next.addEventListener('click', (e) => {
            e.stopPropagation();
            goToStep(3);
        });
        return next;
    }

    function renderSlots(slots, data = null) {
        const list = $('#slotList');
        const tabsEl = $('#windowTabs');
        list.innerHTML = '';
        if (tabsEl) {
            tabsEl.innerHTML = '';
            tabsEl.classList.add('hidden');
        }

        const openCount = slots.filter((s) => s.available).length;
        const meta = getMeta();
        const hasBlocks = Boolean(data?.blocked || (data?.blocks && data.blocks.length > 0));

        if (!openCount && hasBlocks) {
            $('#slotsSubtitle').textContent = data?.blockReason
                ? `Unavailable — ${data.blockReason}`
                : 'Unavailable on this date.';
        } else if (state.consultationPurpose === 'dropoff') {
            $('#slotsSubtitle').textContent = openCount
                ? 'Select the drop-off window below'
                : 'Drop-off is not available on this day.';
        } else {
            $('#slotsSubtitle').textContent = openCount
                ? `${openCount} of ${slots.length} ${slots.length === 1 ? 'slot' : 'slots'} available · ${meta.badge} each`
                : 'No more open slots on this day.';
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

        if (windows.length > 1 && tabsEl && state.consultationPurpose !== 'dropoff') {
            if (!state.activeWindowLabel || !byWindow.has(state.activeWindowLabel)) {
                state.activeWindowLabel =
                    windows.find((w) => byWindow.get(w).some((s) => s.available)) || windows[0];
            }

            tabsEl.classList.remove('hidden');
            windows.forEach((w) => {
                const winSlots = byWindow.get(w);
                const winOpen = winSlots.filter((s) => s.available).length;
                const tab = document.createElement('button');
                tab.type = 'button';
                tab.className = 'window-tab'
                    + (w === state.activeWindowLabel ? ' active' : '')
                    + (winOpen === 0 ? ' window-tab-empty' : '');
                tab.textContent = `${w} (${winOpen})`;
                tab.addEventListener('click', () => {
                    if (state.activeWindowLabel === w) return;
                    state.activeWindowLabel = w;
                    renderSlots(slots, data);
                    list.scrollTop = 0;
                });
                tabsEl.appendChild(tab);
            });

            const activeSlots = byWindow.get(state.activeWindowLabel) || [];
            activeSlots.forEach((slot, i) => list.appendChild(createSlotButton(slot, i)));
            return;
        }

        slots.forEach((slot, i) => {
            list.appendChild(createSlotButton(slot, i));
        });
    }

    function selectSlot(slot, btn) {
        if (btn.classList.contains('selected')) {
            goToStep(3);
            return;
        }

        document.querySelectorAll('.slot.selected').forEach((el) => {
            el.classList.remove('selected');
            const next = el.querySelector('.slot-next');
            if (next) next.remove();
        });

        state.selectedSlot = slot;
        btn.classList.add('selected');
        updateSelectionBox();
        btn.appendChild(createNextBadge());
    }

    /* ---------------- booking form ---------------- */
    function setSubmitting(on) {
        state.submitting = on;
        const btn = $('#submitBtn');
        btn.disabled = on;
        btn.querySelector('.spinner').classList.toggle('hidden', !on);
        btn.querySelector('.btn-label').textContent = on ? 'Scheduling…' : 'Confirm booking';
    }

    async function submitBooking(e) {
        e.preventDefault();
        if (state.submitting) return;
        clearFormFieldErrors('#bookingForm');
        setFormError('');

        if (!state.student) {
            showAuthGate();
            return;
        }
        if (!state.consultationPurpose) {
            goToStep(1);
            return;
        }
        if (state.consultationPurpose === 'letter') {
            if (state.student.instructorRole !== 'adviser') {
                toast('Communication Letter Signature is only available when Arnemie Gayyed is your Adviser.', 'error');
                resetBooking();
                return;
            }
            if (!state.beninsigConfirmed) {
                openBeninsigModal();
                return;
            }
        }
        if (state.consultationPurpose === 'letter_pickup') {
            if (state.student.instructorRole !== 'adviser') {
                toast('Pickup of Communication Letter is only available when Arnemie Gayyed is your Adviser.', 'error');
                resetBooking();
                return;
            }
            if (!hasPickupNotification('letter_pickup')) {
                state.letterPickupNotifiedConfirmed = false;
                openLetterPickupBlockedModal();
                return;
            }
            state.letterPickupNotifiedConfirmed = true;
        }
        if (state.consultationPurpose === 'retrieval') {
            if (!hasPickupNotification('retrieval')) {
                state.retrievalNotifiedConfirmed = false;
                openRetrievalBlockedModal();
                return;
            }
            state.retrievalNotifiedConfirmed = true;
        }
        if (!state.selectedDate || !state.selectedSlot) {
            goToStep(2);
            return;
        }

        const meta = getMeta();
        const teamName = $('#teamInput').value.trim();
        if (teamName.length < 2) {
            setFieldError('#teamInput', 'Please enter your Capstone / Thesis title (at least 2 characters).');
            return;
        }

        const reason = $('#reasonInput').value.trim();
        let payload;

        if (state.bookingType === 'group' || meta.requiresAllMembers) {
            const inputs = getMemberInputs();
            const emptyInput = inputs.find((el) => el.value.trim().length === 0);
            if (emptyInput) {
                setFieldError(
                    '#bookingMembersField',
                    'Please enter this member’s full name, or click × to remove the empty row.',
                    emptyInput
                );
                return;
            }
            const shortInput = inputs.find((el) => el.value.trim().length < 2);
            if (shortInput) {
                setFieldError('#bookingMembersField', 'Each member needs a full name (at least 2 characters).', shortInput);
                return;
            }
            const savedMembers = Array.isArray(state.student?.members) && state.student.members.length
                ? state.student.members.slice(0, MAX_MEMBERS)
                : null;
            const members = (meta.requiresAllMembers && savedMembers)
                ? [...savedMembers]
                : inputs.map((el) => el.value.trim()).filter(Boolean).slice(0, MAX_MEMBERS);
            payload = {
                type: 'group',
                consultationType: state.consultationPurpose,
                defenseLevel: state.consultationPurpose === 'defense' ? state.defenseLevel : undefined,
                beninsigInitialConfirmed: state.beninsigConfirmed,
                retrievalEmailConfirmed: state.retrievalNotifiedConfirmed,
                letterPickupEmailConfirmed: state.letterPickupNotifiedConfirmed,
                teamName,
                members,
                reason,
                date: state.selectedDate,
                startMinute: state.selectedSlot.startMinute,
            };
        } else {
            payload = {
                type: 'individual',
                consultationType: state.consultationPurpose,
                defenseLevel: state.consultationPurpose === 'defense' ? state.defenseLevel : undefined,
                beninsigInitialConfirmed: state.beninsigConfirmed,
                retrievalEmailConfirmed: state.retrievalNotifiedConfirmed,
                letterPickupEmailConfirmed: state.letterPickupNotifiedConfirmed,
                teamName,
                reason,
                date: state.selectedDate,
                startMinute: state.selectedSlot.startMinute,
            };
        }

        if (!meta.reasonOptional && reason.length < 5) {
            setFieldError('#reasonInput', 'Please provide brief details (at least 5 characters).');
            return;
        }
        if (meta.reasonOptional && reason.length > 0 && reason.length < 5) {
            setFieldError('#reasonInput', 'Please enter at least 5 characters, or leave this field blank.');
            return;
        }

        setSubmitting(true);
        try {
            const { booking, student: updatedStudent } = await api('/api/bookings', {
                method: 'POST',
                body: JSON.stringify(payload),
            });
            state.lastBookedId = booking.id;
            state.selectedSlot = null;
            if (updatedStudent) {
                state.student = updatedStudent;
                updateRoleVisibility();
            }
            loadMyBookings();
            window.SchedulerRealtime?.notifyLocal({
                type: 'booking_created',
                date: booking.date,
                bookingId: booking.id,
            });
            showConfirmation(booking);
        } catch (err) {
            if (err.status === 401) {
                setStudent(null);
                setAuthMode('login');
                setAuthError('Your session has expired. Please log in again to continue.');
            } else if (err.code === 'ADVISER_ONLY') {
                toast(err.message, 'error');
                resetBooking();
            } else if (err.code === 'BENINSIG_REQUIRED') {
                state.beninsigConfirmed = false;
                openBeninsigModal();
            } else if (err.code === 'RETRIEVAL_EMAIL_REQUIRED') {
                state.retrievalNotifiedConfirmed = false;
                await loadMyBookings();
                resetBooking();
                openRetrievalBlockedModal();
            } else if (err.code === 'LETTER_PICKUP_EMAIL_REQUIRED') {
                state.letterPickupNotifiedConfirmed = false;
                await loadMyBookings();
                resetBooking();
                openLetterPickupBlockedModal();
            } else if (err.field === 'teamName') {
                setFieldError('#teamInput', err.message);
            } else if (err.field === 'members') {
                setFieldError('#bookingMembersField', err.message);
            } else if (err.field === 'reason') {
                setFieldError('#reasonInput', err.message);
            } else if (err.code === 'BOOKING_LIMIT') {
                setFormError(err.message);
            } else if (err.status === 409 || err.status === 400) {
                toast(err.message, 'error');
                const date = state.selectedDate;
                state.selectedSlot = null;
                updateSelectionBox();
                goToStep(2);
                loadMonth().then((ok) => {
                    if (ok && date) selectDate(date, false, true);
                });
            } else {
                setFormError(err.message);
            }
        } finally {
            setSubmitting(false);
        }
    }

    function showConfirmation(b) {
        state.selectedSlot = null;
        const meta = getMeta(b.consultationType, b.defenseLevel);
        const hasMultipleMembers = Array.isArray(b.members) && b.members.length >= 2;
        const capstone = b.capstoneTitle || b.teamName || state.student?.capstoneTitle || null;
        const isDefense = b.consultationType === 'defense';

        setText('#confirmHeading', b.isDropoff ? 'Drop-off scheduled!' : isDefense ? 'Defense scheduled!' : 'Scheduled!');
        setText('#cPurposeLabel', isDefense ? 'Defense' : 'Consultation');
        setText('#cPurpose', `${b.consultationTitle || meta.title} (${b.durationLabel || meta.badge})`);

        $('#cTeamRow')?.classList.toggle('hidden', !capstone);
        if (capstone) {
            setText('#cTeam', capstone);
        }
        if (hasMultipleMembers) {
            setText('#cNameLabel', `Members (${b.members.length})`);
            setText('#cName', b.members.join(', '));
        } else {
            setText('#cNameLabel', 'Member');
            setText('#cName', b.members?.[0] || b.name);
        }
        setText('#cDate', formatLongDate(b.date));
        setText('#cTime', b.label);
        setText('#cLocation', state.config?.location || 'Faculty Office');
        setText('#cReason', b.reason);
        setText('#cRef', b.reference);

        const confirmCallout = $('#cConfirmCallout');
        if (confirmCallout) {
            if (meta.confirmHtml) {
                confirmCallout.className = `policy-callout ${meta.color}`;
                confirmCallout.innerHTML = meta.confirmHtml;
            } else {
                confirmCallout.innerHTML = '';
                confirmCallout.classList.add('hidden');
            }
        }

        const emailAddr = b.studentEmail || state.student?.email || '';
        setText(
            '#cEmailNotice',
            emailAddr
                ? `Confirmation & calendar invite sent to ${emailAddr}.`
                : 'Confirmation & calendar invite sent to your school email.'
        );
        const outlookCalBtn = $('#cOutlookCalBtn');
        if (outlookCalBtn) {
            outlookCalBtn.href = b.outlookCalendarUrl || '#';
            outlookCalBtn.classList.toggle('hidden', !b.outlookCalendarUrl);
        }
        const downloadIcsBtn = $('#cDownloadIcsBtn');
        if (downloadIcsBtn) {
            const icsHref = b.icsUrl || (b.id ? `/api/bookings/${b.id}/ics` : '');
            downloadIcsBtn.href = icsHref || '#';
            if (b.reference) {
                downloadIcsBtn.download = `consultation-${String(b.reference).toLowerCase()}.ics`;
            }
            downloadIcsBtn.classList.toggle('hidden', !icsHref);
        }

        goToStep(4);
    }

    function resetBooking() {
        $('#bookingForm').reset();
        $('#reasonCount').textContent = '0';
        clearFormFieldErrors('#bookingForm');
        setFormError('');
        if (state.student?.capstoneTitle && $('#teamInput')) {
            $('#teamInput').value = state.student.capstoneTitle;
        }
        resetMembers();
        state.consultationPurpose = null;
        state.defenseLevel = isDefenseLevel(state.student?.projectLevel) ? state.student.projectLevel : null;
        state.defenseDay = null;
        state.beninsigConfirmed = false;
        state.retrievalNotifiedConfirmed = false;
        state.letterPickupNotifiedConfirmed = false;
        state.selectedSlot = null;
        state.loadedMonthKey = null;
        state.loadedSlotsKey = null;
        setBookingType('group');
        document.querySelectorAll('.type-choice-card').forEach((card) => card.classList.remove('selected'));
        updateSelectionBox();
        goToStep(1);
    }

    function resetSlotsPanel() {
        state.selectedDate = null;
        state.loadingSlotsKey = null;
        state.loadedSlotsKey = null;
        document.querySelectorAll('#days .day.selected').forEach((el) => el.classList.remove('selected'));
        updateSelectionBox();
        hideCalendarDayNotice();
        const tabsEl = $('#windowTabs');
        if (tabsEl) {
            tabsEl.innerHTML = '';
            tabsEl.classList.add('hidden');
        }
        const hasOpenDays = Object.values(state.monthDays || {}).some((d) => d?.bookable && d.open > 0);
        if (!hasOpenDays) {
            const isPickup = state.consultationPurpose === 'letter_pickup';
            $('#slotsTitle').textContent = isPickup ? 'No pickup dates open' : 'No dates open in this month';
            $('#slotsSubtitle').textContent = isPickup
                ? 'No Communication Letter Pickup schedule is open for this month yet.'
                : 'No available dates are open in this month yet.';
            $('#slotList').innerHTML = `
                <div class="empty-state">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
                    <p>${isPickup
                        ? 'No dates are open for Communication Letter Pickup in this month yet. Please check another month or wait for your instructor to post available pickup times.'
                        : 'No dates are open in this month yet. Use the calendar arrows to check another month, or check back once your instructor opens dates.'}</p>
                </div>`;
            return;
        }
        $('#slotsTitle').textContent = 'Select a date';
        $('#slotsSubtitle').textContent = 'Pick an available day on the calendar.';
        $('#slotList').innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
                <p>Pick a highlighted day on the calendar.</p>
            </div>`;
    }

    /* ---------------- student profile modal & booking badges ---------------- */
    const DISMISSED_CANCEL_KEY = 'ag_dismissed_cancelled_v1';

    function getDismissedCancelled() {
        try {
            const parsed = JSON.parse(localStorage.getItem(DISMISSED_CANCEL_KEY) || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    function dismissCancelledNotice(id) {
        const current = new Set(getDismissedCancelled());
        current.add(id);
        try {
            localStorage.setItem(DISMISSED_CANCEL_KEY, JSON.stringify([...current].slice(-30)));
        } catch { /* ignore storage quota */ }
        renderCancelledAlertBanner();
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

    function renderCancelledAlertBanner() {
        const banner = $('#cancelledAlertBanner');
        const dot = $('#profileCancelDot');
        if (!state.student) {
            banner?.classList.add('hidden');
            dot?.classList.add('hidden');
            return;
        }

        const today = state.serverToday || state.config?.today || '';
        const dismissed = new Set(getDismissedCancelled());
        const recentCancelled = state.myBookings
            .filter(
                (b) => b.status === 'cancelled'
                    && b.cancellationReason !== 'Cancelled by student.'
                    && (!today || b.date >= today)
                    && !dismissed.has(b.id)
            )
            .sort((a, b) => (b.cancelledAt || b.date).localeCompare(a.cancelledAt || a.date));

        dot?.classList.toggle('hidden', recentCancelled.length === 0);

        if (!banner) return;
        if (!recentCancelled.length) {
            banner.classList.add('hidden');
            banner.innerHTML = '';
            return;
        }

        const latest = recentCancelled[0];
        banner.innerHTML = '';

        const body = document.createElement('div');
        body.className = 'cancelled-alert-body';

        const title = document.createElement('strong');
        title.textContent = `Cancelled: ${latest.consultationTitle} on ${formatLongDate(latest.date)} (${latest.label})`;

        const reasonLine = document.createElement('p');
        reasonLine.textContent = `Reason: ${latest.cancellationReason || 'Please reschedule for another available slot.'}`;

        body.append(title, reasonLine);

        const actions = document.createElement('div');
        actions.className = 'cancelled-alert-actions';

        const viewBtn = document.createElement('a');
        viewBtn.href = '/appointments.html';
        viewBtn.className = 'btn btn-ghost btn-sm';
        viewBtn.textContent = 'View Appointments';

        const dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.className = 'link-btn';
        dismissBtn.textContent = 'Dismiss';
        dismissBtn.addEventListener('click', () => dismissCancelledNotice(latest.id));

        actions.append(viewBtn, dismissBtn);
        banner.append(body, actions);
        banner.classList.remove('hidden');
    }

    function renderProfileSummary() {
        if (!state.student) return;
        const s = state.student;
        setText('#profileCapstoneTitle', s.capstoneTitle || s.name);
        setText('#profileRepName', s.name);
        setText('#profileRepEmail', s.email);

        const levelBadge = $('#profileLevelBadge');
        if (levelBadge) {
            const levelInfo = getDefenseLevelInfo(s.projectLevel);
            levelBadge.textContent = levelInfo ? levelInfo.label : '';
            levelBadge.classList.toggle('hidden', !levelInfo);
        }

        const roleBadge = $('#profileRoleBadge');
        if (roleBadge) {
            const isPanel = s.instructorRole === 'panel';
            roleBadge.textContent = isPanel ? 'Panel Member' : 'Adviser';
            roleBadge.className = `badge ${isPanel ? 'sky' : 'teal'}`;
            roleBadge.classList.toggle('hidden', !s.instructorRole);
        }

        const chipsWrap = $('#profileMemberChips');
        if (chipsWrap) {
            chipsWrap.innerHTML = '';
            const members = Array.isArray(s.members) && s.members.length ? s.members : [s.name];
            members.forEach((m, idx) => {
                const chip = document.createElement('span');
                chip.className = 'member-chip';
                chip.textContent = idx === 0 ? `${m} (Rep)` : m;
                chipsWrap.appendChild(chip);
            });
        }
    }

    function renderStep1EligibilityBadges() {
        const retrievalBadge = $('#retrievalStatusBadge');
        const letterPickupBadge = $('#letterPickupStatusBadge');
        if (!state.student) {
            retrievalBadge?.classList.add('hidden');
            letterPickupBadge?.classList.add('hidden');
            return;
        }

        const applyBadge = (el, purpose) => {
            if (!el) return;
            if (state.pickupEligibility === null) {
                el.classList.add('hidden');
                return;
            }
            const status = getPickupEligibilityDetails(purpose);
            if (status.canBook) {
                el.textContent = 'Ready to book ✓';
                el.className = 'badge teal';
            } else if (status.hasUpcoming) {
                el.textContent = 'Scheduled ✓';
                el.className = 'badge sky';
            } else if (status.alreadyBooked) {
                el.textContent = 'Booked for latest notice';
                el.className = 'badge muted-badge';
            } else {
                el.textContent = 'Awaiting email notice';
                el.className = 'badge amber';
            }
        };

        applyBadge(retrievalBadge, 'retrieval');
        if (state.student.instructorRole === 'adviser') {
            applyBadge(letterPickupBadge, 'letter_pickup');
        } else {
            letterPickupBadge?.classList.add('hidden');
        }
    }

    async function loadMyBookings() {
        if (!state.student) {
            state.myBookings = [];
            state.pickupEligibility = null;
            $('#myAppointmentsLink')?.classList.add('hidden');
            $('#myBookingsBtn')?.classList.add('hidden');
            $('#profileCancelDot')?.classList.add('hidden');
            $('#cancelledAlertBanner')?.classList.add('hidden');
            renderStep1EligibilityBadges();
            return;
        }
        $('#myAppointmentsLink')?.classList.remove('hidden');
        $('#myBookingsBtn')?.classList.remove('hidden');
        try {
            const data = await api('/api/my-bookings');
            state.myBookings = data.bookings || [];
            state.pickupEligibility = data.eligibility || null;
            if (data.today) state.serverToday = data.today;
            if (typeof data.currentMinute === 'number') state.serverCurrentMinute = data.currentMinute;

            const upcomingCount = state.myBookings.filter((b) => bookingCategory(b) === 'upcoming').length;
            const countEl = $('#myBookingsCount');
            if (countEl) {
                countEl.textContent = upcomingCount;
                countEl.classList.toggle('hidden', upcomingCount === 0);
            }
            renderCancelledAlertBanner();
            renderStep1EligibilityBadges();
        } catch {
            /* ignore background fetch error */
        }
    }

    function openMyBookingsModal(startInEditMode = false) {
        renderProfileSummary();
        if (startInEditMode) {
            populateProfileEditForm();
            setProfileModalView('edit');
        } else {
            setProfileModalView('summary');
        }
        $('#myBookingsModal').classList.remove('hidden');
        syncModalBodyLock();
    }

    function closeMyBookingsModal() {
        if (state.profileBusy) return;
        clearInterval(state.profileResendTimer);
        $('#myBookingsModal').classList.add('hidden');
        syncModalBodyLock();
    }

    /* ---------------- student profile edit & email OTP verification ---------------- */
    const PROFILE_FIELD_MAP = {
        profileName: '#profileName',
        profileEmail: '#profileEmail',
        profileCapstone: '#profileCapstone',
        profileRole: '#profileRoleField',
        profileLevel: '#profileLevelField',
        profileMembers: '#profileMembersField',
    };

    function setProfileModalView(view) {
        state.profileView = view;
        showBannerError('#profileEditError', '');
        showBannerError('#profileOtpError', '');
        clearFormFieldErrors('#profileEditForm');
        clearFormFieldErrors('#profileOtpForm');

        $('#profileSummaryView')?.classList.toggle('hidden', view !== 'summary');
        $('#profileEditForm')?.classList.toggle('hidden', view !== 'edit');
        $('#profileOtpForm')?.classList.toggle('hidden', view !== 'otp');

        const titles = {
            summary: 'Profile',
            edit: 'Edit registration info',
            otp: 'Verify new email',
        };
        setText('#myBookingsTitle', titles[view] || 'Profile');
    }

    function getProfileMemberInputs() {
        return Array.from(document.querySelectorAll('#profileMemberList input'));
    }

    function syncProfileMemberControls() {
        const rows = Array.from(document.querySelectorAll('#profileMemberList .member-row'));
        const repName = $('#profileName')?.value.trim() || '';
        rows.forEach((row, idx) => {
            const input = row.querySelector('input');
            const removeBtn = row.querySelector('.remove-member');
            if (idx === 0) {
                input.readOnly = true;
                input.value = repName;
                input.placeholder = 'Member 1 (You) — auto-filled from your name above';
                removeBtn.disabled = true;
                removeBtn.title = 'You are always Member 1';
            } else {
                input.readOnly = false;
                input.placeholder = `Member ${idx + 1} — full name`;
                removeBtn.disabled = false;
                removeBtn.title = 'Remove member';
            }
        });
        setText('#profileMemberCount', `(${rows.length}/${MAX_MEMBERS})`);
        $('#profileAddMemberBtn')?.classList.toggle('hidden', rows.length >= MAX_MEMBERS);
    }

    function addProfileMemberRow(initialValue = '', shouldFocus = false) {
        const list = $('#profileMemberList');
        if (!list || list.children.length >= MAX_MEMBERS) return;

        const row = document.createElement('div');
        row.className = 'member-row';

        const input = document.createElement('input');
        input.type = 'text';
        input.maxLength = 100;
        input.value = initialValue;
        input.addEventListener('input', () => clearFieldError('#profileMembersField'));

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'remove-member';
        removeBtn.setAttribute('aria-label', 'Remove member');
        removeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
        removeBtn.addEventListener('click', () => {
            if (list.children.length <= MIN_MEMBERS) return;
            row.remove();
            clearFieldError('#profileMembersField');
            syncProfileMemberControls();
        });

        row.append(input, removeBtn);
        list.appendChild(row);
        syncProfileMemberControls();
        if (shouldFocus) input.focus();
    }

    function syncProfileSaveButtonLabel() {
        const saveBtn = $('#saveProfileBtn');
        if (!saveBtn || state.profileBusy) return;
        const emailVal = ($('#profileEmail')?.value || '').trim().toLowerCase();
        const currentEmail = (state.student?.email || '').trim().toLowerCase();
        const emailChanged = Boolean(emailVal && currentEmail && emailVal !== currentEmail);
        const labelText = emailChanged ? 'Send OTP & save' : 'Save changes';
        saveBtn.dataset.label = labelText;
        const labelSpan = saveBtn.querySelector('.btn-label');
        if (labelSpan) labelSpan.textContent = labelText;
    }

    function populateProfileEditForm() {
        const s = state.student;
        if (!s) return;
        if ($('#profileName')) $('#profileName').value = s.name || '';
        if ($('#profileEmail')) $('#profileEmail').value = s.email || '';
        if ($('#profileCapstone')) $('#profileCapstone').value = s.capstoneTitle || '';

        const roleVal = s.instructorRole === 'panel' ? 'panel' : 'adviser';
        const roleRadio = document.querySelector(`input[name="profileRole"][value="${roleVal}"]`);
        if (roleRadio) roleRadio.checked = true;

        document.querySelectorAll('input[name="profileLevel"]').forEach((r) => {
            r.checked = r.value === s.projectLevel;
        });

        const list = $('#profileMemberList');
        if (list) {
            list.innerHTML = '';
            const members = Array.isArray(s.members) && s.members.length ? s.members : [s.name || ''];
            members.slice(0, MAX_MEMBERS).forEach((m) => addProfileMemberRow(m));
        }
        syncProfileMemberControls();
        syncProfileSaveButtonLabel();
    }

    function startProfileResendCountdown(seconds = 60) {
        const btn = $('#profileOtpResendBtn');
        if (!btn) return;
        clearInterval(state.profileResendTimer);
        let left = seconds;
        const tick = () => {
            btn.disabled = left > 0;
            btn.textContent = left > 0 ? `Resend code (${left}s)` : 'Resend code';
            if (left-- <= 0) clearInterval(state.profileResendTimer);
        };
        tick();
        state.profileResendTimer = setInterval(tick, 1000);
    }

    function applyUpdatedStudentState(updatedStudent) {
        const prevLevel = state.student?.projectLevel;
        state.student = updatedStudent;
        state.defenseLevel = isDefenseLevel(updatedStudent?.projectLevel) ? updatedStudent.projectLevel : null;

        const myBookingsBtn = $('#myBookingsBtn');
        if (myBookingsBtn) {
            const membersStr = Array.isArray(updatedStudent.members) && updatedStudent.members.length
                ? updatedStudent.members.join(', ')
                : updatedStudent.name;
            myBookingsBtn.title = `Profile · Members: ${membersStr}`;
        }

        if ($('#teamInput')) {
            $('#teamInput').value = updatedStudent.capstoneTitle || '';
        }
        resetMembers();
        updateRoleVisibility();
        renderProfileSummary();
        loadMyBookings();

        // If the student was viewing Communication Letter steps and switched role to Panel, return to Step 1
        if (!state.consultationPurpose && (state.currentStep === 2 || state.currentStep === 3)) {
            goToStep(1);
            return;
        }

        // If defense course level changed while on Step 2 or Step 3 for defense, refresh availability
        if (state.consultationPurpose === 'defense' && prevLevel !== updatedStudent.projectLevel) {
            updatePurposeUI();
            updateSelectionBox();
            if (state.currentStep === 2 || state.currentStep === 3) {
                const date = state.selectedDate;
                state.selectedSlot = null;
                state.loadedMonthKey = null;
                state.loadedSlotsKey = null;
                updateSelectionBox();
                if (state.currentStep === 3) goToStep(2);
                loadMonth().then((ok) => {
                    if (ok && date) selectDate(date, false, true);
                });
            }
        } else if (state.consultationPurpose) {
            updatePurposeUI();
            updateSelectionBox();
        }
    }

    async function handleProfileUpdate(e) {
        e.preventDefault();
        if (state.profileBusy || !state.student) return;
        clearFormFieldErrors('#profileEditForm');
        showBannerError('#profileEditError', '');

        const name = $('#profileName').value.trim();
        const email = $('#profileEmail').value.trim().toLowerCase();
        const capstoneTitle = $('#profileCapstone').value.trim();
        const instructorRole = document.querySelector('input[name="profileRole"]:checked')?.value || 'adviser';
        const projectLevel = document.querySelector('input[name="profileLevel"]:checked')?.value || '';
        const memberInputs = getProfileMemberInputs();
        const domains = state.config?.allowedEmailDomains || [];

        if (name.length < 2) {
            setFieldError('#profileName', 'Please enter your full name (at least 2 characters).');
            return;
        }
        if (!email || (domains.length && !domains.some((d) => email.endsWith(`@${d}`) || email.endsWith(`.${d}`)))) {
            const hint = domains.length ? ` (${domains.map((d) => '@' + d).join(' or ')})` : '';
            setFieldError('#profileEmail', `Please enter your university email${hint}.`);
            return;
        }
        if (capstoneTitle.length < 3) {
            setFieldError('#profileCapstone', 'Please enter your Capstone / Thesis title (at least 3 characters).');
            return;
        }
        if (!isDefenseLevel(projectLevel)) {
            setFieldError('#profileLevelField', 'Please select your course: Capstone 1, Capstone 2, Thesis 1, or Thesis 2.');
            return;
        }

        const emptyExtra = memberInputs.slice(1).find((el) => el.value.trim().length === 0);
        if (emptyExtra) {
            setFieldError(
                '#profileMembersField',
                'Please enter this member’s full name, or click × to remove the extra row.',
                emptyExtra
            );
            return;
        }
        const shortExtra = memberInputs.slice(1).find((el) => el.value.trim().length < 2);
        if (shortExtra) {
            setFieldError('#profileMembersField', 'Each member needs a full name (at least 2 characters).', shortExtra);
            return;
        }
        const otherMembers = memberInputs.slice(1).map((el) => el.value.trim()).filter(Boolean).slice(0, MAX_MEMBERS - 1);
        const members = [name, ...otherMembers];

        const emailChanged = email !== (state.student.email || '').toLowerCase();
        const btn = $('#saveProfileBtn');
        state.profileBusy = true;
        setButtonBusy(btn, true, emailChanged ? 'Sending code…' : 'Saving…');

        try {
            const data = await api('/api/profile/update', {
                method: 'POST',
                body: JSON.stringify({ name, email, capstoneTitle, instructorRole, projectLevel, members }),
            });
            if (data.otpRequired) {
                state.profileOtpEmail = data.email;
                setText('#profileOtpEmail', data.email);
                if ($('#profileOtpCode')) $('#profileOtpCode').value = '';
                setProfileModalView('otp');
                startProfileResendCountdown(data.resendSeconds || 60);
                setTimeout(() => $('#profileOtpCode')?.focus(), 50);
                toast('Verification code sent to your new university email.', 'success');
            } else {
                applyUpdatedStudentState(data.student);
                window.SchedulerRealtime?.notifyLocal({ type: 'student_updated', studentId: data.student?.id });
                setProfileModalView('summary');
                toast('Your registration info has been updated.', 'success');
            }
        } catch (err) {
            if (err.status === 401) {
                closeMyBookingsModal();
                setStudent(null);
                setAuthMode('login');
                setAuthError('Your session has expired. Please log in again.');
            } else if (err.field && PROFILE_FIELD_MAP[err.field]) {
                setFieldError(PROFILE_FIELD_MAP[err.field], err.message);
            } else {
                showBannerError('#profileEditError', err.message);
            }
        } finally {
            state.profileBusy = false;
            setButtonBusy(btn, false);
            syncProfileSaveButtonLabel();
        }
    }

    async function handleProfileOtpVerify(e) {
        e.preventDefault();
        if (state.profileBusy || !state.student) return;
        clearFormFieldErrors('#profileOtpForm');
        showBannerError('#profileOtpError', '');

        const code = ($('#profileOtpCode')?.value || '').replace(/\D/g, '');
        if (code.length !== 6) {
            setFieldError('#profileOtpCode', 'Please enter the 6-digit verification code from your email.');
            return;
        }

        const btn = $('#profileOtpVerifyBtn');
        state.profileBusy = true;
        setButtonBusy(btn, true, 'Verifying…');

        try {
            const data = await api('/api/profile/email/verify', {
                method: 'POST',
                body: JSON.stringify({ email: state.profileOtpEmail, code }),
            });
            clearInterval(state.profileResendTimer);
            applyUpdatedStudentState(data.student);
            window.SchedulerRealtime?.notifyLocal({ type: 'student_updated', studentId: data.student?.id });
            setProfileModalView('summary');
            toast('Email verified and registration info updated!', 'success');
        } catch (err) {
            if (err.status === 401) {
                closeMyBookingsModal();
                setStudent(null);
                setAuthMode('login');
                setAuthError('Your session has expired. Please log in again.');
            } else {
                showBannerError('#profileOtpError', err.message);
            }
        } finally {
            state.profileBusy = false;
            setButtonBusy(btn, false);
        }
    }

    async function handleProfileOtpResend() {
        const btn = $('#profileOtpResendBtn');
        if (!btn || btn.disabled || state.profileBusy) return;
        btn.disabled = true;
        showBannerError('#profileOtpError', '');

        try {
            const data = await api('/api/auth/resend', {
                method: 'POST',
                body: JSON.stringify({ email: state.profileOtpEmail, purpose: 'email_change' }),
            });
            toast('A new verification code has been sent to your new email.', 'success');
            startProfileResendCountdown(data.resendSeconds || 60);
        } catch (err) {
            showBannerError('#profileOtpError', err.message);
            btn.disabled = false;
        }
    }

    /* ---------------- student account ---------------- */
    function updateRoleVisibility() {
        const isAdviser = state.student?.instructorRole === 'adviser';
        const isPanel = state.student?.instructorRole === 'panel';
        const letterCard = $('#letterChoiceCard');
        if (letterCard) {
            letterCard.classList.toggle('hidden', !isAdviser);
        }
        const letterPickupCard = $('#letterPickupChoiceCard');
        if (letterPickupCard) {
            letterPickupCard.classList.toggle('hidden', !isAdviser);
        }
        const panelHint = $('#panelRoleHint');
        if (panelHint) {
            panelHint.classList.toggle('hidden', !isPanel);
        }
        renderStep1EligibilityBadges();
        if (!isAdviser && (state.consultationPurpose === 'letter' || state.consultationPurpose === 'letter_pickup')) {
            state.consultationPurpose = null;
            state.beninsigConfirmed = false;
            state.letterPickupNotifiedConfirmed = false;
            updateSelectionBox();
        }

        const projBox = $('#studentProjectBox');
        if (projBox) {
            if (state.student) {
                const count = Array.isArray(state.student.members) && state.student.members.length
                    ? state.student.members.length
                    : 1;
                const levelInfo = getDefenseLevelInfo(state.student.projectLevel);
                const levelBadge = $('#projectLevelBadge');
                if (levelBadge) {
                    levelBadge.textContent = levelInfo ? levelInfo.label : '';
                    levelBadge.classList.toggle('hidden', !levelInfo);
                }
                const defensePill = $('#defenseCardPill');
                if (defensePill) {
                    defensePill.textContent = levelInfo
                        ? `${levelInfo.label} · ${levelInfo.durationLabel}`
                        : '1–2 hours';
                }
                const roleBadge = $('#projectRoleBadge');
                if (roleBadge) {
                    const isPanel = state.student.instructorRole === 'panel';
                    roleBadge.textContent = isPanel ? 'Panel Member' : 'Adviser';
                    roleBadge.className = `badge ${isPanel ? 'sky' : 'teal'}`;
                    roleBadge.classList.toggle('hidden', !state.student.instructorRole);
                }
                setText('#projectTitleText', state.student.capstoneTitle || state.student.name);
                setText(
                    '#projectMembersText',
                    `${count} ${count === 1 ? 'member' : 'members'} · ${state.student.members?.join(', ') || state.student.name}`
                );
                projBox.classList.remove('hidden');
            } else {
                projBox.classList.add('hidden');
            }
        }
    }

    function setStudent(student, navigateToStep1 = false, shouldScroll = false) {
        state.student = student || null;
        state.defenseLevel = isDefenseLevel(state.student?.projectLevel) ? state.student.projectLevel : null;
        const box = $('#accountBox');
        box?.classList.toggle('hidden', !state.student);
        updateRoleVisibility();

        if (state.student) {
            const myBookingsBtn = $('#myBookingsBtn');
            if (myBookingsBtn) {
                const membersStr = Array.isArray(state.student.members) && state.student.members.length
                    ? state.student.members.join(', ')
                    : state.student.name;
                myBookingsBtn.title = `Profile · Members: ${membersStr}`;
            }
            if (state.student.capstoneTitle && $('#teamInput')) {
                $('#teamInput').value = state.student.capstoneTitle;
            }
            resetMembers();
            setBookingType('group');
            loadMyBookings();
            if (navigateToStep1) {
                goToStep(1, shouldScroll);
            }
        } else {
            state.profileBusy = false;
            closeMyBookingsModal();
            closeBeninsigModal();
            closeRetrievalModal();
            closeLetterPickupModal();
            $('#myAppointmentsLink')?.classList.add('hidden');
            $('#myBookingsBtn')?.classList.add('hidden');
            if ($('#teamInput')) $('#teamInput').value = '';
            state.consultationPurpose = null;
            state.beninsigConfirmed = false;
            state.retrievalNotifiedConfirmed = false;
            state.letterPickupNotifiedConfirmed = false;
            state.pickupEligibility = null;
            state.selectedDate = null;
            state.selectedSlot = null;
            resetMembers();
            setBookingType('group');
            showAuthGate();
        }
        if (state.consultationPurpose) updatePurposeUI();
        syncMemberControls();
    }

    function renderStep3() {
        if (!state.student) {
            showAuthGate();
            return;
        }
        if (state.student.capstoneTitle && $('#teamInput') && !$('#teamInput').value.trim()) {
            $('#teamInput').value = state.student.capstoneTitle;
        }
        if (state.consultationPurpose && getMeta().requiresAllMembers) {
            const savedMembers = Array.isArray(state.student.members) && state.student.members.length
                ? state.student.members.slice(0, MAX_MEMBERS)
                : [state.student.name];
            const currentInputs = getMemberInputs();
            if (currentInputs.length !== savedMembers.length) {
                resetMembers();
            }
        }
        updatePurposeUI();
        syncMemberControls();
    }

    function setAuthMode(mode) {
        state.authMode = mode;
        setAuthError('');
        clearFormFieldErrors('#authView');
        $('#loginForm').classList.toggle('hidden', mode !== 'login');
        $('#registerForm').classList.toggle('hidden', mode !== 'register');
        $('#forgotForm').classList.toggle('hidden', mode !== 'forgot');
        $('#otpForm').classList.toggle('hidden', mode !== 'otp');
        $('#authTabs').classList.toggle('hidden', mode === 'otp' || mode === 'forgot');
        if (mode === 'login' || mode === 'register') {
            const radio = document.querySelector(`input[name="authMode"][value="${mode}"]`);
            if (radio) radio.checked = true;
        }

        const titles = {
            login: 'Sign in to schedule',
            register: 'Create account',
            forgot: 'Reset password',
            otp: state.otpPurpose === 'reset' ? 'Enter reset code' : 'Check email (and spam folder)',
        };
        setText('#authTitle', titles[mode]);
        $('#resetPasswordFields').classList.toggle('hidden', !(mode === 'otp' && state.otpPurpose === 'reset'));
    }

    function setButtonBusy(btn, busy, busyLabel) {
        const label = btn.querySelector('.btn-label');
        if (!btn.dataset.label) btn.dataset.label = label.textContent;
        btn.disabled = busy;
        btn.querySelector('.spinner').classList.toggle('hidden', !busy);
        label.textContent = busy ? busyLabel : btn.dataset.label;
    }

    const SERVER_FIELD_MAP = {
        regName: '#regName',
        regEmail: '#regEmail',
        regCapstone: '#regCapstone',
        regRole: '#regRoleField',
        regLevel: '#regLevelField',
        regMembers: '#regMembersField',
        regPassword: '#regPassword',
    };

    async function runAuth(btn, busyLabel, fn) {
        if (state.authBusy) return;
        state.authBusy = true;
        setAuthError('');
        setButtonBusy(btn, true, busyLabel);
        try {
            await fn();
        } catch (err) {
            if (err.field && SERVER_FIELD_MAP[err.field]) {
                setFieldError(SERVER_FIELD_MAP[err.field], err.message);
            } else {
                setAuthError(err.message);
            }
        } finally {
            state.authBusy = false;
            setButtonBusy(btn, false);
        }
    }

    function startResendCountdown(seconds = 60) {
        const btn = $('#resendBtn');
        clearInterval(state.resendTimer);
        let left = seconds;
        const tick = () => {
            btn.disabled = left > 0;
            btn.textContent = left > 0 ? `Resend code (${left}s)` : 'Resend code';
            if (left-- <= 0) clearInterval(state.resendTimer);
        };
        tick();
        state.resendTimer = setInterval(tick, 1000);
    }

    function showOtpStep(purpose, email, resendSeconds) {
        state.otpPurpose = purpose;
        state.otpEmail = email;
        $('#otpEmail').textContent = email;
        $('#otpCode').value = '';
        $('#resetPassword').value = '';
        setAuthMode('otp');
        startResendCountdown(resendSeconds || 60);
        setTimeout(() => $('#otpCode').focus(), 50);
    }

    function onSignedIn(student, message) {
        ['#loginPassword', '#regPassword', '#regPassword2', '#resetPassword', '#otpCode'].forEach((s) => {
            const el = $(s);
            if (el) el.value = '';
        });
        clearInterval(state.resendTimer);
        setAuthMode('login');
        setStudent(student, true);
        window.SchedulerRealtime?.notifyLocal({ type: 'auth_changed' });
        toast(message, 'success');
    }

    function handleLogin(e) {
        e.preventDefault();
        clearFormFieldErrors('#loginForm');
        setAuthError('');
        const email = $('#loginEmail').value.trim();
        const password = $('#loginPassword').value;
        if (!email) {
            setFieldError('#loginEmail', 'Please enter your university email.');
            return;
        }
        if (!password) {
            setFieldError('#loginPassword', 'Please enter your password.');
            return;
        }
        runAuth($('#loginBtn'), 'Logging in…', async () => {
            const { student } = await api('/api/auth/login', {
                method: 'POST',
                body: JSON.stringify({ email, password }),
            });
            onSignedIn(student, `Welcome back, ${student.name.split(' ')[0]}!`);
        });
    }

    /* ---------------- registration members UI (1 to 3 members) ---------------- */
    function getRegMemberInputs() {
        return Array.from(document.querySelectorAll('#regMemberList input'));
    }

    function syncRegMemberControls() {
        const rows = Array.from(document.querySelectorAll('#regMemberList .member-row'));
        const repName = $('#regName')?.value.trim() || '';
        rows.forEach((row, idx) => {
            const input = row.querySelector('input');
            const removeBtn = row.querySelector('.remove-member');
            if (idx === 0) {
                input.readOnly = true;
                input.value = repName;
                input.placeholder = 'Member 1 (You) — auto-filled from your name above';
                removeBtn.disabled = true;
                removeBtn.title = 'You are always Member 1';
            } else {
                input.readOnly = false;
                input.placeholder = `Member ${idx + 1} — full name`;
                removeBtn.disabled = false;
                removeBtn.title = 'Remove member';
            }
        });
        setText('#regMemberCount', `(${rows.length}/${MAX_MEMBERS})`);
        $('#regAddMemberBtn')?.classList.toggle('hidden', rows.length >= MAX_MEMBERS);
    }

    function addRegMemberRow(initialValue = '', shouldFocus = false) {
        const list = $('#regMemberList');
        if (!list || list.children.length >= MAX_MEMBERS) return;

        const row = document.createElement('div');
        row.className = 'member-row';

        const input = document.createElement('input');
        input.type = 'text';
        input.maxLength = 100;
        input.value = initialValue;
        input.addEventListener('input', () => clearFieldError('#regMembersField'));

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'remove-member';
        removeBtn.setAttribute('aria-label', 'Remove member');
        removeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
        removeBtn.addEventListener('click', () => {
            if (list.children.length <= MIN_MEMBERS) return;
            row.remove();
            clearFieldError('#regMembersField');
            syncRegMemberControls();
        });

        row.append(input, removeBtn);
        list.appendChild(row);
        syncRegMemberControls();
        if (shouldFocus) input.focus();
    }

    function resetRegMembers() {
        const list = $('#regMemberList');
        if (!list) return;
        list.innerHTML = '';
        addRegMemberRow($('#regName')?.value.trim() || '');
    }

    function handleRegister(e) {
        e.preventDefault();
        clearFormFieldErrors('#registerForm');
        setAuthError('');

        const name = $('#regName').value.trim();
        const email = $('#regEmail').value.trim().toLowerCase();
        const capstoneTitle = $('#regCapstone').value.trim();
        const instructorRole = document.querySelector('input[name="regRole"]:checked')?.value || 'adviser';
        const projectLevel = document.querySelector('input[name="regLevel"]:checked')?.value || '';
        const regInputs = getRegMemberInputs();
        const password = $('#regPassword').value;
        const password2 = $('#regPassword2').value;
        const domains = state.config?.allowedEmailDomains || [];

        if (name.length < 2) {
            setFieldError('#regName', 'Please enter your full name (at least 2 characters).');
            return;
        }
        if (!email || (domains.length && !domains.some((d) => email.endsWith(`@${d}`) || email.endsWith(`.${d}`)))) {
            const hint = domains.length ? ` (${domains.map((d) => '@' + d).join(' or ')})` : '';
            setFieldError('#regEmail', `Please enter your university email${hint}.`);
            return;
        }
        if (capstoneTitle.length < 3) {
            setFieldError('#regCapstone', 'Please enter your Capstone / Thesis title (at least 3 characters).');
            return;
        }
        if (!isDefenseLevel(projectLevel)) {
            setFieldError('#regLevelField', 'Please select your course: Capstone 1, Capstone 2, Thesis 1, or Thesis 2.');
            return;
        }

        const emptyExtra = regInputs.slice(1).find((el) => el.value.trim().length === 0);
        if (emptyExtra) {
            setFieldError(
                '#regMembersField',
                'Please enter this member’s full name, or click × to remove the extra row.',
                emptyExtra
            );
            return;
        }
        const shortExtra = regInputs.slice(1).find((el) => el.value.trim().length < 2);
        if (shortExtra) {
            setFieldError('#regMembersField', 'Each member needs a full name (at least 2 characters).', shortExtra);
            return;
        }
        const otherMembers = regInputs.slice(1).map((el) => el.value.trim()).filter(Boolean).slice(0, MAX_MEMBERS - 1);
        const members = [name, ...otherMembers];

        if (password.length < 8) {
            setFieldError('#regPassword', 'Password must be at least 8 characters long.');
            return;
        }
        if (password !== password2) {
            setFieldError('#regPassword2', 'Passwords do not match. Please re-enter your password.');
            return;
        }

        runAuth($('#registerBtn'), 'Sending code…', async () => {
            const data = await api('/api/auth/register/start', {
                method: 'POST',
                body: JSON.stringify({ name, email, capstoneTitle, instructorRole, projectLevel, members, password }),
            });
            showOtpStep('register', data.email, data.resendSeconds);
            toast('Verification code sent. Check your inbox or spam folder.', 'success');
        });
    }

    function handleForgot(e) {
        e.preventDefault();
        clearFormFieldErrors('#forgotForm');
        setAuthError('');
        const email = $('#forgotEmail').value.trim().toLowerCase();
        const domains = state.config?.allowedEmailDomains || [];
        if (!email || (domains.length && !domains.some((d) => email.endsWith(`@${d}`) || email.endsWith(`.${d}`)))) {
            const hint = domains.length ? ` (${domains.map((d) => '@' + d).join(' or ')})` : '';
            setFieldError('#forgotEmail', `Please enter your university email${hint}.`);
            return;
        }
        runAuth($('#forgotBtn'), 'Sending code…', async () => {
            const data = await api('/api/auth/forgot/start', {
                method: 'POST',
                body: JSON.stringify({ email }),
            });
            showOtpStep('reset', data.email, data.resendSeconds);
            toast('If that email is registered, a reset code is on its way.', 'success');
        });
    }

    function handleOtp(e) {
        e.preventDefault();
        clearFormFieldErrors('#otpForm');
        setAuthError('');
        const code = $('#otpCode').value.replace(/\D/g, '');
        if (code.length !== 6) {
            setFieldError('#otpCode', 'Please enter the 6-digit verification code from your email.');
            return;
        }

        if (state.otpPurpose === 'reset') {
            const password = $('#resetPassword').value;
            if (password.length < 8) {
                setFieldError('#resetPassword', 'New password must be at least 8 characters long.');
                return;
            }
            runAuth($('#otpBtn'), 'Verifying…', async () => {
                const { student } = await api('/api/auth/forgot/verify', {
                    method: 'POST',
                    body: JSON.stringify({ email: state.otpEmail, code, password }),
                });
                onSignedIn(student, 'Password updated. You are now logged in.');
            });
        } else {
            runAuth($('#otpBtn'), 'Verifying…', async () => {
                const { student } = await api('/api/auth/register/verify', {
                    method: 'POST',
                    body: JSON.stringify({ email: state.otpEmail, code }),
                });
                onSignedIn(student, 'Email verified! Your group account is ready.');
            });
        }
    }

    async function handleResend() {
        const btn = $('#resendBtn');
        if (btn.disabled) return;
        btn.disabled = true;
        setAuthError('');
        try {
            const data = await api('/api/auth/resend', {
                method: 'POST',
                body: JSON.stringify({ email: state.otpEmail, purpose: state.otpPurpose }),
            });
            toast('A new verification code has been sent. Check your inbox or spam folder.', 'success');
            startResendCountdown(data.resendSeconds || 60);
        } catch (err) {
            setAuthError(err.message);
            btn.disabled = false;
        }
    }

    async function logout() {
        try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
        window.SchedulerRealtime?.notifyLocal({ type: 'auth_changed' });
        setStudent(null);
        setAuthMode('login');
        toast('You have been logged out.');
    }

    async function loadCurrentStudent() {
        try {
            const { student } = await api('/api/auth/me');
            setStudent(student, Boolean(student));
            if (student) {
                const params = new URLSearchParams(window.location.search);
                if (params.get('editProfile') === '1' || params.get('profile') === '1') {
                    openMyBookingsModal(params.get('editProfile') === '1');
                    window.history.replaceState({}, '', window.location.pathname);
                }
            }
        } catch {
            setStudent(null);
        }
    }

    function initPasswordToggles() {
        document.querySelectorAll('.pw-toggle').forEach((btn) => {
            btn.addEventListener('click', () => {
                const input = document.getElementById(btn.dataset.target);
                if (!input) return;
                const showing = input.type === 'text';
                input.type = showing ? 'password' : 'text';
                btn.textContent = showing ? 'Show' : 'Hide';
                btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
                input.focus({ preventScroll: true });
            });
        });
    }

    function initFieldAutoClear() {
        document.querySelectorAll('input, textarea').forEach((inp) => {
            inp.addEventListener('input', () => clearFieldError(inp));
        });
    }

    function initAuth() {
        document.querySelectorAll('input[name="authMode"]').forEach((radio) => {
            radio.addEventListener('change', (e) => setAuthMode(e.target.value));
        });
        $('#loginForm').addEventListener('submit', handleLogin);
        $('#registerForm').addEventListener('submit', handleRegister);
        $('#regName')?.addEventListener('input', syncRegMemberControls);
        $('#regAddMemberBtn')?.addEventListener('click', () => addRegMemberRow('', true));
        resetRegMembers();

        $('#forgotForm').addEventListener('submit', handleForgot);
        $('#otpForm').addEventListener('submit', handleOtp);
        $('#resendBtn').addEventListener('click', handleResend);
        $('#forgotLink').addEventListener('click', () => {
            $('#forgotEmail').value = $('#loginEmail').value;
            setAuthMode('forgot');
            $('#forgotEmail').focus();
        });
        $('#forgotCancel').addEventListener('click', () => setAuthMode('login'));
        $('#otpChangeEmail').addEventListener('click', () => {
            clearInterval(state.resendTimer);
            setAuthMode(state.otpPurpose === 'reset' ? 'forgot' : 'register');
        });
        $('#otpCode').addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
        });
        $('#logoutBtn').addEventListener('click', logout);
        setAuthMode('login');
    }

    function applyEmailHints(config) {
        const domains = config.allowedEmailDomains || [];
        if (!domains.length) return;
        const example = `youremail@${domains[0]}`;
        const domainText = domains.map((d) => '@' + d).join(' or ');
        $('#loginEmail').placeholder = example;
        $('#regEmail').placeholder = example;
        $('#forgotEmail').placeholder = example;
        if ($('#profileEmail')) $('#profileEmail').placeholder = example;
        $('#regEmailHint').textContent = `Must end with ${domainText}`;
        if ($('#profileEmailHint')) {
            $('#profileEmailHint').textContent = `Must end with ${domainText}. Changing your email will send a 6-digit OTP verification code to the new address.`;
        }
    }

    /* ---------------- init ---------------- */
    async function init() {
        const now = new Date();
        state.viewYear = now.getFullYear();
        state.viewMonth = now.getMonth();
        setText('#year', now.getFullYear());

        resetMembers();
        document.querySelectorAll('.type-choice-card').forEach((card) => {
            card.addEventListener('click', () => onClickConsultationCard(card.dataset.purpose));
        });
        $('#changePurposeBtn')?.addEventListener('click', () => goToStep(1));

        // Ma'am Melinda Beninsig prerequisite modal events
        $('#beninsigYesBtn')?.addEventListener('click', () => {
            state.beninsigConfirmed = true;
            closeBeninsigModal();
            proceedWithConsultationPurpose('letter');
        });
        $('#beninsigNoBtn')?.addEventListener('click', () => {
            $('#beninsigAskView').classList.add('hidden');
            $('#beninsigNoView').classList.remove('hidden');
            $('#beninsigCloseBtn')?.focus();
        });
        $('#beninsigCloseBtn')?.addEventListener('click', closeBeninsigModal);
        $('#beninsigModal')?.addEventListener('click', (e) => {
            if (e.target.id === 'beninsigModal') closeBeninsigModal();
        });

        // Retrieval of Manuscript email notification prerequisite modal events
        $('#retrievalYesBtn')?.addEventListener('click', () => {
            state.retrievalNotifiedConfirmed = true;
            closeRetrievalModal();
            proceedWithConsultationPurpose('retrieval');
        });
        $('#retrievalNoBtn')?.addEventListener('click', () => {
            applyPickupBlockedContent({
                purpose: 'retrieval',
                titleSel: '#retrievalNoTitle',
                textSel: '#retrievalNoText',
                linkSel: '#retrievalAppointmentsLink',
                closeBtnSel: '#retrievalCloseBtn',
            });
            $('#retrievalAskView').classList.add('hidden');
            $('#retrievalNoView').classList.remove('hidden');
            $('#retrievalCloseBtn')?.focus();
        });
        $('#retrievalCloseBtn')?.addEventListener('click', closeRetrievalModal);
        $('#retrievalModal')?.addEventListener('click', (e) => {
            if (e.target.id === 'retrievalModal') closeRetrievalModal();
        });

        // Pickup of Communication Letter email notification prerequisite modal events
        $('#letterPickupYesBtn')?.addEventListener('click', () => {
            state.letterPickupNotifiedConfirmed = true;
            closeLetterPickupModal();
            proceedWithConsultationPurpose('letter_pickup');
        });
        $('#letterPickupNoBtn')?.addEventListener('click', () => {
            applyPickupBlockedContent({
                purpose: 'letter_pickup',
                titleSel: '#letterPickupNoTitle',
                textSel: '#letterPickupNoText',
                linkSel: '#letterPickupAppointmentsLink',
                closeBtnSel: '#letterPickupCloseBtn',
            });
            $('#letterPickupAskView').classList.add('hidden');
            $('#letterPickupNoView').classList.remove('hidden');
            $('#letterPickupCloseBtn')?.focus();
        });
        $('#letterPickupCloseBtn')?.addEventListener('click', closeLetterPickupModal);
        $('#letterPickupModal')?.addEventListener('click', (e) => {
            if (e.target.id === 'letterPickupModal') closeLetterPickupModal();
        });

        document.querySelectorAll('input[name="regLevel"]').forEach((r) => {
            r.addEventListener('change', () => clearFieldError('#regLevelField'));
        });
        document.querySelectorAll('input[name="profileLevel"]').forEach((r) => {
            r.addEventListener('change', () => clearFieldError('#profileLevelField'));
        });

        // Student profile modal events
        $('#myBookingsBtn')?.addEventListener('click', () => openMyBookingsModal(false));
        $('#sidebarEditProfileBtn')?.addEventListener('click', () => openMyBookingsModal(true));
        $('#panelRoleSwitchHintBtn')?.addEventListener('click', () => openMyBookingsModal(true));
        $('#openEditProfileBtn')?.addEventListener('click', () => {
            populateProfileEditForm();
            setProfileModalView('edit');
            setTimeout(() => $('#profileName')?.focus(), 40);
        });
        $('#cancelEditProfileBtn')?.addEventListener('click', () => {
            setProfileModalView('summary');
        });
        $('#profileName')?.addEventListener('input', syncProfileMemberControls);
        $('#profileEmail')?.addEventListener('input', syncProfileSaveButtonLabel);
        $('#profileAddMemberBtn')?.addEventListener('click', () => addProfileMemberRow('', true));
        $('#profileEditForm')?.addEventListener('submit', handleProfileUpdate);

        $('#profileOtpForm')?.addEventListener('submit', handleProfileOtpVerify);
        $('#profileOtpResendBtn')?.addEventListener('click', handleProfileOtpResend);
        $('#profileOtpBackBtn')?.addEventListener('click', () => {
            clearInterval(state.profileResendTimer);
            setProfileModalView('edit');
            setTimeout(() => $('#profileEmail')?.focus(), 40);
        });
        $('#profileOtpCode')?.addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
        });

        $('#closeMyBookingsBtn')?.addEventListener('click', closeMyBookingsModal);
        $('#myBookingsModal')?.addEventListener('click', (e) => {
            if (e.target.id === 'myBookingsModal') closeMyBookingsModal();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeBeninsigModal();
                closeRetrievalModal();
                closeLetterPickupModal();
                closeMyBookingsModal();
            }
        });

        document.querySelectorAll('input[name="bookingType"]').forEach((radio) => {
            radio.addEventListener('change', (e) => setBookingType(e.target.value));
        });
        $('#addMemberBtn')?.addEventListener('click', () => addMemberRow('', true));

        $('#prevMonth')?.addEventListener('click', () => changeMonth(-1));
        $('#nextMonth')?.addEventListener('click', () => changeMonth(1));
        $('#backBtn')?.addEventListener('click', () => goToStep(2));

        document.querySelectorAll('.step').forEach((stepEl) => {
            const targetStep = Number(stepEl.dataset.step);
            if (targetStep === 1 || targetStep === 2) {
                stepEl.style.cursor = 'pointer';
                stepEl.addEventListener('click', () => {
                    if (state.currentStep < 4 && targetStep < state.currentStep) {
                        goToStep(targetStep);
                    }
                });
            }
        });

        $('#bookingForm')?.addEventListener('submit', submitBooking);
        $('#bookAnother')?.addEventListener('click', resetBooking);
        $('#reasonInput')?.addEventListener('input', (e) => {
            setText('#reasonCount', e.target.value.length);
        });

        initPasswordToggles();
        initFieldAutoClear();
        initAuth();
        loadCurrentStudent();

        window.SchedulerRealtime?.subscribe(async (event) => {
            if (event?.type === 'auth_changed' && event?.fromLocalTab) {
                loadCurrentStudent();
                return;
            }
            if (
                event?.type === 'schedule_config_updated'
                || event?.type === 'settings_updated'
                || event?.bookingEndDate
                || event?.type?.startsWith('letter_pickup_schedule')
            ) {
                try {
                    const freshConfig = await api('/api/config');
                    state.config = freshConfig;
                    if (freshConfig.lastBookableDate) {
                        setText('#deadlineMeta', `Until ${formatShortDate(freshConfig.lastBookableDate)}`);
                    }
                } catch { /* ignore */ }
            }
            if (!state.student) return;
            if (event?.type === 'student_updated' && event?.fromLocalTab) {
                api('/api/auth/me').then(({ student }) => {
                    if (student) applyUpdatedStudentState(student);
                    else setStudent(null);
                }).catch(() => {});
                return;
            }
            loadMyBookings();
            if (event?.bookingId && state.lastBookedId && event.bookingId === state.lastBookedId) {
                return;
            }
            refreshLiveAvailability();
        });

        try {
            const config = await ensureConfig();
            applyEmailHints(config);
            window.SchedulerRealtime?.init(config);
        } catch {
            toast('Could not connect to the server. Please refresh the page.', 'error');
        }
    }

    async function refreshLiveAvailability() {
        if (!state.student || state.submitting || (state.currentStep !== 2 && state.currentStep !== 3)) return;
        const purpose = state.consultationPurpose || 'system';
        const level = purpose === 'defense' ? (state.defenseLevel || state.student?.projectLevel || 'capstone1') : '';
        const mKey = monthKey(state.viewYear, state.viewMonth);
        const monthQuery = purpose === 'defense'
            ? `/api/month?month=${mKey}&purpose=defense&level=${encodeURIComponent(level)}`
            : `/api/month?month=${mKey}&purpose=${purpose}`;

        try {
            const mData = await api(monthQuery);
            if (state.submitting || (state.currentStep !== 2 && state.currentStep !== 3)) return;
            state.monthDays = mData.days || {};
            state.loadedMonthKey = monthLoadKey(state.viewYear, state.viewMonth, purpose);
            renderCalendar(false);
        } catch { /* ignore transient refresh errors */ }

        if (!state.selectedDate || state.submitting || (state.currentStep !== 2 && state.currentStep !== 3)) return;
        const ds = state.selectedDate;
        const slotsQuery = purpose === 'defense'
            ? `/api/slots?date=${ds}&purpose=defense&level=${encodeURIComponent(level)}`
            : `/api/slots?date=${ds}&purpose=${purpose}`;

        try {
            const data = await api(slotsQuery);
            if (state.selectedDate !== ds || state.submitting || (state.currentStep !== 2 && state.currentStep !== 3)) return;

            if (purpose === 'defense') {
                state.defenseDay = data;
                if (state.selectedSlot) {
                    const check = validateDefenseStartMinute(state.selectedSlot.startMinute, data);
                    if (!check.ok) {
                        state.selectedSlot = null;
                        updateSelectionBox();
                        toast(check.error || 'That defense time was just booked by another group. Please choose another time.', 'error');
                        if (state.currentStep === 3) goToStep(2);
                    }
                }
                const prevRaw = $('#defenseStartInput')?.value;
                const wasFocused = document.activeElement?.id === 'defenseStartInput';
                renderDefenseSlots(data);
                if (!state.selectedSlot && prevRaw && $('#defenseStartInput')) {
                    $('#defenseStartInput').value = prevRaw;
                }
                if (wasFocused && $('#defenseStartInput')) {
                    $('#defenseStartInput').focus();
                }
            } else {
                const slots = data.slots || [];
                if (state.selectedSlot) {
                    const match = slots.find((s) => s.startMinute === state.selectedSlot.startMinute);
                    if (!match || !match.available) {
                        state.selectedSlot = null;
                        updateSelectionBox();
                        toast('That time slot was just booked by another group. Please pick another time.', 'error');
                        if (state.currentStep === 3) goToStep(2);
                    } else {
                        state.selectedSlot = match;
                    }
                }
                renderSlots(slots, data);
            }
        } catch { /* ignore transient refresh errors */ }
    }

    init();
})();
