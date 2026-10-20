const test = require('node:test');
const assert = require('node:assert/strict');
const { sign, playUrl, makeToken, parseToken, newSeed, playlistFromSlot } = require('./playback');

test('signature matches the vector src-tauri/src/remote.rs asserts too', () => {
  assert.equal(sign('test-secret', 'ドライブ', 2, 123, 2_000_000_000), 'tq0M_QDjXZlXkvGvXmraAMsEICMU3Df5o_zJkPPa9Fo');
});

test('playUrl signs exactly the parameters it puts in the query', () => {
  const now = 1_700_000_000_000;
  const url = new URL(playUrl({ baseUrl: 'https://echo.example.org/', secret: 's3cret', ttlSeconds: 600 }, 'ドライブ 夜', 3, 42, now));
  assert.equal(url.origin + url.pathname, 'https://echo.example.org/play');
  assert.equal(url.searchParams.get('list'), 'ドライブ 夜');
  assert.equal(url.searchParams.get('i'), '3');
  assert.equal(url.searchParams.get('seed'), '42');
  const exp = Number(url.searchParams.get('exp'));
  assert.equal(exp, 1_700_000_600);
  assert.equal(url.searchParams.get('sig'), sign('s3cret', 'ドライブ 夜', 3, 42, exp));
});

test('tokens round-trip and reject foreign or malformed ones', () => {
  assert.deepEqual(parseToken(makeToken('ドライブ', 4, 99)), { list: 'ドライブ', i: 4, seed: 99 });
  assert.equal(parseToken('spike'), null);
  assert.equal(parseToken('{"l":"x","i":-1,"s":0}'), null);
  assert.equal(parseToken('{"l":1,"i":0,"s":0}'), null);
  assert.equal(parseToken(undefined), null);
});

test('a new seed is a positive safe integer (0 would mean "in order")', () => {
  for (let n = 0; n < 100; n++) {
    const s = newSeed();
    assert.ok(Number.isSafeInteger(s) && s > 0);
  }
});

test('the slot resolves to the canonical playlist name when Alexa matched one', () => {
  const matched = {
    value: 'ひろとまーしー',
    resolutions: { resolutionsPerAuthority: [
      { status: { code: 'ER_SUCCESS_NO_MATCH' } },
      { status: { code: 'ER_SUCCESS_MATCH' }, values: [{ value: { name: 'ヒロト＆マーシー', id: 'x' } }] },
    ] },
  };
  assert.equal(playlistFromSlot(matched), 'ヒロト＆マーシー');
});

test('without a match the heard text is used; an empty slot gives ""', () => {
  const noMatch = { value: '廣戸麻生', resolutions: { resolutionsPerAuthority: [{ status: { code: 'ER_SUCCESS_NO_MATCH' } }] } };
  assert.equal(playlistFromSlot(noMatch), '廣戸麻生');
  assert.equal(playlistFromSlot({ value: '  ドライブ ' }), 'ドライブ');
  assert.equal(playlistFromSlot({ name: 'playlist' }), '');
  assert.equal(playlistFromSlot(undefined), '');
});
