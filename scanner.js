/**
 * Inspect only resources exposed by the current page. This function is injected
 * with chrome.scripting.executeScript, so keep every dependency inside it.
 */
export async function scanPage() {
  const pageUrl = location.href;
  const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const title = normalizeText(document.title);
  const media = [];
  const lessons = [];
  const iframeOrigins = new Set();
  const mediaUrls = new Set();
  const lessonUrls = new Set();
  const visitedRoots = new Set();
  let hasBlob = false;

  const httpUrl = (value) => {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.startsWith('blob:')) {
      hasBlob = true;
      return null;
    }
    if (!trimmed) return null;
    try {
      const parsed = new URL(trimmed, document.baseURI || pageUrl);
      return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed : null;
    } catch {
      return null;
    }
  };

  const classify = (url, mimeType = '') => {
    const path = url.pathname.toLowerCase();
    const mime = mimeType.toLowerCase().split(';')[0].trim();
    const typeParams = [];
    for (const [key, value] of url.searchParams) {
      if (['type', 'format', 'ext'].includes(key.toLowerCase())) {
        typeParams.push(value.toLowerCase());
      }
    }
    // Segments cannot be downloaded as standalone lesson videos.
    if (/\.(ts|m4s|cmfv|cmfa)$/.test(path)
      || typeParams.some((value) => /^(ts|m4s|cmfv|cmfa)$/.test(value))
      || mime === 'video/mp2t') {
      return 'segment';
    }
    if (/\.m3u8$/.test(path) || typeParams.includes('m3u8')
      || ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'].includes(mime)) {
      return 'hls';
    }
    if (/\.mpd$/.test(path) || typeParams.includes('mpd') || mime === 'application/dash+xml') {
      return 'dash';
    }
    if (/\.(vtt|srt|ttml)$/.test(path)
      || typeParams.some((value) => ['vtt', 'srt', 'ttml'].includes(value))
      || ['text/vtt', 'application/ttml+xml', 'application/x-subrip'].includes(mime)) {
      return 'subtitle';
    }
    if (/\.(mp4|webm|mov|m4v|mp3|m4a|ogg|ogv|oga|wav|flac|aac)$/.test(path)
      || typeParams.some((value) => ['mp4', 'webm', 'mov', 'm4v', 'mp3', 'm4a', 'ogg', 'wav', 'flac', 'aac'].includes(value))
      || /^(video|audio)\//.test(mime)) {
      return 'file';
    }
    return null;
  };

  const addMedia = (value, { source, label, mimeType, fallbackKind, manifestsOnly } = {}) => {
    const url = httpUrl(value);
    if (!url) return;
    const detectedKind = classify(url, mimeType);
    if (detectedKind === 'segment') return;
    const kind = detectedKind || fallbackKind;
    if (!kind || (manifestsOnly && kind !== 'hls' && kind !== 'dash')) return;
    if (mediaUrls.has(url.href)) return;
    mediaUrls.add(url.href);
    media.push({ url: url.href, kind, label: normalizeText(label) || title, source });
  };

  const current = new URL(pageUrl);
  const coursePath = current.pathname.match(/^\/courses\/([^/]+)\/?$/);
  let courseSlug = current.searchParams.get('slug');
  if (!courseSlug && coursePath) {
    try { courseSlug = decodeURIComponent(coursePath[1]); } catch { courseSlug = coursePath[1]; }
  }

  const roots = [document];
  while (roots.length) {
    const root = roots.shift();
    if (visitedRoots.has(root)) continue;
    visitedRoots.add(root);
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
      const tag = String(element.tagName || '').toLowerCase();
      const attr = (name) => element.getAttribute(name) || '';
      const label = attr('aria-label') || attr('title') || title;

      if (['video', 'audio', 'source'].includes(tag)) {
        for (const name of ['currentSrc', 'src', 'data-src']) {
          const value = name === 'currentSrc' ? element.currentSrc : attr(name);
          addMedia(value, { source: `${tag}.${name}`, label, mimeType: attr('type'), fallbackKind: 'file' });
        }
        addMedia(attr('data-subtitle-src'), { source: `${tag}.data-subtitle-src`, label: `${label} — 字幕`, fallbackKind: 'subtitle' });
      } else if (tag === 'track') {
        addMedia(attr('src'), { source: 'track.src', label: attr('label') || attr('srclang') || `${title} — 字幕`, fallbackKind: 'subtitle' });
      } else if (tag === 'iframe') {
        const url = httpUrl(attr('src'));
        if (url) iframeOrigins.add(url.origin);
      } else if (tag === 'a') {
        const linkLabel = normalizeText(element.textContent) || label;
        addMedia(attr('href'), { source: 'a.href', label: linkLabel, mimeType: attr('type') });
        const url = httpUrl(attr('href'));
        const navigationLabel = /^(?:[←→‹›«»\s]*)(?:下一[節堂課]|上一[節堂課]|跳至|跳到|skip\s+to\b|next\s+lesson\b|previous\s+lesson\b)/i.test(linkLabel);
        if (url && url.origin === current.origin && /^\/video\/watch\/?$/.test(url.pathname)
          && url.searchParams.get('slug')?.trim() && url.searchParams.get('sectionId')?.trim()
          && (!courseSlug || url.searchParams.get('slug') === courseSlug)
          && !url.hash && !navigationLabel) {
          // Page fragments and next/previous navigation are not catalog entries.
          // Only lesson URLs are canonicalized; media signatures remain intact.
          url.hash = '';
          if (!lessonUrls.has(url.href)) {
            lessonUrls.add(url.href);
            lessons.push({ url: url.href, title: linkLabel });
          }
        }
      }
    }
  }

  // Resource timing can reveal a manifest selected by a JavaScript player.
  // It is intentionally limited to manifests, not media segments or API calls.
  try {
    for (const resource of performance.getEntriesByType('resource')) {
      addMedia(resource.name, { source: 'performance.resource', label: title, manifestsOnly: true });
    }
  } catch {
    // Some page environments do not expose resource timing.
  }

  return { pageUrl, title, media, lessons, iframeOrigins: [...iframeOrigins], hasBlob };
}
