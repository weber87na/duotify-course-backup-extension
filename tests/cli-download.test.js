import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { downloadMedia, resolvePlaylist } from '../cli/download.js';

const origin = 'https://media.example.test/';
const url = name => new URL(name, origin).href;
const playlist = (...segments) => `#EXTM3U\n${segments.map(segment => `#EXTINF:3,\n${segment}`).join('\n')}\n#EXT-X-ENDLIST\n`;
const ts = (byte = 1) => {
  const bytes = new Uint8Array(376).fill(byte);
  bytes[0] = bytes[188] = 0x47;
  return bytes;
};
const media = (kind = 'hls', name = '課程') => ({ kind, title: name, url: url(kind === 'hls' ? 'video.m3u8' : kind === 'subtitle' ? 'captions.vtt' : 'video.mp4') });
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'course-cli-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function fixtureFetch(resources, requests = []) {
  return async (target, options) => {
    assert.equal(options.credentials, 'include');
    requests.push(target);
    if (!Object.hasOwn(resources, target)) throw new Error(`Unexpected signed URL ${target}`);
    const entry = resources[target];
    return entry instanceof Response ? entry : new Response(entry);
  };
}
function mp4() {
  const data = new Uint8Array(32);
  new DataView(data.buffer).setUint32(0, 24);
  data.set(Buffer.from('ftypisom'), 4);
  return data;
}
function responseAt(body, target) {
  const response = new Response(body);
  Object.defineProperty(response, 'url', { value: target });
  return response;
}

test('playlist follows redirected base URL and selects best/worst/maximum height', async () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000,RESOLUTION=1920x1080\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360\nlow.m3u8\n';
  for (const [options, expected] of [[{}, 'high'], [{ quality: 'worst' }, 'low'], [{ maxHeight: 720 }, 'low']]) {
    const calls = [];
    const result = await resolvePlaylist({ url: url('master.m3u8'), ...options, fetchImpl: fixtureFetch({
      [url('master.m3u8')]: responseAt(master, url('redirected/master.m3u8')),
      [url(`redirected/${expected}.m3u8`)]: playlist('piece.ts'),
    }, calls) });
    assert.equal(result.sourceUrl, url(`redirected/${expected}.m3u8`));
    assert.equal(result.segments[0].url, url('redirected/piece.ts'));
    assert.equal(calls.length, 2);
  }
});

test('playlist rejects loops, unbounded nesting, invalid quality and impossible height', async () => {
  const master = next => `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360\n${next}\n`;
  await assert.rejects(resolvePlaylist({ url: url('a.m3u8'), fetchImpl: async () => new Response(master('a.m3u8')) }), /循環/);
  let requests = 0;
  await assert.rejects(resolvePlaylist({ url: url('0.m3u8'), fetchImpl: async () => new Response(master(`${++requests}.m3u8`)) }), /層數/);
  assert.equal(requests, 6);
  await assert.rejects(resolvePlaylist({ url: url('a'), quality: 'custom' }), /best/);
  await assert.rejects(resolvePlaylist({ url: url('a'), maxHeight: -1 }), /正整數/);
  await assert.rejects(resolvePlaylist({ url: url('a'), maxHeight: 100, fetchImpl: async () => new Response(master('low.m3u8')) }), /高度上限/);
});

test('playlist rejects HTTP error, HTML, oversized text and does not leak signed URLs', async () => {
  for (const response of [new Response('denied', { status: 403 }), new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
    new Response('#EXTM3U', { headers: { 'content-length': String(16 * 1024 * 1024 + 1) } })]) {
    await assert.rejects(resolvePlaylist({ url: url('master?token=secret'), fetchImpl: async () => response }));
  }
  await assert.rejects(resolvePlaylist({ url: url('master?token=secret'), fetchImpl: async () => { throw new Error('https://secret.test/?token=secret'); } }), error => !error.message.includes('secret'));
});

test('clear HLS writes ordered content and publishes only complete file', async t => {
  const outputDir = await directory(t);
  const progress = [];
  const result = await downloadMedia({ media: media(), outputDir, onProgress: value => progress.push(value),
    fetchImpl: async target => {
      const files = await readdir(outputDir);
      assert.equal(files.some(file => file.endsWith('.ts')), false);
      if (target.endsWith('.m3u8')) return new Response(playlist('one.ts', 'two.ts'));
      return new Response(ts(target.endsWith('one.ts') ? 1 : 2));
    } });
  assert.equal(result.bytes, 752);
  assert.equal(result.segments, 2);
  assert.equal(basename(result.path), '課程.ts');
  assert.deepEqual(await readFile(result.path), Buffer.concat([ts(1), ts(2)]));
  assert.deepEqual(await readdir(outputDir), ['課程.ts']);
  assert.equal(progress.at(-1).completed, 2);
});

test('invalid first segment leaves no zero-byte files or .part files', async t => {
  const outputDir = await directory(t);
  await assert.rejects(downloadMedia({ media: media(), outputDir, fetchImpl: fixtureFetch({
    [url('video.m3u8')]: playlist('bad.ts'), [url('bad.ts')]: 'ciphertext or invalid HTML',
  }) }), /MPEG-TS/);
  assert.deepEqual(await readdir(outputDir), []);
});

test('failure after a valid segment removes only this download temporary output', async t => {
  const outputDir = await directory(t);
  await writeFile(join(outputDir, 'keep.part'), 'existing');
  await assert.rejects(downloadMedia({ media: media(), outputDir, fetchImpl: fixtureFetch({
    [url('video.m3u8')]: playlist('one.ts', 'bad.ts'), [url('one.ts')]: ts(), [url('bad.ts')]: 'bad',
  }) }));
  assert.deepEqual(await readdir(outputDir), ['keep.part']);
  assert.equal(await readFile(join(outputDir, 'keep.part'), 'utf8'), 'existing');
});

test('cancellation after first segment cleans temporary file and preserves existing destination', async t => {
  const outputDir = await directory(t);
  await writeFile(join(outputDir, '課程.ts'), 'keep');
  const controller = new AbortController();
  await assert.rejects(downloadMedia({ media: media(), outputDir, signal: controller.signal,
    onProgress: value => { if (value.completed === 1) controller.abort(); },
    fetchImpl: fixtureFetch({ [url('video.m3u8')]: playlist('one.ts', 'two.ts'), [url('one.ts')]: ts() }),
  }), { name: 'AbortError' });
  assert.deepEqual(await readdir(outputDir), ['課程.ts']);
  assert.equal(await readFile(join(outputDir, '課程.ts'), 'utf8'), 'keep');
});

test('same-name simultaneous downloads never overwrite each other or existing files', async t => {
  const outputDir = await directory(t);
  await writeFile(join(outputDir, '課程.ts'), 'existing');
  const results = await Promise.all([1, 2].map(value => downloadMedia({ media: media(), outputDir, fetchImpl: fixtureFetch({
    [url('video.m3u8')]: playlist('one.ts'), [url('one.ts')]: ts(value),
  }) })));
  assert.equal(new Set(results.map(result => result.path)).size, 2);
  assert.equal(await readFile(join(outputDir, '課程.ts'), 'utf8'), 'existing');
  assert.deepEqual((await readdir(outputDir)).sort(), ['課程 (1).ts', '課程 (2).ts', '課程.ts']);
  for (const [index, result] of results.entries()) assert.deepEqual(await readFile(result.path), Buffer.from(ts(index + 1)));
});

test('standard AES HLS decrypts before disk write', async t => {
  const outputDir = await directory(t);
  const raw = new Uint8Array(16).fill(7);
  const key = await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key, ts());
  const list = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0\n#EXTINF:3,\none.ts\n#EXT-X-ENDLIST';
  const result = await downloadMedia({ media: media(), outputDir, fetchImpl: fixtureFetch({
    [url('video.m3u8')]: list, [url('one.ts')]: ciphertext, [url('key.bin')]: raw,
  }) });
  assert.deepEqual(await readFile(result.path), Buffer.from(ts()));
  assert.deepEqual(await readdir(outputDir), ['課程.ts']);
});

test('Duotify needs explicit playback resolver and never treats a lookalike host as trusted', async t => {
  const outputDir = await directory(t);
  const target = 'https://learn.duotify.com/api/video/watch/?slug=test&type=m3u8&videoId=1';
  await assert.rejects(downloadMedia({ media: { ...media(), url: target }, outputDir,
    fetchImpl: async () => new Response(playlist(url('one.ts'))),
  }), /記憶體解密資訊/);
  let resolverCalls = 0;
  const lookalike = 'https://learn.duotify.com.evil.test/api/video/watch/?type=m3u8';
  const result = await downloadMedia({ media: { ...media(), url: lookalike }, outputDir,
    resolvePlayback: async () => { resolverCalls++; },
    fetchImpl: fixtureFetch({ [lookalike]: playlist(url('one.ts')), [url('one.ts')]: ts() }),
  });
  assert.equal(resolverCalls, 0);
  assert.equal(result.bytes, 376);
});

test('Duotify memory resolver decrypts synthetic data without storing context', async t => {
  const outputDir = await directory(t);
  const target = 'https://learn.duotify.com/api/video/watch?slug=test&type=m3u8&videoId=1';
  const raw = new Uint8Array(16).fill(9);
  const iv = new Uint8Array(16).fill(2);
  const encryptKey = await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['encrypt']);
  const key = await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, encryptKey, ts());
  const calls = [];
  const result = await downloadMedia({ media: { ...media(), url: target }, outputDir,
    resolvePlayback: async value => { calls.push(value); return { key, ivBytes: [...iv] }; },
    fetchImpl: fixtureFetch({ [target]: playlist(url('one.ts')), [url('one.ts')]: ciphertext }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceUrl, target);
  assert.deepEqual(await readFile(result.path), Buffer.from(ts()));
  assert.deepEqual(await readdir(outputDir), ['課程.ts']);
});

test('VTT and SRT preserve data; disguised HTML leaves no output', async t => {
  const outputDir = await directory(t);
  for (const [body, extension] of [['WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n你好\n', '.vtt'], ['1\n00:00:00,000 --> 00:00:01,000\n你好\n', '.srt']]) {
    const result = await downloadMedia({ media: media('subtitle'), outputDir, fetchImpl: async () => new Response(body) });
    assert.ok(result.path.endsWith(extension));
    assert.equal(await readFile(result.path, 'utf8'), body);
  }
  await assert.rejects(downloadMedia({ media: media('subtitle', 'bad'), outputDir, fetchImpl: async () => new Response('<html>login') }), /VTT/);
  assert.equal((await readdir(outputDir)).length, 2);
});

test('direct file streams across split headers and validates declared length', async t => {
  const outputDir = await directory(t);
  const bytes = mp4();
  const body = new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 2)); controller.enqueue(bytes.subarray(2)); controller.close(); } });
  const result = await downloadMedia({ media: media('file'), outputDir, fetchImpl: async () => new Response(body, { headers: { 'content-length': String(bytes.length) } }) });
  assert.deepEqual(await readFile(result.path), Buffer.from(bytes));
  await assert.rejects(downloadMedia({ media: media('file', 'truncated'), outputDir,
    fetchImpl: async () => new Response(bytes, { headers: { 'content-length': '9999' } }),
  }), /長度/);
  assert.deepEqual(await readdir(outputDir), ['課程.mp4']);
});

test('direct file HTML, empty, HTTP partial response and midstream failure never publish', async t => {
  const outputDir = await directory(t);
  for (const response of [new Response(''), new Response('<html>login'), new Response(mp4(), { status: 206 })]) {
    await assert.rejects(downloadMedia({ media: media('file'), outputDir, fetchImpl: async () => response }));
  }
  let pulls = 0;
  const body = new ReadableStream({ pull(controller) {
    if (!pulls++) { const chunk = new Uint8Array(8192); chunk.set(mp4()); controller.enqueue(chunk); }
    else controller.error(new Error('secret URL or authentication data'));
  } });
  await assert.rejects(downloadMedia({ media: media('file'), outputDir, fetchImpl: async () => new Response(body) }), error => !error.message.includes('secret'));
  assert.deepEqual(await readdir(outputDir), []);
});

test('cancellation interrupts a stalled manifest body without waiting for network completion', async t => {
  const outputDir = await directory(t);
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const pending = downloadMedia({ media: media(), outputDir, signal: controller.signal, fetchImpl: async () => response });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(outputDir), []);
});
