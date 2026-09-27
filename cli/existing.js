import { createSessionFetch } from './browser.js';

const COURSE_ORIGIN = 'https://learn.duotify.com';
const CONNECT_HELP = '無法連接目前的 Chrome。請使用 Chrome 144 以上版本，手動在 chrome://inspect/#remote-debugging 啟用遠端偵錯，再於 Chrome 的連線提示按「允許」後重試。';

function abortCheck(signal) {
  if (signal?.aborted) throw new DOMException('已取消操作。', 'AbortError');
}

function courseIdentity(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('請提供有效的多奇課程網址。'); }
  if (url.origin !== COURSE_ORIGIN || url.username || url.password) {
    throw new Error('既有 Chrome 模式只支援 HTTPS 多奇課程頁。');
  }
  let slug;
  const course = /^\/courses\/([^/]+)\/?$/.exec(url.pathname);
  if (course) {
    try { slug = decodeURIComponent(course[1]); } catch { /* Rejected below. */ }
  } else if (/^\/video\/watch\/?$/.test(url.pathname)) {
    if (url.searchParams.getAll('slug').length !== 1 || url.searchParams.getAll('sectionId').length !== 1 ||
        !/^[1-9]\d*$/.test(url.searchParams.get('sectionId') || '')) {
      throw new Error('課程播放網址必須包含唯一的 slug 與正整數 sectionId。');
    }
    slug = url.searchParams.get('slug');
  }
  if (!slug || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(slug)) {
    throw new Error('只支援有效的多奇課程目錄或章節網址。');
  }
  return { url: url.href, slug };
}

function sameCourse(raw, slug) {
  try { return courseIdentity(raw).slug === slug; } catch { return false; }
}

async function ignoreFailure(operation) {
  try { await operation(); } catch { /* Closing a detached resource is harmless. */ }
}

/** Consume a late result after cancellation/timeout, closing only our resource. */
async function bounded(promise, { signal, timeoutMs, late = async () => {} }) {
  let expired = false;
  let delivered = false;
  let resolved = false;
  let resolvedValue;
  let cleanup;
  let timer, onAbort;
  const discard = value => {
    if (!cleanup) cleanup = ignoreFailure(() => late(value));
    return cleanup;
  };
  const pending = Promise.resolve(promise).then(async value => {
    resolved = true;
    resolvedValue = value;
    if (expired) {
      await discard(value);
      return undefined;
    }
    return value;
  });
  try {
    const value = await Promise.race([
      pending,
      new Promise((_, reject) => {
        onAbort = () => reject(new DOMException('已取消操作。', 'AbortError'));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) { onAbort(); return; }
        timer = setTimeout(() => reject(new Error(CONNECT_HELP)), timeoutMs);
      }),
    ]);
    delivered = true;
    return value;
  } finally {
    expired = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    // The resource can resolve in the same microtask turn as an abort, before
    // Promise.race reports the abort. It still belongs to this cleanup path.
    if (!delivered && resolved) await discard(resolvedValue);
  }
}

/**
 * Add an in-page guard as well as the Node-side check. The function originates
 * in this CLI, never from page text; navigation cannot move its execution into
 * a login form or another course between the two checks.
 */
function guardedEvaluation(fn, slug) {
  if (typeof fn !== 'function') throw new Error('只允許執行課程工具提供的頁面函式。');
  const source = Function.prototype.toString.call(fn);
  return new Function('...args', `
    const expectedSlug = ${JSON.stringify(slug)};
    const current = new URL(location.href);
    let actualSlug;
    const course = /^\\/courses\\/([^/]+)\\/?$/.exec(current.pathname);
    if (course) {
      try { actualSlug = decodeURIComponent(course[1]); } catch {}
    } else if (/^\\/video\\/watch\\/?$/.test(current.pathname) &&
      current.searchParams.getAll('slug').length === 1 &&
      current.searchParams.getAll('sectionId').length === 1 &&
      /^[1-9]\\d*$/.test(current.searchParams.get('sectionId') || '')) {
      actualSlug = current.searchParams.get('slug');
    }
    if (current.origin !== ${JSON.stringify(COURSE_ORIGIN)} || current.username || current.password || actualSlug !== expectedSlug) {
      throw new Error('目前分頁不是本次指定的課程。');
    }
    return (${source})(...args);
  `);
}

/**
 * Use Chrome's official permission-based auto-connect. Puppeteer discovers the
 * channel itself; this module never opens profiles or accepts CDP endpoints.
 */
export async function launchExistingSession({ url, signal, timeoutMs = 600_000, log = () => {} } = {},
  loadPuppeteer = () => import('puppeteer-core')) {
  const expected = courseIdentity(url);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new Error('連線等待時間必須介於 1 毫秒與 1 小時。');
  }
  abortCheck(signal);
  let puppeteer;
  try {
    const loaded = await loadPuppeteer();
    puppeteer = typeof loaded.connect === 'function' ? loaded : loaded.default;
    if (typeof puppeteer?.connect !== 'function') throw new Error();
  } catch {
    abortCheck(signal);
    throw new Error('找不到 Puppeteer。請先在專案資料夾執行 npm install。');
  }
  abortCheck(signal);
  log('請在目前 Chrome 的連線提示按「允許」。本次只開啟指定課程的新分頁，不會關閉原有分頁。');
  let browser;
  try {
    browser = await bounded(puppeteer.connect({
      channel: 'chrome',
      defaultViewport: null,
      networkEnabled: false,
      issuesEnabled: false,
      protocolTimeout: Math.min(timeoutMs, 30_000),
      targetFilter(target) {
        try {
          const type = target.type();
          if (type === 'browser') return true;
          // A new tab target starts with an empty URL before its about:blank
          // page exists. Both targets are needed for newPage() to attach; the
          // page wrapper still gates every evaluation and cookie read by course.
          return ['page', 'tab'].includes(type) && (target.url() === '' || target.url() === 'about:blank' || sameCourse(target.url(), expected.slug));
        } catch { return false; }
      },
    }), { signal, timeoutMs, late: instance => instance.disconnect() });
    abortCheck(signal);
  } catch {
    if (browser) await ignoreFailure(() => browser.disconnect());
    abortCheck(signal);
    throw new Error(CONNECT_HELP);
  }

  let rawPage, pendingPage, client, pendingClient;
  let closed = false;
  let closePromise;
  let disconnectPromise;
  const pageCleanup = new WeakMap();
  let authOrigin = null;
  const disconnect = () => {
    if (!disconnectPromise) disconnectPromise = ignoreFailure(() => browser.disconnect());
    return disconnectPromise;
  };
  const closePage = page => {
    if (!pageCleanup.has(page)) pageCleanup.set(page, ignoreFailure(() => page.close({ runBeforeUnload: false })));
    return pageCleanup.get(page);
  };
  const close = () => {
    if (!closePromise) {
      closed = true;
      authOrigin = null;
      signal?.removeEventListener('abort', onAbort);
      closePromise = (async () => {
        if (client) await ignoreFailure(() => client.detach());
        if (rawPage) {
          await closePage(rawPage);
          await disconnect();
        } else if (pendingPage) {
          // The create-target command may already have reached Chrome. Keep
          // this connection briefly so a late page can be closed first, while
          // letting the cancelled caller return without awaiting the command.
          const fallback = setTimeout(() => { void disconnect(); }, Math.min(timeoutMs, 30_000));
          fallback.unref?.();
          void pendingPage.then(async page => {
            await closePage(page);
            await disconnect();
          }, disconnect).finally(() => clearTimeout(fallback));
        } else {
          await disconnect();
        }
      })();
    }
    return closePromise;
  };
  const onAbort = () => { void close(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const checkOpen = () => {
    abortCheck(signal);
    if (closed || !rawPage || rawPage.isClosed()) throw new Error('課程瀏覽器工作階段已關閉。');
  };
  const checkPage = () => {
    checkOpen();
    if (!sameCourse(rawPage.url(), expected.slug)) throw new Error('目前分頁不是本次指定的課程。');
  };
  try {
    abortCheck(signal);
    pendingPage = Promise.resolve().then(() => { abortCheck(signal); return browser.newPage(); });
    rawPage = await bounded(pendingPage, {
      signal, timeoutMs: Math.min(timeoutMs, 30_000),
      late: closePage,
    });
    abortCheck(signal);
    if (closed) throw new Error();
    const page = Object.freeze({
      url: () => rawPage.url(),
      isClosed: () => closed || rawPage.isClosed(),
      async goto(target, options = {}) {
        checkOpen();
        if (!sameCourse(target, expected.slug)) throw new Error('只能開啟本次指定課程的目錄或章節。');
        try {
          await rawPage.goto(courseIdentity(target).url, {
            waitUntil: 'domcontentloaded', timeout: Math.min(options.timeout || 30_000, 30_000),
          });
        } catch (error) {
          abortCheck(signal);
          const failure = new Error('無法開啟指定課程頁，請確認登入狀態及網路。');
          if (error?.name === 'TimeoutError') failure.name = 'TimeoutError';
          throw failure;
        }
      },
      async evaluate(fn, ...args) {
        checkPage();
        try { return await rawPage.evaluate(guardedEvaluation(fn, expected.slug), ...args); }
        catch {
          abortCheck(signal);
          throw new Error('無法讀取指定課程頁，請確認該章節仍可正常播放。');
        }
      },
    });
    const context = Object.freeze({
      async cookies(target) {
        checkPage();
        let cookieUrl;
        try { cookieUrl = new URL(target); } catch { throw new Error('登入來源設定無效。'); }
        if (cookieUrl.origin !== COURSE_ORIGIN || cookieUrl.username || cookieUrl.password ||
            cookieUrl.searchParams.has('slug') && (cookieUrl.searchParams.getAll('slug').length !== 1 ||
              cookieUrl.searchParams.get('slug') !== expected.slug)) {
          throw new Error('只允許讀取本次多奇課程來源的登入資料。');
        }
        try {
          if (!pendingClient) {
            pendingClient = Promise.resolve(rawPage.createCDPSession()).then(async session => {
              if (closed) { await ignoreFailure(() => session.detach()); throw new Error(); }
              client = session;
              return session;
            });
          }
          const session = await pendingClient;
          checkPage();
          const result = await session.send('Network.getCookies', { urls: [cookieUrl.href] });
          checkPage();
          if (!Array.isArray(result?.cookies)) throw new Error();
          return result.cookies;
        } catch {
          abortCheck(signal);
          throw new Error('無法取得目前多奇課程的登入狀態。');
        }
      },
    });
    return {
      page,
      context,
      fetchImpl: createSessionFetch(context, { getAuthOrigin: () => authOrigin }),
      setAuthOrigin(value) {
        checkOpen();
        if (!sameCourse(value, expected.slug)) throw new Error('登入來源必須是本次指定的多奇課程。');
        authOrigin = COURSE_ORIGIN;
      },
      close,
    };
  } catch {
    await close();
    abortCheck(signal);
    throw new Error('無法建立課程分頁。請保持 Chrome 開啟並允許本次連線後重試。');
  }
}
