import test from 'node:test';
import assert from 'node:assert/strict';
import { duotifyExpected, validateDuotifyContext } from '../duotify-binding.js';

const origin = 'https://learn.duotify.com';
const page = `${origin}/video/watch?slug=course-a&sectionId=100`;
const secondPage = `${origin}/video/watch?slug=course-a&sectionId=200`;
const manifest = `${origin}/api/video/watch/?slug=course-a&videoId=video-a&type=m3u8`;
const secondManifest = `${origin}/api/video/watch/?slug=course-a&videoId=video-b&type=m3u8`;
const scanFixture = () => ({
  pageUrl: page, lessons: [{ url: page }, { url: secondPage }],
  media: [{ url: manifest, kind: 'hls' }],
});
const itemFixture = () => ({ url: manifest, playlist: { sourceUrl: manifest }, lessonUrl: page });
const expectedFixture = () => ({ courseSlug: 'course-a', sectionId: '100', manifestUrls: [manifest] });
const contextFixture = () => ({
  source: 'duotify-player-1.6.0', method: 'AES-128', courseSlug: 'course-a', sectionId: '100', manifestUrl: manifest,
});
function failsExpected(scan, item) {
  assert.throws(() => duotifyExpected(scan, item), error => {
    assert.equal(error.constructor, Error);
    assert.match(error.message, /請.*掃描/);
    assert.ok(!error.message.includes('http'));
    assert.ok(!error.message.includes('REVIEW_SENTINEL'));
    return true;
  });
}

test('binds the current manifest to a scanned playable source page without mutation', () => {
  const scan = scanFixture(), item = itemFixture();
  const before = JSON.stringify({ scan, item });
  assert.deepEqual(duotifyExpected(scan, item), expectedFixture());
  assert.equal(JSON.stringify({ scan, item }), before);
  assert.doesNotThrow(() => validateDuotifyContext(contextFixture(), expectedFixture()));
});

test('batch chapters retain the original source section and manifest anchors', () => {
  const item = { url: secondManifest, playlist: { sourceUrl: secondManifest }, lessonUrl: secondPage };
  const expected = duotifyExpected(scanFixture(), item);
  assert.deepEqual(expected, expectedFixture());
  assert.doesNotThrow(() => validateDuotifyContext(contextFixture(), expected));
  assert.throws(() => validateDuotifyContext({ ...contextFixture(), sectionId: '200', manifestUrl: secondManifest }, expected));
});

test('original and final manifest URLs require the same first-party course and video identity', () => {
  const invalidUrls = [
    undefined, null, '', '/api/video/watch/?slug=course-a&videoId=video-a&type=m3u8',
    manifest.replace('https:', 'http:'),
    manifest.replace(origin, 'https://learn.duotify.com.evil.test'),
    manifest.replace(origin, 'https://learn.duotify.com:444'),
    manifest.replace(origin, 'https://user:pass@learn.duotify.com'),
    manifest.replace('/api/video/watch/', '/unrelated'),
    manifest.replace('type=m3u8', 'type=ts'),
    manifest.replace('videoId=video-a', 'videoId='),
    manifest.replace('videoId=video-a&', ''),
    manifest.replace('slug=course-a', 'slug=%20'),
    manifest + '#fragment', manifest + '&type=ts', manifest + '&videoId=other', manifest + '&slug=other',
    'https://REVIEW_SENTINEL.invalid/private',
  ];
  for (const url of invalidUrls) {
    failsExpected(scanFixture(), { ...itemFixture(), url });
    failsExpected(scanFixture(), { ...itemFixture(), playlist: { sourceUrl: url } });
  }
  failsExpected(scanFixture(), { ...itemFixture(), playlist: { sourceUrl: secondManifest } });
  failsExpected(scanFixture(), { ...itemFixture(), playlist: { sourceUrl: manifest.replace('course-a', 'other-course') } });
  assert.doesNotThrow(() => duotifyExpected(scanFixture(), {
    ...itemFixture(), playlist: { sourceUrl: manifest.replace('/watch/', '/watch') + '&signature=refreshed' },
  }));
});

test('source and selected lesson must be valid first-party pages from the scanned course', () => {
  for (const value of [
    undefined, '', page.replace('https:', 'http:'), page.replace('/video/watch', '/courses/course-a'),
    page.replace('course-a', 'other-course'), page.replace('&sectionId=100', ''), page + '#section',
    page.replace(origin, 'https://user:pass@learn.duotify.com'), page + '&slug=other', page + '&sectionId=200',
  ]) {
    failsExpected({ ...scanFixture(), pageUrl: value }, itemFixture());
    failsExpected(scanFixture(), { ...itemFixture(), lessonUrl: value });
  }
  failsExpected(scanFixture(), { ...itemFixture(), lessonUrl: page.replace('sectionId=100', 'sectionId=999') });
  failsExpected({ ...scanFixture(), lessons: [] }, { ...itemFixture(), lessonUrl: secondPage });
  assert.doesNotThrow(() => duotifyExpected({ ...scanFixture(), lessons: [] }, itemFixture()));
});

test('only same-course valid scanned HLS API manifests become source anchors', () => {
  const irrelevant = [
    { kind: 'subtitle', url: manifest },
    { kind: 'hls', url: manifest.replace('course-a', 'other-course') },
    { kind: 'hls', url: 'https://media.example.test/playlist.m3u8' },
    { kind: 'hls', url: manifest + '&videoId=ambiguous' },
    { kind: 'hls', url: null }, null,
  ];
  const scan = { ...scanFixture(), media: [...irrelevant, { kind: 'hls', url: manifest }, { kind: 'hls', url: manifest }] };
  assert.deepEqual(duotifyExpected(scan, itemFixture()).manifestUrls, [manifest]);
  for (const media of [undefined, null, [], irrelevant]) failsExpected({ ...scanFixture(), media }, itemFixture());
  failsExpected(null, itemFixture());
  failsExpected(scanFixture(), null);
});

test('returned playback context must retain exact source, method, course, section, and scanned manifest', () => {
  const changes = [
    { source: 'untrusted-player' }, { method: 'NONE' }, { courseSlug: 'other-course' }, { sectionId: '200' },
    { manifestUrl: secondManifest }, { manifestUrl: manifest + '&signature=changed' },
    { manifestUrl: manifest.replace('https:', 'http:') }, { manifestUrl: manifest + '#fragment' },
    { manifestUrl: manifest + '&slug=other-course' }, { manifestUrl: 'https://REVIEW_SENTINEL.invalid/private' },
    { manifestUrl: undefined },
  ];
  for (const change of changes) {
    assert.throws(() => validateDuotifyContext({ ...contextFixture(), ...change }, expectedFixture()), error => {
      assert.equal(error.message, '原課程分頁或播放清單已變更，請重新掃描。');
      return true;
    });
  }
  assert.throws(() => validateDuotifyContext(null, expectedFixture()));
  assert.throws(() => validateDuotifyContext(contextFixture(), null));
  assert.throws(() => validateDuotifyContext(contextFixture(), { ...expectedFixture(), manifestUrls: [] }));
  assert.throws(() => validateDuotifyContext(contextFixture(), { ...expectedFixture(), manifestUrls: [manifest, 'bad'] }));
  // This function intentionally neither reads nor validates the caller-owned key.
  const context = contextFixture();
  Object.defineProperty(context, 'keyBytes', { get() { assert.fail('Binding must not access key material'); } });
  assert.doesNotThrow(() => validateDuotifyContext(context, expectedFixture()));
});
