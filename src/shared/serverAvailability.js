// SPDX-License-Identifier: GPL-3.0-only
(function initializeServerAvailability(root) {
  'use strict';

  // Catalog age, not a direct health check. Keep badges and join checks consistent.
  const MAX_LIVE_SERVER_AGE_MS = 4 * 60 * 60 * 1000;

  function assessServerAvailability(server = {}, options = {}) {
    const status = String(server.status || '').trim().toLocaleLowerCase('en');
    const lastUpdatedAt = Date.parse(String(server.lastUpdated || ''));
    if (!Number.isFinite(lastUpdatedAt)) {
      return { available: false, reason: 'unknown', ageMs: null };
    }
  
    const suppliedNow = typeof options.now === 'function' ? options.now() : options.now;
    const now = Number.isFinite(Number(suppliedNow)) ? Number(suppliedNow) : Date.now();
    const suppliedMaximumAge = Number(options.maximumAgeMs);
    const maximumAgeMs = Number.isFinite(suppliedMaximumAge) && suppliedMaximumAge >= 60_000
      ? suppliedMaximumAge
      : MAX_LIVE_SERVER_AGE_MS;
    const ageMs = Math.max(0, now - lastUpdatedAt);
    if (lastUpdatedAt > now + 5 * 60 * 1000) {
      return { available: false, reason: 'unknown', ageMs: null };
    }
    if (ageMs > maximumAgeMs) return { available: false, reason: 'stale', ageMs };
    if (status !== 'online') {
      return { available: false, reason: ['offline', 'dead'].includes(status) ? 'offline' : 'unknown', ageMs };
    }
    return { available: true, reason: 'online', ageMs };
  }

  const api = Object.freeze({ MAX_LIVE_SERVER_AGE_MS, assessServerAvailability });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.launcherServerAvailability = api;
})(globalThis);
