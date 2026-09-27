import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createCipheriv } from 'node:crypto';
import { readDuotifyPlaybackContext } from '../duotify.js';
import { parseHls } from '../hls.js';
import { transferHls } from '../transfer.js';

const pageUrl = 'https://learn.duotify.com/video/watch?slug=claude-code&sectionId=280';
const dataSrc = '/api/video/watch/?slug=claude-code&videoId=synthetic-video&type=m3u8';
const expectedContext = { courseSlug: 'claude-code', sectionId: '280', manifestUrls: [`https://learn.duotify.com${dataSrc}`] };
const key = Array.from({ length: 16 }, (_, index) => index * 13);
const positions = [11, 15, 17, 24, 27, 51, 59, 61, 62, 67, 68, 70, 74, 85, 89, 97, 126, 131, 137, 144, 150, 151];

// Independent BigInt FNV reference for synthetic cookie names.
function dayHash(day) {
  let value = 2166136261n;
  for (const character of day) value = ((value ^ BigInt(character.charCodeAt(0))) * 16777619n) & 0xffffffffn;
  return value.toString(16);
}
function cookie(day = '20260927', bytes = key) {
  const encoded = Buffer.from(bytes).toString('base64').replace(/=+$/, '');
  const value = Array(170).fill('x');
  for (let index = 0; index < positions.length; index++) value[positions[index]] = encoded[index];
  return `.AspNetCore.Antiforgery-${dayHash(day)}=${value.join('')}`;
}
function run({ url = pageUrl, cookieText = cookie(), videos, now = [2026, 8, 27], denyCookieRead = false,
  expected = expectedContext, omitExpected = false } = {}) {
  let reads = 0;
  const document = {
    querySelectorAll(selector) {
      assert.equal(selector, 'video[data-src]');
      return videos ?? [{ readyState: 4, duration: 14170, getAttribute: () => dataSrc }];
    },
    get cookie() {
      reads++;
      if (denyCookieRead) assert.fail('Cookies must not be read before course validation');
      return cookieText;
    },
    set cookie(_) { assert.fail('The adapter must never alter cookies'); },
  };
  const fixedNow = new Date(...now, 12).getTime();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
  }
  const result = vm.runInNewContext(`(${readDuotifyPlaybackContext.toString()})(${omitExpected ? '' : 'expected'})`, {
    URL, Date: Clock, location: { href: url }, document, expected,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    fetch: () => assert.fail('No network requests allowed'),
    console: new Proxy({}, { get: () => () => assert.fail('No logging allowed') }),
    localStorage: new Proxy({}, { get: () => assert.fail('No storage allowed') }),
    sessionStorage: new Proxy({}, { get: () => assert.fail('No storage allowed') }),
  });
  return { result: JSON.parse(JSON.stringify(result)), reads };
}

function failure(options, pattern) {
  const { result } = run(options);
  assert.deepEqual(Object.keys(result), ['error']);
  assert.match(result.error, pattern);
  return result.error;
}

test('serialized isolated-world adapter derives synthetic key and explicit IV', () => {
  const { result, reads } = run();
  assert.equal(reads, 1);
  assert.deepEqual(result, {
    source: 'duotify-player-1.6.0', method: 'AES-128', courseSlug: 'claude-code', sectionId: '280',
    manifestUrl: `https://learn.duotify.com${dataSrc}`, keyBytes: key,
    ivBytes: [...Buffer.from('5ee252b312f057d3deab6f98b5e48407', 'hex')],
  });
  assert.ok(!JSON.stringify(result).includes('Antiforgery'));
});

test('requires exact HTTPS host and playable chapter before reading cookies', () => {
  for (const url of [
    'http://learn.duotify.com/video/watch?slug=claude-code&sectionId=280',
    'https://learn.duotify.com.evil.test/video/watch?slug=claude-code&sectionId=280',
    'https://learn.duotify.com:444/video/watch?slug=claude-code&sectionId=280',
    'https://learn.duotify.com/courses/claude-code',
    'https://learn.duotify.com/video/watch?slug=claude-code',
  ]) failure({ url, denyCookieRead: true }, /課程|章節/);
  for (const [readyState, duration] of [[0, 100], [1, 100], [2, 0], [2, NaN], [2, Infinity]]) {
    failure({ videos: [{ readyState, duration, getAttribute: () => dataSrc }], denyCookieRead: true }, /先播放/);
  }
});

test('rejects absent or malformed expected scope before reading cookies', () => {
  failure({ omitExpected: true, denyCookieRead: true }, /掃描的課程播放資訊無效/);
  for (const expected of [null, {}, [], { ...expectedContext, courseSlug: '' },
    { ...expectedContext, sectionId: 280 }, { ...expectedContext, manifestUrls: [] },
    { ...expectedContext, manifestUrls: [dataSrc] },
    { ...expectedContext, manifestUrls: ['https://media.example.test' + dataSrc] },
    { ...expectedContext, manifestUrls: ['http://learn.duotify.com' + dataSrc] },
    { ...expectedContext, manifestUrls: ['https://learn.duotify.com' + dataSrc.replace('claude-code', 'other-course')] },
    { ...expectedContext, manifestUrls: ['https://learn.duotify.com' + dataSrc.replace('type=m3u8', 'type=vtt')] },
    { ...expectedContext, manifestUrls: ['https://learn.duotify.com' + dataSrc + '&slug=other-course'] },
  ]) failure({ expected, denyCookieRead: true }, /掃描的課程播放資訊無效/);
});

test('binds expected course and section before reading cookies', () => {
  for (const url of [pageUrl.replace('claude-code', 'other-course'), pageUrl.replace('sectionId=280', 'sectionId=290'),
    pageUrl + '&slug=other-course', pageUrl + '&sectionId=290']) {
    failure({ url, denyCookieRead: true }, /已掃描的課程章節不一致/);
  }
});

test('requires the scanned manifest and a decoded frame, including when paused', () => {
  failure({ videos: [{ readyState: 4, duration: 100, getAttribute: () => dataSrc.replace('synthetic-video', 'different-video') }],
    denyCookieRead: true }, /先播放/);
  failure({ videos: [{ readyState: 4, duration: 100, error: { code: 3 }, getAttribute: () => dataSrc }],
    denyCookieRead: true }, /先播放/);
  const { result } = run({ videos: [{ readyState: 2, duration: 100, paused: true, error: null,
    getAttribute: () => `https://learn.duotify.com${dataSrc}` }] });
  assert.deepEqual(result.keyBytes, key);
});

test('requires same-course first-party manifest and video identifier', () => {
  for (const source of [
    '/api/video/watch/?slug=other-course&videoId=synthetic-video&type=m3u8',
    'https://media.example.test/api/video/watch/?slug=claude-code&videoId=x&type=m3u8',
    '/api/video/watch/?slug=claude-code&type=m3u8',
    '/api/video/watch/?slug=claude-code&videoId=x&type=vtt',
    '/unrelated?slug=claude-code&videoId=x&type=m3u8',
    dataSrc + '#unexpected',
  ]) failure({ videos: [{ readyState: 4, duration: 1, getAttribute: () => source }], denyCookieRead: true }, /先播放/);
});

test('matches only dated playback cookies within the player five-day window', () => {
  for (const day of ['20260925', '20260926', '20260927', '20260928', '20260929']) {
    assert.deepEqual(run({ cookieText: cookie(day) }).result.keyBytes, key);
  }
  for (const day of ['20260924', '20260930']) failure({ cookieText: cookie(day) }, /已失效/);
  assert.deepEqual(run({ cookieText: `unrelated=secret; ${cookie('20260924')}; ${cookie()}` }).result.keyBytes, key);
});

test('calendar hashing handles month and year boundaries', () => {
  for (const day of ['20251230', '20251231', '20260101', '20260102', '20260103']) {
    assert.deepEqual(run({ now: [2026, 0, 1], cookieText: cookie(day) }).result.keyBytes, key);
  }
});

test('preserves player selection order without a random fallback or cookie mutation', () => {
  const secondKey = Array(16).fill(244);
  assert.deepEqual(run({ cookieText: `${cookie('20260926', secondKey)}; ${cookie()}` }).result.keyBytes, secondKey);
  const short = `.AspNetCore.Antiforgery-${dayHash('20260927')}=too-short`;
  assert.deepEqual(run({ cookieText: `${short}; ${cookie('20260926')}` }).result.keyBytes, key);
  failure({ cookieText: short }, /已失效/);
  failure({ cookieText: '' }, /已失效/);
});

test('malformed selected material fails closed without exposing cookie values', () => {
  const malformed = cookie().split('=')[0] + '=' + '!'.repeat(170);
  const error = failure({ cookieText: `${malformed}; ${cookie('20260926')}` }, /格式不受支援/);
  assert.ok(!error.includes('!'));
  assert.ok(!error.includes('Antiforgery'));
});

test('synthetic cookie context feeds nonextractable crypto and validated TS transfer', async () => {
  const { result: context } = run();
  const segmentUrl = 'https://media.example.test/synthetic.ts';
  const playlist = parseHls(`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${segmentUrl}\n#EXT-X-ENDLIST\n`, context.manifestUrl);
  assert.equal(playlist.segments[0].encryption, null);
  const clear = new Uint8Array(376).fill(0xff);
  // Two complete synthetic null TS packets; no course media is involved.
  clear.set([0x47, 0x1f, 0xff, 0x10], 0);
  clear.set([0x47, 0x1f, 0xff, 0x11], 188);
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(context.keyBytes), Buffer.from(context.ivBytes));
  const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]);
  const rawKey = new Uint8Array(context.keyBytes);
  let cryptoKey;
  try { cryptoKey = await crypto.subtle.importKey('raw', rawKey, 'AES-CBC', false, ['decrypt']); }
  finally { rawKey.fill(0); context.keyBytes.fill(0); }
  assert.equal(cryptoKey.extractable, false);
  playlist.segments[0].encryption = { method: context.method, source: 'duotify-memory', iv: [...context.ivBytes] };
  const writes = [];
  const requests = [];
  let resolutions = 0;
  const result = await transferHls({
    playlist,
    writable: { async write(bytes) { writes.push(bytes.slice()); } },
    resolveKey(encryption) {
      resolutions++;
      assert.equal(encryption.source, 'duotify-memory');
      assert.deepEqual(encryption.iv, context.ivBytes);
      return cryptoKey;
    },
    fetchImpl: async target => {
      requests.push(target);
      assert.equal(target, segmentUrl, 'No key endpoint or actual network may be requested');
      return new Response(ciphertext, { headers: { 'Content-Type': 'video/mp2t' } });
    },
  });
  assert.equal(resolutions, 1);
  assert.deepEqual(requests, [segmentUrl]);
  assert.deepEqual(writes, [clear]);
  assert.deepEqual(result, { bytes: clear.length, segments: 1 });
});
