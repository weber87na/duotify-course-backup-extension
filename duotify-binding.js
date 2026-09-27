// Pure provenance checks. No cookies, network, browser globals, or key bytes.
const ORIGIN = 'https://learn.duotify.com';
const COURSE_ERROR = '課程與來源分頁不一致，請回到已購買且可播放的課程重新掃描。';
const MANIFEST_ERROR = '影片清單與所選課程不一致，請重新掃描。';
const LESSON_ERROR = '章節不在原課程掃描結果中，請重新掃描。';
const SOURCE_ERROR = '原課程分頁缺少可驗證的影片清單，請播放影片後重新掃描。';
const CONTEXT_ERROR = '原課程分頁或播放清單已變更，請重新掃描。';

function firstPartyUrl(value, path, parameters) {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f]/.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.origin !== ORIGIN || url.username || url.password || url.hash || !path.test(url.pathname)) return null;
  for (const parameter of parameters) {
    const values = url.searchParams.getAll(parameter);
    // Ambiguous duplicate parameters can be interpreted differently by servers.
    if (values.length !== 1 || !values[0].trim() || values[0] !== values[0].trim()) return null;
  }
  return url;
}

function lessonUrl(value) {
  return firstPartyUrl(value, /^\/video\/watch\/?$/, ['slug', 'sectionId']);
}

function manifestUrl(value) {
  const url = firstPartyUrl(value, /^\/api\/video\/watch\/?$/, ['slug', 'videoId', 'type']);
  return url?.searchParams.get('type') === 'm3u8' ? url : null;
}

/**
 * Bind a selected item to the scanned course and retain the original playable
 * page as the cookie-read anchor, including when downloading another chapter.
 */
export function duotifyExpected(scan, item) {
  const original = manifestUrl(item?.url);
  const final = manifestUrl(item?.playlist?.sourceUrl);
  if (!original || !final ||
    original.searchParams.get('slug') !== final.searchParams.get('slug') ||
    original.searchParams.get('videoId') !== final.searchParams.get('videoId')) {
    throw new Error(MANIFEST_ERROR);
  }
  const courseSlug = original.searchParams.get('slug');
  const source = lessonUrl(scan?.pageUrl);
  if (!source || source.searchParams.get('slug') !== courseSlug) throw new Error(COURSE_ERROR);

  const selected = lessonUrl(item?.lessonUrl);
  if (!selected || selected.searchParams.get('slug') !== courseSlug) throw new Error(LESSON_ERROR);
  const isSource = selected.href === source.href;
  const isScannedLesson = Array.isArray(scan?.lessons) && scan.lessons.some(lesson => {
    const candidate = lessonUrl(lesson?.url);
    return candidate?.href === selected.href;
  });
  if (!isSource && !isScannedLesson) throw new Error(LESSON_ERROR);

  const manifestUrls = new Set();
  for (const media of Array.isArray(scan?.media) ? scan.media : []) {
    if (media?.kind !== 'hls') continue;
    const manifest = manifestUrl(media.url);
    if (manifest?.searchParams.get('slug') === courseSlug) manifestUrls.add(manifest.href);
  }
  if (!manifestUrls.size) throw new Error(SOURCE_ERROR);
  return { courseSlug, sectionId: source.searchParams.get('sectionId'), manifestUrls: [...manifestUrls] };
}

/** Validate identity only. The caller separately validates and disposes keys. */
export function validateDuotifyContext(context, expected) {
  const validText = value => typeof value === 'string' && !!value.trim() && value === value.trim();
  if (!validText(expected?.courseSlug) || !validText(expected?.sectionId) ||
    !Array.isArray(expected?.manifestUrls) || !expected.manifestUrls.length ||
    !context || context.source !== 'duotify-player-1.6.0' || context.method !== 'AES-128' ||
    context.courseSlug !== expected.courseSlug || context.sectionId !== expected.sectionId) {
    throw new Error(CONTEXT_ERROR);
  }
  const actual = manifestUrl(context.manifestUrl);
  const allowed = expected.manifestUrls.map(manifestUrl);
  if (!actual || actual.searchParams.get('slug') !== expected.courseSlug ||
    allowed.some(url => !url || url.searchParams.get('slug') !== expected.courseSlug) ||
    !allowed.some(url => url.href === actual.href)) {
    throw new Error(CONTEXT_ERROR);
  }
}
