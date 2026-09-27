import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { scanPage } from '../scanner.js';

function element(tagName, attributes = {}, properties = {}) {
  return {
    tagName: tagName.toUpperCase(),
    getAttribute: (name) => attributes[name] ?? null,
    ...properties,
  };
}

function scan({ elements = [], url = 'https://learn.duotify.com/video/watch?slug=claude-code&sectionId=280', baseURI = url, resources = [], title = ' Claude Code 課程 ' } = {}) {
  const context = {
    URL,
    location: { href: url },
    document: { title, baseURI, querySelectorAll: () => elements },
    performance: { getEntriesByType: () => resources.map((name) => ({ name })) },
  };
  // Serialization reproduces scripting.executeScript: no module closure survives.
  return vm.runInNewContext(`(${scanPage.toString()})()`, context).then((value) => JSON.parse(JSON.stringify(value)));
}

test('finds the authenticated page manifest and subtitles behind a blob player', async () => {
  const hls = '/api/video/watch/?slug=claude-code&videoId=abc&type=m3u8';
  const subtitles = '/api/video/watch/?slug=claude-code&videoId=abc&type=vtt';
  const result = await scan({ elements: [
    element('video', { src: 'blob:https://learn.duotify.com/123', 'data-src': hls, 'data-subtitle-src': subtitles }, { currentSrc: 'blob:https://learn.duotify.com/123' }),
    element('source', { src: hls, type: 'application/x-mpegURL' }),
  ] });
  assert.equal(result.hasBlob, true);
  assert.equal(result.title, 'Claude Code 課程');
  assert.deepEqual(result.media.map(({ url, kind, source }) => ({ url, kind, source })), [
    { url: `https://learn.duotify.com${hls}`, kind: 'hls', source: 'video.data-src' },
    { url: `https://learn.duotify.com${subtitles}`, kind: 'subtitle', source: 'video.data-subtitle-src' },
  ]);
});

test('collects only matching-course lessons and deduplicates exact links', async () => {
  const lesson = '/video/watch?slug=claude-code&sectionId=281';
  const result = await scan({ url: 'https://learn.duotify.com/courses/claude-code', elements: [
    element('a', { href: lesson }, { textContent: '  02.\n 開始操作 ' }),
    element('a', { href: lesson }, { textContent: 'duplicate' }),
    element('a', { href: '/video/watch?slug=another-course&sectionId=2' }),
    element('a', { href: 'https://evil.example/video/watch?slug=claude-code&sectionId=4' }),
    element('a', { href: '/courses/claude-code' }),
  ] });
  assert.deepEqual(result.lessons, [{ url: `https://learn.duotify.com${lesson}`, title: '02. 開始操作' }]);
});

test('recognizes files, DASH, tracks and MIME-only sources without stripping signatures', async () => {
  const result = await scan({ elements: [
    element('video', { src: 'https://cdn.example/a.mp4?signature=A%2BB&expires=123' }),
    element('source', { src: '/media/opaque', type: 'application/dash+xml' }),
    element('track', { src: '/subtitles/opaque', label: '繁體中文' }),
    element('a', { href: '/download/opaque', type: 'video/mp4', download: '' }, { textContent: '下載影片' }),
    element('a', { href: '/clip.webm?download=1' }, { textContent: 'WebM' }),
  ] });
  assert.deepEqual(result.media.map(({ kind }) => kind), ['file', 'dash', 'subtitle', 'file', 'file']);
  assert.equal(result.media[0].url, 'https://cdn.example/a.mp4?signature=A%2BB&expires=123');
  assert.equal(result.media[2].label, '繁體中文');
});

test('keeps catalog order and names despite preceding skip links and lesson navigation', async () => {
  const first = '/video/watch?slug=claude-code&sectionId=280';
  const second = '/video/watch?slug=claude-code&sectionId=290';
  const result = await scan({ elements: [
    element('a', { href: first + '#main' }, { textContent: '跳至主要內容' }),
    element('a', { href: second }, { textContent: '下一節' }),
    element('a', { href: first }, { textContent: '第一堂：開發流程' }),
    element('a', { href: second }, { textContent: '第二堂：進階操作' }),
    element('a', { href: first }, { textContent: '上一節' }),
    element('a', { href: '/video/watch?slug=claude-code' }, { textContent: '缺少章節' }),
    element('a', { href: '/video/watch?sectionId=300' }, { textContent: '缺少課程' }),
    element('a', { href: first + '#main' }, { textContent: '頁面內連結' }),
    element('video', { src: 'https://cdn.example/lesson.mp4?signature=keep#t=10' }),
  ] });
  assert.deepEqual(result.lessons, [
    { url: `https://learn.duotify.com${first}`, title: '第一堂：開發流程' },
    { url: `https://learn.duotify.com${second}`, title: '第二堂：進階操作' },
  ]);
  assert.equal(result.media[0].url, 'https://cdn.example/lesson.mp4?signature=keep#t=10');
});

test('rejects non-HTTP schemes and segments, even in media tags or resource timing', async () => {
  const result = await scan({ elements: [
    element('video', { src: 'javascript:alert(1)' }),
    element('source', { src: 'data:video/mp4;base64,AAA' }),
    element('source', { src: 'https://user:password@cdn.example/lesson.mp4' }),
    element('video', { src: '/segment.ts', type: 'video/mp2t' }),
    element('source', { src: '/segment/opaque', type: 'video/mp2t' }),
    element('a', { href: '/chunk.m4s' }),
    element('audio', { src: '/chunk?type=m4s' }),
  ], resources: [
    'https://cdn.example/chunk.ts',
    'https://cdn.example/chunk.m4s',
    'https://learn.duotify.com/api/users',
    'https://cdn.example/master.m3u8?token=keep',
    'https://cdn.example/manifest.mpd',
    'https://cdn.example/trailer.mp4',
  ] });
  assert.deepEqual(result.media.map(({ url, kind }) => ({ url, kind })), [
    { url: 'https://cdn.example/master.m3u8?token=keep', kind: 'hls' },
    { url: 'https://cdn.example/manifest.mpd', kind: 'dash' },
  ]);
});

test('visits accessible shadow roots, resolves base URLs, and reports iframe origins', async () => {
  const result = await scan({ baseURI: 'https://assets.example/path/', elements: [
    element('custom-player', {}, { shadowRoot: { querySelectorAll: () => [element('video', { src: 'lesson.mp4' })] } }),
    element('iframe', { src: 'https://player.example/embed/1' }),
    element('iframe', { src: 'https://player.example/embed/2' }),
    element('iframe', { src: 'about:blank' }),
  ] });
  assert.deepEqual(result.media.map(({ url }) => url), ['https://assets.example/path/lesson.mp4']);
  assert.deepEqual(result.iframeOrigins, ['https://player.example']);
});

test('returns only the documented metadata contract', async () => {
  const result = await scan();
  assert.deepEqual(Object.keys(result).sort(), ['hasBlob', 'iframeOrigins', 'lessons', 'media', 'pageUrl', 'title']);
  assert.deepEqual(result.media, []);
  assert.equal(result.hasBlob, false);
});
