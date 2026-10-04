// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const PERIOD_MS = 60_000;
const FOCUS_COOLDOWN_MS = 15_000;
const BUSY_STATES = new Set(['checking', 'available', 'downloading', 'verifying', 'downloaded']);

function createUpdateCheckScheduler({ check, getState, enabled = () => true, onError = () => {},
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let running = false;
  let timer = null;
  let pending = null;
  let lastAttempt = -Infinity;
  function schedule(delay = PERIOD_MS) {
    if (timer !== null) clearTimer(timer);
    timer = running ? setTimer(tick, delay) : null;
    timer?.unref?.();
  }
  async function poll() {
    if (!running || !enabled() || BUSY_STATES.has(getState()) || pending) return;
    lastAttempt = now();
    pending = Promise.resolve().then(check);
    try { await pending; } catch (error) { onError(error); } finally { pending = null; }
  }
  async function tick() {
    timer = null;
    await poll();
    if (running) schedule();
  }
  return {
    start() { if (!running) { running = true; schedule(1500); } },
    stop() { running = false; if (timer !== null) clearTimer(timer); timer = null; },
    focus() { return now() - lastAttempt >= FOCUS_COOLDOWN_MS ? poll() : Promise.resolve(); }
  };
}
module.exports = { createUpdateCheckScheduler, PERIOD_MS, FOCUS_COOLDOWN_MS };
