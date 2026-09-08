const { readBoundedResponseText } = require('./boundedResponse');
const WORKSHOP_ORIGIN = 'https://reforger.armaplatform.com';
const WORKSHOP_CDN_HOST = 'ar-gcp-cdn.bistudio.com';
const CACHE_TTL_MS = 20 * 60 * 1000;
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const WORKSHOP_CATEGORY_TAGS = new Set([
  'WEAPONS',
  'VEHICLES',
  'CHARACTERS',
  'CLOTHING',
  'TERRAINS',
  'SCENARIOS_MP',
  'SCENARIOS_SP',
  'SYSTEMS',
  'SCRIPTS',
  'EFFECTS',
  'PROPS',
  'MISC'
]);

const detailsCache = new Map();
const searchCache = new Map();

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= Number.MAX_SAFE_INTEGER ? number : 0;
}

function normalizeModId(value) {
  const modId = String(value || '').trim().toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(modId)) throw new Error('Некорректный GUID мода.');
  return modId;
}

function extractNextData(html) {
  const source = String(html || '');
  const match = source.match(/<script\b[^>]*\bid=(["'])__NEXT_DATA__\1[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('Страница Workshop не содержит данные мода.');

  try {
    return JSON.parse(match[2]);
  } catch {
    throw new Error('Workshop вернул некорректные данные мода.');
  }
}

function safeImageUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== WORKSHOP_CDN_HOST) return '';
    return url.href;
  } catch {
    return '';
  }
}

function normalizeImages(items) {
  const unique = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const url = safeImageUrl(item?.url);
    if (url) unique.add(url);
  }
  return [...unique].slice(0, 10);
}

function normalizeSearchItem(asset) {
  const modId = String(asset?.id || '').trim().toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(modId)) return null;
  const rating = nonNegativeNumber(asset.averageRating);
  const previewUrls = normalizeImages(asset.previews);
  return {
    modId,
    name: String(asset.name || modId),
    author: String(asset.author?.username || ''),
    summary: String(asset.summary || ''),
    version: String(asset.currentVersionNumber || ''),
    gameVersion: String(asset.gameVersion || asset.dependencyTree?.gameVersion || ''),
    sizeBytes: nonNegativeNumber(asset.currentVersionSize),
    ratingPercent: Math.max(0, Math.min(100, Math.round(rating <= 1 ? rating * 100 : rating))),
    ratingCount: nonNegativeNumber(asset.ratingCount),
    subscriberCount: nonNegativeNumber(asset.subscriberCount),
    updatedAt: String(asset.updatedAt || ''),
    previewUrl: previewUrls[0] || '',
    tags: (Array.isArray(asset.tags) ? asset.tags : [])
      .map((tag) => String(tag?.name || tag || '').trim())
      .filter(Boolean)
      .slice(0, 8)
  };
}

function normalizeWorkshopSearch(pageData, request) {
  const pageProps = pageData?.props?.pageProps;
  const assets = pageProps?.assets;
  const rows = Array.isArray(assets?.rows) ? assets.rows : [];
  return {
    query: String(pageProps?.search ?? request.query),
    sort: request.sort,
    page: Math.max(1, nonNegativeNumber(pageProps?.page || request.page)),
    count: nonNegativeNumber(assets?.count),
    pageSize: rows.length || 16,
    items: rows.map(normalizeSearchItem).filter(Boolean)
  };
}

async function fetchWorkshopPage(url, options, unavailableMessage) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Сетевой запрос Workshop недоступен.');

  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'Arma-Reforger-Launcher'
      },
      redirect: 'follow',
      signal
    });
    if (!response?.ok) throw new Error(`Workshop вернул ошибку ${response?.status || 0}.`);
    const finalUrl = new URL(response.url || url);
    if (finalUrl.origin !== WORKSHOP_ORIGIN) throw new Error('Workshop перенаправил запрос на неизвестный адрес.');
    return await readBoundedResponseText(response, {
      maximumBytes: MAX_PAGE_BYTES,
      signal,
      tooLargeMessage: 'Страница Workshop слишком большая.'
    });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw new Error('Workshop не ответил вовремя.');
    if (/^Workshop |^Страница Workshop/.test(error?.message || '')) throw error;
    throw new Error(unavailableMessage);
  } finally {
    clearTimeout(timeout);
  }

}

function normalizeDependency(item) {
  const modId = String(item?.asset?.id || item?.modId || item?.id || '').toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(modId)) return null;
  return {
    modId,
    name: String(item?.asset?.name || item?.name || modId),
    version: String(item?.version || ''),
    sizeBytes: nonNegativeNumber(item?.totalFileSize)
  };
}

function normalizeScenarioId(value) {
  const scenarioId = String(value || '').trim();
  if (scenarioId.length > 512
    || /[\r\n\0]/.test(scenarioId)
    || !/^\{[0-9A-F]{16}\}.+\.conf$/i.test(scenarioId)) {
    throw new Error('Некорректный ID сценария.');
  }
  return scenarioId;
}

function normalizeScenario(item) {
  let scenarioId;
  try {
    scenarioId = normalizeScenarioId(item?.gameId || item?.scenarioId);
  } catch {
    return null;
  }
  return {
    scenarioId,
    name: String(item?.name || scenarioId).trim().slice(0, 180),
    gameMode: String(item?.gameMode || '').trim().slice(0, 120),
    author: String(item?.authorName || '').trim().slice(0, 120),
    playerCount: Math.max(0, Number.parseInt(item?.playerCount, 10) || 0)
  };
}

function normalizeScenarios(items) {
  const unique = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const scenario = normalizeScenario(item);
    if (scenario && !unique.has(scenario.scenarioId)) unique.set(scenario.scenarioId, scenario);
  }
  return [...unique.values()].slice(0, 24);
}

function normalizeWorkshopDetails(pageData, requestedModId) {
  const pageProps = pageData?.props?.pageProps;
  const asset = pageProps?.asset;
  const modId = String(asset?.id || '').toUpperCase();
  if (!asset || modId !== requestedModId) throw new Error('Workshop не вернул запрошенный мод.');

  const rating = nonNegativeNumber(asset.averageRating);
  const versions = (Array.isArray(asset.versions) ? asset.versions : []).slice(0, 8).map((version) => ({
    version: String(version?.version || ''),
    gameVersion: String(version?.gameVersion || ''),
    sizeBytes: nonNegativeNumber(version?.totalFileSize),
    createdAt: String(version?.createdAt || '')
  }));
  const dependencies = (Array.isArray(asset.dependencies) ? asset.dependencies : [])
    .map(normalizeDependency)
    .filter(Boolean);
  const scenarios = normalizeScenarios(
    Array.isArray(pageProps.assetVersionDetail?.scenarios)
      ? pageProps.assetVersionDetail.scenarios
      : asset.scenarios
  );

  return {
    modId,
    name: String(asset.name || modId),
    author: String(asset.author?.username || ''),
    summary: String(asset.summary || ''),
    description: String(asset.description || ''),
    license: String(asset.license || ''),
    ratingPercent: Math.max(0, Math.min(100, Math.round((rating <= 1 ? rating * 100 : rating)))),
    ratingCount: nonNegativeNumber(asset.ratingCount),
    version: String(asset.currentVersionNumber || ''),
    gameVersion: String(asset.gameVersion || asset.dependencyTree?.gameVersion || ''),
    sizeBytes: nonNegativeNumber(asset.currentVersionSize),
    downloads: nonNegativeNumber(pageProps.getAssetDownloadTotal?.total),
    createdAt: String(asset.createdAt || ''),
    updatedAt: String(asset.updatedAt || ''),
    previewUrls: normalizeImages(asset.previews),
    screenshotUrls: normalizeImages(asset.screenshots),
    tags: (Array.isArray(asset.tags) ? asset.tags : [])
      .map((tag) => String(tag?.name || '').trim())
      .filter(Boolean)
      .slice(0, 24),
    scenarios,
    dependencies,
    versions,
    changelog: String(pageProps.assetVersionDetail?.changelog || ''),
    workshopUrl: `${WORKSHOP_ORIGIN}/workshop/${modId}`
  };
}

async function fetchWorkshopDetails(modId, options = {}) {
  const normalizedId = normalizeModId(modId);
  const now = options.now?.() ?? Date.now();
  const cached = detailsCache.get(normalizedId);
  if (!options.refresh && cached && cached.expiresAt > now) return cached.value;

  const html = await fetchWorkshopPage(
    `${WORKSHOP_ORIGIN}/workshop/${normalizedId}`,
    options,
    'Не удалось подключиться к Workshop.'
  );

  const value = normalizeWorkshopDetails(extractNextData(html), normalizedId);
  detailsCache.set(normalizedId, {
    value,
    expiresAt: now + (options.cacheTtlMs || CACHE_TTL_MS)
  });
  return value;
}

async function fetchWorkshopSearch(value = {}, options = {}) {
  const query = String(value.query || '').trim().slice(0, 120);
  const page = Math.max(1, Math.min(500, Number.parseInt(value.page, 10) || 1));
  const sort = ['subscribers', 'newest', 'rating'].includes(value.sort) ? value.sort : 'subscribers';
  const requestedCategory = String(value.category || '').trim().toUpperCase();
  const category = WORKSHOP_CATEGORY_TAGS.has(requestedCategory) ? requestedCategory : '';
  const request = { query, category, page, sort };
  const key = JSON.stringify(request);
  const now = options.now?.() ?? Date.now();
  const cached = searchCache.get(key);
  if (!value.refresh && cached && cached.expiresAt > now) return cached.value;

  const url = new URL('/workshop', WORKSHOP_ORIGIN);
  if (query) url.searchParams.set('search', query);
  if (category) url.searchParams.set('tags', category);
  url.searchParams.set('page', String(page));
  url.searchParams.set('sort', sort);
  const html = await fetchWorkshopPage(url.href, options, 'Не удалось выполнить поиск в Workshop.');
  const result = normalizeWorkshopSearch(extractNextData(html), request);
  searchCache.set(key, {
    value: result,
    expiresAt: now + (options.cacheTtlMs || SEARCH_CACHE_TTL_MS)
  });
  return result;
}

function clearWorkshopDetailsCache() {
  detailsCache.clear();
  searchCache.clear();
}

module.exports = {
  clearWorkshopDetailsCache,
  extractNextData,
  fetchWorkshopDetails,
  fetchWorkshopSearch,
  normalizeWorkshopDetails,
  normalizeWorkshopSearch,
  normalizeScenarioId,
  safeImageUrl
};
