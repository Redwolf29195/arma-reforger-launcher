const https = require('node:https');

const UPDATE_PUSH_TOPIC = 'algz-armareforger-launcher-release-f39c6d4182a749a58e14';
const UPDATE_PUSH_URL = `https://ntfy.sh/${UPDATE_PUSH_TOPIC}/json`;
const UPDATE_SIGNAL_PREFIX = 'launcher-update:';
const MAX_PUSH_LINE_BYTES = 64 * 1024;

function normalizeVersion(value) {
  const version = String(value || '').trim();
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : '';
}

function parseUpdatePushLine(line) {
  const source = String(line || '').trim();
  if (!source) return null;

  let event;
  try {
    event = JSON.parse(source);
  } catch {
    return null;
  }

  if (event?.event !== 'message') return null;
  const message = String(event.message || '');
  if (!message.startsWith(UPDATE_SIGNAL_PREFIX)) return null;
  const version = normalizeVersion(message.slice(UPDATE_SIGNAL_PREFIX.length));
  if (!version) return null;

  return {
    id: String(event.id || ''),
    version,
    time: Number(event.time || 0)
  };
}

function createUpdatePushSubscriber({
  url = UPDATE_PUSH_URL,
  request = https.get,
  onUpdate = () => {},
  onStatus = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  let running = false;
  let currentConnection = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let lastMessageId = '';

  function closeConnection(connection) {
    if (!connection) return;
    connection.finished = true;
    if (currentConnection === connection) currentConnection = null;
    connection.response?.destroy?.();
    connection.request?.destroy?.();
  }

  function scheduleReconnect(error) {
    if (!running || reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * (2 ** Math.min(reconnectAttempt, 5)));
    reconnectAttempt += 1;
    onStatus({ state: 'reconnecting', delay, error: error?.message || '' });
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    reconnectTimer?.unref?.();
  }

  function connect() {
    if (!running || currentConnection) return;
    const connection = { request: null, response: null, finished: false };
    currentConnection = connection;
    let buffer = '';
    let bufferedBytes = 0;
    const active = () => running && !connection.finished && currentConnection === connection;
    const reconnect = (error) => {
      if (!active()) return;
      closeConnection(connection);
      buffer = '';
      bufferedBytes = 0;
      scheduleReconnect(error);
    };

    onStatus({ state: 'connecting' });
    try {
      connection.request = request(url, {
        headers: {
          Accept: 'application/x-ndjson',
          'Cache-Control': 'no-cache',
          'User-Agent': 'Arma-Reforger-Launcher-Update-Push'
        }
      }, (response) => {
        if (!active()) {
          response.on('error', () => {});
          response.destroy?.();
          return;
        }
        connection.response = response;
        response.once('error', reconnect);
        response.once('end', () => reconnect());
        response.once('aborted', () => reconnect(new Error('Push channel was interrupted')));
        response.once('close', () => reconnect());
        if (response.statusCode !== 200) {
          reconnect(new Error(`Push channel returned HTTP ${response.statusCode || 0}`));
          return;
        }

        reconnectAttempt = 0;
        onStatus({ state: 'connected' });
        response.setEncoding?.('utf8');
        response.on('data', (chunk) => {
          if (!active()) return;
          const text = String(chunk || '');
          let offset = 0;
          while (active() && offset < text.length) {
            const newlineIndex = text.indexOf('\n', offset);
            const segment = text.slice(offset, newlineIndex < 0 ? text.length : newlineIndex);
            bufferedBytes += Buffer.byteLength(segment, 'utf8');
            if (bufferedBytes > MAX_PUSH_LINE_BYTES) {
              reconnect(new Error('Push channel message is too large'));
              return;
            }
            buffer += segment;
            if (newlineIndex < 0) break;
            const signal = parseUpdatePushLine(buffer.replace(/\r$/, ''));
            buffer = '';
            bufferedBytes = 0;
            offset = newlineIndex + 1;
            if (signal && (!signal.id || signal.id !== lastMessageId)) {
              lastMessageId = signal.id;
              try { Promise.resolve(onUpdate(signal)).catch(() => {}); } catch {}
            }
          }
        });
      });
      connection.request.once('error', reconnect);
      connection.request.once('close', () => reconnect());
      if (!active()) {
        connection.request.destroy?.();
        return;
      }
      connection.request.setTimeout?.(90_000, () => {
        if (active()) reconnect(new Error('Push channel timed out'));
      });
    } catch (error) {
      reconnect(error);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      connect();
    },
    stop() {
      running = false;
      if (reconnectTimer) clearTimer(reconnectTimer);
      reconnectTimer = null;
      closeConnection(currentConnection);
      onStatus({ state: 'stopped' });
    },
    isRunning() {
      return running;
    }
  };
}

module.exports = {
  UPDATE_PUSH_TOPIC,
  UPDATE_PUSH_URL,
  createUpdatePushSubscriber,
  parseUpdatePushLine
};
