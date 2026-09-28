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

test('reads literal Duotify course click handlers as chapter metadata without executing them', async () => {
  const result = await scan({ url: 'https://learn.duotify.com/courses/ai-prompt', elements: [
    element('a', { href: 'javascript:void(0);', onclick: "handleContentClickRedirect(event, 'ai-prompt', 281)", class: 'fw-bold text-decoration-none' }, { textContent: '  AI 提示工程：第一堂  ' }),
    element('a', { href: 'javascript:void(0);', onclick: ' \n handleContentClickRedirect ( event , "ai-prompt" , 295 ) ; \n' }, { textContent: '第二堂：實際操作' }),
    element('a', { href: 'javascript:void(0);', onclick: "handleContentClickRedirect(event, 'ai-prompt', 312);" }, { textContent: '第三堂：進階應用' }),
  ] });
  assert.deepEqual(result.lessons, [
    { url: 'https://learn.duotify.com/video/watch?slug=ai-prompt&sectionId=281', title: 'AI 提示工程：第一堂' },
    { url: 'https://learn.duotify.com/video/watch?slug=ai-prompt&sectionId=295', title: '第二堂：實際操作' },
    { url: 'https://learn.duotify.com/video/watch?slug=ai-prompt&sectionId=312', title: '第三堂：進階應用' },
  ]);
  assert.deepEqual(result.media, []);
});

test('mixed ordinary links and literal handlers deduplicate chapters in first DOM order', async () => {
  const first = '/video/watch?sectionId=281&slug=ai-prompt';
  const second = '/video/watch?slug=ai-prompt&sectionId=295';
  const result = await scan({ url: 'https://learn.duotify.com/courses/ai-prompt', elements: [
    element('a', { href: first, onclick: "handleContentClickRedirect(event, 'ai-prompt', 281)" }, { textContent: '第一堂' }),
    element('a', { href: 'javascript:void(0);', onclick: "handleContentClickRedirect(event, 'ai-prompt', 281)" }, { textContent: '重複第一堂' }),
    element('a', { href: 'javascript:void(0);', onclick: "handleContentClickRedirect(event, 'ai-prompt', 295)" }, { textContent: '第二堂' }),
    element('a', { href: second }, { textContent: '重複第二堂' }),
  ] });
  assert.deepEqual(result.lessons, [
    { url: `https://learn.duotify.com${first}`, title: '第一堂' },
    { url: `https://learn.duotify.com${second}`, title: '第二堂' },
  ]);
});

test('ignores handlers outside the exact HTTPS Duotify course landing page', async () => {
  const elements = [element('a', { href: 'javascript:void(0);', onclick: "handleContentClickRedirect(event, 'ai-prompt', 281)" }, { textContent: '第一堂' })];
  for (const url of [
    'http://learn.duotify.com/courses/ai-prompt', 'https://elsewhere.example/courses/ai-prompt',
    'https://learn.duotify.com:8443/courses/ai-prompt', 'https://learn.duotify.com/courses/another-course',
    'https://learn.duotify.com/courses/another-course?slug=ai-prompt',
    'https://learn.duotify.com/video/watch?slug=ai-prompt&sectionId=281',
    'https://learn.duotify.com/login?slug=ai-prompt',
  ]) {
    const result = await scan({ url, elements });
    assert.deepEqual(result.lessons, [], url);
  }
});

test('course path determines handler scope even when a conflicting slug query is present', async () => {
  const result = await scan({ url: 'https://learn.duotify.com/courses/ai-prompt?slug=another-course', elements: [
    element('a', { href: 'javascript:void(0);', onclick: "handleContentClickRedirect(event, 'another-course', 999)" }, { textContent: '其他課程' }),
    element('a', { href: 'javascript:void(0);', onclick: "handleContentClickRedirect(event, 'ai-prompt', 281)" }, { textContent: '目前課程' }),
  ] });
  assert.deepEqual(result.lessons, [{ url: 'https://learn.duotify.com/video/watch?slug=ai-prompt&sectionId=281', title: '目前課程' }]);
});

test('rejects unknown handler code, non-literal arguments, cross-course slugs and invalid IDs', async () => {
  const invalid = [
    "otherHandler(event, 'ai-prompt', 281)",
    "handlecontentclickredirect(event, 'ai-prompt', 281)",
    "handleContentClickRedirect(event, 'another-course', 281)",
    "handleContentClickRedirect(event, 'ai-prompt', 281); alert('extra')",
    "alert('prefix'); handleContentClickRedirect(event, 'ai-prompt', 281)",
    "return handleContentClickRedirect(event, 'ai-prompt', 281)",
    "handleContentClickRedirect(event, slug, 281)",
    'handleContentClickRedirect(event, `ai-prompt`, 281)',
    "handleContentClickRedirect(event, 'ai-prompt', sectionId)",
    "handleContentClickRedirect(event, 'ai-prompt', 280 + 1)",
    "handleContentClickRedirect(window.event, 'ai-prompt', 281)",
    "handleContentClickRedirect(event, 'ai-prompt', 281, extra)",
    "handleContentClickRedirect(event, 'ai-prompt', 0)",
    "handleContentClickRedirect(event, 'ai-prompt', -1)",
    "handleContentClickRedirect(event, 'ai-prompt', 0281)",
    "handleContentClickRedirect(event, 'ai-prompt', 281.5)",
    "handleContentClickRedirect(event, 'ai-prompt', Infinity)",
    "handleContentClickRedirect(event, 'ai-prompt', 9007199254740992)",
    "handleContentClickRedirect(event, 'ai-prompt', 281);;",
    "handleContentClickRedirect(event, 'ai-prompt', 281) // trailing code",
  ];
  const result = await scan({ url: 'https://learn.duotify.com/courses/ai-prompt', elements:
    invalid.map(onclick => element('a', { href: 'javascript:void(0);', onclick }, { textContent: '無效章節' })),
  });
  assert.deepEqual(result.lessons, []);
  assert.deepEqual(result.media, []);
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
