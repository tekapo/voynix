// URL signing and AudioPlayer tokens for the Voynix Echo skill. Pure functions
// (no Alexa SDK), so `node --test` can cover them.
//
// The Mac verifies `sig` with the same message layout — see `play_mac` in
// src-tauri/src/remote.rs; both sides test one shared vector.
const crypto = require('node:crypto');

/** HMAC-SHA256 over "{i}|{seed}|{exp}|{list}", base64url without padding.
 *  `list` is last because it is free text; the numbers before it contain no "|". */
function sign(secret, list, i, seed, exp) {
  return crypto.createHmac('sha256', secret).update(`${i}|${seed}|${exp}|${list}`).digest('base64url');
}

/** The URL an Echo fetches. `seed` 0 plays the playlist in order. */
function playUrl({ baseUrl, secret, ttlSeconds = 7200 }, list, i, seed, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const sig = sign(secret, list, i, seed, exp);
  return `${baseUrl.replace(/\/+$/, '')}/play?list=${encodeURIComponent(list)}&i=${i}&seed=${seed}&exp=${exp}&sig=${sig}`;
}

/** What we remember between AudioPlayer events: AudioPlayer tokens are opaque
 *  strings that come back verbatim in every event (up to 1024 characters). */
function makeToken(list, i, seed) {
  return JSON.stringify({ l: list, i, s: seed });
}

function parseToken(token) {
  try {
    const t = JSON.parse(token);
    if (typeof t.l === 'string' && Number.isInteger(t.i) && t.i >= 0 && Number.isInteger(t.s) && t.s >= 0) {
      return { list: t.l, i: t.i, seed: t.s };
    }
  } catch (_) { /* not ours */ }
  return null;
}

/** A fresh non-zero seed, within JavaScript's exact-integer range. */
function newSeed() {
  return 1 + crypto.randomInt(2 ** 31 - 1);
}

/** The playlist name to send to the Mac for a slot: the canonical name Alexa
 *  resolved it to (a value of the PLAYLIST slot type, e.g. "ヒロト＆マーシー"),
 *  else what it heard, else "". Without a match Alexa still passes the raw
 *  recognition — which may be kanji for a name it doesn't know ("廣戸麻生"). */
function playlistFromSlot(slot) {
  const matched = slot?.resolutions?.resolutionsPerAuthority?.find((a) => a.status?.code === 'ER_SUCCESS_MATCH');
  return (matched?.values?.[0]?.value?.name ?? slot?.value ?? '').trim();
}

module.exports = { sign, playUrl, makeToken, parseToken, newSeed, playlistFromSlot };
