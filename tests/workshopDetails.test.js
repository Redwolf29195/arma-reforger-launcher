const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clearWorkshopDetailsCache,
  extractNextData,
  fetchWorkshopDetails,
  fetchWorkshopSearch,
  normalizeScenarioId,
  normalizeWorkshopDetails,
  normalizeWorkshopSearch,
  safeImageUrl
} = require('../src/core/workshopDetails');

const MOD_ID = '672B0395726428B6';

function workshopHtml() {
  const data = {
    props: {
      pageProps: {
        asset: {
          id: MOD_ID,
          name: 'Enhanced Radio',
          summary: 'Radio summary',
          description: 'Radio description',
          license: 'APL-SA',
          averageRating: 0.98,
          ratingCount: 42,
          currentVersionNumber: '1.0.34',
          currentVersionSize: 14334036,
          gameVersion: '1.8.0.10',
          createdAt: '2025-12-21T21:44:26.000Z',
          updatedAt: '2026-08-14T05:22:28.000Z',
          author: { username: 'Fedora12' },
          previews: [{ url: 'https://ar-gcp-cdn.bistudio.com/image/preview.jpg' }],
          screenshots: [{ url: 'https://example.com/rejected.jpg' }],
          tags: [{ name: 'RADIO' }],
          dependencies: [{ version: '1.2.3', asset: { id: '646B350F36C6D3E4', name: 'Core' } }],
          versions: [{ version: '1.0.34', gameVersion: '1.8.0.10', totalFileSize: 14334036 }]
        },
        assetVersionDetail: {
          changelog: 'Updated radio routing',
          scenarios: [{
            name: 'Radio Operations',
            gameId: '{EF980D7F911C6F1C}Missions/RadioOperations.conf',
            gameMode: 'Cooperative',
            authorName: 'Fedora12',
            playerCount: 32
          }]
        },
        getAssetDownloadTotal: { total: 287127 }
      }
    }
  };
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;
}

function responseFor(html) {
  return {
    ok: true,
    status: 200,
    url: `https://reforger.armaplatform.com/workshop/${MOD_ID}`,
    headers: { get: () => String(Buffer.byteLength(html)) },
    text: async () => html
  };
}

test('extracts and normalizes official Workshop details', async () => {
  clearWorkshopDetailsCache();
  const html = workshopHtml();
  const details = await fetchWorkshopDetails(MOD_ID.toLowerCase(), {
    fetchImpl: async () => responseFor(html)
  });

  assert.equal(details.modId, MOD_ID);
  assert.equal(details.name, 'Enhanced Radio');
  assert.equal(details.version, '1.0.34');
  assert.equal(details.ratingPercent, 98);
  assert.equal(details.downloads, 287127);
  assert.deepEqual(details.scenarios, [{
    scenarioId: '{EF980D7F911C6F1C}Missions/RadioOperations.conf',
    name: 'Radio Operations',
    gameMode: 'Cooperative',
    author: 'Fedora12',
    playerCount: 32
  }]);
  assert.deepEqual(details.previewUrls, ['https://ar-gcp-cdn.bistudio.com/image/preview.jpg']);
  assert.deepEqual(details.screenshotUrls, []);
  assert.deepEqual(details.dependencies[0], {
    modId: '646B350F36C6D3E4',
    name: 'Core',
    version: '1.2.3',
    sizeBytes: 0
  });
});

test('caches Workshop details by GUID', async () => {
  clearWorkshopDetailsCache();
  const html = workshopHtml();
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return responseFor(html);
  };

  await fetchWorkshopDetails(MOD_ID, { fetchImpl, now: () => 1000 });
  await fetchWorkshopDetails(MOD_ID, { fetchImpl, now: () => 2000 });
  assert.equal(requests, 1);
});

test('rejects invalid GUIDs and non-official image hosts', () => {
  assert.throws(() => extractNextData('<html></html>'), /не содержит данные/);
  assert.equal(safeImageUrl('https://example.com/image.jpg'), '');
  assert.equal(safeImageUrl('https://ar-gcp-cdn.bistudio.com/image.jpg'), 'https://ar-gcp-cdn.bistudio.com/image.jpg');
});

test('validates copy-ready Workshop scenario IDs', () => {
  const scenarioId = '{EF980D7F911C6F1C}Missions/ATMEasternEuropePvEvP.conf';
  assert.equal(normalizeScenarioId(`  ${scenarioId}  `), scenarioId);
  assert.throws(() => normalizeScenarioId('Missions/NoResourceId.conf'), /Некорректный ID/);
  assert.throws(() => normalizeScenarioId('{EF980D7F911C6F1C}Missions/Bad.conf\nnext'), /Некорректный ID/);
});

test('normalizes Workshop search results for preset use', () => {
  const result = normalizeWorkshopSearch({ props: { pageProps: {
    search: 'RHS',
    page: 2,
    assets: { count: 17, rows: [{
      id: '595f2bf2f44836fb',
      name: 'RHS - Status Quo',
      author: { username: 'RHS' },
      averageRating: 0.88,
      currentVersionNumber: '0.16.5150',
      currentVersionSize: 2048,
      previews: [{ url: 'https://ar-gcp-cdn.bistudio.com/image/test.jpg' }]
    }] }
  } } }, { query: 'RHS', page: 2, sort: 'subscribers' });

  assert.equal(result.count, 17);
  assert.equal(result.items[0].modId, '595F2BF2F44836FB');
  assert.equal(result.items[0].version, '0.16.5150');
  assert.equal(result.items[0].ratingPercent, 88);
  assert.equal(result.items[0].previewUrl, 'https://ar-gcp-cdn.bistudio.com/image/test.jpg');
});

test('fetchWorkshopSearch validates sort and uses a bounded request URL', async () => {
  clearWorkshopDetailsCache();
  let requestedUrl = '';
  const payload = { props: { pageProps: { search: 'ACE', page: 1, assets: { count: 0, rows: [] } } } };
  const result = await fetchWorkshopSearch({ query: 'ACE', sort: 'invalid', page: -5, refresh: true }, {
    fetchImpl: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        url,
        headers: { get: () => '100' },
        text: async () => `<script id="__NEXT_DATA__">${JSON.stringify(payload)}</script>`
      };
    }
  });

  assert.match(requestedUrl, /search=ACE/);
  assert.match(requestedUrl, /page=1/);
  assert.match(requestedUrl, /sort=subscribers/);
  assert.equal(result.items.length, 0);
});

test('fetchWorkshopSearch applies supported Workshop category tags', async () => {
  clearWorkshopDetailsCache();
  let requestedUrl = '';
  const payload = { props: { pageProps: { search: '', page: 1, assets: { count: 0, rows: [] } } } };
  const fetchImpl = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      url,
      headers: { get: () => '100' },
      text: async () => `<script id="__NEXT_DATA__">${JSON.stringify(payload)}</script>`
    };
  };

  await fetchWorkshopSearch({ category: 'weapons', refresh: true }, { fetchImpl });
  assert.match(requestedUrl, /tags=WEAPONS/);

  await fetchWorkshopSearch({ category: 'not-a-real-category', refresh: true }, { fetchImpl });
  assert.doesNotMatch(requestedUrl, /tags=/);
});

test('Workshop timeout covers a stalled response body after headers arrived', async () => {
  clearWorkshopDetailsCache();
  let cancelled = false;
  await assert.rejects(fetchWorkshopDetails(MOD_ID, {
    timeoutMs: 15,
    fetchImpl: async () => ({
      ...responseFor(''),
      body: {
        getReader: () => ({
          read: () => new Promise(() => {}),
          cancel: () => { cancelled = true; return new Promise(() => {}); },
          releaseLock() {}
        })
      },
      text: () => new Promise(() => {})
    })
  }), /не ответил вовремя/);
  assert.equal(cancelled, true);
});

test('Workshop rejects a chunked oversized page before buffering the entire download', async () => {
  clearWorkshopDetailsCache();
  let reads = 0;
  let cancelled = false;
  await assert.rejects(fetchWorkshopDetails(MOD_ID, {
    fetchImpl: async () => ({
      ...responseFor(''),
      body: {
        getReader: () => ({
          read: async () => { reads += 1; return { value: Buffer.alloc(1024 * 1024), done: false }; },
          cancel: () => { cancelled = true; },
          releaseLock() {}
        })
      },
      text: () => { throw new Error('unbounded body reader'); }
    })
  }), /Страница Workshop слишком большая/);
  assert.equal(reads, 3);
  assert.equal(cancelled, true);
});

test('malformed Workshop metrics normalize to finite nonnegative values', () => {
  for (const number of ['Infinity', 'NaN', '1e309', '1e308', -1, 'bad']) {
    const asset = {
      id: MOD_ID, averageRating: number, currentVersionSize: number,
      ratingCount: number, subscriberCount: number,
      dependencies: [{ id: '1337C0DE5DABBEEF', totalFileSize: number }],
      versions: [{ totalFileSize: number }]
    };
    const details = normalizeWorkshopDetails({ props: { pageProps: {
      asset, getAssetDownloadTotal: { total: number }
    } } }, MOD_ID);
    for (const key of ['ratingPercent', 'ratingCount', 'sizeBytes', 'downloads']) assert.equal(details[key], 0);
    assert.equal(details.dependencies[0].sizeBytes, 0);
    assert.equal(details.versions[0].sizeBytes, 0);
    const search = normalizeWorkshopSearch({ props: { pageProps: {
      assets: { count: number, rows: [asset] }, page: number
    } } }, { query: '', page: 1, sort: 'subscribers' });
    assert.equal(search.count, 0);
    assert.equal(search.page, 1);
    assert.equal(search.items[0].subscriberCount, 0);
    assert.equal(search.items[0].sizeBytes, 0);
  }
});
