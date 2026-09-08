const crypto = require('node:crypto');

const TRANSLATION_ORIGIN = 'https://api.mymemory.translated.net';
const MAX_SEGMENT_BYTES = 450;
const MAX_SOURCE_BYTES = 4_800;
const MAX_RESPONSE_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const CACHE_LIMIT = 100;

const translationCache = new Map();

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function cutAtUtf8Boundary(value, maximumBytes) {
  let bytes = 0;
  let index = 0;
  for (const character of String(value || '')) {
    const characterBytes = byteLength(character);
    if (bytes + characterBytes > maximumBytes) break;
    bytes += characterBytes;
    index += character.length;
  }
  return index;
}

function splitLongLine(line, maximumBytes = MAX_SEGMENT_BYTES) {
  const chunks = [];
  let remaining = String(line || '').trim();
  while (remaining) {
    if (byteLength(remaining) <= maximumBytes) {
      chunks.push(remaining);
      break;
    }

    const hardLimit = cutAtUtf8Boundary(remaining, maximumBytes);
    if (hardLimit <= 0) throw new Error('Не удалось подготовить описание к переводу.');
    const candidate = remaining.slice(0, hardLimit);
    const preferredBreaks = [
      candidate.lastIndexOf('. '),
      candidate.lastIndexOf('! '),
      candidate.lastIndexOf('? '),
      candidate.lastIndexOf('; '),
      candidate.lastIndexOf(', '),
      candidate.lastIndexOf(' ')
    ];
    const bestBreak = Math.max(...preferredBreaks);
    const splitAt = bestBreak >= Math.floor(hardLimit * 0.45)
      ? bestBreak + (candidate[bestBreak] === ' ' ? 0 : 1)
      : hardLimit;
    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitAt).trim();
  }
  return chunks;
}

function splitForTranslation(text, maximumBytes = MAX_SEGMENT_BYTES) {
  const parts = String(text || '').replace(/\r\n/g, '\n').split(/(\n+)/);
  const result = [];
  for (const part of parts) {
    if (!part) continue;
    if (/^\n+$/.test(part)) {
      result.push({ type: 'separator', value: part });
      continue;
    }
    const leading = part.match(/^\s*/)?.[0] || '';
    const trailing = part.match(/\s*$/)?.[0] || '';
    const content = part.trim();
    if (!content) {
      result.push({ type: 'separator', value: part });
      continue;
    }
    if (leading) result.push({ type: 'separator', value: leading });
    splitLongLine(content, maximumBytes).forEach((value, index) => {
      if (index > 0) result.push({ type: 'separator', value: ' ' });
      result.push({ type: 'text', value });
    });
    if (trailing) result.push({ type: 'separator', value: trailing });
  }
  return result;
}

function isMostlyRussian(text) {
  const letters = String(text || '').match(/\p{L}/gu) || [];
  if (letters.length === 0) return false;
  const cyrillic = letters.filter((character) => /\p{Script=Cyrillic}/u.test(character)).length;
  return cyrillic / letters.length >= 0.35;
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

async function readBoundedText(response, maximumBytes = MAX_RESPONSE_BYTES) {
  const contentLength = Number(response.headers?.get?.('content-length') || 0);
  if (contentLength > maximumBytes) throw new Error('Сервис перевода вернул слишком большой ответ.');
  const text = await response.text();
  if (byteLength(text) > maximumBytes) throw new Error('Сервис перевода вернул слишком большой ответ.');
  return text;
}

async function translateSegment(segment, options = {}) {
  if (byteLength(segment) > MAX_SEGMENT_BYTES) throw new Error('Фрагмент описания слишком большой для перевода.');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Сетевой перевод недоступен.');

  const url = new URL('/get', TRANSLATION_ORIGIN);
  url.searchParams.set('q', segment);
  url.searchParams.set('langpair', 'en|ru');
  url.searchParams.set('mt', '1');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'Arma-Reforger-Launcher'
      },
      redirect: 'manual',
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Сервис перевода не ответил вовремя.');
    throw new Error('Не удалось подключиться к сервису перевода.');
  } finally {
    clearTimeout(timeout);
  }

  if (!response?.ok) throw new Error(`Сервис перевода вернул ошибку ${response?.status || 0}.`);
  const finalUrl = new URL(response.url || url);
  if (finalUrl.origin !== TRANSLATION_ORIGIN) throw new Error('Сервис перевода перенаправил запрос на неизвестный адрес.');
  let payload;
  try {
    payload = JSON.parse(await readBoundedText(response));
  } catch (error) {
    if (error.message.includes('слишком большой')) throw error;
    throw new Error('Сервис перевода вернул некорректный ответ.');
  }
  const translated = decodeEntities(payload?.responseData?.translatedText).trim();
  const status = Number(payload?.responseStatus || 200);
  if (status >= 400 || !translated || /MYMEMORY WARNING/i.test(translated)) {
    throw new Error(String(payload?.responseDetails || 'Перевод описания временно недоступен.'));
  }
  return translated;
}

function getCachedTranslation(key) {
  const value = translationCache.get(key);
  if (!value) return null;
  translationCache.delete(key);
  translationCache.set(key, value);
  return value;
}

function cacheTranslation(key, value) {
  translationCache.set(key, value);
  while (translationCache.size > CACHE_LIMIT) {
    translationCache.delete(translationCache.keys().next().value);
  }
}

async function translateToRussian(text, options = {}) {
  const source = String(text || '').trim();
  if (!source) return { text: '', alreadyRussian: false, cached: false };
  if (byteLength(source) > MAX_SOURCE_BYTES) {
    throw new Error('Описание слишком длинное для бесплатного перевода. Откройте оригинал или страницу Workshop.');
  }
  if (isMostlyRussian(source)) return { text: source, alreadyRussian: true, cached: false };

  const key = crypto.createHash('sha256').update(source).digest('hex');
  const cached = getCachedTranslation(key);
  if (cached) return { text: cached, alreadyRussian: false, cached: true };

  const parts = splitForTranslation(source);
  const textParts = parts.filter((part) => part.type === 'text');
  const translatedParts = new Map();
  let next = 0;
  const worker = async () => {
    while (next < textParts.length) {
      const index = next++;
      translatedParts.set(textParts[index], await translateSegment(textParts[index].value, options));
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, textParts.length) }, worker));
  const translated = parts.map((part) => (
    part.type === 'text' ? translatedParts.get(part) : part.value
  )).join('').trim();
  if (!translated) throw new Error('Перевод описания временно недоступен.');
  cacheTranslation(key, translated);
  return { text: translated, alreadyRussian: false, cached: false };
}

function clearTranslationCache() {
  translationCache.clear();
}

module.exports = {
  MAX_SEGMENT_BYTES,
  MAX_SOURCE_BYTES,
  TRANSLATION_ORIGIN,
  clearTranslationCache,
  isMostlyRussian,
  splitForTranslation,
  translateSegment,
  translateToRussian
};
