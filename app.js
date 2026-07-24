/**
 * Gate Log — 11-Gate Border Control System
 * Main Application Controller
 */
(function () {
  'use strict';

  // ============================================================
  // CONSTANTS
  // ============================================================
  const GATE_COUNT = 11;
  const GATE_NAMES = {
    1: 'PRC', 2: 'PD', 3: 'KSN', 4: 'KRK', 5: 'BCK',
    6: 'PV', 7: 'BV', 8: 'TPP', 9: 'TPS', 10: 'OY', 11: 'MJ'
  };

  const GATE_USER_IDS = {
    1: '611176837', 2: '1056058526', 3: '1008024796', 4: '894207621',
    5: '1982470859', 6: '430797398', 7: '754793320', 8: '895457451',
    9: '6977030728', 10: '450005349', 11: '955020302'
  };

  const DEFAULT_TG_CONFIG = {
    token: '6973348257:AAG2igvcKTGZrZ7R4zf_zoSH7CyoK1G_W8w',
    chatId: '-1003575172928',
    alertChatId: '518858937' // private chat where the "all gates passed" alert is sent
  };

  const REVOKED_TOKENS = new Set([
    '6973348257:AAF1gnYylgCOrM0P7wzV16vZh9xKX-mfDuU'
  ]);

  // getApiBase(): Read from localStorage each time to support runtime changes via Settings
  function getApiBase() {
    try {
      return localStorage.getItem('gate_api_base') || '';
    } catch (e) {
      return '';
    }
  }

  const PHOTO_WINDOW = {
    start: 11 * 3600,        // 11:00 AM Cambodia time
    end: (16 * 3600) + (10 * 60)  // 16:10 (4:10 PM) Cambodia time
  };

  const POLL_LOCK_TTL = 60000; // 60 seconds

  // ============================================================
  // STATE
  // ============================================================
  const state = {
    entries: [],
    saving: false,
    isSyncing: false,
    selectedGate: 1,
    selectedDir: 'in',
    selectedNation: 'na',
    selectedNationName: '',
    selectedType: 'na',
    box1: 0,
    box2: 0,
    tgConfig: { ...DEFAULT_TG_CONFIG },
    // Start with no visible nation status on init; user selection will enable it.
    nationSelectedByUser: false,
    autoSyncTimer: null,
    storageMode: 'unknown',
    memoryStore: {}
  };

  // ============================================================
  // UTILITY FUNCTIONS
  // ============================================================
  const $ = (id) => document.getElementById(id);

  const gateForUser = (() => {
    const map = {};
    Object.entries(GATE_USER_IDS).forEach(([gate, id]) => {
      map[id] = parseInt(gate, 10);
    });
    return (userId) => map[userId] || null;
  })();

  const generateId = () =>
    'e' + Date.now() + Math.random().toString(36).slice(2, 7);

  // ============================================================
  // AUDIO ENGINE
  // ============================================================
  const audio = {
    ctx: null,

    init() {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.ctx.state === 'suspended') {
        this.ctx.resume();
      }
      return this.ctx;
    },

    beep(freq, type, duration, volume = 0.15) {
      try {
        const ctx = this.init();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();

        oscillator.type = type;
        oscillator.frequency.value = freq;

        const now = ctx.currentTime;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(volume, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start(now);
        oscillator.stop(now + duration + 0.02);
      } catch (e) {
        // Silently fail if audio is unavailable
      }
    },

    playAlert() {
      this.beep(660, 'square', 0.28, 0.2);
    },

    playSuccess() {
      this.beep(880, 'sine', 0.18, 0.15);
    },

    // Short ascending 3-note chime played when a sync session completes
    // (all gates verified).
    playSessionComplete() {
      this.beep(660, 'sine', 0.16, 0.18);
      setTimeout(() => this.beep(880, 'sine', 0.16, 0.18), 160);
      setTimeout(() => this.beep(1320, 'sine', 0.30, 0.2), 320);
    },

    unlock() {
      try { this.init(); } catch (e) { /* ignore */ }
    }
  };

  // Unlock audio on first user interaction
  ['touchstart', 'click', 'keydown'].forEach((event) => {
    document.addEventListener(event, () => audio.unlock(), { passive: true });
  });

  // ============================================================
  // STORAGE LAYER
  // ============================================================
  const storage = {
    async get(key, shared = false) {
      // Try cloud storage (Telegram Web App)
      if (window.storage) {
        try {
          const result = await window.storage.get(key, shared);
          state.storageMode = 'cloud';
          return result ? result.value : null;
        } catch (e) {
          // Fall through to local storage
        }
      }

      // Try local storage
      try {
        const raw = localStorage.getItem(key);
        if (state.storageMode === 'unknown') {
          state.storageMode = 'local';
        }
        return raw;
      } catch (e) {
        // Fall through to memory
      }

      // Memory fallback
      state.storageMode = 'memory';
      return state.memoryStore[key] || null;
    },

    async set(key, value, shared = false) {
      // Try cloud storage first
      if (window.storage) {
        try {
          await window.storage.set(key, value, shared);
          state.storageMode = 'cloud';
          return true;
        } catch (e) {
          // Fall through
        }
      }

      // Try local storage
      try {
        localStorage.setItem(key, value);
        if (state.storageMode !== 'cloud') {
          state.storageMode = 'local';
        }
        return true;
      } catch (e) {
        // Fall through
      }

      // Memory fallback
      state.memoryStore[key] = value;
      state.storageMode = 'memory';
      return true;
    }
  };

  // ============================================================
  // DATA PERSISTENCE
  // ============================================================
  const dataStore = {
    async loadEntries() {
      try {
        const raw = await storage.get('gate-entries', true);
        state.entries = raw ? JSON.parse(raw) : [];
      } catch (e) {
        state.entries = [];
      }
    },

    async saveEntries() {
      state.saving = true;
      await storage.set('gate-entries', JSON.stringify(state.entries), true);
      state.saving = false;
    },

    async loadConfig() {
      try {
        const raw = await storage.get('telegram-config', false);
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && (parsed.token || parsed.chatId)) {
          state.tgConfig = { ...DEFAULT_TG_CONFIG, ...parsed };
        } else {
          state.tgConfig = { ...DEFAULT_TG_CONFIG };
          await this.saveConfig();
        }

        // Sync revoked tokens so a rotated bot token doesn't get stuck in localStorage
        if (REVOKED_TOKENS.has(state.tgConfig.token)) {
          state.tgConfig.token = DEFAULT_TG_CONFIG.token;
          await this.saveConfig();
        }
      } catch (e) {
        state.tgConfig = { ...DEFAULT_TG_CONFIG };
      }
    },

    async saveConfig() {
      await storage.set('telegram-config', JSON.stringify(state.tgConfig), false);
    }
  };

  // ============================================================
  // POLL LOCK MANAGER
  // ============================================================
  const pollLock = {
    DEVICE_ID: Math.random().toString(36).slice(2, 10),
    KEY: 'gate_poll_lock',

    async acquire() {
      try {
        const raw = await storage.get(this.KEY, true);
        const lock = raw ? JSON.parse(raw) : null;
        const now = Date.now();

        if (lock && lock.deviceId !== this.DEVICE_ID && (now - lock.ts) < POLL_LOCK_TTL) {
          return false;
        }

        await storage.set(this.KEY, JSON.stringify({ deviceId: this.DEVICE_ID, ts: now }), true);
        return true;
      } catch (e) {
        return true;
      }
    },

    async refresh() {
      try {
        await storage.set(this.KEY, JSON.stringify({ deviceId: this.DEVICE_ID, ts: Date.now() }), true);
      } catch (e) { /* ignore */ }
    },

    async release() {
      try {
        await storage.set(this.KEY, JSON.stringify({ deviceId: this.DEVICE_ID, ts: 0 }), true);
      } catch (e) { /* ignore */ }
    }
  };

  // ============================================================
  // UI HELPERS
  // ============================================================
  const ui = {
    setStatus(message, isError = false, isSuccess = false) {
      const el = $('statusMsg');
      if (!el) return;

      el.textContent = message;
      el.className = 'status-msg' + (isError ? ' err' : isSuccess ? ' ok' : '');
      // NOTE: messages now persist until explicitly cleared by calling
      // `ui.setStatus('')`. Previously messages auto-cleared after 5s.
    },

    setSyncIndicator(status) {
      const indicator = $('syncIndicator');
      if (!indicator) return;

      indicator.classList.remove('sync-running', 'sync-success', 'sync-error');

      if (status) {
        indicator.classList.add(`sync-${status}`);
      }
    },

    updateTotals() {
      const totals = computeTotals(state.selectedType);

      if ($('heroIn')) $('heroIn').textContent = totals.totalIn;
      if ($('heroOut')) $('heroOut').textContent = totals.totalOut;

      const gateTotals = totals.perGate[state.selectedGate];
      if ($('gateIn')) $('gateIn').textContent = gateTotals.in;
      if ($('gateOut')) $('gateOut').textContent = gateTotals.out;
    },

    updateGateName() {
      const el = $('gateTotalsName');
      if (el) {
        el.textContent = GATE_NAMES[state.selectedGate];
      }
    },

    updateGateBadge(isVerified) {
      const badge = $('gateVerifiedBadge');
      if (!badge) return;

      if (isVerified) {
        badge.textContent = 'Verified';
        badge.classList.add('visible');
      } else {
        badge.classList.remove('visible');
      }
    },

    updateDebugPanel(photoCounts, verified, events) {
      const lastSyncEl = $('debugLastSync');
      const photoCountsEl = $('debugPhotoCounts');
      const verifiedEl = $('debugVerified');
      const eventsEl = $('debugEvents');
      const storageModeEl = $('debugStorageMode');

      if (lastSyncEl) {
        lastSyncEl.textContent = new Date().toLocaleTimeString();
      }

      if (photoCountsEl) {
        const counts = [];
        for (let g = 1; g <= GATE_COUNT; g++) {
          const count = photoCounts[g] || 0;
          if (count > 0) {
            counts.push(`${g}.${GATE_NAMES[g]}:${count}`);
          }
        }
        photoCountsEl.textContent = counts.length > 0 ? counts.join(', ') : '0 (need 2+)';
      }

      if (verifiedEl) {
        const verifiedList = [];
        for (let g = 1; g <= GATE_COUNT; g++) {
          if (verified[g]) verifiedList.push(`${g}.${GATE_NAMES[g]}`);
        }
        verifiedEl.textContent = verifiedList.length > 0 ? verifiedList.join(', ') : 'None';
      }

      if (eventsEl) {
        if (events && events.length > 0) {
          eventsEl.textContent = events.slice(-5).join('\n');
        } else {
          eventsEl.textContent = 'No events';
        }
      }

      if (storageModeEl) {
        storageModeEl.textContent = state.storageMode;
      }
    }
  };

  // ============================================================
  // COMPUTATION
  // ============================================================
  function computeTotals(type) {
    const perGate = {};
    for (let g = 1; g <= GATE_COUNT; g++) {
      perGate[g] = { in: 0, out: 0, inFemale: 0, outFemale: 0 };
    }

    state.entries.forEach((entry) => {
      if (type && entry.type !== type) return;
      const bucket = perGate[entry.gate];
      if (!bucket) return;

      const p = entry.person || 0;
      const f = entry.female || 0;
      if (entry.dir === 'in') {
        bucket.in += p;
        bucket.inFemale += f;
      } else {
        bucket.out += p;
        bucket.outFemale += f;
      }
    });

    let totalIn = 0, totalOut = 0, totalInFemale = 0, totalOutFemale = 0;
    Object.values(perGate).forEach((bucket) => {
      totalIn += bucket.in;
      totalOut += bucket.out;
      totalInFemale += bucket.inFemale;
      totalOutFemale += bucket.outFemale;
    });

    return { perGate, totalIn, totalOut, totalInFemale, totalOutFemale };
  }

  // ============================================================
  // VERIFICATION STYLES
  // ============================================================
  function applyVerificationStyles(verified) {
    let allVerified = true;
    for (let g = 1; g <= GATE_COUNT; g++) {
      const btn = document.querySelector(`.gate-btn[data-gate="${g}"]`);
      if (!btn) continue;

      const isVerified = !!verified[g];
      btn.classList.toggle('verified', isVerified);
      if (!isVerified) allVerified = false;
    }

    // Show the "temp pass" hint only while at least one gate is unverified.
    const hint = $('gateHint');
    if (hint) hint.hidden = allVerified;

    // Update badge for current gate
    ui.updateGateBadge(!!verified[state.selectedGate]);
  }

  // Manual temporary pass: toggle a gate's verified state without photos.
  async function manualToggleGateVerified(gate) {

    const { year, month, day } = getCambodiaDate();
    const todayKey = buildDateKey(year, month, day);

    let verified = {};
    try {
      const v = await storage.get(todayKey, true);
      if (v) verified = JSON.parse(v);
    } catch (e) { /* ignore */ }

    if (verified[gate]) {
      delete verified[gate];
    } else {
      verified[gate] = true;
    }

    await storage.set(todayKey, JSON.stringify(verified), true);
    applyVerificationStyles(verified);
    ui.updateGateBadge(!!verified[state.selectedGate]);
    return !!verified[gate];
  }

  // Returns true when every one of the GATE_COUNT gates is verified
  // (manual temp-passes included).
  function allGatesVerified(verified) {
    if (!verified) return false;
    for (let g = 1; g <= GATE_COUNT; g++) {
      if (!verified[g]) return false;
    }
    return true;
  }

  // Merge the proxy's photo-based verified set with locally toggled manual
  // temp-passes (Shift+click), which are stored under todayKey in shared
  // storage. Manual passes are client-only, so the proxy never sees them.
  async function mergeManualPasses(proxyVerified) {
    const merged = { ...(proxyVerified || {}) };
    const { year, month, day } = getCambodiaDate();
    const todayKey = buildDateKey(year, month, day);
    try {
      const raw = await storage.get(todayKey, true);
      if (raw) {
        const local = JSON.parse(raw);
        Object.keys(local).forEach((g) => { merged[g] = true; });
      }
    } catch (e) { /* ignore */ }
    return merged;
  }

  // ============================================================
  // TELEGRAM MESSAGE SENDER (text)
  // ============================================================
  async function sendTelegramMessage(text, chatIdOverride) {
    const chatId = chatIdOverride || state.tgConfig.chatId;
    if (!state.tgConfig.token || !chatId) return false;

    try {
      // Proxy mode
      if (getApiBase()) {
        const response = await fetch(`${getApiBase()}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'sendMessage',
            chat_id: chatId,
            text: text
          })
        });
        const data = await response.json();
        return !!(data && data.ok);
      }

      // Direct mode
      const response = await fetch(buildTelegramUrl('sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ chat_id: String(chatId), text: text })
      });
      const data = await response.json();
      return !!(data && data.ok);
    } catch (e) {
      console.error('[GateSync] sendMessage failed:', e);
      return false;
    }
  }

  // Send "all gates verified" alert to the PRIVATE alertChatId, once per day.
  async function maybeSendAllVerifiedAlert(verified) {
    let count = 0;
    for (let g = 1; g <= GATE_COUNT; g++) {
      if (verified && verified[g]) count++;
    }
    if (count < GATE_COUNT) return;

    const { year, month, day } = getCambodiaDate();
    const alertKey = `alert_sent_${buildDateKey(year, month, day)}`;

    let alreadySent = false;
    try {
      const raw = await storage.get(alertKey, true);
      alreadySent = raw === '1';
    } catch (e) { /* ignore */ }

    // Session complete: play the chime once per day, regardless of whether the
    // Telegram alert is configured.
    if (!alreadySent) {
      audio.playSessionComplete();
      try { await storage.set(alertKey, '1', true); } catch (e) { /* ignore */ }
    }

    if (!state.tgConfig.alertChatId) return;

    const dateStr = `${day}/${month + 1}/${year}`;
    const ok = await sendTelegramMessage(
      `✅ All ${GATE_COUNT} gates verified for ${dateStr}. Border control sync complete.`,
      state.tgConfig.alertChatId
    );

    if (ok) {
      try { await storage.set(alertKey, '1', true); } catch (e) { /* ignore */ }
    }
  }

  // ============================================================
  // TELEGRAM SYNC ENGINE
  // ============================================================
  // ============================================================
  // TELEGRAM API
  // ============================================================
  function buildTelegramUrl(method) {
    const base = getApiBase() || 'https://api.telegram.org';
    // If using proxy, path is /bot/<token>/<method>
    // If direct, path is /bot<token>/<method> (note: no slash after bot)
    if (getApiBase()) {
      return `${base}/bot${state.tgConfig.token}/${method}`;
    }
    return `${base}/bot${state.tgConfig.token}/${method}`;
  }

  function getCambodiaDate() {
    const now = new Date(Date.now() + (7 * 60 * 60 * 1000));
    return {
      year: now.getUTCFullYear(),
      month: now.getUTCMonth(),
      day: now.getUTCDate()
    };
  }

  function buildDateKey(year, month, day) {
    return `verified_gates_${year}_${month + 1}_${day}`;
  }

  function isWithinTimeWindow(msgDate) {
    const totalSeconds = (msgDate.getUTCHours() * 3600) +
                         (msgDate.getUTCMinutes() * 60) +
                         msgDate.getUTCSeconds();

    // Window wraps past midnight (e.g. 11:00 → 4:10 next day), so start > end.
    // Valid when AFTER start (today) OR BEFORE end (early next morning).
    if (PHOTO_WINDOW.start <= PHOTO_WINDOW.end) {
      return totalSeconds >= PHOTO_WINDOW.start && totalSeconds <= PHOTO_WINDOW.end;
    }
    return totalSeconds >= PHOTO_WINDOW.start || totalSeconds <= PHOTO_WINDOW.end;
  }

  function tallyPhotos(updates, photoCounts, context) {
    if (!context.seenUsers) context.seenUsers = [];

    updates.forEach((update) => {
      if (update.update_id > context.maxId) {
        context.maxId = update.update_id;
      }

      const message = update.message;
      if (!message || !message.photo || !message.photo.length) return;

      // Verify chat
      if (String(message.chat.id) !== String(state.tgConfig.chatId)) return;

      // Verify user gate
      const fromId = message.from ? String(message.from.id) : null;
      const gate = fromId ? gateForUser(fromId) : null;

      if (!gate) {
        if (fromId) context.seenUsers.push(`${fromId} (unknown gate)`);
        return;
      }

      // Check Cambodia date
      const msgCambodia = new Date((message.date * 1000) + (7 * 60 * 60 * 1000));
      const { year, month, day } = context;

      const isToday = msgCambodia.getUTCFullYear() === year &&
                      msgCambodia.getUTCMonth() === month &&
                      msgCambodia.getUTCDate() === day;

      if (!isToday) {
        context.seenUsers.push(`${fromId} (not today)`);
        return;
      }

      // Check time window
      if (!isWithinTimeWindow(msgCambodia)) {
        context.seenUsers.push(`${fromId} (outside window)`);
        return;
      }

      photoCounts[gate] = (photoCounts[gate] || 0) + 1;
      context.seenUsers.push(`${fromId} → gate ${gate}`);
    });
  }

  async function checkTelegramUpdates(notifyProgress = false) {
    if (!state.tgConfig.token || !state.tgConfig.chatId || state.isSyncing) {
      return;
    }

    state.isSyncing = true;
    ui.setSyncIndicator('running');

    // Proxy mode: let the server handle everything
    if (getApiBase()) {
      try {
        const proxyUrl = `${getApiBase()}/verified-today`;
        const response = await fetch(proxyUrl, {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) {
          throw new Error(`Proxy responded with ${response.status}`);
        }

        const data = await response.json();

        const merged = await mergeManualPasses(data.verified || {});
        applyVerificationStyles(merged);
        ui.updateDebugPanel(
          data.photoCounts || {},
          merged,
          ['Synced via proxy']
        );

        await maybeSendAllVerifiedAlert(merged);

        ui.setSyncIndicator('success');
        ui.setStatus('Synced via proxy', false, true);
        audio.playSuccess();
       
      } catch (error) {
        console.error('[Proxy] Sync error:', error);
        ui.setSyncIndicator('error');
        ui.setStatus('Proxy sync failed', true);
        audio.playAlert();
      } finally {
        state.isSyncing = false;
      }
      return allGatesVerified(merged);
    }

    // Direct mode (original code continues...)

    const { year, month, day } = getCambodiaDate();
    const todayKey = buildDateKey(year, month, day);
    const offsetKey = `tg_offset_${todayKey}`;
    const photosKey = `tg_photos_${todayKey}`;

    // Acquire poll lock
    const canPoll = await pollLock.acquire();
    if (!canPoll) {
      // Read shared state from another device
      let sharedVerified = null;
      try {
        const shared = await storage.get(todayKey, true);
        if (shared) sharedVerified = JSON.parse(shared);
      } catch (e) {
        // Ignore
      }

        if (sharedVerified && Object.keys(sharedVerified).length > 0) {
          applyVerificationStyles(sharedVerified);
          await maybeSendAllVerifiedAlert(sharedVerified);
          ui.setSyncIndicator('success');
          ui.setStatus('Synced from shared state', false, true);
          ui.updateDebugPanel({}, sharedVerified, ['Synced from shared state']);
        } else {
          ui.setSyncIndicator('success');
          ui.setStatus('Sync lock held by another device', false, false);
          ui.updateDebugPanel({}, {}, ['Lock held by another device']);
        }
        state.isSyncing = false;
        return allGatesVerified(sharedVerified);
    }

    // Load existing state
    let verified = {};
    let photoCounts = {};
    let lastUpdateId = 0;

    try {
      const v = await storage.get(todayKey, true);
      if (v) verified = JSON.parse(v);
    } catch (e) { /* ignore */ }

    try {
      const p = await storage.get(photosKey, true);
      if (p) photoCounts = JSON.parse(p);
    } catch (e) { /* ignore */ }

    try {
      const o = await storage.get(offsetKey, true);
      if (o) lastUpdateId = parseInt(o, 10) || 0;
    } catch (e) { /* ignore */ }

    const context = { maxId: lastUpdateId, year, month, day };

    try {
      // Build request parameters
      const offsetParam = lastUpdateId === 0
        ? 'offset=-100&limit=100'
        : `offset=${context.maxId + 1}&limit=100&timeout=0`;

      const url = `${buildTelegramUrl('getUpdates')}?${offsetParam}`;
      const response = await fetch(url);
      const data = await response.json();

      if (!data.ok) {
        if (/conflict/i.test(data.description || '')) {
           console.warn('[GateSync] Poll conflict detected');
           ui.setSyncIndicator('error');
           ui.setStatus('Conflict: another instance is polling', true);
           audio.playAlert();
           applyVerificationStyles(verified);
           ui.updateDebugPanel(photoCounts, verified, context?.seenUsers);
           await pollLock.release();
           state.isSyncing = false;
           return allGatesVerified(verified);
         }

         console.error('[GateSync] API error:', data.description);
         ui.setSyncIndicator('error');
         ui.setStatus(`Telegram: ${data.description || 'error'}`, true);
         audio.playAlert();
         applyVerificationStyles(verified);
         ui.updateDebugPanel(photoCounts, verified, context?.seenUsers);
         await pollLock.release();
         state.isSyncing = false;
         return allGatesVerified(verified);
       }

      // Process updates
      const updates = data.result || [];
      if (updates.length) {
        tallyPhotos(updates, photoCounts, context);

        await storage.set(offsetKey, String(context.maxId), true);
        await storage.set(photosKey, JSON.stringify(photoCounts), true);
      }

      console.log('[GateSync] counts=', photoCounts, ' events=', context.seenUsers);

      // Verify gates with >= 2 photos
      for (let g = 1; g <= GATE_COUNT; g++) {
        if (verified[g]) continue;
        if ((photoCounts[g] || 0) >= 2) {
          verified[g] = true;
        }
      }

      // Persist and apply
      await storage.set(todayKey, JSON.stringify(verified), true);
      await pollLock.refresh();
      applyVerificationStyles(verified);
      await maybeSendAllVerifiedAlert(verified);
      ui.updateDebugPanel(photoCounts, verified, context?.seenUsers);

      ui.setSyncIndicator('success');
      ui.setStatus('Synced', false, true);
      audio.playSuccess();

    } catch (error) {
      console.error('[GateSync] Connection error:', error);
      ui.setSyncIndicator('error');
      ui.setStatus('Sync failed (network error)', true);
      audio.playAlert();
      applyVerificationStyles(verified);
      ui.updateDebugPanel(photoCounts || {}, verified || {}, context?.seenUsers);
      await pollLock.release();
    } finally {
      state.isSyncing = false;
    }
    return allGatesVerified(verified);
  }

  // ============================================================
  // EXPORT ENGINES
  // ============================================================
  function generateWordHtml(totals, type) {
    const khmerMonths = [
      'មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា',
      'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ'
    ];
    const khmerDigits = (n) => String(n).replace(/\d/g, (d) => '០១២៣៤៥៦៧៨៩'[d]);
    const now = new Date();
    const typeLabel = type === 'thai' ? 'ជនបរទេសសញ្ជាតិ(ថៃ)' : 'ជនជាតិខ្មែរ';
    const dateLine = `របកដំណើរចេញ-ចូល ${typeLabel} ប្រចាំថ្ងៃទី${khmerDigits(now.getDate())} ខែ${khmerMonths[now.getMonth()]} ឆ្នាំ${khmerDigits(now.getFullYear())} ដែលមានដូចខាងក្រោម៖`;
    const khmerGates = {
      1: 'ព្រែកចាក', 2: 'ភ្នំដិន', 3: 'ក្អមសំណ', 4: 'កោះរកា',
      5: 'បន្ទាយចក្រី', 6: 'ព្រៃវល្លិ៍', 7: 'បាវិត',
      8: 'ត្រពាំងផ្លុង', 9: 'ត្រពាំងស្រែ', 10: 'អូរយ៉ាដាវ', 11: 'ម៉ឺនជ័យ'
    };

    const sections = [];

    // Group entries (for this type) — one record per Add Entry press
    const batchMap = new Map();
    state.entries.forEach((e) => {
      if (type && e.type !== type) return;
      const key = e.id;
      batchMap.set(key, {
        gate: e.gate,
        dir: e.dir,
        ts: e.ts,
        type: e.type,
        country: e.country,
        total: e.person || 0,
        female: e.female || 0
      });
    });
    const batches = [...batchMap.values()].sort((a, b) => a.ts - b.ts);

    const batchTag = (b) => (b.type === 'thai' ? 'thai' : (b.country || 'na'));

    // In section
    const inLines = batches
      .filter((b) => b.dir === 'in')
      .map((b) => {
        const khmer = khmerGates[b.gate] || `លេខ ${b.gate}`;
        return `<div class="line">ប៉ុស្តិ៍${khmer}: ចូលប្រទេសចំនួន ${b.total}នាក់ (ស្រី ${b.female}នាក់) [${batchTag(b)}]</div>`;
      });
    if (inLines.length) {
      sections.push(`<div class="heading">ក.១- ចូលប្រទេស</div>${inLines.join('')}`);
    }

    // Out section
    const outLines = batches
      .filter((b) => b.dir === 'out')
      .map((b) => {
        const khmer = khmerGates[b.gate] || `លេខ ${b.gate}`;
        return `<div class="line">ប៉ុស្តិ៍${khmer}: ចេញពីប្រទេសចំនួន ${b.total}នាក់ (ស្រី ${b.female}នាក់) [${batchTag(b)}]</div>`;
      });
    if (outLines.length) {
      sections.push(`<div class="heading">ក.២- ចេញពីប្រទេស</div>${outLines.join('')}`);
    }

    return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
  <meta charset="UTF-8">
  <title>Gate Manifest</title>
  <style>
    body { font-family: 'Khmer OS Siemreap', Arial, sans-serif; color: #222; line-height: 1.6; font-size: 12pt; }
    .heading { font-weight: bold; margin-top: 14pt; margin-bottom: 6pt; }
    .date { margin-bottom: 12pt; }
    .line { margin-bottom: 6pt; padding-left: 10pt; }
    .divider { border-bottom: 1px dashed #ccc; margin: 18pt 0; }
  </style>
</head>
<body>
  <div class="date">${dateLine}</div>
  ${sections.join('<div class="divider"></div>')}
</body>
</html>`;
  }

  // Pluggable per-nationality doc templates.
  // 'thai' uses the Thai doc; any other type falls back to the generic
  // generator until a template is provided (see thai-doc.js).
  const DOC_TEMPLATES = {
    thai: (typeof window.THAI_DOC !== 'undefined') ? window.THAI_DOC : null,
    na: (typeof window.NA_DOC !== 'undefined') ? window.NA_DOC : null
  };

  const REPORT_KHMER_MONTHS = [
    'មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា',
    'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ'
  ];
  const toKhmerDigits = (n) => String(n).replace(/\d/g, (d) => '០១២៣៤៥៦៧៨៩'[d]);

  function fillTemplateHeader(tpl) {
    const now = new Date();
    return tpl.header.template
      .split('(day in khmer numer)').join(toKhmerDigits(now.getDate()))
      .split('[month in khmer]').join(REPORT_KHMER_MONTHS[now.getMonth()])
      .split('[year in number]').join(toKhmerDigits(now.getFullYear()))
      .split('[year in khmer numer]').join(toKhmerDigits(now.getFullYear()));
  }

  function buildTemplateBody(type) {
    const khmerGates = {
      1: 'ព្រែកចាក', 2: 'ភ្នំដិន', 3: 'ក្អមសំណ', 4: 'កោះរកា',
      5: 'បន្ទាយចក្រី', 6: 'ព្រៃវល្លិ៍', 7: 'បាវិត',
      8: 'ត្រពាំងផ្លុង', 9: 'ត្រពាំងស្រែ', 10: 'អូរយ៉ាដាវ', 11: 'ម៉ឺនជ័យ'
    };
    const tagOf = (b) => (b.type === 'thai' ? 'THAILAND' : (b.country || 'na').toUpperCase());
    const tpl = DOC_TEMPLATES[type];
    const showHeadings = !tpl || tpl.showHeadings !== false;
    const lineFor = (b, dirLabel) => {
      const khmer = khmerGates[b.gate] || `លេខ ${b.gate}`;
      return `<div class="line">ប៉ុស្តិ៍${khmer}: ${dirLabel}ប្រទេសចំនួន ${b.person || 0}នាក់ (ស្រី ${b.female || 0}នាក់) [${tagOf(b)}]</div>`;
    };
    const batches = state.entries.filter((e) => e.type === type).sort((a, b) => a.ts - b.ts);
    const sections = [];
    const ins = batches.filter((b) => b.dir === 'in');
    if (ins.length) sections.push(`${showHeadings ? '<div class="heading">ក.១- ចូលប្រទេស</div>' : ''}${ins.map((b) => lineFor(b, 'ចូល')).join('')}`);
    const outs = batches.filter((b) => b.dir === 'out');
    if (outs.length) sections.push(`${showHeadings ? '<div class="heading">ក.២- ចេញពីប្រទេស</div>' : ''}${outs.map((b) => lineFor(b, 'ចេញពី')).join('')}`);
    return sections.join('<div class="divider"></div>');
  }

  function generateReport(type) {
    const tpl = DOC_TEMPLATES[type];
    if (!tpl || !tpl.header || !tpl.header.template) {
      return generateWordHtml(computeTotals(type), type);
    }
    const dateLine = fillTemplateHeader(tpl);
    const secondLine = (tpl.secondLine) ? `<div class="line">${tpl.secondLine}</div>` : '';
    const body = buildTemplateBody(type);
    return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
  <meta charset="UTF-8">
  <title>Gate Manifest</title>
  <style>
    body { font-family: 'Khmer OS Siemreap', Arial, sans-serif; color: #222; line-height: 1.6; font-size: 12pt; }
    .heading { font-weight: bold; margin-top: 14pt; margin-bottom: 6pt; }
    .date { margin-bottom: 12pt; }
    .line { margin-bottom: 6pt; padding-left: 10pt; }
    .divider { border-bottom: 1px dashed #ccc; margin: 18pt 0; }
  </style>
</head>
<body>
  <div class="date">${dateLine}</div>
  ${secondLine}
  ${body}
</body>
</html>`;
  }

  // --- Shared template loader (with embedded fallback) ---
  // Try fetching the external .dotx first (so edits to the file take effect),
  // then fall back to the base64 copy embedded in templates.js. This keeps the
  // export working in environments where fetch() cannot reach the file:
  // file://, the Telegram in-app browser, or when the template is not deployed.
  async function loadTemplateBytes(filename, embedKey) {
    try {
      const resp = await fetch(filename, { cache: 'no-store' });
      if (resp.ok) {
        return new Uint8Array(await resp.arrayBuffer());
      }
    } catch (e) {
      // fall through to the embedded copy
    }
    const b64 = (typeof window.GATE_TEMPLATES !== 'undefined') && window.GATE_TEMPLATES[embedKey];
    if (b64) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
    throw new Error(filename + ' not found');
  }

  // --- NA Word: fill doc_temp_na.docx (in the project folder) with NA entries ---
  // The template contains a placeholder line:
  //   ---------------------------data go here----------------------------------
  // We replace that paragraph with the stored entry data.
  const NA_DOCX_PLACEHOLDER = '---------------------------data go here----------------------------------';

  function xmlEscape(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function docxParagraph(text, opts) {
    opts = opts || {};
    const bold = opts.bold ? '<w:b/>' : '';
    const size = opts.size || 24;
    const rPr =
      `<w:rPr>${bold}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` +
      `<w:rFonts w:ascii="Khmer OS Siemreap" w:hAnsi="Khmer OS Siemreap" w:cs="Khmer OS Siemreap" w:eastAsia="Khmer OS Siemreap"/></w:rPr>`;
    const jc = opts.align && opts.align !== 'left' ? `<w:jc w:val="${opts.align}"/>` : '';
    return `<w:p><w:pPr>${jc}</w:pPr><w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
  }

  // A data row: Khmer OS Siemreap 12pt, indented with two tabs (no heading).
  function docxDataLine(text) {
    return `<w:p><w:r><w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/>` +
      `<w:rFonts w:ascii="Khmer OS Siemreap" w:hAnsi="Khmer OS Siemreap" w:cs="Khmer OS Siemreap" w:eastAsia="Khmer OS Siemreap"/></w:rPr>` +
      `<w:tab/><w:tab/><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
  }

  function buildNaDataParagraphs() {
    const khmerGates = {
      1: 'ព្រែកចាក', 2: 'ភ្នំដិន', 3: 'ក្អមសំណ', 4: 'កោះរកា',
      5: 'បន្ទាយចក្រី', 6: 'ព្រៃវល្លិ៍', 7: 'បាវិត',
      8: 'ត្រពាំងផ្លុង', 9: 'ត្រពាំងស្រែ', 10: 'អូរយ៉ាដាវ', 11: 'ម៉ឺនជ័យ'
    };
    const tagOf = (b) => (b.type === 'thai' ? 'THAILAND' : (b.country || 'na').toUpperCase());

    const lineFor = (b, dirLabel) => {
      const khmer = khmerGates[b.gate] || `លេខ ${b.gate}`;
      return `ប៉ុស្តិ៍${khmer}: ${dirLabel}ប្រទេសចំនួន ${b.person || 0}នាក់ (ស្រី ${b.female || 0}នាក់) [${tagOf(b)}]`;
    };

    // The template already contains the "ក.១- មិនអនុញ្ញាតឱ្យចូលប្រទេស" line, so we only
    // list the stored entries as indented data rows (no section headings).
    const batches = state.entries.filter((e) => e.type === 'na').sort((a, b) => a.ts - b.ts);
    return batches.map((b) => docxDataLine(lineFor(b, b.dir === 'in' ? 'ចូល' : 'ចេញពី')));
  }

  function replacePlaceholderParagraph(xml, ph, replacement) {
    const phIdx = xml.indexOf(ph);
    if (phIdx === -1) {
      // Fallback: append before </w:body> if the placeholder is missing.
      const idx = xml.lastIndexOf('</w:body>');
      if (idx === -1) return xml;
      return xml.slice(0, idx) + replacement + xml.slice(idx);
    }
    // Find the paragraph (<w:p ...>) that contains the placeholder. Must not
    // match <w:pPr> etc., so check the character right after "<w:p".
    let pStart = -1;
    for (let k = phIdx; k >= 0; k--) {
      if (xml.startsWith('<w:p', k)) {
        const c = xml[k + 4];
        if (c === ' ' || c === '>' || c === '/') { pStart = k; break; }
      }
    }
    if (pStart === -1) return xml;
    const marker = '</w:p>';
    const pEnd = xml.indexOf(marker, phIdx) + marker.length;
    return xml.slice(0, pStart) + replacement + xml.slice(pEnd);
  }

  // Like replacePlaceholderParagraph, but matches the placeholder even when its
  // text is split across several <w:t> runs (Word often breaks long markers
  // like "data go here for IN" into multiple runs). It finds the <w:p> whose
  // concatenated run text contains `marker` and replaces that whole paragraph.
  function replaceParagraphByText(xml, marker, replacement) {
    const paraRe = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
    let result = '';
    let last = 0;
    let m;
    while ((m = paraRe.exec(xml)) !== null) {
      const para = m[0];
      let txt = '';
      const tre = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
      let tm;
      while ((tm = tre.exec(para)) !== null) txt += tm[1];
      const out = txt.includes(marker) ? replacement : para;
      result += xml.slice(last, m.index) + out;
      last = m.index + para.length;
    }
    result += xml.slice(last);
    return result;
  }

  // Fill the (day) / (month) / (year) placeholders in the template header with
  // the current Cambodia-date values.
  function fillNaDatePlaceholders(xml) {
    const now = new Date();
    return xml
      .split('(day)').join(toKhmerDigits(now.getDate()))
      .split('(month)').join(REPORT_KHMER_MONTHS[now.getMonth()])
      .split('(year)').join(toKhmerDigits(now.getFullYear()));
  }

  async function generateNaDocx() {
    if (typeof JSZip === 'undefined') throw new Error('JSZip not loaded');
    const bytes = await loadTemplateBytes('doc_temp_na.dotx', 'na');

    const zip = await JSZip.loadAsync(bytes);
    const file = zip.file('word/document.xml');
    if (!file) throw new Error('Bad NA docx template');

    let xml = await file.async('string');
    xml = fillNaDatePlaceholders(xml);
    const replacement = buildNaDataParagraphs().join('');
    xml = replacePlaceholderParagraph(xml, NA_DOCX_PLACEHOLDER, replacement);
    zip.file('word/document.xml', xml);

    // The source is a .dotx template, whose [Content_Types].xml declares the
    // main part as "...wordprocessingml.template.main+xml". Saving it with a
    // .docx extension makes Word reject the file as corrupt, so convert the
    // content type to the document variant.
    const ct = zip.file('[Content_Types].xml');
    if (ct) {
      let ctXml = await ct.async('string');
      ctXml = ctXml.split(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml'
      ).join(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
      );
      zip.file('[Content_Types].xml', ctXml);
    }

    return await zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
  }

  async function exportNaWord() {
    try {
      const blob = await generateNaDocx();
      const now = new Date();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `IN_OUT_${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}.docx`;
      link.click();
      URL.revokeObjectURL(url);
      ui.setStatus('NA Word exported (.docx)', false, true);
    } catch (err) {
      console.warn('NA docx export failed:', err);
      ui.setStatus('NA Word export failed', true);
    }
  }

  // Render the NA Word report (.docx from doc_temp_na) to a PDF file.
  // We reuse the exact filled .docx produced by generateNaDocx() and convert
  // it to PDF so the output matches the NA_Word export.
  async function exportNaPdf() {
    if (typeof window.mammoth === 'undefined') {
      ui.setStatus('Mammoth library not loaded', true);
      return;
    }
    if (!window.jspdf?.jsPDF) {
      ui.setStatus('PDF library not loaded', true);
      return;
    }
    if (!window.html2canvas) {
      ui.setStatus('Image library not loaded', true);
      return;
    }
    try {
      ui.setStatus('Rendering NA PDF...');
      const docxBlob = await generateNaDocx();
      const arrayBuffer = await docxBlob.arrayBuffer();
      const { value: html } = await window.mammoth.convertToHtml({ arrayBuffer });

      const container = document.createElement('div');
      container.innerHTML = html;
      // mammoth drops Word <w:tab/> when converting to HTML, so the 2-tab
      // indent on data rows is lost. Re-apply it: data lines start with
      // "ប៉ុស្តិ៍" — pad them to match the 2-tab indent shown in the .docx.
      container.querySelectorAll('p').forEach((p) => {
        if (p.textContent.trim().startsWith('ប៉ុស្តិ៍')) {
          p.style.paddingLeft = '1in';
        }
      });
      Object.assign(container.style, {
        position: 'fixed',
        left: '-10000px',
        top: '0',
        width: '794px',
        padding: '40px',
        background: '#fff',
        boxSizing: 'border-box',
        fontFamily: "'Khmer OS Siemreap', Arial, sans-serif",
        color: '#222',
        lineHeight: '1.6',
        fontSize: '12pt'
      });
      document.body.appendChild(container);

      const canvas = await window.html2canvas(container, {
        scale: 2,
        backgroundColor: '#ffffff'
      });
      document.body.removeChild(container);

      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const imgW = pageW;
      const imgH = (canvas.height * imgW) / canvas.width;
      const imgData = canvas.toDataURL('image/png');

      let heightLeft = imgH;
      let position = 0;
      doc.addImage(imgData, 'PNG', 0, position, imgW, imgH);
      heightLeft -= pageH;
      while (heightLeft > 0) {
        position -= pageH;
        doc.addPage();
        doc.addImage(imgData, 'PNG', 0, position, imgW, imgH);
        heightLeft -= pageH;
      }

      const now = new Date();
      doc.save(`IN_OUT_${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}.pdf`);
      ui.setStatus('NA PDF exported', false, true);
    } catch (err) {
      console.warn('NA PDF export failed:', err);
      ui.setStatus('NA PDF export failed', true);
    }
  }

  // Export both NA and Thai Word files from the renamed "NA,Thai,TWG" button.
  async function exportNaThaiWord() {
    await exportNaWord();
    exportWord('thai');
  }

  // Thai template placeholders: doc_temp_thai.dotx has two "data go here"
  // markers — one per direction section (IN / OUT) — each preceded by its
  // Khmer heading (ក.១- ចូលប្រទេស / ក.២- ចេញពីប្រទេស).
  const THAI_DOCX_IN_PLACEHOLDER = 'data go here for IN';
  const THAI_DOCX_OUT_PLACEHOLDER = 'data go here for OUT';

  // Indented data rows (Khmer OS Siemreap 12pt, two tabs) for one direction.
  function buildThaiDataLines(dir) {
    const khmerGates = {
      1: 'ព្រែកចាក', 2: 'ភ្នំដិន', 3: 'ក្អមសំណ', 4: 'កោះរកា',
      5: 'បន្ទាយចក្រី', 6: 'ព្រៃវល្លិ៍', 7: 'បាវិត',
      8: 'ត្រពាំងផ្លុង', 9: 'ត្រពាំងស្រែ', 10: 'អូរយ៉ាដាវ', 11: 'ម៉ឺនជ័យ'
    };
    const lineFor = (b) => {
      const khmer = khmerGates[b.gate] || `លេខ ${b.gate}`;
      return `ប៉ុស្តិ៍${khmer}: ចំនួន ${b.person || 0}នាក់ (ស្រី ${b.female || 0}នាក់) [THAILAND]`;
    };
    const batches = state.entries
      .filter((e) => e.type === 'thai' && e.dir === dir)
      .sort((a, b) => a.ts - b.ts);
    return batches.map((b) => docxDataLine(lineFor(b)));
  }

  // --- Thai Word: fill doc_temp_thai.dotx with the Thai entries ---
  async function generateThaiDocx() {
    if (typeof JSZip === 'undefined') throw new Error('JSZip not loaded');
    const bytes = await loadTemplateBytes('doc_temp_thai.dotx', 'thai');

    const zip = await JSZip.loadAsync(bytes);
    const file = zip.file('word/document.xml');
    if (!file) throw new Error('Bad Thai docx template');

    let xml = await file.async('string');
    xml = fillNaDatePlaceholders(xml);
    // The Thai template splits the "data go here for IN/OUT" markers across
    // runs, so match by the paragraph's concatenated text, not a raw substring.
    xml = replaceParagraphByText(xml, THAI_DOCX_IN_PLACEHOLDER, buildThaiDataLines('in').join(''));
    xml = replaceParagraphByText(xml, THAI_DOCX_OUT_PLACEHOLDER, buildThaiDataLines('out').join(''));
    zip.file('word/document.xml', xml);

    // The source is a .dotx template, whose [Content_Types].xml declares the
    // main part as "...wordprocessingml.template.main+xml". Saving it with a
    // .docx extension makes Word reject the file as corrupt, so convert the
    // content type to the document variant (same handling as the NA template).
    const ct = zip.file('[Content_Types].xml');
    if (ct) {
      let ctXml = await ct.async('string');
      ctXml = ctXml.split(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml'
      ).join(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
      );
      zip.file('[Content_Types].xml', ctXml);
    }

    return await zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
  }

  function exportWord(type) {
    try {
      const t = type || state.selectedType;
      if (t === 'thai') {
        return (async () => {
          try {
            const blob = await generateThaiDocx();
            const now = new Date();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `THAI_${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}.docx`;
            link.click();
            URL.revokeObjectURL(url);
            ui.setStatus('Thai Word exported (.docx)', false, true);
          } catch (err) {
            console.warn('Thai docx export failed:', err);
            ui.setStatus('Thai Word export failed: ' + (err && err.message ? err.message : err), true);
          }
        })();
      }
      const now = new Date();
      const html = generateReport(t);
      const blob = new Blob([html], { type: 'application/msword' });
      const url = URL.createObjectURL(blob);

      const prefix = t === 'thai' ? 'THAI_' : 'NA_';
      const link = document.createElement('a');
      link.href = url;
      link.download = `${prefix}${now.getDate()}.${now.getMonth() + 1}.${now.getFullYear()}.doc`;
      link.click();

      URL.revokeObjectURL(url);
      ui.setStatus('Word exported', false, true);
    } catch (err) {
      ui.setStatus('Word export failed', true);
    }
  }

  async function sendWordToTelegram() {
    if (!state.tgConfig.token || !state.tgConfig.chatId) {
      ui.setStatus('Configure Telegram settings first', true);
      $('settingsPanel')?.classList.add('open');
      return;
    }

    try {
      const totals = computeTotals(state.selectedType);
      const html = generateReport(state.selectedType);
      const blob = new Blob([html], { type: 'application/msword' });

      const caption = `Gate Manifest (${state.selectedType === 'thai' ? 'Thai' : (state.selectedNationName || 'Na')})\nIn: ${totals.totalIn} (${totals.totalInFemale} Female) | Out: ${totals.totalOut} (${totals.totalOutFemale} Female)`;

      const now = new Date();
      const prefix = state.selectedType === 'thai' ? 'THAI_' : 'NA_';
      const fileName = `${prefix}${now.getDate()}.${now.getMonth() + 1}.${now.getFullYear()}.doc`;

      // Proxy mode: convert to base64 and send via proxy
      if (getApiBase()) {
        const reader = new FileReader();
        const base64 = await new Promise((resolve, reject) => {
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });

        ui.setStatus('Sending Word...');
        const response = await fetch(`${getApiBase()}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'sendDocument',
            chat_id: state.tgConfig.chatId,
            caption: caption,
            file: base64,
            fileName: fileName,
            mimeType: 'application/msword'
          })
        });

        const result = await response.json();
        if (result.ok) {
          ui.setStatus('Word sent to Telegram', false, true);
        } else {
          ui.setStatus(`Proxy: ${result.error || 'send failed'}`, true);
        }
        return;
      }

      // Direct mode
      const formData = new FormData();
      formData.append('chat_id', state.tgConfig.chatId);
      formData.append('document', blob, fileName);
      formData.append('caption', caption);

      ui.setStatus('Sending Word...');
      const response = await fetch(
        buildTelegramUrl('sendDocument'),
        { method: 'POST', body: formData }
      );

      const result = await response.json();
      if (result.ok) {
        ui.setStatus('Word sent to Telegram', false, true);
      } else {
        ui.setStatus(`Telegram: ${result.description}`, true);
      }
    } catch (err) {
      ui.setStatus('Failed to send Word', true);
    }
  }

  async function exportPdf(returnBlob = false) {
    if (!window.jspdf?.jsPDF) {
      ui.setStatus('PDF library not loaded', true);
      return null;
    }
    if (!window.html2canvas) {
      ui.setStatus('Image library not loaded', true);
      return null;
    }

    try {
      ui.setStatus('Rendering PDF...');
      const html = generateReport(state.selectedType);

      const container = document.createElement('div');
      container.innerHTML = html;
      Object.assign(container.style, {
        position: 'fixed',
        left: '-10000px',
        top: '0',
        width: '794px',
        padding: '40px',
        background: '#fff',
        boxSizing: 'border-box'
      });
      document.body.appendChild(container);

      const canvas = await window.html2canvas(container, {
        scale: 2,
        backgroundColor: '#ffffff'
      });
      document.body.removeChild(container);

      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const imgW = pageW;
      const imgH = (canvas.height * imgW) / canvas.width;
      const imgData = canvas.toDataURL('image/png');

      let heightLeft = imgH;
      let position = 0;
      doc.addImage(imgData, 'PNG', 0, position, imgW, imgH);
      heightLeft -= pageH;
      while (heightLeft > 0) {
        position -= pageH;
        doc.addPage();
        doc.addImage(imgData, 'PNG', 0, position, imgW, imgH);
        heightLeft -= pageH;
      }

      const blob = doc.output('blob');
      if (returnBlob) return blob;

      const prefix = state.selectedType === 'thai' ? 'THAI_' : 'NA_';
      doc.save(`${prefix}${new Date().toISOString().slice(0, 10)}.pdf`);
      ui.setStatus('PDF exported', false, true);
      return blob;
    } catch (err) {
      ui.setStatus('PDF export failed', true);
      return null;
    }
  }

  async function exportImage(returnBlob = false) {
    if (!window.html2canvas) {
      ui.setStatus('Image library not loaded', true);
      return null;
    }

    try {
      ui.setStatus('Rendering image...');
      const canvas = await window.html2canvas($('report-root'), {
        backgroundColor: '#0b0e11',
        scale: 2
      });

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (returnBlob) return blob;

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const prefix = state.selectedType === 'thai' ? 'THAI_' : 'NA_';
      link.href = url;
      link.download = `${prefix}${Date.now()}.png`;
      link.click();

      URL.revokeObjectURL(url);
      ui.setStatus('Image exported', false, true);
      return blob;
    } catch (err) {
      ui.setStatus('Image export failed', true);
      return null;
    }
  }

  async function sendToTelegram(kind) {
    if (!state.tgConfig.token || !state.tgConfig.chatId) {
      ui.setStatus('Configure Telegram settings first', true);
      $('settingsPanel')?.classList.add('open');
      return;
    }

    try {
      ui.setStatus('Sending...');
      const prefix = state.selectedType === 'thai' ? 'THAI_' : 'NA_';
      let blob, endpoint, field, filename;

      if (kind === 'image') {
        blob = await exportImage(true);
        endpoint = 'sendPhoto';
        field = 'photo';
        filename = `${prefix}${Date.now()}.png`;
      } else {
        blob = exportPdf(true);
        endpoint = 'sendDocument';
        field = 'document';
        filename = `${prefix}${Date.now()}.pdf`;
      }

      if (!blob) return;

      const totals = computeTotals(state.selectedType);
      const caption = `Gate Manifest (${state.selectedType === 'thai' ? 'Thai' : (state.selectedNationName || 'Na')})\nIn: ${totals.totalIn} (${totals.totalInFemale} Female) | Out: ${totals.totalOut} (${totals.totalOutFemale} Female)`;

      // Proxy mode: convert to base64 and send via proxy
      if (getApiBase()) {
        const reader = new FileReader();
        const base64 = await new Promise((resolve, reject) => {
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });

        const response = await fetch(`${getApiBase()}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: endpoint,
            chat_id: state.tgConfig.chatId,
            caption: caption,
            file: base64,
            fileName: filename,
            mimeType: kind === 'image' ? 'image/png' : 'application/pdf'
          })
        });

        const data = await response.json();
        if (data.ok) {
          ui.setStatus('Sent', false, true);
        } else {
          ui.setStatus(`Proxy: ${data.error || 'send failed'}`, true);
        }
        return;
      }

      // Direct mode
      const formData = new FormData();
      formData.append('chat_id', state.tgConfig.chatId);
      formData.append('caption', caption);
      formData.append(field, blob, filename);

      const response = await fetch(
        buildTelegramUrl(endpoint),
        { method: 'POST', body: formData }
      );

      const data = await response.json();
      if (data.ok) {
        ui.setStatus('Sent', false, true);
      } else {
        ui.setStatus(`Telegram: ${data.description || 'error'}`, true);
      }
    } catch (err) {
      ui.setStatus('Send failed', true);
    }
  }

  // ============================================================
  // SIDEBAR / GATE NAVIGATION
  // ============================================================
  async function loadSelectedGate() {
    try {
      const raw = await Promise.race([
        storage.get('gate_selected', false),
        new Promise((res) => setTimeout(() => res(null), 1500))
      ]);
      if (raw) {
        const g = parseInt(raw, 10);
        if (g >= 1 && g <= GATE_COUNT) state.selectedGate = g;
      }
    } catch (e) { /* ignore */ }
  }

  function applyActiveGateClasses() {
    const grid = $('gateDots');
    if (!grid) return;
    grid.querySelectorAll('.gate-btn').forEach((b) => {
      const isActive = parseInt(b.dataset.gate, 10) === state.selectedGate;
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }

  async function saveSelectedGate() {
    try {
      await storage.set('gate_selected', String(state.selectedGate), false);
    } catch (e) { /* ignore */ }
  }
  function buildGateGrid() {
    const grid = $('gateDots');
    if (!grid) return;

    function rowForGate(g) {
      if (g <= 4) return grid.querySelector('.gate-row[data-row="1"]');
      if (g <= 8) return grid.querySelector('.gate-row[data-row="2"]');
      return grid.querySelector('.gate-row[data-row="3"]');
    }

    for (let g = 1; g <= GATE_COUNT; g++) {
      const btn = document.createElement('button');
      btn.className = 'gate-btn' + (g === state.selectedGate ? ' active' : '');
      btn.dataset.gate = g;
      btn.textContent = '•';
      btn.setAttribute('aria-label', `Gate ${g}: ${GATE_NAMES[g]}`);
      btn.title = `${g}. ${GATE_NAMES[g]}`;
      btn.type = 'button';
      btn.setAttribute('aria-pressed', g === state.selectedGate ? 'true' : 'false');
      rowForGate(g).appendChild(btn);
    }

    // Manual temporary pass via long-press (touch AND mouse, ~0.5s hold).
    let pressTimer = null;
    let didLongPress = false;
    const LONG_PRESS_MS = 550;

    function clearPressTimer() {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    }

    function startPress(btn) {
      const gate = parseInt(btn.dataset.gate, 10);
      const label = GATE_NAMES[gate];
      didLongPress = false;
      clearPressTimer();
      pressTimer = setTimeout(() => {
        didLongPress = true;
        btn.classList.add('longpress');
        manualToggleGateVerified(gate).then((isOn) => {
          ui.setStatus(
            isOn ? `Temp pass: gate ${label} verified` : `Temp pass removed: gate ${label}`,
            false,
            true
          );
        });
      }, LONG_PRESS_MS);
    }

    function endPress() {
      clearPressTimer();
      grid.querySelectorAll('.gate-btn.longpress').forEach((b) => b.classList.remove('longpress'));
    }

    grid.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const btn = e.target.closest('.gate-btn');
      if (btn) startPress(btn);
    });
    grid.addEventListener('pointerup', endPress);
    grid.addEventListener('pointerleave', endPress);
    grid.addEventListener('pointercancel', clearPressTimer);
    // Stop the browser/Telegram long-press menu so the gesture works.
    grid.addEventListener('contextmenu', (e) => e.preventDefault());

    grid.addEventListener('click', (e) => {
      const btn = e.target.closest('.gate-btn');
      if (!btn) return;

      // Tail of a long-press: skip normal selection (toggle already happened).
      if (didLongPress) { didLongPress = false; return; }

      state.selectedGate = parseInt(btn.dataset.gate, 10);
      saveSelectedGate();

      grid.querySelectorAll('.gate-btn').forEach((b) => {
        const isActive = b === btn;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });

      ui.updateGateName();
      ui.updateTotals();

      const label = GATE_NAMES[state.selectedGate];
      ui.setStatus(`Selected gate: ${label}`, false, true);
    });

    // Show gate name on hover without needing to click.
    grid.addEventListener('mouseover', (e) => {
      const btn = e.target.closest('.gate-btn');
      if (!btn) return;
      const gate = parseInt(btn.dataset.gate, 10);
      if (isNaN(gate) || gate < 1 || gate > GATE_COUNT) return;
      ui.setStatus(`${gate}. ${GATE_NAMES[gate]}`);
    });

    grid.addEventListener('mouseout', (e) => {
      const fromBtn = e.target.closest('.gate-btn');
      const toBtn = e.relatedTarget?.closest?.('.gate-btn');
      if (fromBtn && !toBtn) {
        ui.setStatus('');
      }
    });
  }

  // ============================================================
  // COUNTER CONTROLS
  // ============================================================
  function setupCounters() {
    $('box1Up')?.addEventListener('click', () => {
      state.box1++;
      renderCounters();
    });

    $('box1Down')?.addEventListener('click', () => {
      if (state.box1 > 0) state.box1--;
      renderCounters();
    });

    $('box2Up')?.addEventListener('click', () => {
      state.box2++;
      renderCounters();
    });

    $('box2Down')?.addEventListener('click', () => {
      if (state.box2 > 0) state.box2--;
      renderCounters();
    });
  }

  function renderCounters() {
    if ($('box1Val')) $('box1Val').textContent = state.box1;
    if ($('box2Val')) $('box2Val').textContent = state.box2;
  }

  // ============================================================
  // DIRECTION TOGGLE
  // ============================================================
  function setupDirectionToggle() {
    $('btnDirIn')?.addEventListener('click', () => {
      state.selectedDir = 'in';
      $('btnDirIn').classList.add('active');
      $('btnDirOut')?.classList.remove('active');
    });

    $('btnDirOut')?.addEventListener('click', () => {
      state.selectedDir = 'out';
      $('btnDirOut').classList.add('active');
      $('btnDirIn')?.classList.remove('active');
    });
  }

  // ============================================================
  // NATIONALITY TOGGLE
  // ============================================================
  const ASEAN_NATIONS = [
    'Brunei', 'Indonesia', 'Laos', 'Malaysia',
    'Myanmar', 'Philippines', 'Singapore', 'Thailand', 'Vietnam'
  ];

  const OTHER_NATIONS = [
    'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola',
    'Antigua and Barbuda', 'Argentina', 'Armenia', 'Australia', 'Austria',
    'Azerbaijan', 'Bahamas', 'Bahrain', 'Bangladesh', 'Barbados',
    'Belarus', 'Belgium', 'Belize', 'Benin', 'Bhutan', 'Bolivia',
    'Bosnia and Herzegovina', 'Botswana', 'Brazil', 'Bulgaria',
    'Burkina Faso', 'Burundi', 'Cabo Verde', 'Cameroon', 'Canada',
    'Central African Republic', 'Chad', 'Chile', 'Colombia',
    'Comoros', 'Congo', 'Costa Rica', "Cote d'Ivoire", 'Croatia',
    'Cuba', 'Cyprus', 'Czechia', 'Denmark', 'Djibouti',
    'Dominica', 'Dominican Republic', 'Ecuador', 'Egypt', 'El Salvador',
    'Equatorial Guinea', 'Eritrea', 'Estonia', 'Eswatini', 'Ethiopia',
    'Fiji', 'Finland', 'France', 'Gabon', 'Gambia', 'Georgia',
    'Germany', 'Ghana', 'Greece', 'Grenada', 'Guatemala', 'Guinea',
    'Guinea-Bissau', 'Guyana', 'Haiti', 'Honduras', 'Hungary',
    'Iceland', 'India', 'Iran', 'Iraq', 'Ireland', 'Israel',
    'Italy', 'Jamaica', 'Japan', 'Jordan', 'Kazakhstan', 'Kenya',
    'Kiribati', 'Korea (North)', 'Korea (South)', 'Kuwait',
    'Kyrgyzstan', 'Latvia', 'Lebanon', 'Lesotho', 'Liberia', 'Libya',
    'Liechtenstein', 'Lithuania', 'Luxembourg', 'Madagascar',
    'Malawi', 'Maldives', 'Mali', 'Malta', 'Marshall Islands',
    'Mauritania', 'Mauritius', 'Mexico', 'Micronesia', 'Moldova',
    'Monaco', 'Mongolia', 'Montenegro', 'Morocco', 'Mozambique',
    'Namibia', 'Nauru', 'Nepal', 'Netherlands', 'New Zealand',
    'Nicaragua', 'Niger', 'Nigeria', 'North Macedonia', 'Norway',
    'Oman', 'Pakistan', 'Palau', 'Palestine', 'Panama',
    'Papua New Guinea', 'Paraguay', 'Peru', 'Poland', 'Portugal',
    'Qatar', 'Romania', 'Russia', 'Rwanda',
    'Saint Kitts and Nevis', 'Saint Lucia', 'Saint Vincent and the Grenadines',
    'Samoa', 'San Marino', 'Sao Tome and Principe', 'Saudi Arabia',
    'Senegal', 'Serbia', 'Seychelles', 'Sierra Leone', 'Slovakia',
    'Slovenia', 'Solomon Islands', 'Somalia', 'South Africa',
    'South Sudan', 'Spain', 'Sri Lanka', 'Sudan', 'Suriname',
    'Sweden', 'Switzerland', 'Syria', 'Taiwan', 'Tajikistan',
    'Tanzania', 'Timor-Leste', 'Togo', 'Tonga',
    'Trinidad and Tobago', 'Tunisia', 'Turkey', 'Turkmenistan',
    'Tuvalu', 'Uganda', 'Ukraine', 'United Arab Emirates',
    'United Kingdom', 'United States', 'Uruguay', 'Uzbekistan',
    'Vanuatu', 'Vatican City', 'Yemen', 'Zambia',
    'Zimbabwe'
  ];

  const ALL_NATIONS = ['China', 'Vietnam'].concat(ASEAN_NATIONS, OTHER_NATIONS);

  function updateTypeHeader() {
    // Only show the nation in the status area if the user explicitly
    // selected a nation (avoid showing on initial load/refresh).
    if (!state.nationSelectedByUser) {
      ui.setStatus('');
      return;
    }

    if (state.selectedType === 'na') {
      const name = state.selectedNationName || 'Na';
      ui.setStatus(name);
    } else {
      ui.setStatus('Thai');
    }
  }

  function setupNationToggle() {
    const list = $('nationList');
    const backdrop = $('nationBackdrop');

    function closeList() {
      if (list) list.hidden = true;
      if (backdrop) backdrop.hidden = true;
    }

    function openList() {
      if (list) list.hidden = false;
      if (backdrop) backdrop.hidden = false;
    }

    function markSelected(nation) {
      if (!list) return;
      list.querySelectorAll('.nation-item').forEach((it) => {
        it.classList.toggle('selected', it.dataset.nation === nation);
      });
    }

    function wireItem(it) {
      it.addEventListener('click', () => selectItem(it));
    }

    function selectItem(it) {
      const nation = it.dataset.nation;
      state.selectedNation = nation;
      state.selectedNationName = it.textContent;
      state.nationSelectedByUser = true;
      state.selectedType = 'na';
      $('btnNa').classList.add('active');
      $('btnThai')?.classList.remove('active');
      markSelected(nation);
      closeList();
      updateTypeHeader();
      ui.updateTotals();
      updateCounterMode();
    }

    $('btnNa')?.addEventListener('click', () => {
      state.nationSelectedByUser = true;
      state.selectedType = 'na';
      $('btnNa').classList.add('active');
      $('btnThai')?.classList.remove('active');
      openList();
      updateTypeHeader();
      ui.updateTotals();
      updateCounterMode();
    });

    $('btnThai')?.addEventListener('click', () => {
      state.nationSelectedByUser = true;
      closeList();
      state.selectedType = 'thai';
      state.selectedNation = 'thai';
      $('btnThai').classList.add('active');
      $('btnNa')?.classList.remove('active');
      updateTypeHeader();
      ui.updateTotals();
      updateCounterMode();
    });

    function updateCounterMode() {
      const panel = document.querySelector('.counter-panel');
      if (!panel) return;
      panel.classList.toggle('na-mode', state.selectedType === 'na');
      panel.classList.toggle('thai-mode', state.selectedType === 'thai');
    }

    updateCounterMode();

    if (backdrop) {
      backdrop.addEventListener('click', closeList);
    }

    if (list) {
      ALL_NATIONS.forEach((name) => {
        const btn = document.createElement('button');
        btn.className = 'nation-item';
        btn.dataset.nation = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
        btn.type = 'button';
        btn.textContent = name;
        wireItem(btn);
        list.appendChild(btn);
      });
    }

    const search = $('nationSearch');
    if (search && list) {
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        list.querySelectorAll('.nation-item').forEach((it) => {
          const match = it.textContent.toLowerCase().includes(q);
          it.style.display = match ? '' : 'none';
        });
      });
    }

    markSelected(state.selectedNation);
  }

  // ============================================================
  // ADD ENTRY
  // ============================================================
  function setupAddButton() {
    $('btnAdd')?.addEventListener('click', async () => {
      if (!state.selectedGate) {
        ui.setStatus('Please select a gate', true);
        return;
      }

      if (state.box2 > state.box1) {
        ui.setStatus('Female count cannot exceed total', true);
        return;
      }

      if (state.box1 - state.box2 < 0) {
        ui.setStatus('Male count cannot be negative', true);
        return;
      }

      if (!state.nationSelectedByUser) {
        ui.setStatus('Please select a type or country', true);
        return;
      }

      const total = state.box1;
      const femaleCount = state.box2;
      const now = Date.now();
      const entry = {
        id: generateId(),
        gate: state.selectedGate,
        gateName: GATE_NAMES[state.selectedGate],
        dir: state.selectedDir,
        person: total,
        female: femaleCount,
        type: state.selectedType,
        country: state.selectedNationName,
        ts: now
      };

      state.entries.push(entry);
      await dataStore.saveEntries();

      // Send the new entry to the local server to append into DB.xlsx
      if (getApiBase()) {
        try {
          await fetch(`${getApiBase()}/add-entry`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries: [entry] })
          });
        } catch (err) {
          console.error('Failed to write DB.xlsx:', err);
        }
      }

      const label = GATE_NAMES[state.selectedGate];
      const msg = `Added ${total} ${state.selectedDir.toUpperCase()} (${femaleCount} Female) to ${label}`;

      state.box1 = 0;
      state.box2 = 0;
      renderCounters();
      ui.updateTotals();

      state.selectedNation = 'na';
      if ($('btnNa')) {
        $('btnNa').textContent = 'Na';
        $('btnNa').classList.add('active');
      }
      $('btnThai')?.classList.remove('active');

      ui.setStatus(msg, false, true);
    });
  }

  // ============================================================
  // AUTO SYNC
  // ============================================================
  function toggleAutoSync(button) {
    if (state.autoSyncTimer) {
      clearInterval(state.autoSyncTimer);
      state.autoSyncTimer = null;
      button.textContent = 'Sync';
      ui.setStatus('Auto-sync stopped', false, true);
    } else {
      button.textContent = 'Stop';
      ui.setStatus('Auto-sync active (1 min)', false, true);

      const runOnce = async () => {
        const allVerified = await checkTelegramUpdates(true);
        if (allVerified) {
          // All gates verified: stop auto-sync and report completion.
          if (state.autoSyncTimer) {
            clearInterval(state.autoSyncTimer);
            state.autoSyncTimer = null;
            button.textContent = 'Sync';
          }
          ui.setStatus('All gates verified — auto-sync stopped', false, true);
          return;
        }
        // Keep the green light pulsing during the wait until the next check.
        if (state.autoSyncTimer) ui.setSyncIndicator('running');
      };

      runOnce();
      state.autoSyncTimer = setInterval(runOnce, 60000);
    }
  }

  // ============================================================
  // UNDO / RESET
  // ============================================================
  async function undoLast() {
    if (!state.entries.length) {
      ui.setStatus('Nothing to undo', false);
      return;
    }

    state.entries.sort((a, b) => a.ts - b.ts);
    state.entries.pop();
    await dataStore.saveEntries();
    ui.updateTotals();
    ui.setStatus('Last entry undone', false, true);
  }

  async function resetAll() {
    if (!confirm('Reset ALL gate counts? This cannot be undone.')) return;
    if (!confirm('Really sure?')) return;

    state.entries = [];
    await dataStore.saveEntries();
    ui.updateTotals();
    ui.setStatus('All counts reset', false, true);
  }

  // ============================================================
  // WIRE UP EVENT HANDLERS
  // ============================================================
  function wireControls() {
    // Export buttons
    $('btnExportWord').onclick = () => exportWord('thai');
    $('btnExportNAWord').onclick = () => exportNaThaiWord();
    $('btnExportNAPdf').onclick = () => exportNaPdf();
    $('btnTelegramWord').onclick = sendWordToTelegram;
    $('btnExportPdf').onclick = () => exportPdf();

    // Settings
    $('btnToggleSettings').onclick = () => {
      const panel = $('settingsPanel');
      panel.classList.toggle('open');
      panel.setAttribute('aria-hidden', !panel.classList.contains('open'));
    };

    // Telegram send
    $('btnSendImg').onclick = () => sendToTelegram('image');
    $('btnSendPdf').onclick = () => sendToTelegram('pdf');

    // Actions
    $('btnUndo').onclick = undoLast;
    $('btnReset').onclick = resetAll;

    // Sync
    $('btnSync').onclick = () => toggleAutoSync($('btnSync'));
    $('btnCheck').onclick = () => {
      audio.unlock();
      checkTelegramUpdates(false);
    };

    // Check/Sync buttons reveal ONLY when the gates navigator header is pressed
    (function wireNavReveal() {
      const reveal = $('gateReveal');
      const navHeader = document.querySelector('.gate-nav-header');
      if (!reveal || !navHeader) return;
      navHeader.addEventListener('click', () => {
        reveal.classList.toggle('show-actions');
      });
    })();

    // Test alert: send Khmer reminder to the current private alert chat (you).
    $('btnTestAlert')?.addEventListener('click', async () => {
      audio.unlock();
      const ok = await sendTelegramMessage(
        'សូមផ្ញើរបកចូល ក្រុមម៉ោង ៤ សូមអរគុណ',
        state.tgConfig.alertChatId || '518858937'
      );
      ui.setStatus(ok ? 'Test alert sent' : 'Test alert failed', false, !ok);
    });

    // Settings save
    $('btnSaveSettings').onclick = async () => {
      state.tgConfig.token = $('tgToken').value.trim();
      state.tgConfig.chatId = $('tgChatId').value.trim();
      state.tgConfig.alertChatId = $('tgAlertChatId')?.value.trim() || '';

      // Save getApiBase()
      const apiBase = $('apiBase')?.value.trim() || '';
      try {
        localStorage.setItem('gate_api_base', apiBase);
      } catch (e) { /* ignore */ }

      await dataStore.saveConfig();
      ui.setStatus('Settings saved', false, true);
      await checkTelegramUpdates();
    };

  }

  // ============================================================
  // LIBRARY CHECK
  // ============================================================
  function checkLibraries() {
    setTimeout(() => {
      const failed = window.__libFailed || {};
      const missingPdf = failed.jspdf || !window.jspdf?.jsPDF;
      const missingImg = failed.html2canvas || !window.html2canvas;
      const missingMammoth = failed.mammoth || typeof window.mammoth === 'undefined';
      const warning = $('libWarning');

      if ((missingPdf || missingImg || missingMammoth) && warning) {
        const parts = [];
        if (missingPdf) parts.push('PDF export');
        if (missingImg) parts.push('Image export');
        if (missingMammoth) parts.push('NA PDF export');
        warning.textContent = `${parts.join(' and ')} unavailable offline.`;
        warning.classList.add('show');
      }
    }, 1500);
  }

  // ============================================================
  // FOLDER VERSION -> HEADER
  // ============================================================
  // Reads the version from the containing folder name (e.g. "code_v1.0" or "Main")
  // and sets the nav header to "Gates v1.0" or "Gates vMain". No manual edits needed per version.
  function applyFolderVersion() {
    const el = document.querySelector('.gate-nav-title');
    if (!el) return;
    try {
      const rawPath = decodeURIComponent(window.location.pathname);
      // Strip trailing index.html so "Main/index.html" becomes "Main/"
      const pathname = rawPath.replace(/\/index\.html$/i, '');
      const match = pathname.match(/\/([^\/]+)\/?$/i);
      const folder = match ? match[1] : '';
      if (/^main$/i.test(folder)) { el.textContent = `Gates vMain`; return; }

      const verMatch = pathname.match(/code_v(\d+(?:\.\d+)?)/i);
      if (verMatch) { el.textContent = `Gates v${verMatch[1]}`; return; }

      // Fallback for hosts without a folder name (e.g. GitHub Pages):
      // read the version from <meta name="gate-version">.
      const meta = document.querySelector('meta[name="gate-version"]');
      if (meta && meta.content) el.textContent = `Gates v${meta.content}`;
    } catch (e) { /* keep default header */ }
  }

  // ============================================================
  // INITIALIZATION
  // ============================================================
  async function init() {
    // Set header version from the folder name
    applyFolderVersion();

    // Build UI first so gates always render
    buildGateGrid();
    setupCounters();
    setupDirectionToggle();
    setupNationToggle();
    setupAddButton();
    wireControls();

    // Load config, and start with a fresh entry list each refresh
    await dataStore.loadConfig();
    state.entries = [];
    await dataStore.saveEntries();

    // Restore last selected gate (non-blocking, has its own timeout)
    await loadSelectedGate();
    applyActiveGateClasses();

    // Populate settings form
    if ($('tgToken')) $('tgToken').value = state.tgConfig.token || '';
    if ($('tgChatId')) $('tgChatId').value = state.tgConfig.chatId || '';
    if ($('apiBase')) {
      try {
        $('apiBase').value = localStorage.getItem('gate_api_base') || '';
      } catch (e) { /* ignore */ }
    }

    if ($('tgAlertChatId')) $('tgAlertChatId').value = state.tgConfig.alertChatId || '';

    // Initial render
    ui.updateGateName();
    ui.updateTotals();
    renderCounters();
    updateTypeHeader();
    checkLibraries();

    // Initial styles
    applyVerificationStyles({});

    // Randomly change the "Linked: ..." badge color on a slow blink cycle
    const linkedEl = $('btnTestAlert');
    if (linkedEl) {
      const linkedPalette = ['#e83e8c', '#34d27b', '#5dade2', '#f5b041', '#e74c3c', '#c084fc', '#22d3ee'];
      setInterval(() => {
        const color = linkedPalette[Math.floor(Math.random() * linkedPalette.length)];
        linkedEl.style.color = color;
      }, 3000);
    }

    // Poll for external changes (other devices)
    setInterval(async () => {
      if (state.saving) return;
      const before = JSON.stringify(state.entries);
      await dataStore.loadEntries();
      if (JSON.stringify(state.entries) !== before) {
        ui.updateTotals();
      }
    }, 8000);
  }

  // ============================================================
  // MASTER-PC SCHEDULED SYNC (15:00 Cambodia time)
  // ============================================================
  // On the PC named "Master-PC", automatically trigger a Telegram sync
  // once per day at 15:00 Cambodia time. Cambodia is UTC+7.
  const HOST_PC_NAME = 'Master-PC';
  const SCHEDULED_SYNC_HOUR = 15; // 15:00 (3:00 PM) Cambodia time
  const SCHEDULED_SYNC_MINUTE_START = 0;  // auto-start window begins at 15:00
  const SCHEDULED_SYNC_MINUTE_END = 10;   // and ends at 15:10 (Cambodia time)

  function getPcName() {
    try {
      const params = new URLSearchParams(window.location.search);
      const fromUrl = params.get('pc');
      if (fromUrl) return fromUrl;
    } catch (e) { /* ignore */ }
    try {
      // Browser has no direct hostname API; read a user-set value if present,
      // otherwise fall back to the known environment name marker.
      const stored = localStorage.getItem('gate_pc_name');
      if (stored) return stored;
    } catch (e) { /* ignore */ }
    // Fallback: expose a global so it can be set per deployment.
    return (typeof window.__PC_NAME__ !== 'undefined') ? window.__PC_NAME__ : '';
  }

  function cambodiaNow() {
    return new Date(Date.now() + (7 * 60 * 60 * 1000));
  }

  // True when the current Cambodia time is within the daily auto-start window
  // (15:00–15:10). Used so the Master-PC begins auto-sync on its own while the
  // operator is in that window.
  function inAutoStartWindow(now) {
    return now.getUTCHours() === SCHEDULED_SYNC_HOUR &&
      now.getUTCMinutes() >= SCHEDULED_SYNC_MINUTE_START &&
      now.getUTCMinutes() <= SCHEDULED_SYNC_MINUTE_END;
  }

  function scheduleMasterSync() {
    if (getPcName().toLowerCase() !== HOST_PC_NAME.toLowerCase()) return;

    // Auto-start the auto-sync on load if we're inside the 15:00–15:10 window.
    // If all gates verify, toggleAutoSync's runOnce will stop it again.
    if (inAutoStartWindow(cambodiaNow()) && !state.autoSyncTimer) {
      const btn = $('btnSync');
      if (btn) toggleAutoSync(btn);
    }

    const tick = () => {
      const now = cambodiaNow();
      // Auto-start the moment the window opens, even if the page was already
      // open before 15:00.
      if (inAutoStartWindow(now) && !state.autoSyncTimer) {
        const btn = $('btnSync');
        if (btn) toggleAutoSync(btn);
      }
      // Also fire a single once-per-day scheduled sync at the top of the hour.
      if (now.getUTCHours() === SCHEDULED_SYNC_HOUR && now.getUTCMinutes() === 0) {
        // Fire once per minute-window to avoid missing the exact tick;
        // guard against multiple fires within the same hour.
        const key = `master_sync_fired_${now.getUTCFullYear()}_${now.getUTCMonth()}_${now.getUTCDate()}_${SCHEDULED_SYNC_HOUR}`;
        (async () => {
          let fired = false;
          try {
            const raw = await storage.get(key, true);
            fired = raw === '1';
          } catch (e) { /* ignore */ }
          if (!fired) {
            try { await storage.set(key, '1', true); } catch (e) { /* ignore */ }
            ui.setStatus('Master-PC scheduled sync at 15:00', false, true);
            await checkTelegramUpdates(true);
          }
        })();
      }

      // Alert unverified gates at 15:50 Cambodia time.
      if (now.getUTCHours() === 15 && now.getUTCMinutes() === 50) {
        const alertKey = `gate_alerts_${now.getUTCFullYear()}_${now.getUTCMonth()}_${now.getUTCDate()}`;
        (async () => {
          let fired = false;
          try {
            const raw = await storage.get(alertKey, true);
            fired = raw === '1';
          } catch (e) { /* ignore */ }
          if (!fired) {
            const { year, month, day } = getCambodiaDate();
            const todayKey = buildDateKey(year, month, day);
            let verified = {};
            try {
              const raw = await storage.get(todayKey, true);
              if (raw) verified = JSON.parse(raw);
            } catch (e) { /* ignore */ }
            for (let g = 1; g <= GATE_COUNT; g++) {
              if (!verified[g]) {
                await sendTelegramMessage(
                  'សូមផ្ញើរបកចូល ក្រុមម៉ោង ៤ សូមអរគុណ',
                  GATE_USER_IDS[g]
                );
              }
            }
            try { await storage.set(alertKey, '1', true); } catch (e) { /* ignore */ }
          }
        })();
      }
    };

    tick();
    setInterval(tick, 60000);
  }

  // Start application
  init().then(scheduleMasterSync);
})();
