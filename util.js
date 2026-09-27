export function httpUrl(value, base) {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('不支援這種媒體網址。');
  return url.href;
}

export function originPattern(value) {
  return `${new URL(httpUrl(value)).origin}/*`;
}

export function safeName(value, fallback = '課程影片') {
  let name = String(value || fallback).normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '').slice(0, 110).replace(/[. ]+$/g, '');
  if (!name) name = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4);
  return `${(n / 1024 ** i).toFixed(i > 1 ? 2 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][i]}`;
}

export function mediaKind(value, mime = '') {
  try {
    const u = new URL(value);
    const ext = u.searchParams.get('type') || u.pathname.split('.').pop();
    if (/^(m3u8|hls)$/i.test(ext) || /mpegurl/i.test(mime)) return 'hls';
    if (/^mpd$/i.test(ext) || /dash\+xml/i.test(mime)) return 'dash';
    if (/^(vtt|srt)$/i.test(ext) || /text\/vtt/i.test(mime)) return 'subtitle';
    if (/^(mp4|webm|mov|m4v|mp3|m4a|ogg)$/i.test(ext) || /^(video|audio)\//i.test(mime)) return 'file';
  } catch { /* Not an HTTP URL. */ }
  return null;
}

export async function uniqueFile(directory, desired) {
  if (globalThis.navigator?.locks) {
    return navigator.locks.request('course-backup-file-allocation', () => allocateFile(directory, desired));
  }
  return allocateFile(directory, desired);
}

async function allocateFile(directory, desired) {
  const dot = desired.lastIndexOf('.');
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : '';
  for (let index = 0; index < 10000; index++) {
    const name = index ? `${stem} (${index})${ext}` : desired;
    try {
      await directory.getFileHandle(name);
    } catch (error) {
      if (error.name === 'NotFoundError') return { name, handle: await directory.getFileHandle(name, { create: true }) };
      throw error;
    }
  }
  throw new Error('同名檔案太多，請選擇另一個資料夾。');
}
