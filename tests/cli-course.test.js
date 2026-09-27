import test from 'node:test';
import assert from 'node:assert/strict';
import { selectLessons, scanSummary, scanWhenReady, playbackFor } from '../cli/course.js';
import { run } from '../cli/index.js';

const pageUrl = 'https://learn.duotify.com/video/watch?slug=example&sectionId=280';
const second = 'https://learn.duotify.com/video/watch?slug=example&sectionId=290';
const manifest = 'https://learn.duotify.com/api/video/watch/?slug=example&videoId=synthetic&type=m3u8';
const scan = { pageUrl, title: '合成課程', lessons: [{ url: pageUrl, title: '第一章' }, { url: second, title: '第二章' }],
  media: [{ url: manifest, kind: 'hls', source: 'video.data-src' }] };

test('course selection respects catalog order and defaults to current chapter', () => {
  assert.deepEqual(selectLessons(scan).map(l => l.index), [1]);
  assert.deepEqual(selectLessons({ ...scan, pageUrl: second }).map(l => l.index), [2]);
  assert.deepEqual(selectLessons(scan, { chapters: [2, 1] }).map(l => l.index), [1, 2]);
  assert.deepEqual(selectLessons(scan, { all: true }).map(l => l.index), [1, 2]);
  assert.throws(() => selectLessons(scan, { chapters: [3] }), /範圍/);
  assert.throws(() => selectLessons({ ...scan, pageUrl: pageUrl.replace('280', '999') }), /指定的章節/);
  assert.deepEqual(selectLessons({ ...scan, pageUrl: 'https://learn.duotify.com/courses/example' }).map(l => l.index), [1]);
});

test('scan summary exposes lesson labels, never signed media URLs', () => {
  const summary = scanSummary({ ...scan, media: [{ ...scan.media[0], url: `${manifest}&sig=synthetic-private` }] });
  assert.equal(summary.lessons[0].sectionId, '280');
  assert.ok(!JSON.stringify(summary).includes('synthetic-private'));
  assert.ok(!JSON.stringify(summary).includes('videoId'));
});

test('ready scan never evaluates a login page from another origin', async () => {
  const page = { isClosed: () => false, url: () => 'https://login.example.test/', evaluate: () => assert.fail('Do not inspect a login form') };
  await assert.rejects(scanWhenReady(page, pageUrl, { timeoutMs: 1 }), /逾時/);
  const canceled = AbortSignal.abort();
  await assert.rejects(scanWhenReady(page, pageUrl, { signal: canceled }), { name: 'AbortError' });
});

test('playback binds current chapter before key import and clears returned raw key bytes', async () => {
  const bytes = Array(16).fill(7);
  const context = { source: 'duotify-player-1.6.0', method: 'AES-128', courseSlug: 'example', sectionId: '280',
    manifestUrl: manifest, keyBytes: bytes, ivBytes: Array(16).fill(0) };
  const page = { async evaluate(fn, expected) { assert.equal(expected.sectionId, '280'); return context; } };
  const playback = await playbackFor(page, scan, { ...scan.media[0], lessonUrl: pageUrl }, { sourceUrl: manifest });
  assert.equal(playback.key.extractable, false); assert.equal(playback.key.algorithm.name, 'AES-CBC');
  assert.deepEqual(bytes, Array(16).fill(0));
  await assert.rejects(playbackFor({ evaluate: () => assert.fail('Scope mismatch must reject before cookie access') }, scan,
    { ...scan.media[0], lessonUrl: 'https://elsewhere.test/' }, { sourceUrl: manifest }), /章節/);
});

test('real command orchestration navigates selected chapters, closes session, and emits no source URLs', async () => {
  let current = pageUrl, closed = 0, launches = 0, auth;
  const downloaded = [];
  const page = {
    isClosed: () => false, url: () => current,
    async goto(url) { current = url; },
    async evaluate(fn) {
      if (fn.name === 'scanPage') return { ...scan, pageUrl: current };
      return true;
    },
  };
  const output = [], logs = [];
  const code = await run(['download', pageUrl, '--all', '--json', '--browser', 'chrome'], {
    stdout: { write: text => output.push(text) }, stderr: { write: text => logs.push(text) },
    launch: async () => { launches++; return { page, setAuthOrigin: url => { auth = url; }, fetchImpl: () => {}, close: async () => { closed++; } }; },
    download: async ({ media, resolvePlayback }) => {
      downloaded.push(media); assert.equal(typeof resolvePlayback, 'function');
      return { path: `/synthetic/${downloaded.length}.ts`, bytes: 376, segments: 1 };
    },
  });
  assert.equal(code, 0); assert.equal(launches, 1); assert.equal(closed, 1); assert.equal(auth, pageUrl);
  assert.equal(downloaded.length, 2); assert.equal(downloaded[1].lessonUrl, second);
  assert.equal(JSON.parse(output.join('')).completed.length, 2);
  assert.ok(!output.join('').includes('videoId')); assert.ok(!logs.join('').includes('https://'));
});

test('direct mode does not launch a browser and propagates failed item exit status', async () => {
  const output = [];
  const code = await run(['download', '--media', 'https://example.test/a.m3u8', '--json'], {
    stdout: { write: text => output.push(text) }, stderr: { write() {} },
    launch: () => assert.fail('Direct mode must not launch a browser'),
    existing: () => assert.fail('Direct mode must not connect to Chrome'),
    download: async () => { throw new Error('Failed https://example.test/file?token=synthetic'); },
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(output.join('')).failed.length, 1);
  assert.ok(!output.join('').includes('token='));
});

test('default command connects to existing Chrome and closes its session after selected downloads', async () => {
  let current = pageUrl, closed = 0, connected = 0;
  const downloaded = [], output = [];
  const page = {
    isClosed: () => false, url: () => current,
    async goto(url) { current = url; },
    async evaluate(fn) { return fn.name === 'scanPage' ? { ...scan, pageUrl: current } : true; },
  };
  const code = await run(['download', pageUrl, '--chapters', '2', '--json'], {
    stdout: { write: value => output.push(value) }, stderr: { write() {} },
    launch: () => assert.fail('Default mode must not launch an automation browser'),
    existing: async options => {
      connected++;
      assert.equal(options.url, pageUrl);
      assert.equal(options.timeoutMs, 600000);
      return { page, setAuthOrigin(url) { assert.equal(url, pageUrl); }, close: async () => { closed++; } };
    },
    download: async ({ media }) => { downloaded.push(media); return { path: '/synthetic/chapter2.ts', bytes: 376 }; },
  });
  assert.equal(code, 0);
  assert.equal(connected, 1);
  assert.equal(closed, 1);
  assert.deepEqual(downloaded.map(item => item.lessonUrl), [second]);
  assert.equal(JSON.parse(output.join('')).completed.length, 1);
});

test('existing Chrome scan disconnects without downloading', async () => {
  let closed = 0, output = '';
  const page = { isClosed: () => false, url: () => pageUrl, goto: async () => {}, evaluate: async () => scan };
  assert.equal(await run(['scan', pageUrl, '--json'], {
    stdout: { write(value) { output += value; } }, stderr: { write() {} },
    launch: () => assert.fail('Must not launch'), download: () => assert.fail('Scan must not download'),
    existing: async () => ({ page, setAuthOrigin() {}, close: async () => { closed++; } }),
  }), 0);
  assert.equal(closed, 1);
  assert.deepEqual(JSON.parse(output).lessons.map(item => item.sectionId), ['280', '290']);
});

test('JSON display titles and output filenames cannot expose a signed URL from page text', async () => {
  const sensitive = '合成標題 https://example.test/asset?sig=synthetic-secret';
  const rawScan = { ...scan, title: sensitive, lessons: scan.lessons.map(lesson => ({ ...lesson, title: sensitive })) };
  const page = { isClosed: () => false, url: () => pageUrl, goto: async () => {}, evaluate: async () => rawScan };
  let text = '';
  const launch = async () => ({ page, setAuthOrigin() {}, close: async () => {} });
  assert.equal(await run(['scan', pageUrl, '--json', '--browser', 'chrome'], { launch,
    stdout: { write: value => { text += value; } }, stderr: { write() {} } }), 0);
  assert.ok(!text.includes('synthetic-secret'));
  text = '';
  await run(['download', '--media', 'https://example.test/asset.mp4', '--title', sensitive, '--json'], {
    stdout: { write: value => { text += value; } }, stderr: { write() {} },
    download: async ({ media }) => { assert.ok(!media.title.includes('synthetic-secret')); return { path: '/synthetic/result.mp4', bytes: 32 }; },
  });
  assert.ok(!text.includes('synthetic-secret'));
});
