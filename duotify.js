/**
 * Reproduce the public player's playback metadata in the authorized page only.
 * Inject this self-contained function in Chrome's ISOLATED world. The returned
 * key must remain in caller memory for the selected course and never be logged,
 * stored, exported, or included in a saved playlist or diagnostic report.
 */
export function readDuotifyPlaybackContext(expected) {
  const fail = error => ({ error });
  const invalidExpected = () => fail('掃描的課程播放資訊無效，請重新掃描課程。');
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
    typeof expected.courseSlug !== 'string' || !expected.courseSlug.trim() ||
    typeof expected.sectionId !== 'string' || !expected.sectionId.trim() ||
    !Array.isArray(expected.manifestUrls) || !expected.manifestUrls.length) return invalidExpected();
  const isManifest = (url, slug) => url.origin === 'https://learn.duotify.com' &&
    !url.username && !url.password && !url.hash && /^\/api\/video\/watch\/?$/.test(url.pathname) &&
    ['slug', 'type', 'videoId'].every(name => url.searchParams.getAll(name).length === 1) &&
    url.searchParams.get('slug') === slug && url.searchParams.get('type') === 'm3u8' &&
    !!url.searchParams.get('videoId')?.trim();
  const expectedManifests = new Set();
  for (const value of expected.manifestUrls) {
    if (typeof value !== 'string') return invalidExpected();
    let manifest;
    // An expected source must be an absolute URL previously discovered by the
    // scan. Never expand caller input against whichever page is open now.
    try { manifest = new URL(value); } catch { return invalidExpected(); }
    if (!isManifest(manifest, expected.courseSlug)) return invalidExpected();
    expectedManifests.add(manifest.href);
  }
  const page = new URL(location.href);
  if (page.origin !== 'https://learn.duotify.com' || !/^\/video\/watch\/?$/.test(page.pathname)) {
    return fail('請在多奇已購買課程的影片播放頁取得播放資訊。');
  }
  const courseSlug = page.searchParams.get('slug');
  const sectionId = page.searchParams.get('sectionId');
  if (!courseSlug?.trim() || !sectionId?.trim()) return fail('目前頁面缺少課程或章節資訊。');
  if (page.searchParams.getAll('slug').length !== 1 || page.searchParams.getAll('sectionId').length !== 1 ||
    courseSlug !== expected.courseSlug || sectionId !== expected.sectionId) {
    return fail('目前播放頁與已掃描的課程章節不一致，請回到原章節再試。');
  }

  let manifestUrl = null;
  for (const video of document.querySelectorAll('video[data-src]')) {
    if (!(video.readyState >= 2) || video.error || !Number.isFinite(video.duration) || video.duration <= 0) continue;
    let manifest;
    try { manifest = new URL(video.getAttribute('data-src'), page.href); } catch { continue; }
    if (!isManifest(manifest, courseSlug) || !expectedManifests.has(manifest.href)) continue;
    manifestUrl = manifest.href;
    break;
  }
  if (!manifestUrl) return fail('請先播放目前已購買的課程影片，再重新取得播放資訊。');

  // Public fork of hls.js 1.6.0: TransmuxerInterface selects a cookie suffix
  // matching the local calendar date within two days, using a 32-bit FNV-1a hash.
  const now = new Date();
  const suffixes = new Set();
  for (let dayOffset = -2; dayOffset <= 2; dayOffset++) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOffset);
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    const day = date.toISOString().slice(0, 10).replace(/-/g, '');
    let hash = 2166136261;
    for (let index = 0; index < day.length; index++) {
      hash ^= day.charCodeAt(index);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    suffixes.add((hash >>> 0).toString(16).replace(/[^A-Za-z0-9]/g, '').slice(0, 12));
  }

  const prefix = '.AspNetCore.Antiforgery-';
  const positions = [11, 15, 17, 24, 27, 51, 59, 61, 62, 67, 68, 70, 74, 85, 89, 97, 126, 131, 137, 144, 150, 151];
  let encodedKey = null;
  // Read once, after validating the active playable course. Do not copy cookie
  // names or full values into the returned object. Unlike the player, never
  // delete stale cookies or manufacture a random fallback key.
  for (const entry of document.cookie.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    const name = entry.slice(0, separator).trim();
    if (!name.startsWith(prefix) || !suffixes.has(name.slice(prefix.length))) continue;
    const value = entry.slice(separator + 1);
    if (value.length <= positions.at(-1)) continue;
    const candidate = positions.map(index => value[index]).join('');
    if (candidate.includes('\0')) continue;
    encodedKey = candidate;
    break;
  }
  if (!encodedKey) return fail('目前課程的播放資訊已失效，請重新整理課程並播放影片。');
  if (!/^[A-Za-z0-9+/]{22}$/.test(encodedKey)) return fail('目前課程的播放資訊格式不受支援。');
  let decoded;
  try { decoded = atob(encodedKey + '=='); } catch { return fail('目前課程的播放資訊格式不受支援。'); }
  if (decoded.length !== 16) return fail('目前課程的播放資訊格式不受支援。');

  // The playlist rewrite uses an explicit public IV. Its data-URI key is a
  // decoy: Transmuxer.push replaces key/keyId with the worker key above while
  // preserving this IV. This constant is an IV, not a media key or credential.
  const ivHex = '5ee252b312f057d3deab6f98b5e48407';
  return {
    source: 'duotify-player-1.6.0',
    method: 'AES-128',
    courseSlug,
    sectionId,
    manifestUrl,
    keyBytes: Array.from(decoded, character => character.charCodeAt(0)),
    ivBytes: ivHex.match(/../g).map(byte => parseInt(byte, 16)),
  };
}
