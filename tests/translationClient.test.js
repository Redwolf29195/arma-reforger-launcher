const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_SEGMENT_BYTES,
  MAX_SOURCE_BYTES,
  clearTranslationCache,
  splitForTranslation,
  translateToRussian
} = require('../src/core/translationClient');

test.beforeEach(() => clearTranslationCache());

test('splitForTranslation keeps line separators and respects the API byte limit', () => {
  const source = `${'Alpha bravo charlie delta. '.repeat(40)}\n\nSecond line.`;
  const parts = splitForTranslation(source);
  assert.equal(parts.map((part) => part.value).join('').includes('\n\n'), true);
  for (const part of parts.filter((part) => part.type === 'text')) {
    assert.ok(Buffer.byteLength(part.value, 'utf8') <= MAX_SEGMENT_BYTES);
  }
});

test('translateToRussian translates bounded segments and preserves paragraphs', async () => {
  const requested = [];
  const result = await translateToRussian('First sentence.\n\nSecond sentence.', {
    fetchImpl: async (url) => {
      const value = new URL(url).searchParams.get('q');
      requested.push(value);
      return new Response(JSON.stringify({
        responseStatus: 200,
        responseData: { translatedText: `RU:${value}` }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  assert.equal(result.text, 'RU:First sentence.\n\nRU:Second sentence.');
  assert.deepEqual(requested.sort(), ['First sentence.', 'Second sentence.']);
});

test('translateToRussian returns Russian text without a network request', async () => {
  let calls = 0;
  const result = await translateToRussian('Этот мод показывает положение игрока на карте.', {
    fetchImpl: async () => {
      calls += 1;
      throw new Error('unexpected');
    }
  });
  assert.equal(result.alreadyRussian, true);
  assert.equal(result.text, 'Этот мод показывает положение игрока на карте.');
  assert.equal(calls, 0);
});

test('translateToRussian rejects text beyond the free-service allowance', async () => {
  await assert.rejects(
    translateToRussian('a'.repeat(MAX_SOURCE_BYTES + 1), { fetchImpl: async () => null }),
    /слишком длинное/
  );
});
