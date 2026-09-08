const net = require('node:net');
const { readBoundedResponseText } = require('./boundedResponse');

const SERVER_CATALOG_ORIGIN = 'https://reforgermods.com';
const SERVER_LIST_PATH = '/api/servers';
const SERVER_GAME = 'reforger';
const SERVER_FETCH_LIMIT = 500;
const SERVER_ID_PATTERN = /^(?:\d{1,12}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const MOD_ID_PATTERN = /^[0-9A-F]{16}$/;
const SORT_VALUES = new Set([
  'players_desc',
  'players_asc',
  'popularity',
  'recent',
  'mod_size_desc',
  'mod_size_asc',
  'name_asc',
  'name_desc'
]);
const MAX_LIST_BYTES = 8 * 1024 * 1024;
const MAX_DETAILS_BYTES = 16 * 1024 * 1024;

const listCache = new Map();
const detailsCache = new Map();
const serverSeeds = new Map();

function cleanText(value, maximumLength = 200) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, maximumLength);
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= Number.MAX_SAFE_INTEGER ? number : 0;
}

function normalizeServerId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!SERVER_ID_PATTERN.test(id)) throw new Error('Некорректный идентификатор сервера.');
  return id;
}

function normalizeServerAddress(value) {
  const source = String(value || '').trim();
  if (!source || /[\s/\\?#]/.test(source)) throw new Error('Укажите адрес сервера в формате IP:порт.');

  const separator = source.lastIndexOf(':');
  if (separator <= 0 || separator === source.length - 1) {
    throw new Error('Укажите адрес сервера в формате IP:порт.');
  }

  const host = source.slice(0, separator).toLowerCase();
  const portText = source.slice(separator + 1);
  const port = Number.parseInt(portText, 10);
  const hostnameValid = host.length <= 253
    && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host);

  const invalidNumericAddress = /^[\d.]+$/.test(host) && net.isIP(host) !== 4;
  if (invalidNumericAddress || (net.isIP(host) !== 4 && !hostnameValid)) {
    throw new Error('Некорректный адрес сервера.');
  }
  if (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65535) throw new Error('Некорректный порт сервера.');
  return `${host}:${port}`;
}

function normalizeServer(rawServer) {
  const id = normalizeServerId(rawServer?.id);
  const rawAddress = rawServer?.host_address
    || `${String(rawServer?.ip ?? '').trim()}:${String(rawServer?.port ?? '').trim()}`;
  return {
    id,
    name: cleanText(rawServer?.name, 180) || id,
    address: normalizeServerAddress(rawAddress),
    playerCount: nonNegativeNumber(rawServer?.players ?? rawServer?.current_players ?? rawServer?.player_count),
    playerLimit: nonNegativeNumber(rawServer?.maxPlayers ?? rawServer?.player_count_limit),
    queueCount: nonNegativeNumber(rawServer?.queueCount ?? rawServer?.current_queue ?? rawServer?.queue_players_count),
    scenarioName: cleanText(rawServer?.scenarioName ?? rawServer?.scenario_name, 180),
    gameVersion: cleanText(rawServer?.gameVersion ?? rawServer?.game_version, 40),
    official: rawServer?.official === true,
    passwordProtected: rawServer?.passwordProtected === true || rawServer?.password_protected === true,
    totalModSize: nonNegativeNumber(
      rawServer?.modpackEstimatedBytes ?? rawServer?.modpackKnownBytes ?? rawServer?.total_mod_size
    ),
    tags: (Array.isArray(rawServer?.tags) ? rawServer.tags : []).map((tag) => cleanText(tag, 40)).filter(Boolean).slice(0, 20),
    status: cleanText(rawServer?.bmStatus ?? rawServer?.status, 20).toLocaleLowerCase('en'),
    lastUpdated: cleanText(rawServer?.bmLastSeenAt ?? rawServer?.last_updated, 60),
    popularityRank: nonNegativeNumber(rawServer?.sqeRank)
  };
}

function normalizeServerMod(rawMod, sizeById = new Map()) {
  const modId = String(rawMod?.workshop_id ?? rawMod?.modId ?? rawMod?.id ?? '').trim().toUpperCase();
  if (!MOD_ID_PATTERN.test(modId)) return null;
  const version = cleanText(rawMod?.version, 64);
  return {
    modId,
    name: cleanText(rawMod?.name, 180) || modId,
    version: version.includes('|') ? '' : version,
    sizeBytes: nonNegativeNumber(
      sizeById.get(modId) ?? rawMod?.size_bytes ?? rawMod?.sizeBytes
    ),
    required: rawMod?.required !== false
  };
}

async function readJsonResponse(response, maximumBytes, signal) {
  if (!response?.ok) throw new Error(`Каталог серверов вернул ошибку ${response?.status || 0}.`);
  const finalUrl = new URL(response.url || SERVER_CATALOG_ORIGIN);
  if (finalUrl.origin !== SERVER_CATALOG_ORIGIN) throw new Error('Каталог серверов перенаправил запрос на неизвестный адрес.');

  const text = await readBoundedResponseText(response, {
    maximumBytes, signal, tooLargeMessage: 'Ответ каталога серверов слишком большой.'
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Каталог серверов вернул некорректные данные.');
  }
}

async function fetchCatalogJson(url, options = {}, maximumBytes = MAX_LIST_BYTES) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Сетевой запрос каталога серверов недоступен.');

  const timeout = Math.max(1000, Math.min(30000, Number(options.timeout) || 10000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Arma-Reforger-Launcher'
      }
    });
    return await readJsonResponse(response, maximumBytes, controller.signal);
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError'
      || error?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT') {
      throw new Error('Каталог серверов не ответил вовремя.');
    }
    if (/^Каталог серверов|^Ответ каталога/.test(error?.message || '')) throw error;
    throw new Error(`Не удалось подключиться к каталогу серверов: ${error?.message || error}`);
  } finally {
    clearTimeout(timer);
  }
}

function rememberServerSeed(rawServer) {
  const server = normalizeServer(rawServer);
  const mods = (Array.isArray(rawServer?.mods) ? rawServer.mods : [])
    .map((rawMod) => normalizeServerMod(rawMod))
    .filter(Boolean);
  const seed = { server, mods };
  serverSeeds.set(server.id, seed);
  return seed;
}

async function fetchServerCatalog(search, refresh, options) {
  const cacheKey = search.toLocaleLowerCase('en');
  const now = options.now?.() ?? Date.now();
  const cached = listCache.get(cacheKey);
  if (!refresh && cached && cached.expiresAt > now) return cached.value;

  const url = new URL(SERVER_LIST_PATH, SERVER_CATALOG_ORIGIN);
  url.searchParams.set('limit', String(SERVER_FETCH_LIMIT));
  url.searchParams.set('offset', '0');
  url.searchParams.set('game', SERVER_GAME);
  if (search) {
    // The compact catalog is enough for lightweight browsing, but it omits empty
    // servers. Search the full catalog so a named server is still discoverable
    // with 0 or 1 player without downloading the heavy list every time.
    url.searchParams.set('full', '1');
    url.searchParams.set('search', search);
  }
  if (refresh) url.searchParams.set('_', String(now));

  const document = await fetchCatalogJson(url, options, MAX_LIST_BYTES);
  if (!Array.isArray(document?.data)) throw new Error('Каталог серверов вернул некорректный список.');
  const items = document.data.flatMap((rawServer) => {
    try {
      return [rememberServerSeed(rawServer).server];
    } catch {
      return [];
    }
  });
  const value = { items, total: Math.max(items.length, nonNegativeNumber(document?.meta?.total)) };
  listCache.set(cacheKey, { value, expiresAt: now + 30_000 });
  return value;
}

function sortServers(items, sort) {
  const byName = (left, right) => left.name.localeCompare(right.name, 'en', { sensitivity: 'base' });
  const byLiveStatus = (left, right) => {
    const rank = (server) => server.status === 'online' ? 0 : server.status === 'offline' ? 1 : 2;
    return rank(left) - rank(right);
  };
  const byPopularity = (left, right) => {
    const leftRank = left.popularityRank || Number.MAX_SAFE_INTEGER;
    const rightRank = right.popularityRank || Number.MAX_SAFE_INTEGER;
    return byLiveStatus(left, right)
      || leftRank - rightRank
      || right.playerCount - left.playerCount
      || byName(left, right);
  };
  const comparators = {
    players_desc: (left, right) => byLiveStatus(left, right)
      || right.playerCount - left.playerCount
      || byPopularity(left, right),
    players_asc: (left, right) => byLiveStatus(left, right)
      || left.playerCount - right.playerCount
      || byPopularity(left, right),
    popularity: byPopularity,
    recent: (left, right) => byLiveStatus(left, right)
      || (Date.parse(right.lastUpdated) || 0) - (Date.parse(left.lastUpdated) || 0)
      || byPopularity(left, right),
    mod_size_desc: (left, right) => byLiveStatus(left, right)
      || right.totalModSize - left.totalModSize
      || byPopularity(left, right),
    mod_size_asc: (left, right) => byLiveStatus(left, right)
      || left.totalModSize - right.totalModSize
      || byPopularity(left, right),
    name_asc: (left, right) => byLiveStatus(left, right) || byName(left, right),
    name_desc: (left, right) => byLiveStatus(left, right) || byName(right, left)
  };
  return [...items].sort(comparators[sort] || comparators.players_desc);
}

async function fetchServerList(payload = {}, options = {}) {
  const page = Math.max(1, Number.parseInt(payload.page, 10) || 1);
  const pageSize = Math.max(10, Math.min(100, Number.parseInt(payload.pageSize, 10) || 50));
  const search = cleanText(payload.search, 120);
  const sort = SORT_VALUES.has(payload.sort) ? payload.sort : 'players_desc';
  const catalog = await fetchServerCatalog(search, payload.refresh === true, options);
  const normalizedSearch = search.toLocaleLowerCase('en');
  const matching = normalizedSearch
    ? catalog.items.filter((server) => [server.name, server.address, server.scenarioName]
      .some((value) => String(value || '').toLocaleLowerCase('en').includes(normalizedSearch)))
    : catalog.items;
  const sorted = sortServers(matching, sort);
  const offset = (page - 1) * pageSize;
  const items = sorted.slice(offset, offset + pageSize);
  return {
    items,
    page,
    pageSize,
    hasNext: offset + pageSize < sorted.length,
    provider: 'Arma Mods',
    providerUrl: `${SERVER_CATALOG_ORIGIN}/servers`
  };
}

function storageSizeMap(document) {
  const map = new Map();
  for (const rawMod of Array.isArray(document?.data?.mods) ? document.data.mods : []) {
    const modId = String(rawMod?.id || '').trim().toUpperCase();
    if (MOD_ID_PATTERN.test(modId)) map.set(modId, nonNegativeNumber(rawMod?.sizeBytes));
  }
  return map;
}

async function fetchServerDetails(serverId, options = {}) {
  const id = normalizeServerId(serverId);
  const now = options.now?.() ?? Date.now();
  const cached = detailsCache.get(id);
  const refresh = options.refresh === true || options.requireLive === true;
  if (!refresh && cached && cached.expiresAt > now) return cached.value;

  const detailsUrl = new URL(`${SERVER_LIST_PATH}/${encodeURIComponent(id)}`, SERVER_CATALOG_ORIGIN);
  detailsUrl.searchParams.set('game', SERVER_GAME);
  const storageUrl = new URL(`${SERVER_LIST_PATH}/${encodeURIComponent(id)}/storage`, SERVER_CATALOG_ORIGIN);
  storageUrl.searchParams.set('game', SERVER_GAME);
  if (refresh) {
    detailsUrl.searchParams.set('_', String(now));
    storageUrl.searchParams.set('_', String(now));
  }

  const [detailsResult, storageResult] = await Promise.allSettled([
    fetchCatalogJson(detailsUrl, options, MAX_DETAILS_BYTES),
    fetchCatalogJson(storageUrl, options, MAX_DETAILS_BYTES)
  ]);
  if (detailsResult.status === 'rejected') {
    const seed = serverSeeds.get(id);
    if (seed && options.requireLive !== true) return seed;
    throw detailsResult.reason;
  }

  const document = detailsResult.value;
  const rawServer = document?.data ?? document?.server;
  const rawMods = rawServer?.mods ?? document?.mods;
  if (!rawServer || !Array.isArray(rawMods)) throw new Error('Каталог серверов не вернул сведения о сборке.');
  const server = normalizeServer(rawServer);
  if (server.id !== id) {
    const error = new Error('Каталог серверов вернул другой сервер.');
    error.code = 'SERVER_CATALOG_ID_MISMATCH';
    throw error;
  }

  const sizeById = storageResult.status === 'fulfilled' ? storageSizeMap(storageResult.value) : new Map();
  const seen = new Set();
  const mods = [];
  for (const rawMod of rawMods) {
    const mod = normalizeServerMod(rawMod, sizeById);
    if (!mod || seen.has(mod.modId)) continue;
    seen.add(mod.modId);
    mods.push(mod);
  }
  const storage = storageResult.status === 'fulfilled' ? storageResult.value?.data : null;
  const totalModSize = Math.max(
    0,
    nonNegativeNumber(storage?.estimatedBytes),
    mods.reduce((total, mod) => total + mod.sizeBytes, 0),
    server.totalModSize
  );
  const value = { server: { ...server, totalModSize }, mods };
  serverSeeds.set(id, value);
  detailsCache.set(id, { value, expiresAt: now + 60_000 });
  return value;
}

module.exports = {
  SERVER_CATALOG_ORIGIN,
  fetchServerDetails,
  fetchServerList,
  normalizeServer,
  normalizeServerAddress,
  normalizeServerId,
  normalizeServerMod
};
