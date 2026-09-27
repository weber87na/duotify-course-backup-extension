const MAX_OBJECT_BYTES = 128 * 1024 * 1024;
const ATTEMPT_TIMEOUT_MS = 45_000;
const MAX_ATTEMPTS = 3;

class TransferError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.name = 'TransferError';
    this.retryable = retryable;
  }
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('已取消下載。', 'AbortError');
}

function checkedUrl(resource) {
  if (!resource || typeof resource.url !== 'string') {
    throw new TransferError('缺少影片網址。');
  }
  let url;
  try { url = new URL(resource.url); } catch {
    throw new TransferError('影片網址無效。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TransferError('只支援沒有內嵌帳密的 HTTP(S) 影片網址。');
  }
  return url.href;
}

function encryptionKey(encryption) {
  if (encryption == null) return 'clear';
  if (encryption.method !== 'AES-128' ||
    !Array.isArray(encryption.iv) || encryption.iv.length !== 16 ||
    Array.from(encryption.iv).some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new TransferError('HLS 解密資訊無效；只支援具有有效 IV 的標準 AES-128。');
  }
  if ('source' in encryption) {
    if (encryption.source !== 'duotify-memory' || 'url' in encryption) {
      throw new TransferError('HLS 記憶體金鑰來源無效。');
    }
    return `memory:${encryption.source}\n${encryption.iv.join(',')}`;
  }
  return `${checkedUrl(encryption)}\n${encryption.iv.join(',')}`;
}

async function resolveMemoryKey(encryption, resolveKey, signal) {
  if (typeof resolveKey !== 'function') throw new TransferError('缺少已登入課程的記憶體播放金鑰來源。');
  checkAbort(signal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timeout;
  let stop;
  try {
    const cancelled = new Promise((_, reject) => {
      stop = () => reject(new DOMException('已取消下載。', 'AbortError'));
      controller.signal.addEventListener('abort', stop, { once: true });
      timeout = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
    });
    let key;
    try {
      key = await Promise.race([Promise.resolve().then(() => {
        checkAbort(controller.signal);
        return resolveKey(encryption, controller.signal);
      }), cancelled]);
    } catch {
      checkAbort(signal);
      if (controller.signal.aborted) throw new TransferError('取得課程播放金鑰逾時。');
      throw new TransferError('無法取得課程播放金鑰，請保持已登入且可播放的課程分頁開啟。');
    }
    checkAbort(signal);
    if (typeof CryptoKey !== 'function' || !(key instanceof CryptoKey) || key.type !== 'secret' || key.extractable !== false ||
      key.algorithm.name !== 'AES-CBC' || key.algorithm.length !== 128 || !key.usages.includes('decrypt')) {
      throw new TransferError('課程播放金鑰無效，必須是不可匯出的 AES-CBC 128 位元解密金鑰。');
    }
    return key;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', stop);
  }
}

function resourceKey(resource) {
  const url = checkedUrl(resource);
  const range = resource.byteRange;
  if (range != null && (
    !Number.isSafeInteger(range.offset) || range.offset < 0 ||
    !Number.isSafeInteger(range.length) || range.length <= 0 ||
    !Number.isSafeInteger(range.offset + range.length) || range.length > MAX_OBJECT_BYTES
  )) {
    throw new TransferError('影片的位元組範圍無效或過大。');
  }
  const encryption = encryptionKey(resource.encryption);
  if (range && resource.encryption) {
    throw new TransferError('目前不支援加密 HLS 的位元組範圍區段。');
  }
  return `${url}\n${range ? `${range.offset}:${range.length}` : 'all'}\n${encryption}`;
}

function delay(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('已取消下載。', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function validateResponse(response, range, isKey = false) {
  const label = isKey ? '解密金鑰' : '影片';
  if (response.status === 401 || response.status === 403) {
    throw new TransferError(`無法存取${label}（HTTP ${response.status}），請開啟課程並重新登入。`);
  }
  if (!response.ok) {
    throw new TransferError(`${label}請求失敗（HTTP ${response.status}）。`, response.status === 429 || response.status >= 500 && response.status <= 599);
  }
  const contentType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  // Some media CDNs mislabel binary segments as text/plain. Payload validation
  // remains mandatory, so allowing this MIME type does not allow login pages.
  if (contentType !== 'text/plain' && /^(?:text\/|application\/(?:json|[^;]+\+json|xml|[^;]+\+xml))/.test(contentType)) {
    throw new TransferError(isKey ? '解密金鑰請求回傳網頁或文字，請開啟課程並重新登入。' : '伺服器回傳的是網頁或文字，請開啟課程並重新登入。');
  }
  const lengthHeader = response.headers.get('content-length');
  if (isKey && lengthHeader && /^\d+$/.test(lengthHeader) && Number(lengthHeader) !== 16) {
    throw new TransferError('AES-128 解密金鑰必須恰為 16 位元組。');
  }
  if (lengthHeader && /^\d+$/.test(lengthHeader) && Number(lengthHeader) > MAX_OBJECT_BYTES) {
    throw new TransferError('單一影片區段超過 128 MiB 上限。');
  }
  if (range) {
    if (response.status !== 206) {
      throw new TransferError('伺服器未依指定的位元組範圍回傳影片。');
    }
    const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(response.headers.get('content-range') || '');
    const expectedEnd = range.offset + range.length - 1;
    if (!match || Number(match[1]) !== range.offset || Number(match[2]) !== expectedEnd ||
      match[3] !== '*' && (!Number.isSafeInteger(Number(match[3])) || Number(match[3]) <= expectedEnd)) {
      throw new TransferError('伺服器回傳的位元組範圍不正確。');
    }
  } else if (response.status === 206) {
    throw new TransferError(`伺服器僅回傳部分${label}，無法確認完整性。`);
  }
}

async function readBytes(response, range, signal, isKey = false) {
  if (!response.body?.getReader) throw new TransferError(isKey ? '無法讀取解密金鑰回應內容。' : '無法讀取影片回應內容。');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  let complete = false;
  try {
    while (true) {
      checkAbort(signal);
      const next = await reader.read();
      checkAbort(signal);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new TransferError('影片回應包含無效資料。');
      length += next.value.byteLength;
      if (isKey && length > 16) throw new TransferError('AES-128 解密金鑰必須恰為 16 位元組。');
      if (length > MAX_OBJECT_BYTES || range && length > range.length) {
        throw new TransferError(range ? '影片的位元組範圍長度不正確。' : '單一影片區段超過 128 MiB 上限。');
      }
      chunks.push(next.value);
    }
    complete = true;
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (isKey && length !== 16) throw new TransferError('AES-128 解密金鑰必須恰為 16 位元組。');
  if (range && length !== range.length) throw new TransferError('影片的位元組範圍長度不正確。', true);
  if (!length) throw new TransferError('伺服器回傳空白的影片內容。', true);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function validateTs(bytes) {
  let start = 0;
  // Timed ID3 metadata may precede a transport stream.
  if (bytes.length >= 10 && bytes[0] === 73 && bytes[1] === 68 && bytes[2] === 51) {
    if ([6, 7, 8, 9].some(index => bytes[index] & 128)) throw new TransferError('影片的 ID3 標頭無效。');
    start = 10 + bytes[6] * 2 ** 21 + bytes[7] * 2 ** 14 + bytes[8] * 2 ** 7 + bytes[9];
    if (bytes[5] & 16) start += 10;
  }
  if (bytes.length - start < 188 || (bytes.length - start) % 188 !== 0) {
    throw new TransferError('回應不是支援的 MPEG-TS 影片區段。');
  }
  for (let offset = start; offset < bytes.length; offset += 188) {
    if (bytes[offset] !== 0x47) throw new TransferError('MPEG-TS 影片區段的資料無效。');
  }
}

function validateMp4(bytes, initialization) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = new Set();
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) throw new TransferError('MP4 資料區塊的標頭不完整。');
    let size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    let headerLength = 8;
    if (!/^[\x20-\x7e]{4}$/.test(type)) throw new TransferError('回應不是支援的 MP4 影片。');
    if (size === 1) {
      if (bytes.length - offset < 16) throw new TransferError('MP4 資料區塊的標頭不完整。');
      size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
      headerLength = 16;
    } else if (size === 0) {
      // Size zero means through the end of the *file*, not just this segment.
      // Preserving it would consume all later fragments in the combined file.
      throw new TransferError('MP4 資料區塊未指定長度，無法安全合併影片。');
    }
    if (!Number.isSafeInteger(size) || size < headerLength || size > bytes.length - offset) {
      throw new TransferError('MP4 資料區塊無效或不完整。');
    }
    boxes.add(type);
    offset += size;
  }
  if (initialization ? !boxes.has('moov') : !boxes.has('moof') || !boxes.has('mdat')) {
    throw new TransferError(initialization ? '回應不是 MP4 初始化區段。' : '回應不是 fMP4 影片區段。');
  }
}

async function fetchObject(resource, { signal, fetchImpl, format, initialization, keyCache, resolveKey }) {
  const isKey = format === 'key';
  let key;
  if (resource.encryption) {
    if (!globalThis.crypto?.subtle) throw new TransferError('此瀏覽器不支援 HLS AES-128 解密。');
    const memorySource = resource.encryption.source === 'duotify-memory';
    const keyUrl = memorySource ? null : checkedUrl(resource.encryption);
    const cacheId = memorySource ? 'memory:duotify-memory' : `url:${keyUrl}`;
    key = keyCache.get(cacheId);
    if (!key) {
      if (memorySource) {
        key = await resolveMemoryKey(resource.encryption, resolveKey, signal);
      } else {
        const keyBytes = await fetchObject({ url: keyUrl }, { signal, fetchImpl, format: 'key' });
        try {
          key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['decrypt']);
        } catch {
          throw new TransferError('無法使用伺服器提供的 AES-128 解密金鑰。');
        } finally {
          keyBytes.fill(0);
        }
      }
      checkAbort(signal);
      keyCache.set(cacheId, key);
    }
  }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    checkAbort(signal);
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ATTEMPT_TIMEOUT_MS);
    let retry;
    try {
      const headers = {};
      if (resource.byteRange) {
        const { offset, length } = resource.byteRange;
        headers.Range = `bytes=${offset}-${offset + length - 1}`;
      }
      const response = await fetchImpl(resource.url, { credentials: 'include', signal: controller.signal, headers });
      checkAbort(signal);
      try {
        validateResponse(response, resource.byteRange, isKey);
      } catch (error) {
        await response.body?.cancel().catch(() => {});
        throw error;
      }
      let bytes = await readBytes(response, resource.byteRange, controller.signal, isKey);
      checkAbort(signal);
      if (isKey) return bytes;
      if (key) {
        if (!bytes.length || bytes.length % 16 !== 0) {
          throw new TransferError('AES-128 加密影片區段的長度無效或不完整。');
        }
        try {
          // WebCrypto validates and removes the PKCS#7 padding used by HLS.
          bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new Uint8Array(resource.encryption.iv) }, key, bytes));
        } catch {
          throw new TransferError('AES-128 影片解密失敗，金鑰、IV 或影片資料可能不正確。');
        }
        checkAbort(signal);
        checkAbort(controller.signal);
      }
      if (format === 'ts') validateTs(bytes);
      else validateMp4(bytes, initialization);
      return bytes;
    } catch (error) {
      checkAbort(signal);
      const label = isKey ? '解密金鑰' : '影片';
      retry = timedOut ? new TransferError(`${label}下載逾時。`, true) :
        error instanceof TransferError ? error : new TransferError(`網路錯誤中斷了${label}下載。`, true);
      if (!retry.retryable || attempt === MAX_ATTEMPTS - 1) throw retry;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    await delay(200 * 2 ** attempt, signal);
  }
}

/**
 * Download a finite, clear or standard AES-128 HLS playlist with bounded memory.
 * Each media object is completely fetched and validated before it is written.
 * The caller owns close()/abort() and must abort its file on any error.
 * Trusted site adapters may opt in to source:'duotify-memory' and provide
 * resolveKey(encryption, signal), returning a nonextractable AES-CBC CryptoKey.
 * Never assign that internal source directly from website playlist content.
 */
export async function transferHls({ playlist, writable, signal, onProgress, fetchImpl = fetch, resolveKey }) {
  checkAbort(signal);
  if (!playlist || playlist.type !== 'media' || playlist.endList !== true ||
    !Array.isArray(playlist.segments) || !playlist.segments.length) {
    throw new TransferError('需要已結束且包含影片區段的 HLS 清單。');
  }
  if (!['ts', 'fmp4'].includes(playlist.format)) throw new TransferError('不支援此 HLS 影片格式。');
  if (typeof writable?.write !== 'function') throw new TransferError('請先選擇可寫入的下載位置。');
  const map = playlist.map || playlist.segments[0].map || null;
  const mapKey = map ? resourceKey(map) : null;
  if (playlist.format === 'fmp4' && !map) throw new TransferError('缺少 MP4 初始化區段。');
  if (playlist.format === 'ts' && map) throw new TransferError('目前不支援另有初始化區段的 MPEG-TS 串流。');
  for (const segment of playlist.segments) {
    resourceKey(segment);
    if (segment.map && resourceKey(segment.map) !== mapKey) {
      throw new TransferError('影片的初始化區段會改變，無法安全合併。');
    }
  }
  if (typeof resolveKey !== 'function' && (map?.encryption?.source === 'duotify-memory' ||
    playlist.segments.some(segment => segment.encryption?.source === 'duotify-memory'))) {
    throw new TransferError('缺少已登入課程的記憶體播放金鑰來源。');
  }
  let bytes = 0;
  let completed = 0;
  const report = () => onProgress?.({ completed, total: playlist.segments.length, bytes });
  report();
  // CryptoKeys live only for this transfer; nothing is saved to storage or logs.
  const keyCache = new Map();
  const options = { signal, fetchImpl, format: playlist.format, initialization: false, keyCache, resolveKey };
  try {
    if (map) {
      const data = await fetchObject(map, { ...options, initialization: true });
      checkAbort(signal);
      await writable.write(data);
      bytes += data.byteLength;
      checkAbort(signal);
      report();
    }
    for (const segment of playlist.segments) {
      checkAbort(signal);
      const data = await fetchObject(segment, options);
      checkAbort(signal);
      await writable.write(data);
      bytes += data.byteLength;
      completed++;
      checkAbort(signal);
      report();
    }
    return { bytes, segments: completed };
  } finally {
    keyCache.clear();
  }
}
