import { scanPage } from '../scanner.js';
import { readDuotifyPlaybackContext } from '../duotify.js';
import { duotifyExpected, validateDuotifyContext } from '../duotify-binding.js';

const abortCheck = signal => { if (signal?.aborted) throw new DOMException('已取消。', 'AbortError'); };
const pause = (signal, ms = 700) => new Promise((resolve, reject) => {
  abortCheck(signal);
  const onAbort = () => { clearTimeout(timer); reject(new DOMException('已取消。', 'AbortError')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

export function duotifySlug(raw) {
  const url = new URL(raw);
  if (url.origin !== 'https://learn.duotify.com') return null;
  const path = url.pathname.match(/^\/courses\/([^/]+)\/?$/);
  return path ? decodeURIComponent(path[1]) : url.searchParams.get('slug');
}

function samePage(actual, expected) {
  const a = new URL(actual), b = new URL(expected);
  if (a.origin !== b.origin) return false;
  if (b.origin === 'https://learn.duotify.com') {
    const slug = duotifySlug(expected);
    if (!slug || duotifySlug(actual) !== slug) return false;
    if (/^\/video\/watch\/?$/.test(b.pathname)) {
      return /^\/video\/watch\/?$/.test(a.pathname) && a.searchParams.get('sectionId') === b.searchParams.get('sectionId');
    }
    return /^\/courses\/|^\/video\/watch\/?$/.test(a.pathname);
  }
  a.hash = ''; b.hash = ''; return a.href === b.href;
}

export function selectLessons(scan, { all = false, chapters } = {}) {
  const catalog = scan.lessons?.length ? scan.lessons : [{ url: scan.pageUrl, title: scan.title }];
  const entries = catalog.map((lesson, index) => ({ ...lesson, index: index + 1 }));
  if (chapters?.some(index => index < 1 || index > entries.length)) throw new Error('章節編號超出目錄範圍，請先執行 scan。');
  if (all) return entries;
  if (chapters) return entries.filter(entry => chapters.includes(entry.index));
  const current = entries.find(entry => samePage(entry.url, scan.pageUrl));
  if (!current && duotifySlug(scan.pageUrl) && /^\/video\/watch\/?$/.test(new URL(scan.pageUrl).pathname)) {
    throw new Error('課程目錄沒有目前指定的章節，請重新開啟章節或明確指定 --chapters。');
  }
  return [current || entries[0]];
}

/** Wait on the course page, never inspect login forms or unrelated tabs. */
export async function scanWhenReady(page, expectedUrl, { signal, timeoutMs = 600000, playable = false } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    abortCheck(signal);
    if (page.isClosed()) throw new Error('課程瀏覽器已關閉。');
    try {
      if (samePage(page.url(), expectedUrl)) {
        if (playable && new URL(expectedUrl).origin === 'https://learn.duotify.com') {
          const ready = await page.evaluate(() => {
            const videos = [...document.querySelectorAll('video[data-src]')];
            if (videos.some(video => video.readyState >= 2 && !video.error && Number.isFinite(video.duration) && video.duration > 0)) return true;
            for (const video of videos) {
              video.muted = true;
              video.play()?.catch(() => {});
            }
            return false;
          });
          if (!ready) { await pause(signal); continue; }
        }
        const scan = await page.evaluate(scanPage);
        if (samePage(scan.pageUrl, expectedUrl) && (playable ? scan.media?.length : scan.lessons?.length || scan.media?.length)) return scan;
      }
    } catch (error) {
      abortCheck(signal);
      if (page.isClosed()) throw new Error('課程瀏覽器已關閉。');
      // User login/navigation can replace the JS execution context. Retry only
      // within the bounded wait; do not print page/library exception contents.
    }
    await pause(signal);
  }
  throw new Error('等待課程逾時。請確認 Chrome 課程分頁已登入，且所選章節可播放；可調整 --wait-login。');
}

export async function navigateCourse(page, url, signal) {
  abortCheck(signal);
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
  catch (error) {
    abortCheck(signal);
    if (page.isClosed()) throw new Error('課程瀏覽器已關閉。');
    if (error?.name !== 'TimeoutError') throw new Error('無法開啟課程頁，請檢查網路及網址。');
  }
}

/** Source identity is checked in Node and again inside the page before cookies. */
export async function playbackFor(page, scan, item, playlist, signal) {
  abortCheck(signal);
  const expected = duotifyExpected(scan, { ...item, playlist });
  let context, raw;
  try {
    try { context = await page.evaluate(readDuotifyPlaybackContext, expected); }
    catch { abortCheck(signal); throw new Error('無法取得目前章節的播放資訊，請確認仍能播放。'); }
    abortCheck(signal);
    if (context?.error) throw new Error(context.error);
    validateDuotifyContext(context, expected);
    const validBytes = bytes => Array.isArray(bytes) && bytes.length === 16 && bytes.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
    if (!validBytes(context.keyBytes) || !validBytes(context.ivBytes)) throw new Error('課程播放解密資訊格式不正確。');
    raw = Uint8Array.from(context.keyBytes);
    const key = await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
    abortCheck(signal);
    return { key, ivBytes: [...context.ivBytes] };
  } finally {
    raw?.fill(0);
    if (Array.isArray(context?.keyBytes)) context.keyBytes.fill(0);
  }
}

export function scanSummary(scan) {
  return { title: scan.title, lessons: selectLessons(scan, { all: true }).map(({ index, title, url }) => ({
    index, title, sectionId: new URL(url).searchParams.get('sectionId') || undefined,
  })), media: (scan.media || []).map(media => ({ kind: media.kind, source: media.source })) };
}
