/**
 * A deliberately bounded HLS VOD parser. It never fetches URLs or decrypts data.
 * Supported output is one ordered TS stream, or fMP4 fragments with one stable
 * initialization map. The caller must validate payloads and HTTP byte ranges.
 * Reference: https://datatracker.ietf.org/doc/html/rfc8216
 */
export class HlsParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HlsParseError';
    this.code = 'INVALID_HLS';
  }
}

export class UnsupportedHlsError extends Error {
  constructor(message, feature = 'unsupported') {
    super(message);
    this.name = 'UnsupportedHlsError';
    this.code = 'UNSUPPORTED_HLS';
    this.feature = feature;
  }
}

const unsupported = (message, feature) => {
  throw new UnsupportedHlsError(message, feature);
};
const invalid = (message) => { throw new HlsParseError(message); };

function integer(value, label, minimum = 0) {
  if (!/^\d+$/.test(value || '')) invalid(`${label} 必須是整數。`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum) invalid(`${label} 超出有效範圍。`);
  return result;
}

function resolveUri(value, baseUrl) {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) invalid('影片清單包含無效網址。');
  if (value.includes('{$')) unsupported('目前不支援使用變數替換的串流清單。', 'variables');
  let result;
  try { result = new URL(value, baseUrl); } catch { invalid('影片清單包含無效網址。'); }
  if (!['http:', 'https:'].includes(result.protocol) || result.username || result.password) {
    unsupported('只支援沒有內嵌帳密的 HTTP(S) 影片網址。', 'url-scheme');
  }
  if (result.hash) invalid('影片清單的資源網址不應包含片段識別碼。');
  return result.href;
}

// Commas inside quoted CODECS, NAME, or URI values must remain intact.
function attributes(value) {
  const result = Object.create(null);
  let position = 0;
  while (position < value.length) {
    const match = /^([A-Z0-9-]+)=/.exec(value.slice(position));
    if (!match) invalid('影片清單的屬性格式不正確。');
    const key = match[1];
    if (Object.hasOwn(result, key)) invalid(`影片清單重複宣告 ${key}。`);
    position += match[0].length;
    let item;
    if (value[position] === '"') {
      const end = value.indexOf('"', position + 1);
      if (end < 0) invalid('影片清單的屬性引號未結束。');
      item = value.slice(position + 1, end);
      position = end + 1;
    } else {
      const end = value.indexOf(',', position);
      item = value.slice(position, end < 0 ? value.length : end);
      if (!item || /\s/.test(item)) invalid('影片清單的屬性值不正確。');
      position = end < 0 ? value.length : end;
    }
    result[key] = item;
    if (position < value.length) {
      if (value[position] !== ',' || position === value.length - 1) invalid('影片清單的屬性分隔符號不正確。');
      position += 1;
    }
  }
  return result;
}

function range(value, previous, url, isMap = false) {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value);
  if (!match) invalid('串流的位元組範圍格式不正確。');
  const length = integer(match[1], '位元組長度', 1);
  let offset;
  if (match[2] !== undefined) offset = integer(match[2], '位元組起點');
  else {
    if (isMap) unsupported('初始化區段的位元組範圍必須明確指定起點。', 'map-byte-range');
    if (!previous?.byteRange || previous.url !== url) invalid('省略起點的位元組範圍必須接續同一資源的上一個範圍。');
    offset = previous.byteRange.offset + previous.byteRange.length;
  }
  if (!Number.isSafeInteger(offset + length)) invalid('串流的位元組範圍過大。');
  return { offset, length };
}

function parseEncryption(value, baseUrl) {
  const attr = attributes(value);
  if (!attr.METHOD) invalid('加密標記缺少 METHOD。');
  if (attr.METHOD === 'NONE') {
    if (Object.keys(attr).some((key) => key !== 'METHOD')) invalid('METHOD=NONE 不應包含其他加密屬性。');
    return null;
  }
  if (attr.METHOD !== 'AES-128') {
    unsupported(`目前不支援 ${attr.METHOD} 加密方式。`, 'encryption-method');
  }
  if (attr.KEYFORMAT !== undefined && attr.KEYFORMAT !== 'identity') {
    unsupported('目前僅支援 HLS AES-128 identity 金鑰格式；不支援此金鑰格式或 DRM。', 'key-format');
  }
  if (attr.KEYFORMATVERSIONS !== undefined) {
    if (!/^[1-9]\d*(?:\/[1-9]\d*)*$/.test(attr.KEYFORMATVERSIONS)) invalid('金鑰格式版本不正確。');
    if (!attr.KEYFORMATVERSIONS.split('/').includes('1')) {
      unsupported('目前不支援此 HLS 金鑰格式版本。', 'key-format-version');
    }
  }
  if (!attr.URI) invalid('AES-128 加密標記缺少金鑰 URI。');
  let iv = null;
  if (attr.IV !== undefined) {
    if (!/^0[xX][0-9a-fA-F]{1,32}$/.test(attr.IV)) invalid('AES-128 IV 必須是最多 128 位元的十六進位數字。');
    const hex = attr.IV.slice(2).padStart(32, '0');
    iv = Array.from({ length: 16 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
  }
  return { method: 'AES-128', url: resolveUri(attr.URI, baseUrl), iv };
}

// Only declarative metadata leaves the parser; key bytes are never fetched here.
function encryptionSnapshot(key, sequence = null) {
  if (!key) return null;
  if (key.iv) return { ...key, iv: [...key.iv] };
  if (sequence === null) invalid('AES-128 加密的初始化區段必須明確指定 IV。');
  let remaining = sequence;
  const iv = new Array(16).fill(0);
  for (let index = iv.length - 1; index >= 0; index -= 1) {
    iv[index] = Number(remaining & 255n);
    remaining >>= 8n;
  }
  return { ...key, iv };
}

const metadataTags = new Set([
  'EXT-X-INDEPENDENT-SEGMENTS', 'EXT-X-START', 'EXT-X-PROGRAM-DATE-TIME',
  'EXT-X-DATERANGE', 'EXT-X-ALLOW-CACHE', 'EXT-X-SESSION-DATA',
]);

/**
 * @returns {{type:'master',variants:Array}|{type:'media',segments:Array,map:object|null,
 * duration:number,format:'ts'|'fmp4',endList:true,mediaSequence:number,targetDuration:number|null}}
 */
export function parseHls(text, baseUrl) {
  if (typeof text !== 'string') invalid('影片清單必須是文字。');
  const base = resolveUri(String(baseUrl || ''), undefined);
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.shift() !== '#EXTM3U') invalid('回應不是 HLS 清單，可能需要重新登入或連結已失效。');
  if (lines.length > 200000) unsupported('此串流清單太大。', 'playlist-size');

  const variants = [];
  const renditions = [];
  const segments = [];
  let pendingVariant = null;
  let pendingDuration = null;
  let pendingRange = null;
  let stableMap = null;
  let activeEncryption = null;
  let endList = false;
  let mediaSequence = 0;
  let targetDuration = null;
  let mediaTagSeen = false;
  let iframeVariantSeen = false;
  const singletonTags = new Set();

  for (const line of lines) {
    if (!line.startsWith('#')) {
      const url = resolveUri(line, base);
      if (pendingVariant) {
        variants.push({ ...pendingVariant, url });
        pendingVariant = null;
      } else {
        if (pendingDuration === null) invalid('影片區段缺少 EXTINF 時長。');
        segments.push({
          url,
          duration: pendingDuration,
          byteRange: pendingRange === null ? null : range(pendingRange, segments.at(-1), url),
          map: stableMap,
          encryption: encryptionSnapshot(activeEncryption, BigInt(mediaSequence) + BigInt(segments.length)),
        });
        pendingDuration = null;
        pendingRange = null;
      }
      continue;
    }
    if (!line.startsWith('#EXT')) {
      // Some players recognize an embedded key tag even inside a comment.
      // Fail closed on ambiguous syntax instead of labeling ciphertext clear.
      if (/#EXT-X-(?:SESSION-)?KEY:/.test(line)) {
        unsupported('影片清單的註解含有非標準加密標記，無法安全判定加密方式。', 'embedded-key');
      }
      continue;
    }
    const colon = line.indexOf(':');
    const tag = line.slice(1, colon < 0 ? undefined : colon);
    const value = colon < 0 ? '' : line.slice(colon + 1);
    if (tag === 'EXTM3U') invalid('HLS 清單包含重複的開頭。');
    if (['EXT-X-ENDLIST', 'EXT-X-VERSION', 'EXT-X-MEDIA-SEQUENCE', 'EXT-X-TARGETDURATION', 'EXT-X-PLAYLIST-TYPE', 'EXT-X-DISCONTINUITY-SEQUENCE'].includes(tag)) {
      if (singletonTags.has(tag)) invalid(`影片清單重複宣告 ${tag}。`);
      singletonTags.add(tag);
    }
    switch (tag) {
      case 'EXT-X-STREAM-INF': {
        if (pendingVariant) invalid('畫質清單缺少網址。');
        const attr = attributes(value);
        const resolution = attr.RESOLUTION?.match(/^(\d+)x(\d+)$/);
        if (attr.RESOLUTION && !resolution) invalid('畫質解析度格式不正確。');
        pendingVariant = {
          bandwidth: integer(attr.BANDWIDTH, '畫質頻寬', 1),
          averageBandwidth: attr['AVERAGE-BANDWIDTH'] ? integer(attr['AVERAGE-BANDWIDTH'], '平均頻寬', 1) : null,
          width: resolution ? integer(resolution[1], '影片寬度', 1) : null,
          height: resolution ? integer(resolution[2], '影片高度', 1) : null,
          codecs: attr.CODECS || '', name: attr.NAME || '',
          audioGroup: attr.AUDIO || null, subtitleGroup: attr.SUBTITLES || null,
          videoGroup: attr.VIDEO || null,
        };
        break;
      }
      case 'EXT-X-MEDIA': renditions.push(attributes(value)); break;
      case 'EXT-X-I-FRAME-STREAM-INF': iframeVariantSeen = true; break;
      case 'EXTINF': {
        mediaTagSeen = true;
        if (pendingDuration !== null) invalid('影片區段的時長後缺少網址。');
        const durationText = value.split(',')[0];
        if (!/^\d+(?:\.\d+)?$/.test(durationText)) invalid('影片區段時長格式不正確。');
        pendingDuration = Number(durationText);
        if (!Number.isFinite(pendingDuration) || pendingDuration <= 0) invalid('影片區段時長必須大於零。');
        break;
      }
      case 'EXT-X-BYTERANGE':
        mediaTagSeen = true;
        if (pendingRange !== null) invalid('影片區段重複宣告位元組範圍。');
        pendingRange = value;
        break;
      case 'EXT-X-MAP': {
        mediaTagSeen = true;
        const attr = attributes(value);
        const url = resolveUri(attr.URI, base);
        const nextMap = {
          url,
          byteRange: attr.BYTERANGE ? range(attr.BYTERANGE, null, url, true) : null,
          encryption: encryptionSnapshot(activeEncryption),
        };
        if ((segments.length && !stableMap) || (stableMap && JSON.stringify(stableMap) !== JSON.stringify(nextMap))) {
          unsupported('影片的初始化區段會改變，目前無法安全合併成單一檔案。', 'changing-map');
        }
        stableMap = nextMap;
        break;
      }
      case 'EXT-X-KEY':
        mediaTagSeen = true;
        activeEncryption = parseEncryption(value, base);
        break;
      case 'EXT-X-SESSION-KEY': {
        unsupported('目前不支援主清單的 EXT-X-SESSION-KEY 加密宣告。', 'session-key');
        break;
      }
      case 'EXT-X-ENDLIST':
        if (value) invalid('EXT-X-ENDLIST 格式不正確。');
        mediaTagSeen = true; endList = true; break;
      case 'EXT-X-TARGETDURATION':
        mediaTagSeen = true; targetDuration = integer(value, '目標時長', 1); break;
      case 'EXT-X-MEDIA-SEQUENCE':
        mediaTagSeen = true;
        if (segments.length) invalid('MEDIA-SEQUENCE 必須位於第一個影片區段之前。');
        mediaSequence = integer(value, '區段序號'); break;
      case 'EXT-X-DISCONTINUITY-SEQUENCE':
        mediaTagSeen = true;
        if (segments.length) invalid('DISCONTINUITY-SEQUENCE 必須位於影片區段之前。');
        integer(value, '不連續序號'); break;
      case 'EXT-X-PLAYLIST-TYPE':
        mediaTagSeen = true;
        if (!['VOD', 'EVENT'].includes(value)) invalid('PLAYLIST-TYPE 格式不正確。');
        break;
      case 'EXT-X-VERSION': integer(value, 'HLS 版本', 1); break;
      case 'EXT-X-DISCONTINUITY': unsupported('影片包含時間軸或編碼切換，目前無法安全合併成單一檔案。', 'discontinuity'); break;
      case 'EXT-X-I-FRAMES-ONLY': unsupported('此清單只有預覽關鍵影格，不是完整影片。', 'iframes'); break;
      case 'EXT-X-GAP': unsupported('影片清單包含缺少的區段。', 'gap'); break;
      case 'EXT-X-PART':
      case 'EXT-X-PART-INF':
      case 'EXT-X-PRELOAD-HINT':
      case 'EXT-X-SERVER-CONTROL':
      case 'EXT-X-RENDITION-REPORT':
      case 'EXT-X-SKIP': unsupported('目前不支援低延遲或增量更新的串流清單。', 'low-latency'); break;
      case 'EXT-X-DEFINE': unsupported('目前不支援使用變數替換的串流清單。', 'variables'); break;
      default:
        if (!metadataTags.has(tag)) unsupported(`目前不支援清單功能 ${tag}。`, 'unknown-tag');
    }
  }
  if (pendingVariant) invalid('畫質清單缺少網址。');
  if (pendingDuration !== null || pendingRange !== null) invalid('影片清單在區段網址之前中斷。');
  if (variants.length) {
    if (mediaTagSeen || segments.length) invalid('清單混合了畫質選項與影片區段。');
    for (const variant of variants) {
      for (const [key, type] of [['audioGroup', 'AUDIO'], ['subtitleGroup', 'SUBTITLES'], ['videoGroup', 'VIDEO']]) {
        if (!variant[key]) continue;
        const group = renditions.filter((entry) => entry.TYPE === type && entry['GROUP-ID'] === variant[key]);
        if (!group.length || group.some((entry) => entry.URI) || type === 'SUBTITLES') {
          unsupported('此畫質使用分開的音軌、字幕或視訊軌，目前不支援合併下載。', 'separate-renditions');
        }
      }
    }
    return { type: 'master', variants };
  }
  if (iframeVariantSeen || renditions.length) unsupported('此清單沒有可直接合併的完整影片畫質。', 'separate-renditions');
  if (!endList) unsupported('此清單尚未結束，可能是直播或仍在更新，無法確認完整影片。', 'live');
  if (!segments.length) invalid('影片清單沒有任何影片區段。');
  let explicitFormat = null;
  for (const segment of segments) {
    const path = new URL(segment.url).pathname.toLowerCase();
    if (/\.(aac|ac3|ec3|mp3|vtt|webvtt|webm|ogg|oga)$/.test(path)) {
      unsupported('此清單不是支援的 TS 或 fMP4 影片串流。', 'container');
    }
    const format = /\.(ts|m2ts)$/.test(path) ? 'ts' : /\.(m4s|mp4|m4f|cmfv|cmfa)$/.test(path) ? 'fmp4' : null;
    if (explicitFormat && format && explicitFormat !== format) unsupported('影片清單混合了不同容器格式。', 'container');
    explicitFormat ||= format;
  }
  if (explicitFormat === 'fmp4' && !stableMap) unsupported('fMP4 影片缺少初始化區段，無法安全合併。', 'missing-map');
  if (explicitFormat === 'ts' && stableMap) unsupported('目前不支援另有初始化區段的 TS 串流。', 'container');
  const duration = segments.reduce((total, segment) => total + segment.duration, 0);
  if (!Number.isFinite(duration)) invalid('影片總時長超出有效範圍。');
  return {
    type: 'media', segments, map: stableMap, duration,
    format: stableMap ? 'fmp4' : 'ts', endList: true, mediaSequence, targetDuration,
  };
}
