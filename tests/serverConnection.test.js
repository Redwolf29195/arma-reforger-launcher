const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assessServerAvailability,
  prepareLiveServerConnection,
  prepareServerConnection,
  serverCapacity
} = require('../src/core/serverConnection');

test('prepares a server join entirely from the selected server snapshot', () => {
  const connection = prepareServerConnection({
    serverId: '39079454',
    name: 'Selected server',
    address: 'server.example.test:2001',
    mods: [
      { modId: '1337C0DE5DABBEEF', name: 'Missing mod', version: '1.0.0', status: 'missing' },
      { modId: '595F2BF2F44836FB', name: 'Old mod', version: '2.0.0', status: 'version-mismatch' },
      { modId: '1337C0DE5DABBEEF', name: 'Duplicate', status: 'ready' },
      { modId: 'invalid', name: 'Ignored' }
    ]
  });

  assert.deepEqual(connection.server, {
    id: '39079454',
    name: 'Selected server',
    address: 'server.example.test:2001'
  });
  assert.equal(connection.mods.length, 2);
  assert.equal(connection.missingCount, 1);
  assert.equal(connection.mismatchCount, 1);
});

test('validates a direct connection without requiring catalog data', () => {
  const connection = prepareServerConnection({ address: '127.0.0.1:2001' });
  assert.equal(connection.knownServer, false);
  assert.equal(connection.server.name, '127.0.0.1:2001');
  assert.deepEqual(connection.mods, []);
});

test('recognizes a full server without treating an unknown capacity as full', () => {
  assert.deepEqual(serverCapacity({ playerCount: 128, playerLimit: 128, queueCount: 5 }), {
    playerCount: 128,
    playerLimit: 128,
    queueCount: 5,
    full: true
  });
  assert.equal(serverCapacity({ playerCount: 127, playerLimit: 128 }).full, false);
  assert.equal(serverCapacity({ playerCount: 50, playerLimit: 0 }).full, false);
});

test('replaces a stale renderer snapshot with the verified live server endpoint and mod pack', () => {
  const snapshot = prepareServerConnection({
    serverId: '39079454',
    name: 'Old server name',
    address: 'old.example.test:2001',
    mods: [{ modId: '1337C0DE5DABBEEF', name: 'Old mod', status: 'ready' }]
  });
  const connection = prepareLiveServerConnection(snapshot, {
    server: {
      id: '39079454',
      name: 'Current server name',
      address: 'live.example.test:2002',
      status: 'online',
      lastUpdated: '2026-09-04T18:40:00.000Z'
    },
    mods: [{ modId: '595F2BF2F44836FB', name: 'Current mod', status: 'missing' }]
  });

  assert.equal(connection.server.address, 'live.example.test:2002');
  assert.equal(connection.server.name, 'Current server name');
  assert.equal(connection.server.status, 'online');
  assert.deepEqual(connection.mods.map((mod) => mod.modId), ['595F2BF2F44836FB']);
  assert.equal(connection.missingCount, 1);
  assert.throws(() => prepareLiveServerConnection(snapshot, {
    server: { id: '39079455', address: 'wrong.example.test:2001' },
    mods: []
  }), /другой сервер/);
});

test('allows a normal two-hour catalog cycle and warns on stale or unavailable records', () => {
  const now = Date.parse('2026-09-04T18:45:00.000Z');
  assert.deepEqual(assessServerAvailability({
    status: 'online',
    lastUpdated: '2026-09-04T18:43:00.000Z'
  }, { now }), { available: true, reason: 'online', ageMs: 120_000 });
  assert.deepEqual(assessServerAvailability({
    status: 'online',
    lastUpdated: '2026-09-04T16:14:00.000Z'
  }, { now }), { available: true, reason: 'online', ageMs: 9_060_000 });
  assert.deepEqual(assessServerAvailability({
    status: 'online',
    lastUpdated: '2026-09-04T14:44:00.000Z'
  }, { now }), { available: false, reason: 'stale', ageMs: 14_460_000 });
  assert.deepEqual(assessServerAvailability({
    status: 'offline',
    lastUpdated: '2026-09-04T18:44:00.000Z'
  }, { now }), { available: false, reason: 'offline', ageMs: 60_000 });
  assert.equal(assessServerAvailability({
    status: 'dead', lastUpdated: '2026-09-04T18:44:00.000Z'
  }, { now }).reason, 'offline');
  assert.deepEqual(assessServerAvailability({ status: 'online' }, { now }), {
    available: false,
    reason: 'unknown',
    ageMs: null
  });
  assert.equal(assessServerAvailability({
    status: 'online', lastUpdated: '2026-09-04T19:44:00.000Z'
  }, { now }).reason, 'unknown');
});
