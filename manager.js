import { parseHls } from './hls.js';
import { transferHls } from './transfer.js';
import { readDuotifyPlaybackContext } from './duotify.js';
import { duotifyExpected, validateDuotifyContext } from './duotify-binding.js';
import { httpUrl, originPattern, safeName, formatBytes, mediaKind, uniqueFile } from './util.js';

const $ = (id) => document.getElementById(id);
const api = globalThis.chrome;
let scan, folder, busy = false, downloading = false, controller;
let items = [], missingOrigins = new Set(), selection = new Map(), preferredVariants = new Map();
const directIds = new Map();
const isExtension = !!api?.runtime?.id;

class PermissionNeeded extends Error {
  constructor(url) { super('需要授權媒體來源，請按下方的「允許列出的來源並繼續」。'); this.origin = originPattern(url); }
}

function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
function text(tag, value, className) { const e = document.createElement(tag); e.textContent = value; if (className) e.className = className; return e; }
function readableError(error) {
  if (error.name === 'AbortError') return '已取消。未完成的影片不會標示為成功；重新下載會從頭開始。';
  if (error instanceof PermissionNeeded) return error.message;
  // Never display signed media URLs, server bodies or arbitrary stack traces.
  return String(error.message || '操作失敗，請重新開啟課程後再試。').replace(/https?:\/\/[^\s<>"']+/g, '[媒體來源]').slice(0, 450);
}

async function requireHost(url) {
  if (!await api.permissions.contains({ origins: [originPattern(url)] })) throw new PermissionNeeded(url);
}

async function fetchText(url, kind = 'manifest', outerSignal) {
  url = httpUrl(url);
  await requireHost(url);
  let response;
  const request = new AbortController();
  const cancel = () => request.abort();
  outerSignal?.addEventListener('abort', cancel, {once:true});
  if (outerSignal?.aborted) request.abort();
  const timer = setTimeout(() => request.abort(), 45000);
  try {
  try { response = await fetch(url, { credentials: 'include', signal: request.signal }); }
  catch { if (outerSignal?.aborted) throw new DOMException('Aborted', 'AbortError'); throw new Error('無法連線到媒體來源。請確認登入、網路及網站權限。'); }
  if ([401, 403].includes(response.status)) throw new Error(`伺服器拒絕存取（HTTP ${response.status}）。請在原課程重新登入並確認影片仍能播放。`);
  if (!response.ok) throw new Error(`來源回傳 HTTP ${response.status}，請稍後重試。`);
  const cap = kind === 'lesson' ? 8 * 1024 * 1024 : 16 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > cap) { await response.body?.cancel(); throw new Error('清單或字幕檔案超過安全大小限制。'); }
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > cap) throw new Error('清單或字幕檔案過大，已停止讀取。');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const result = new Uint8Array(bytes); let offset = 0;
  for (const c of chunks) { result.set(c, offset); offset += c.length; }
  return { text: new TextDecoder().decode(result), url: response.url || url };
  } catch (error) {
    if (request.signal.aborted && !outerSignal?.aborted) throw new Error('讀取清單或字幕逾時，請稍後重試。');
    throw error;
  } finally { clearTimeout(timer); outerSignal?.removeEventListener('abort', cancel); }
}

function renderLessons() {
  $('lessons').replaceChildren();
  const lessons = scan.lessons?.length ? scan.lessons : [{ url: scan.pageUrl, title: scan.title }];
  for (const lesson of lessons) {
    const label = text('label', '', 'lesson'); const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.checked = true;
    selection.set(lesson.url, { ...lesson, selected: true });
    checkbox.addEventListener('change', () => { selection.get(lesson.url).selected = checkbox.checked; });
    const copy = text('span', lesson.title || '目前影片');
    copy.append(text('small', new URL(lesson.url).pathname));
    label.append(checkbox, copy); $('lessons').append(label);
  }
}

function equivalentLesson(a, b) {
  const aa = new URL(a), bb = new URL(b); aa.hash = ''; bb.hash = ''; return aa.href === bb.href;
}

async function lessonMedia(lesson) {
  if (equivalentLesson(lesson.url, scan.pageUrl)) return scan.media;
  // Only request lesson links actually discovered in the selected course's DOM.
  if (!scan.lessons.some(l => l.url === lesson.url)) throw new Error('找不到這個課程目錄項目，請重新掃描。');
  const {text: html, url: base} = await fetchText(lesson.url, 'lesson');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const found = new Map();
  function add(raw, mime, source) {
    if (!raw || raw.startsWith('blob:')) return;
    try { const url = httpUrl(raw, base), kind = mediaKind(url, mime); if (kind) found.set(url, { url, kind, source }); } catch { /* unsupported source */ }
  }
  for (const e of doc.querySelectorAll('video,audio,source,track')) {
    for (const attr of ['src', 'data-src']) add(e.getAttribute(attr), e.getAttribute('type'), attr);
    add(e.getAttribute('data-subtitle-src'), 'text/vtt', '字幕');
  }
  for (const e of doc.querySelectorAll('a[href]')) add(e.getAttribute('href'), e.getAttribute('type'), '連結');
  if (!found.size) throw new Error('這個章節未回傳影片。請先在網站開啟該章節確認可播放，再按擴充功能圖示。');
  return [...found.values()];
}

function addItem(data) {
  const item = { ...data, selected: true, ready: false, status: '分析中…', progress: 0, requiredOrigins: new Set() };
  const box = text('div', '', 'item');
  const top = text('div', '', 'item-top');
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = true; checkbox.disabled = busy;
  checkbox.setAttribute('aria-label', `選擇 ${item.title}`);
  checkbox.addEventListener('change', async () => { item.selected = checkbox.checked; await updatePermissionBox(); updateControls(); });
  const content = text('div', '', 'item-content');
  const heading = text('div', '', 'item-title'); heading.append(text('span', (item.kind || '章節').toUpperCase(), 'pill'), text('span', item.title));
  let host = ''; try { host = new URL(item.url).hostname; } catch { /* empty */ }
  const meta = text('div', host, 'item-meta'), options = text('div', ''), status = text('div', item.status, 'item-state');
  const progress = document.createElement('progress'); progress.max = 1; progress.value = 0; progress.hidden = true;
  content.append(heading, meta, options, status, progress); top.append(checkbox, content); box.append(top); $('items').append(box);
  item.ui = { box, checkbox, meta, options, status, progress }; items.push(item); return item;
}

function setStatus(item, message, state = '') {
  item.status = message; item.ui.status.textContent = message;
  item.ui.status.className = `item-state ${state === 'error' ? 'error-text' : state === 'done' ? 'success-text' : ''}`;
}

async function loadManifest(url) {
  const response = await fetchText(url);
  return { ...parseHls(response.text, response.url), sourceUrl: response.url };
}

async function prepareItem(item) {
  item.requiredOrigins.clear();
  item.duotify = false;
  if (item.kind === 'dash') throw new Error('目前不支援 DASH（.mpd），此項目無法下載。');
  if (item.kind === 'subtitle') {
    item.requiredOrigins.add(originPattern(item.url));
    await requireHost(item.url); item.ready = true; setStatus(item, '字幕可供下載'); return;
  }
  if (item.kind === 'file') { item.ready = true; setStatus(item, '由 Chrome 下載管理員儲存直接影片'); return; }
  item.requiredOrigins.add(originPattern(item.url));
  let playlist = await loadManifest(item.url);
  if (playlist.type === 'master') {
    const variants = [...playlist.variants].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    const selectedUrl = preferredVariants.get(item.url) || variants[0]?.url;
    const selected = variants.find(v => v.url === selectedUrl) || variants[0];
    if (!selected) throw new Error('HLS 清單沒有可選擇的畫質。');
    const select = document.createElement('select'); select.disabled = busy; select.setAttribute('aria-label', `${item.title} 畫質`);
    for (const v of variants) {
      const option = text('option', `${v.height ? `${v.width} × ${v.height}` : v.name || '畫質'}${v.bandwidth ? ` · ${(v.bandwidth / 1000000).toFixed(2)} Mbps` : ''}`);
      option.value = v.url; option.selected = v.url === selected.url; select.append(option);
    }
    select.addEventListener('change', async () => {
      if (busy) return;
      busy = true;
      preferredVariants.set(item.url, select.value); item.ready = false; item.completed = false; item.ui.progress.hidden = true;
      setStatus(item, '正在分析所選畫質…'); updateControls();
      try { await prepareItem(item); } catch (error) { collectError(item, error); }
      finally { await updatePermissionBox(); busy = false; updateControls(); }
    });
    item.ui.options.replaceChildren(select);
    item.requiredOrigins.add(originPattern(selected.url));
    playlist = await loadManifest(selected.url);
    for (let depth = 0; playlist.type === 'master' && depth < 3; depth++) {
      const next = [...playlist.variants].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
      if (!next) throw new Error('HLS 清單沒有可用的影片。');
      item.requiredOrigins.add(originPattern(next.url));
      playlist = await loadManifest(next.url);
    }
  }
  if (playlist.type !== 'media') throw new Error('HLS 主清單巢狀層數過多。');
  const sourceUrl = new URL(item.url);
  item.duotify = sourceUrl.origin === 'https://learn.duotify.com' && /^\/api\/video\/watch\/?$/.test(sourceUrl.pathname)
    && sourceUrl.searchParams.get('type') === 'm3u8' && playlist.format === 'ts'
    && !playlist.segments.some(segment => segment.encryption);
  item.playlist = playlist;
  if (item.duotify) { duotifyExpected(scan, item); $('duotify-note').hidden = false; }
  const origins = new Set(playlist.segments.map(segment => originPattern(segment.url)));
  if (playlist.map) origins.add(originPattern(playlist.map.url));
  for (const resource of [...playlist.segments, ...(playlist.map ? [playlist.map] : [])]) {
    if (resource.encryption?.url) origins.add(originPattern(resource.encryption.url));
  }
  for (const origin of origins) item.requiredOrigins.add(origin);
  item.ready = true;
  const minutes = Math.floor(playlist.duration / 60);
  item.ui.meta.textContent = `${new URL(item.url).hostname} · ${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分 · ${playlist.segments.length} 個分段 · ${playlist.format === 'ts' ? '.ts' : '.mp4'}`;
  setStatus(item, item.duotify ? '已解析多奇課程清單；下載時使用原課程頁的播放解密資訊，並驗證解密後的影片。' : playlist.segments.some(segment => segment.encryption) ? '已解析 AES-128 清單；下載時會在本機解密並驗證影片。' : '已解析完整清單；下載時會驗證實際分段格式。');
}

function collectError(item, error) {
  item.ready = false;
  if (error instanceof PermissionNeeded) item.requiredOrigins.add(error.origin);
  setStatus(item, readableError(error), error instanceof PermissionNeeded ? '' : 'error');
}

async function updatePermissionBox() {
  const required = [];
  const requested = new Set(items.filter(item => item.selected).flatMap(item => [...item.requiredOrigins]));
  for (const origin of requested) if (!await api.permissions.contains({ origins: [origin] })) required.push(origin);
  missingOrigins = new Set(required);
  $('permissions').hidden = required.length === 0;
  $('origins').replaceChildren(...required.map(origin => text('li', origin)));
}

function updateControls() {
  $('download').disabled = busy || missingOrigins.size > 0 || !items.some(i => i.ready && i.selected && !i.completed && !i.downloadId);
  $('analyze').disabled = busy; $('rescan').disabled = busy; $('folder').disabled = busy; $('grant').disabled = busy;
  $('cancel').disabled = !downloading && ![...directIds.values()].some(item => item.downloadId && !item.completed);
  for (const e of document.querySelectorAll('input[type=checkbox],select')) e.disabled = busy;
}

async function analyze() {
  if (busy) return;
  const chosen = [...selection.values()].filter(i => i.selected);
  if (!chosen.length) { notice('請先勾選至少一個章節。', true); return; }
  busy = true; items = []; missingOrigins.clear(); $('items').replaceChildren(); $('duotify-note').hidden = true; updateControls();
  notice('正在讀取所選章節的影片清單。');
  let number = 0;
  try {
    for (const lesson of chosen) {
      number++; $('analysis-progress').textContent = `正在分析 ${number} / ${chosen.length}：${lesson.title}`;
      let media;
      try { media = await lessonMedia(lesson); }
      catch (error) { collectError(addItem({ title: lesson.title, kind: 'chapter', url: lesson.url }), error); continue; }
      if (!media?.length) {
        const item = addItem({title:lesson.title,kind:'chapter',url:lesson.url});
        setStatus(item, scan.hasBlob ? '只找到 blob 播放器，未取得清單。請先播放影片並重新掃描。若在跨網域內嵌播放器，請開啟該播放器頁再掃描。' : '尚未找到影片；請先開啟章節並播放，再重新掃描。', 'error'); continue;
      }
      for (const candidate of media) {
        const item = addItem({ ...candidate, lessonUrl: lesson.url, title: `${String(number).padStart(2, '0')} ${lesson.title}${candidate.kind === 'subtitle' ? '（字幕）' : ''}` });
        try { await prepareItem(item); } catch (error) { collectError(item, error); }
      }
    }
    await updatePermissionBox();
    const ready = items.filter(i => i.ready).length;
    $('count').textContent = `${ready} / ${items.length} 項已解析`;
    notice(missingOrigins.size ? '需要授權清單列出的媒體來源，才能繼續。' : ready ? '分析完成。選擇儲存資料夾後，即可開始下載。' : '尚無可下載項目，請查看每個項目的原因。', !ready && !missingOrigins.size);
  } finally { busy = false; $('analysis-progress').textContent = ''; updateControls(); }
}

async function saveSubtitle(item) {
  const response = await fetchText(item.url, 'subtitle', controller.signal);
  if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const body = response.text.replace(/^\uFEFF/, '');
  if (!/^WEBVTT(?:\s|$)/.test(body) && !/^\s*\d+\s*\r?\n\d\d:\d\d:\d\d[,.]\d{3}\s*-->/.test(body)) throw new Error('字幕來源不是有效的 VTT / SRT，可能登入已失效。');
  const ext = body.startsWith('WEBVTT') ? '.vtt' : '.srt';
  const file = await uniqueFile(folder, safeName(item.title) + ext), writable = await file.handle.createWritable();
  try { await writable.write(body); await writable.close(); } catch (error) { await writable.abort().catch(() => {}); throw error; }
  return file.name;
}

async function duotifyTransferContext(item) {
  if (!Number.isInteger(scan.tabId)) throw new Error('找不到原課程分頁。請回到已登入且可播放的課程頁，再按擴充功能圖示。');
  const expected = duotifyExpected(scan, item);
  let results;
  try { results = await api.scripting.executeScript({ target: { tabId: scan.tabId }, func: readDuotifyPlaybackContext, args: [expected] }); }
  catch { throw new Error('無法取得原課程頁的播放資訊。請保留該分頁，確認影片能播放後重試。'); }
  const context = results?.[0]?.result;
  let rawKey;
  try {
    if (!context || context.error) throw new Error(context?.error || '未取得多奇播放器解密資訊。');
    validateDuotifyContext(context, expected);
    if (!Array.isArray(context.keyBytes) || context.keyBytes.length !== 16 || context.keyBytes.some(n => !Number.isInteger(n) || n < 0 || n > 255)
      || !Array.isArray(context.ivBytes) || context.ivBytes.length !== 16 || context.ivBytes.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error('播放解密資訊格式不正確，請重新整理課程頁並確認能播放。');
    rawKey = new Uint8Array(context.keyBytes);
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-CBC', false, ['decrypt']);
    const iv = [...context.ivBytes];
    return { key, playlist: { ...item.playlist, segments: item.playlist.segments.map(segment => ({ ...segment,
      encryption: { method: 'AES-128', source: 'duotify-memory', iv: [...iv] }
    })) } };
  } finally {
    rawKey?.fill(0);
    if (Array.isArray(context?.keyBytes)) context.keyBytes.fill(0);
  }
}

async function saveHls(item) {
  let playback = null, writable;
  try {
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    playback = item.duotify ? await duotifyTransferContext(item) : null;
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const file = await uniqueFile(folder, safeName(item.title) + (item.playlist.format === 'ts' ? '.ts' : '.mp4'));
    writable = await file.handle.createWritable();
    item.ui.progress.hidden = false;
    const result = await transferHls({ playlist: playback?.playlist || item.playlist, writable, signal: controller.signal,
      resolveKey: playback ? async () => playback.key : undefined,
      onProgress: ({completed,total,bytes}) => {
      item.ui.progress.value = completed / total;
      setStatus(item, `${completed} / ${total} 分段 · 已寫入 ${formatBytes(bytes)}\n請保持此分頁開啟。`);
    }});
    await writable.close();
    return `${file.name} · ${formatBytes(result.bytes)}`;
  } catch (error) {
    await writable?.abort().catch(() => {});
    throw error;
  } finally { playback = null; }
}

async function startDirect(item) {
  const url = new URL(item.url);
  const suffix = url.pathname.match(/\.(mp4|webm|mov|m4v|mp3|m4a|ogg)$/i)?.[0] || '';
  const id = await api.downloads.download({ url: httpUrl(item.url), filename: safeName(item.title) + suffix, conflictAction: 'uniquify', saveAs: false });
  item.downloadId = id; directIds.set(id, item); setStatus(item, '已交給 Chrome 下載管理員，等待下載完成…');
  await refreshDirect(id);
}

async function refreshDirect(id) {
  const item = directIds.get(id); if (!item) return;
  const [download] = await api.downloads.search({id}); if (!download) return;
  if (download.state === 'complete') {
    if (download.fileSize <= 0 || /^(text\/|application\/(json|.*\+json|xml|.*\+xml))/i.test(download.mime || '')) {
      item.downloadId = null; setStatus(item, 'Chrome 收到的檔案不是有效影片，可能是登入頁或空檔。請檢查下載內容並重新登入。', 'error');
    } else { item.completed = true; setStatus(item, `Chrome 下載完成 · ${formatBytes(download.fileSize)}`, 'done'); }
  }
  else if (download.state === 'interrupted') { item.downloadId = null; setStatus(item, `Chrome 下載中斷：${download.error || '未知原因'}。可在 Chrome 下載頁重試。`, 'error'); }
  else setStatus(item, `${download.paused ? 'Chrome 已暫停' : 'Chrome 下載中'} · ${formatBytes(download.bytesReceived)} / ${formatBytes(download.totalBytes)}`);
  updateControls();
}

async function downloadSelected() {
  const chosen = items.filter(i => i.selected && i.ready && !i.completed && !i.downloadId);
  if (!chosen.length) return;
  if (chosen.some(i => i.kind !== 'file') && !folder) { notice('請先按「選擇儲存資料夾」，再開始下載。', true); return; }
  busy = true; downloading = true; controller = new AbortController(); $('cancel').disabled = false; updateControls();
  let finished = 0, failed = 0;
  for (const item of chosen) {
    if (controller.signal.aborted) break;
    setStatus(item, '正在開始下載…');
    try {
      if (item.kind === 'file') { await startDirect(item); }
      else {
        const name = item.kind === 'subtitle' ? await saveSubtitle(item) : await saveHls(item);
        item.completed = true; finished++; setStatus(item, `儲存完成：${name}`, 'done');
      }
    } catch (error) {
      failed++;
      const customPlayer = item.duotify && /MPEG-TS/.test(error.message || '');
      setStatus(item, customPlayer ? '解密後的影片格式仍不正確，可能網站已更換播放器或解密資訊。請重新整理原課程頁並確認能播放，再重試；未完成的檔案不會標示成功。' : readableError(error), 'error');
    }
    $('overall').textContent = `${finished} 項已儲存 · ${failed} 項未完成`;
  }
  const canceled = controller.signal.aborted;
  busy = false; downloading = false; updateControls();
  notice(canceled ? '已取消本次下載。完成的檔案仍保留；未完成項目可重新下載。' : `本次處理結束：${finished} 項已儲存、${failed} 項未完成。直接影片請以 Chrome 下載管理員狀態為準。`, failed > 0);
}

$('analyze').addEventListener('click', () => analyze().catch(error => notice(readableError(error), true)));
$('grant').addEventListener('click', async () => {
  try {
    const granted = await api.permissions.request({ origins: [...missingOrigins] });
    if (granted) await analyze(); else notice('未授權媒體來源。你可以保留目前權限，或稍後再授權。');
  } catch (error) { notice(readableError(error), true); }
});
$('folder').addEventListener('click', async () => {
  try { folder = await window.showDirectoryPicker({mode:'readwrite',id:'course-backup'}); $('folder-name').textContent = folder.name; }
  catch (error) { if (error.name !== 'AbortError') notice('無法選擇資料夾。請使用 Chrome，並選擇一般的自訂資料夾。', true); }
});
$('download').addEventListener('click', () => downloadSelected().catch(error => { busy = false; downloading = false; updateControls(); notice(readableError(error), true); }));
$('cancel').addEventListener('click', async () => {
  controller?.abort(); $('cancel').disabled = true;
  for (const [id, item] of directIds) {
    if (item.downloadId && !item.completed) await api.downloads.cancel(id).catch(() => {});
  }
});
$('rescan').addEventListener('click', async () => {
  if (scan?.tabId) {
    try { await api.tabs.update(scan.tabId, {active:true}); } catch { /* Closed lesson tab. */ }
  }
  notice('請回到課程頁，播放影片後再按擴充功能圖示。每次按圖示會開啟最新掃描結果。');
});
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });

async function init() {
  if (!isExtension) { notice('這是介面預覽。請在 Chrome 載入擴充功能，再從課程頁按圖示開始。'); $('page-title').textContent = '課程備份助手'; for (const button of document.querySelectorAll('button')) button.disabled = true; return; }
  const key = new URL(location.href).searchParams.get('scan');
  if (!key || !/^scan-[0-9a-f-]+$/.test(key)) throw new Error('請從課程頁按擴充功能圖示，建立新的掃描結果。');
  scan = (await api.storage.session.get(key))[key];
  if (!scan) throw new Error('這份掃描結果已過期。請回到課程頁再按一次擴充功能圖示。');
  if (scan.error) throw new Error(scan.error);
  $('page-title').textContent = scan.title;
  renderLessons();
  notice(`找到 ${scan.lessons?.length || 1} 個章節項目。勾選內容後，按「分析已選內容」。`);
  api.downloads.onChanged.addListener(delta => { if (directIds.has(delta.id)) refreshDirect(delta.id).catch(() => {}); });
}
init().catch(error => { notice(readableError(error), true); $('page-title').textContent = '請重新掃描課程'; $('analyze').disabled = true; });
