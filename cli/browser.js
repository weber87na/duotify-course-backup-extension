const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_HEADERS = new Set(['accept', 'range']);
const MAX_REDIRECTS = 5;

function abortError() {
  return new DOMException('已取消操作。', 'AbortError');
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

function checkedUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch {
    throw new Error('請求網址無效。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('只支援不含內嵌帳密的 HTTP(S) 網址。');
  }
  url.hash = '';
  return url;
}

function authOrigin(value) {
  const url = checkedUrl(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) {
    throw new Error('登入來源必須使用 HTTPS；只有本機測試可以使用 HTTP。');
  }
  return url.origin;
}

function requestHeaders(input) {
  let headers;
  try { headers = new Headers(input); } catch {
    throw new Error('請求標頭格式無效。');
  }
  for (const name of headers.keys()) {
    if (!ALLOWED_HEADERS.has(name)) {
      throw new Error('只允許設定 Accept 與 Range 請求標頭。');
    }
  }
  return headers;
}

async function abortable(promise, signal) {
  const pending = Promise.resolve(promise);
  if (signal?.aborted) {
    // The operation may reject after it synchronously cancelled the request.
    // Consume that rejection without disclosing the original error or reason.
    void pending.catch(() => {});
    throw abortError();
  }
  if (!signal) return pending;
  let abort;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        abort = () => reject(abortError());
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function discardBody(response) {
  try { await response.body?.cancel(); } catch { /* A failed redirect body is discarded. */ }
}

/**
 * Fetch streaming media with cookies from this run's scoped browser adapter.
 * The browser filters cookies by URL; only the explicitly selected origin may
 * receive them. Redirects rebuild headers on every hop and never downgrade TLS.
 */
export function createSessionFetch(context, { getAuthOrigin, fetchImpl = globalThis.fetch } = {}) {
  if (typeof context?.cookies !== 'function' || typeof getAuthOrigin !== 'function' || typeof fetchImpl !== 'function') {
    throw new Error('瀏覽器下載工作階段設定無效。');
  }
  return async (input, options = {}) => {
    const signal = options.signal;
    checkAbort(signal);
    const method = (options.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method) || options.body != null) {
      throw new Error('下載只支援 GET 或 HEAD 請求。');
    }
    const originalHeaders = requestHeaders(options.headers);
    let target = checkedUrl(input);
    let selectedOrigin;
    try {
      const selected = getAuthOrigin();
      selectedOrigin = selected ? authOrigin(selected) : null;
    } catch {
      throw new Error('登入來源設定無效。');
    }
    for (let redirects = 0; ; redirects += 1) {
      checkAbort(signal);
      const headers = new Headers(originalHeaders);
      if (target.origin === selectedOrigin) {
        try {
          // Pass the entire URL so the browser applies cookie path rules.
          const cookies = await abortable(context.cookies(target.href), signal);
          checkAbort(signal);
          if (!Array.isArray(cookies) || cookies.some(cookie =>
            typeof cookie.name !== 'string' || typeof cookie.value !== 'string' ||
            /[\r\n;=]/.test(cookie.name) || /[\r\n;]/.test(cookie.value))) {
            throw new Error();
          }
          if (cookies.length) headers.set('cookie', cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '));
        } catch {
          checkAbort(signal);
          throw new Error('無法讀取本次瀏覽器工作階段的登入狀態。');
        }
      }
      let response;
      try {
        response = await abortable(fetchImpl(target.href, { method, headers, signal, redirect: 'manual' }), signal);
      } catch {
        checkAbort(signal);
        throw new Error('網路請求失敗，請檢查連線後再試。');
      } finally {
        // Release our reference as soon as request headers have been consumed.
        headers.delete('cookie');
      }
      if (signal?.aborted) {
        await discardBody(response);
        throw abortError();
      }
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get('location');
      await discardBody(response);
      if (redirects >= MAX_REDIRECTS) throw new Error('請求重新導向次數超過上限。');
      if (!location) throw new Error('伺服器重新導向缺少目的網址。');
      const next = checkedUrl(location, target);
      if (target.protocol === 'https:' && next.protocol !== 'https:') {
        throw new Error('拒絕從 HTTPS 重新導向到未加密的 HTTP。');
      }
      target = next;
    }
  };
}

/** Launch a fresh, visible browser. No existing profile or saved login is used. */
export async function launchSession({ browser = 'chrome', signal, log = () => {} } = {}, loadPlaywright = () => import('playwright')) {
  if (!['chrome', 'msedge', 'chromium'].includes(browser)) {
    throw new Error('瀏覽器必須是 chrome、msedge 或 chromium。');
  }
  checkAbort(signal);
  let chromium;
  try { ({ chromium } = await loadPlaywright()); } catch {
    checkAbort(signal);
    throw new Error('找不到 Playwright。請先在專案資料夾執行 npm install。');
  }
  checkAbort(signal);
  let instance;
  try {
    instance = await chromium.launch({ headless: false, ...(browser === 'chromium' ? {} : { channel: browser }), timeout: 30_000 });
  } catch {
    checkAbort(signal);
    throw new Error(browser === 'chromium'
      ? '無法啟動 Chromium。請先執行 npx playwright install chromium。'
      : `無法啟動 ${browser === 'chrome' ? 'Chrome' : 'Microsoft Edge'}。請確認瀏覽器已安裝，或改用 --browser chromium。`);
  }
  let context;
  let closedContext;
  let selectedOrigin = null;
  let closePromise;
  const close = () => {
    if (!closePromise) {
      signal?.removeEventListener('abort', onAbort);
      selectedOrigin = null;
      closePromise = (async () => {
        closedContext = context;
        try { await closedContext?.close(); } catch { /* Browser may already be closed. */ }
        try { await instance.close(); } catch { /* Close remains idempotent. */ }
      })();
    }
    return closePromise;
  };
  const onAbort = () => { void close(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    checkAbort(signal);
    context = await instance.newContext({ acceptDownloads: false });
    checkAbort(signal);
    const page = await context.newPage();
    checkAbort(signal);
    log('已開啟獨立瀏覽器；請在視窗內登入，本次登入資料不會匯出。');
    return {
      page,
      context,
      fetchImpl: createSessionFetch(context, { getAuthOrigin: () => selectedOrigin }),
      setAuthOrigin(pageUrl) {
        if (closePromise) throw new Error('瀏覽器工作階段已關閉。');
        selectedOrigin = authOrigin(pageUrl);
      },
      close,
    };
  } catch {
    await close();
    // A context may finish creation while the abort handler closes the browser.
    if (context !== closedContext) {
      try { await context?.close(); } catch { /* No saved state is retained. */ }
    }
    checkAbort(signal);
    throw new Error('無法建立瀏覽器工作階段，請關閉後重試。');
  }
}
