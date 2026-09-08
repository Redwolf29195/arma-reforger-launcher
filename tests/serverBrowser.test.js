const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchServerDetails,
  fetchServerList,
  normalizeServer,
  normalizeServerMod,
  normalizeServerAddress
} = require('../src/core/serverBrowser');

const serverId = '39079454';

function jsonResponse(url, document, options = {}) {
  const text = JSON.stringify(document);
  return {
    ok: options.ok !== false,
    status: options.status || 200,
    url: options.url || String(url),
    headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(Buffer.byteLength(text)) : null },
    text: async () => text
  };
}

test('loads, filters and sorts the bounded public server catalog', async () => {
  let requestedUrl;
  const result = await fetchServerList(
    { search: 'Bakhmut', sort: 'players_desc', page: 1, pageSize: 10, refresh: true },
    {
      fetchImpl: async (url) => {
        requestedUrl = new URL(url);
        return jsonResponse(url, {
          data: [
            { id: 'invalid', ip: 'bad', port: 0 },
            {
              id: serverId,
              name: 'Bakhmut Front',
              ip: '155.103.80.243',
              port: 2004,
              players: 42,
              maxPlayers: 128,
              scenarioName: 'Bakhmut',
              modpackEstimatedBytes: 1024,
              sqeRank: 2,
              mods: []
            },
            {
              id: '39705069',
              name: 'Bakhmut Operations',
              ip: '207.174.43.176',
              port: 2006,
              players: 50,
              maxPlayers: 128,
              scenarioName: 'Bakhmut',
              modpackEstimatedBytes: 2048,
              sqeRank: 1,
              mods: []
            }
          ],
          meta: { total: 2, limit: 500, offset: 0 }
        });
      }
    }
  );

  assert.equal(requestedUrl.origin, 'https://reforgermods.com');
  assert.equal(requestedUrl.pathname, '/api/servers');
  assert.equal(requestedUrl.searchParams.get('search'), 'Bakhmut');
  assert.equal(requestedUrl.searchParams.get('full'), '1');
  assert.ok(requestedUrl.searchParams.get('_'));
  assert.equal(requestedUrl.searchParams.get('game'), 'reforger');
  assert.equal(requestedUrl.searchParams.get('limit'), '500');
  assert.equal(result.items[0].address, '207.174.43.176:2006');
  assert.equal(result.items[0].playerCount, 50);
  assert.equal(result.items[1].address, '155.103.80.243:2004');
  assert.equal(result.providerUrl, 'https://reforgermods.com/servers');
  assert.equal(result.hasNext, false);
});

test('discovers and prioritizes an online public server with zero players', async () => {
  let requestedUrl;
  const result = await fetchServerList(
    { search: 'ALGZ', sort: 'players_desc', page: 1, pageSize: 10, refresh: true },
    {
      now: () => 123456789,
      fetchImpl: async (url) => {
        requestedUrl = new URL(url);
        return jsonResponse(url, {
          data: [
            {
              id: '39079455',
              name: 'ALGZ old record',
              ip: '155.103.80.244',
              port: 2001,
              players: 24,
              maxPlayers: 64,
              bmStatus: 'offline',
              mods: []
            },
            {
              id: '39079456',
              name: 'ALGZ public server',
              ip: '155.103.80.245',
              port: 2001,
              players: 0,
              maxPlayers: 64,
              bmStatus: 'online',
              mods: []
            }
          ],
          meta: { total: 2, limit: 500, offset: 0 }
        });
      }
    }
  );

  assert.equal(requestedUrl.searchParams.get('search'), 'ALGZ');
  assert.equal(requestedUrl.searchParams.get('full'), '1');
  assert.equal(requestedUrl.searchParams.get('_'), '123456789');
  assert.equal(result.items[0].name, 'ALGZ public server');
  assert.equal(result.items[0].playerCount, 0);
  assert.equal(result.items[0].status, 'online');
});

test('uses the lightweight catalog while browsing without a search', async () => {
  let requestedUrl;
  await fetchServerList(
    { search: '', sort: 'players_desc', page: 1, pageSize: 10, refresh: true },
    {
      now: () => 987654321,
      fetchImpl: async (url) => {
        requestedUrl = new URL(url);
        return jsonResponse(url, { data: [], meta: { total: 0, limit: 500, offset: 0 } });
      }
    }
  );

  assert.equal(requestedUrl.searchParams.has('search'), false);
  assert.equal(requestedUrl.searchParams.has('full'), false);
  assert.equal(requestedUrl.searchParams.get('_'), '987654321');
});

test('keeps exact server Workshop IDs and adds storage sizes', async () => {
  const requestedPaths = [];
  const requestedCacheBusters = [];
  const result = await fetchServerDetails(serverId, {
    refresh: true,
    now: () => 24680,
    fetchImpl: async (url) => {
      const requestedUrl = new URL(url);
      requestedPaths.push(requestedUrl.pathname);
      requestedCacheBusters.push(requestedUrl.searchParams.get('_'));
      if (requestedUrl.pathname.endsWith('/storage')) {
        return jsonResponse(url, {
          data: {
            mods: [{ id: '1337C0DE5DABBEEF', name: 'RHS Pack', sizeBytes: 4096 }],
            estimatedBytes: 4096
          }
        });
      }
      return jsonResponse(url, {
        data: {
          id: serverId,
          name: 'Versioned server',
          ip: 'server.example.test',
          port: 2001,
          players: 2,
          maxPlayers: 64,
          mods: [
            { id: '1337c0de5dabbeef', name: 'RHS Pack', version: '0.16.5150' },
            { id: 'invalid', name: 'Ignored' }
          ]
        }
      });
    }
  });

  assert.deepEqual(requestedPaths.sort(), [
    `/api/servers/${serverId}`,
    `/api/servers/${serverId}/storage`
  ]);
  assert.deepEqual(requestedCacheBusters, ['24680', '24680']);
  assert.deepEqual(result.mods, [{
    modId: '1337C0DE5DABBEEF',
    name: 'RHS Pack',
    version: '0.16.5150',
    sizeBytes: 4096,
    required: true
  }]);
  assert.equal(result.server.totalModSize, 4096);
});

test('requires a live detail response for an action even when a stale list seed exists', async () => {
  const staleServerId = '39079457';
  await fetchServerList(
    { search: 'Stale seed', sort: 'players_desc', page: 1, pageSize: 10, refresh: true },
    {
      now: () => 111,
      fetchImpl: async (url) => jsonResponse(url, {
        data: [{
          id: staleServerId,
          name: 'Stale seed',
          ip: '192.0.2.10',
          port: 2001,
          players: 12,
          maxPlayers: 64,
          bmStatus: 'online',
          bmLastSeenAt: '2026-09-04T17:00:00.000Z',
          mods: []
        }],
        meta: { total: 1 }
      })
    }
  );

  const unavailableFetch = async () => {
    throw new TypeError('network unavailable');
  };
  const browsingFallback = await fetchServerDetails(staleServerId, {
    refresh: true,
    now: () => 222,
    fetchImpl: unavailableFetch
  });
  assert.equal(browsingFallback.server.address, '192.0.2.10:2001');
  await assert.rejects(
    fetchServerDetails(staleServerId, {
      refresh: true,
      requireLive: true,
      now: () => 333,
      fetchImpl: unavailableFetch
    }),
    /Не удалось подключиться к каталогу серверов/
  );
});

test('rejects unsafe or malformed direct server addresses', () => {
  assert.equal(normalizeServerAddress('server.example.test:2001'), 'server.example.test:2001');
  assert.throws(() => normalizeServerAddress('999.999.999.999:2001'), /Некорректный адрес/);
  assert.throws(() => normalizeServerAddress('127.0.0.1:2001 -addons BAD'), /формате IP:порт/);
  assert.throws(() => normalizeServerAddress('127.0.0.1:70000'), /Некорректный порт/);
});

test('requireLive bypasses a valid detail cache without needing a separate refresh flag', async () => {
  const id = '39079458';
  const fetchImpl = async (url) => jsonResponse(url, {
    data: { id, ip: '192.0.2.20', port: 2001, mods: [] }
  });
  await fetchServerDetails(id, { now: () => 1000, fetchImpl });
  let requests = 0;
  await assert.rejects(fetchServerDetails(id, {
    requireLive: true,
    now: () => 1001,
    fetchImpl: async (url) => {
      requests += 1;
      assert.equal(new URL(url).searchParams.get('_'), '1001');
      throw new Error('offline');
    }
  }), /каталогу серверов/);
  assert.equal(requests, 2);
});

test('catalog cancels an oversized chunked response while receiving it', async () => {
  let reads = 0;
  let cancelled = false;
  await assert.rejects(fetchServerList({ refresh: true }, {
    fetchImpl: async (url) => ({
      ok: true, url: String(url), headers: { get: () => '1' },
      body: {
        getReader: () => ({
          read: async () => { reads += 1; return { value: Buffer.alloc(1024 * 1024), done: false }; },
          cancel: () => { cancelled = true; return new Promise(() => {}); },
          releaseLock() {}
        })
      },
      text: () => { throw new Error('unbounded body reader'); }
    })
  }), /Ответ каталога серверов слишком большой/);
  assert.equal(reads, 9);
  assert.equal(cancelled, true);
});

test('rejects malformed catalog ports instead of silently connecting to a truncated port', () => {
  for (const port of ['2001evil', '2001.5', '2001 -addons BAD', '2e3', 2001.5]) {
    assert.throws(() => normalizeServer({ id: serverId, ip: '127.0.0.1', port }));
  }
  assert.equal(normalizeServer({ id: serverId, ip: '127.0.0.1', port: '02001' }).address, '127.0.0.1:2001');
});

test('malformed numeric catalog metrics cannot introduce NaN or Infinity into capacity and sizes', () => {
  for (const number of ['Infinity', 'NaN', '1e309', '1e308', -123, 'invalid']) {
    const server = normalizeServer({
      id: serverId, ip: '127.0.0.1', port: 2001,
      players: number, maxPlayers: number, queueCount: number,
      modpackEstimatedBytes: number, sqeRank: number
    });
    for (const key of ['playerCount', 'playerLimit', 'queueCount', 'totalModSize', 'popularityRank']) {
      assert.equal(server[key], 0, `${key}: ${number}`);
    }
    assert.equal(normalizeServerMod({ modId: '1337C0DE5DABBEEF', sizeBytes: number }).sizeBytes, 0);
  }
});
