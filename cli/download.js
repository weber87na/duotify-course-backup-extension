import { mkdir, open, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseHls } from '../hls.js';
import { transferHls } from '../transfer.js';
import { httpUrl, safeName } from '../util.js';

const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 45_000;
const MAX_PLAYLIST_DEPTH = 6;

class DownloadError extends Error {
  constructor(message) { super(message); this.name = 'DownloadError'; }
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('已取消下載。', 'AbortError');
}

function checkedUrl(value) {
  try { return httpUrl(value); } catch { throw new DownloadError('媒體網址必須是沒有內嵌帳密的 HTTP(S) 網址。'); }
}

function safeError(error, fallback = '下載失敗，請確認網路及登入狀態。') {
  if (error?.name === 'AbortError') return new DOMException('已取消下載。', 'AbortError');
  if (['DownloadError', 'HlsParseError', 'UnsupportedHlsError', 'TransferError'].includes(error?.name)) {
    // Parser diagnostics can include an unknown tag supplied by the server.
    return new DownloadError(String(error.message).replace(/https?:\/\/\S+/gi, '[網址已隱藏]'));
  }
  return new DownloadError(fallback);
}

function validateResponse(response, { text = false } = {}) {
  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? response.status : '未知';
    throw new DownloadError(`媒體請求失敗（HTTP ${status}），請確認登入狀態及存取權限。`);
  }
  if (response.status === 206) throw new DownloadError('伺服器只回傳部分內容，無法確認檔案完整性。');
  const mime = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (/^(?:text\/html|application\/(?:xhtml\+xml|json|[^;]+\+json|xml|[^;]+\+xml))$/.test(mime) ||
    !text && mime.startsWith('text/') && mime !== 'text/plain') {
    throw new DownloadError('伺服器回傳網頁或文字錯誤，請重新登入課程。');
  }
  if (!response.body?.getReader) throw new DownloadError('媒體回應沒有可讀取的內容。');
}

// A request owns its cancellation listener and timer. Text requests have a total
// deadline; large direct files use the same deadline for each read instead.
async function request(url, { fetchImpl, signal, idle = false }, consume) {
  checkAbort(signal);
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  let rejectCancelled;
  const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
  const abort = () => {
    controller.abort();
    rejectCancelled(new DOMException('已取消下載。', 'AbortError'));
  };
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; abort(); }, TIMEOUT_MS);
  };
  signal?.addEventListener('abort', abort, { once: true });
  resetTimer();
  const wait = (promise) => Promise.race([promise, cancelled]);
  let response;
  try {
    response = await wait(Promise.resolve().then(() => fetchImpl(url, {
      signal: controller.signal, credentials: 'include',
    })));
    checkAbort(signal);
    return await consume(response, async (reader) => {
      checkAbort(signal);
      if (idle) resetTimer();
      const next = await wait(reader.read());
      checkAbort(signal);
      return next;
    });
  } catch (error) {
    checkAbort(signal);
    if (timedOut) throw new DownloadError('媒體請求逾時（45 秒未完成或未收到資料）。');
    throw safeError(error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
    // The reader normally owns cancellation; this handles rejected headers.
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}

async function readText(url, options) {
  return request(url, options, async (response, read) => {
    validateResponse(response, { text: true });
    const declared = response.headers.get('content-length');
    if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_TEXT_BYTES) {
      throw new DownloadError('清單或字幕超過 16 MiB 上限。');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    let complete = false;
    try {
      while (true) {
        const next = await read(reader);
        if (next.done) { complete = true; break; }
        if (!(next.value instanceof Uint8Array)) throw new DownloadError('媒體回應資料無效。');
        length += next.value.byteLength;
        if (length > MAX_TEXT_BYTES) throw new DownloadError('清單或字幕超過 16 MiB 上限。');
        chunks.push(next.value);
      }
    } finally {
      if (!complete) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!length) throw new DownloadError('伺服器回傳空白的清單或字幕。');
    const data = Buffer.concat(chunks, length);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
    catch { throw new DownloadError('清單或字幕不是有效的 UTF-8 文字。'); }
    return { text, data, sourceUrl: checkedUrl(response.url || url) };
  });
}

function selectVariant(variants, quality, maxHeight) {
  let candidates = [...variants];
  if (maxHeight !== undefined) candidates = candidates.filter(variant => variant.height && variant.height <= maxHeight);
  if (!candidates.length) throw new DownloadError('沒有符合高度上限的影片畫質。');
  candidates.sort((a, b) => (a.height || 0) - (b.height || 0) ||
    (a.averageBandwidth || a.bandwidth) - (b.averageBandwidth || b.bandwidth));
  return quality === 'worst' ? candidates[0] : candidates.at(-1);
}

/** Resolve one complete VOD media playlist without persisting any URLs. */
export async function resolvePlaylist({ url, fetchImpl = fetch, signal, quality = 'best', maxHeight }) {
  if (!['best', 'worst'].includes(quality)) throw new DownloadError('畫質必須是 best 或 worst。');
  if (maxHeight !== undefined && (!Number.isSafeInteger(maxHeight) || maxHeight <= 0)) {
    throw new DownloadError('影片高度上限必須是正整數。');
  }
  let current = checkedUrl(url);
  const seen = new Set();
  try {
    for (let depth = 0; depth < MAX_PLAYLIST_DEPTH; depth++) {
      checkAbort(signal);
      if (seen.has(current)) throw new DownloadError('影片畫質清單形成循環。');
      seen.add(current);
      const result = await readText(current, { fetchImpl, signal });
      const playlist = parseHls(result.text, result.sourceUrl);
      if (playlist.type === 'media') return { ...playlist, sourceUrl: result.sourceUrl };
      current = selectVariant(playlist.variants, quality, maxHeight).url;
    }
    throw new DownloadError('影片畫質清單層數超過支援上限。');
  } catch (error) { throw safeError(error); }
}

// Nothing is created until the first validated write. Publication uses hardlink
// rather than rename: Windows and POSIX rename differ when a destination exists.
class AtomicOutput {
  constructor(outputDir, name, signal) {
    this.directory = resolve(outputDir);
    this.name = name;
    this.signal = signal;
    this.bytes = 0;
    this.temp = null;
    this.handle = null;
  }

  async write(data) {
    checkAbort(this.signal);
    if (!(data instanceof Uint8Array) || !data.byteLength) throw new DownloadError('拒絕寫入空白或無效資料。');
    if (!this.handle) {
      await mkdir(this.directory, { recursive: true });
      for (let attempt = 0; attempt < 10; attempt++) {
        const path = join(this.directory, `.course-backup-${randomUUID()}.part`);
        try {
          this.handle = await open(path, 'wx', 0o600);
          this.temp = path;
          break;
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      if (!this.handle) throw new DownloadError('無法建立獨有的暫存檔案。');
    }
    let position = 0;
    while (position < data.byteLength) {
      checkAbort(this.signal);
      const { bytesWritten } = await this.handle.write(data.subarray(position));
      if (!bytesWritten) throw new DownloadError('磁碟寫入未完成，請確認剩餘空間。');
      position += bytesWritten;
      this.bytes += bytesWritten;
    }
  }

  async finish() {
    checkAbort(this.signal);
    if (!this.handle || !this.bytes) throw new DownloadError('下載沒有產生有效資料。');
    await this.handle.sync();
    await this.handle.close();
    this.handle = null;
    const dot = this.name.lastIndexOf('.');
    const stem = dot > 0 ? this.name.slice(0, dot) : this.name;
    const extension = dot > 0 ? this.name.slice(dot) : '';
    for (let index = 0; index < 10000; index++) {
      checkAbort(this.signal);
      const path = join(this.directory, `${stem}${index ? ` (${index})` : ''}${extension}`);
      try { await link(this.temp, path); }
      catch (error) {
        if (error.code === 'EEXIST') continue;
        throw new DownloadError('無法安全發布完整檔案；目的地需支援硬連結（例如本機 NTFS、APFS 或 ext4）。');
      }
      // The completed path is now immutable from our perspective. abort() only
      // cleans the random temporary name if removing it fails here.
      await unlink(this.temp).then(() => { this.temp = null; }, () => {});
      return { path, bytes: this.bytes };
    }
    throw new DownloadError('同名檔案太多，請選擇其他下載資料夾。');
  }

  async abort() {
    if (this.handle) { await this.handle.close().catch(() => {}); this.handle = null; }
    if (this.temp) {
      await unlink(this.temp).then(() => { this.temp = null; }, error => {
        if (error.code === 'ENOENT') this.temp = null;
      });
    }
  }
}

function isDuotifyPlaylist(url, playlist) {
  const source = new URL(url);
  return source.origin === 'https://learn.duotify.com' && /^\/api\/video\/watch\/?$/.test(source.pathname) &&
    source.searchParams.get('type') === 'm3u8' && playlist.format === 'ts' &&
    playlist.segments.every(segment => !segment.encryption);
}

function directExtension(prefix) {
  const ascii = (start, end) => Buffer.from(prefix.subarray(start, end)).toString('ascii');
  if (prefix.length >= 16 && ascii(4, 8) === 'ftyp' && new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(0) >= 16) return '.mp4';
  if (prefix.length >= 5 && prefix[0] === 0x1a && prefix[1] === 0x45 && prefix[2] === 0xdf && prefix[3] === 0xa3) return '.webm';
  if (prefix.length >= 27 && ascii(0, 4) === 'OggS') return '.ogg';
  if (prefix.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return '.wav';
  if (prefix.length >= 376 && prefix[0] === 0x47 && prefix[188] === 0x47) return '.ts';
  if (prefix.length >= 10 && ascii(0, 3) === 'ID3' || prefix.length >= 4 && prefix[0] === 0xff && (prefix[1] & 0xe0) === 0xe0) return '.mp3';
  throw new DownloadError('回應不是支援的 MP4、WebM、TS 或音訊檔案，可能是登入頁或失效連結。');
}

async function downloadDirect({ url, title, outputDir, fetchImpl, signal, onProgress }) {
  let output;
  try {
    return await request(url, { fetchImpl, signal, idle: true }, async (response, read) => {
      validateResponse(response);
      const reader = response.body.getReader();
      let complete = false;
      const pending = [];
      let pendingLength = 0;
      const initialize = () => {
        const prefix = Buffer.concat(pending, pendingLength);
        const extension = directExtension(prefix);
        output = new AtomicOutput(outputDir, `${safeName(title)}${extension}`, signal);
        return prefix;
      };
      try {
        while (true) {
          const next = await read(reader);
          if (next.done) { complete = true; break; }
          if (!(next.value instanceof Uint8Array)) throw new DownloadError('媒體回應資料無效。');
          if (!next.value.byteLength) continue;
          if (!output) {
            pending.push(next.value);
            pendingLength += next.value.byteLength;
            if (pendingLength < 4096) continue;
            const prefix = initialize();
            await output.write(prefix);
            pending.length = 0;
          } else await output.write(next.value);
          onProgress?.({ bytes: output.bytes });
        }
        if (!output) {
          if (!pendingLength) throw new DownloadError('伺服器回傳空白影片。');
          const prefix = initialize();
          await output.write(prefix);
          onProgress?.({ bytes: output.bytes });
        }
        const length = response.headers.get('content-length');
        const encoding = response.headers.get('content-encoding');
        if (length && /^\d+$/.test(length) && (!encoding || encoding === 'identity') && Number(length) !== output.bytes) {
          throw new DownloadError('影片長度與伺服器宣告不符，檔案可能不完整。');
        }
        return await output.finish();
      } finally {
        if (!complete) void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });
  } finally { await output?.abort(); }
}

/** Download one selected media item. Credentials and keys belong to the caller. */
export async function downloadMedia({ media, outputDir, fetchImpl = fetch, signal, quality = 'best', maxHeight, resolvePlayback, onProgress }) {
  if (!media || !['hls', 'subtitle', 'file'].includes(media.kind)) throw new DownloadError('不支援此媒體種類。');
  if (typeof outputDir !== 'string' || !outputDir.trim()) throw new DownloadError('請指定下載資料夾。');
  const url = checkedUrl(media.url);
  let output;
  let playback;
  try {
    checkAbort(signal);
    if (media.kind === 'file') return await downloadDirect({ url, title: media.title, outputDir, fetchImpl, signal, onProgress });
    if (media.kind === 'subtitle') {
      const { text, data } = await readText(url, { fetchImpl, signal });
      const body = text.replace(/^\uFEFF/, '').trimStart();
      let extension;
      if (/^WEBVTT(?:\s|$)/.test(body)) extension = '.vtt';
      else if (/^\d+\s*\r?\n\d\d:\d\d:\d\d[,.]\d{3}\s*-->/.test(body)) extension = '.srt';
      else throw new DownloadError('字幕來源不是有效的 VTT / SRT，可能登入已失效。');
      output = new AtomicOutput(outputDir, `${safeName(media.title, '課程字幕')}${extension}`, signal);
      await output.write(data);
      const result = await output.finish();
      onProgress?.({ bytes: result.bytes, completed: 1, total: 1 });
      return result;
    }
    let playlist = await resolvePlaylist({ url, fetchImpl, signal, quality, maxHeight });
    if (isDuotifyPlaylist(url, playlist)) {
      if (typeof resolvePlayback !== 'function') throw new DownloadError('此 Duotify 影片需要已登入且可播放課程的記憶體解密資訊；請透過課程頁下載。');
      try { playback = await resolvePlayback(playlist); }
      catch { checkAbort(signal); throw new DownloadError('無法取得此課程的播放解密資訊，請確認已登入且影片可正常播放。'); }
      if (!Array.isArray(playback?.ivBytes) || playback.ivBytes.length !== 16 ||
        playback.ivBytes.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
        throw new DownloadError('課程播放 IV 資訊無效。');
      }
      playlist = { ...playlist, segments: playlist.segments.map(segment => ({ ...segment,
        encryption: { method: 'AES-128', source: 'duotify-memory', iv: [...playback.ivBytes] },
      })) };
    }
    checkAbort(signal);
    output = new AtomicOutput(outputDir, `${safeName(media.title)}${playlist.format === 'fmp4' ? '.mp4' : '.ts'}`, signal);
    const transfer = await transferHls({ playlist, writable: output, signal, fetchImpl, onProgress,
      resolveKey: playback ? async () => playback.key : undefined });
    const result = await output.finish();
    return { ...result, segments: transfer.segments };
  } catch (error) { throw safeError(error); }
  finally { playback = null; await output?.abort(); }
}
