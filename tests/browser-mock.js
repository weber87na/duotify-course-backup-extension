/* Local integration harness only. The production manifest never loads this file. */
(() => {
  'use strict';
  const origin = location.origin;
  const firstLesson = `${origin}/video/watch?slug=local-fixture&sectionId=289`;
  const secondLesson = `${origin}/video/watch?slug=local-fixture&sectionId=290`;
  const scan = {
    pageUrl: firstLesson,
    title: '本機整合測試：兩個章節與字幕',
    tabId: 123,
    createdAt: Date.now(),
    hasBlob: true,
    iframeOrigins: [],
    lessons: [
      { url: firstLesson, title: '第一章：畫質與字幕' },
      { url: secondLesson, title: '第二章：批次章節讀取' },
    ],
    media: [
      { url: `${origin}/fixtures/first.m3u8`, kind: 'hls', source: 'video.data-src' },
      { url: `${origin}/fixtures/first.vtt`, kind: 'subtitle', source: 'video.data-subtitle-src' },
    ],
  };
  const grants = new Set();
  const downloads = new Map();
  const downloadListeners = new Set();
  const entries = new Map();
  const state = { permissionRequests: [], requests: [], directorySelected: false, errors: [] };
  window.__testFiles = [];
  window.__testState = state;

  function render() {
    const node = document.getElementById('test-results');
    if (!node) return;
    node.textContent = JSON.stringify({
      mode: 'LOCAL MOCK — no files are written to disk',
      directorySelected: state.directorySelected,
      permissionRequests: state.permissionRequests,
      grantedOrigins: [...grants],
      files: window.__testFiles.map(({ name, bytes, state: status }) => ({ name, bytes, state: status })),
      requests: state.requests,
      errors: state.errors,
      expected: { savedFiles: 3, firstHighTsBytes: 752, firstLowTsBytes: 376, secondTsBytes: 1128 },
    }, null, 2);
  }

  function setupPanel() {
    const panel = document.createElement('section');
    panel.className = 'panel';
    const title = document.createElement('h2');
    title.textContent = '本機整合測試結果';
    const explanation = document.createElement('p');
    explanation.textContent = '這個測試僅連線到 localhost。第一章高畫質使用合成 AES-128 加密片段，解密後應為 752 bytes；低畫質與第二章維持未加密。授權與資料夾選擇均為模擬；輸出保存在記憶體。';
    const result = document.createElement('pre');
    result.id = 'test-results';
    result.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.5';
    panel.append(title, explanation, result);
    document.querySelector('main').append(panel);
    render();
  }
  document.addEventListener('DOMContentLoaded', setupPanel, { once: true });
  window.addEventListener('error', event => { state.errors.push(event.message); render(); });
  window.addEventListener('unhandledrejection', event => { state.errors.push(String(event.reason?.message || event.reason)); render(); });

  // Prevent this harness from accidentally contacting the real course or CDN.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, options) => {
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, origin);
    if (target.origin !== origin) throw new Error('The local test harness blocks external network requests.');
    state.requests.push(target.pathname);
    render();
    return nativeFetch(input, options);
  };

  const mockChrome = {
    runtime: { id: 'course-backup-local-test', getURL: path => new URL(path, `${origin}/`).href },
    storage: {
      session: {
        async get(key) { return key === 'scan-deadbeef' ? { [key]: structuredClone(scan) } : {}; },
      },
    },
    permissions: {
      async contains({ origins = [] }) { return origins.every(pattern => grants.has(pattern)); },
      async request({ origins = [] }) {
        if (origins.some(pattern => pattern !== `${origin}/*`)) throw new Error('A fixture requested an unexpected origin.');
        state.permissionRequests.push([...origins]);
        for (const pattern of origins) grants.add(pattern);
        render();
        return true;
      },
    },
    tabs: { async update() { return {}; } },
    downloads: {
      onChanged: {
        addListener(callback) { downloadListeners.add(callback); },
        removeListener(callback) { downloadListeners.delete(callback); },
      },
      async search({ id } = {}) { return downloads.has(id) ? [structuredClone(downloads.get(id))] : []; },
      async download() { throw new Error('The fixture must not initiate a real Chrome download.'); },
      async cancel(id) {
        const item = downloads.get(id);
        if (item) {
          item.state = 'interrupted'; item.error = 'USER_CANCELED';
          for (const listener of downloadListeners) listener({ id, state: { current: 'interrupted' } });
        }
      },
    },
  };
  Object.defineProperty(window, 'chrome', { configurable: true, value: mockChrome });

  async function bytesOf(value) {
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    throw new TypeError('Unexpected writable input in the test harness.');
  }

  const directory = {
    kind: 'directory', name: '本機測試資料夾（記憶體）',
    async getFileHandle(name, options = {}) {
      if (!entries.has(name)) {
        if (!options.create) throw new DOMException('Missing fixture output.', 'NotFoundError');
        const record = { name, bytes: 0, state: 'created', content: new Uint8Array() };
        const handle = {
          kind: 'file', name,
          async createWritable() {
            let chunks = [], ended = false;
            record.state = 'writing'; render();
            return {
              async write(value) {
                if (ended) throw new DOMException('The fixture stream is closed.', 'InvalidStateError');
                chunks.push(await bytesOf(value));
              },
              async close() {
                if (ended) throw new DOMException('The fixture stream is closed.', 'InvalidStateError');
                ended = true;
                record.bytes = chunks.reduce((length, chunk) => length + chunk.byteLength, 0);
                record.content = new Uint8Array(record.bytes);
                let offset = 0;
                for (const chunk of chunks) { record.content.set(chunk, offset); offset += chunk.byteLength; }
                chunks = [];
                record.state = 'closed'; render();
              },
              async abort() { ended = true; chunks = []; record.state = 'aborted'; render(); },
            };
          },
          async getFile() { return new File([record.content], name); },
        };
        entries.set(name, handle);
        window.__testFiles.push(record);
        render();
      }
      return entries.get(name);
    },
  };
  Object.defineProperty(window, 'showDirectoryPicker', {
    configurable: true,
    value: async () => { state.directorySelected = true; render(); return directory; },
  });
})();
