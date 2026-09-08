const test = require('node:test');
const assert = require('node:assert/strict');
const { readBoundedResponseText } = require('../src/core/boundedResponse');

test('preserves UTF-8 characters split across stream chunks at the byte limit', async () => {
  const input = Buffer.from('Моды 🎮');
  const body = new ReadableStream({
    start(controller) {
      for (const byte of input) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    }
  });
  assert.equal(await readBoundedResponseText(new Response(body), {
    maximumBytes: input.length, tooLargeMessage: 'too large'
  }), 'Моды 🎮');
});

test('stops an unlimited body after crossing the real byte limit despite a false small header', async () => {
  let reads = 0;
  let cancelled = false;
  const response = {
    headers: { get: () => '1' },
    body: {
      getReader: () => ({
        read: async () => { reads += 1; return { value: Buffer.alloc(64), done: false }; },
        cancel: () => { cancelled = true; return new Promise(() => {}); },
        releaseLock() {}
      })
    },
    text: () => { throw new Error('unbounded text() must not be called'); }
  };
  await assert.rejects(readBoundedResponseText(response, {
    maximumBytes: 128, tooLargeMessage: 'too large'
  }), /too large/);
  assert.equal(reads, 3);
  assert.equal(cancelled, true);
});

test('abort stops a stalled iterator without awaiting its stalled return()', async () => {
  const controller = new AbortController();
  let returned = false;
  const response = {
    body: {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}),
        return: () => { returned = true; return new Promise(() => {}); }
      })
    }
  };
  const reading = readBoundedResponseText(response, {
    maximumBytes: 128, signal: controller.signal, tooLargeMessage: 'too large'
  });
  controller.abort();
  await assert.rejects(reading, { name: 'AbortError' });
  assert.equal(returned, true);
});

test('rejects already-aborted requests without starting a read', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readBoundedResponseText({ text() { assert.fail('unexpected read'); } }, {
    maximumBytes: 128, signal: controller.signal, tooLargeMessage: 'too large'
  }), { name: 'AbortError' });
});

test('retains complete content across buffer growth and thousands of small chunks', async () => {
  const input = Buffer.alloc(160_000, 65);
  let offset = 0;
  const response = {
    body: {
      async *[Symbol.asyncIterator]() {
        while (offset < input.length) {
          const length = Math.min(13, input.length - offset);
          yield input.subarray(offset, offset + length);
          offset += length;
        }
      }
    }
  };
  assert.equal(await readBoundedResponseText(response, {
    maximumBytes: input.length, tooLargeMessage: 'too large'
  }), input.toString());
});
