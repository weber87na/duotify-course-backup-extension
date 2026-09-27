import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionFetch, launchSession } from '../cli/browser.js';

const origin = 'https://courses.example.test';
function fixture(responses, getAuthOrigin = () => origin) {
  const requests = [];
  const cookieQueries = [];
  const fetch = createSessionFetch({
    async cookies(url) {
      cookieQueries.push(url);
      return [{ name: 'session', value: 'synthetic-test-cookie' }];
    },
  }, {
    getAuthOrigin,
    async fetchImpl(url, options) {
      requests.push({ url, ...options, headers: new Headers(options.headers) });
      const next = responses.shift();
      return typeof next === 'function' ? next(url, options) : next;
    },
  });
  return { fetch, requests, cookieQueries };
}

test('sends cookies only to the selected exact origin and uses full cookie path', async () => {
  const f = fixture([new Response('playlist'), new Response('segment'), new Response('port'), new Response('subdomain')]);
  await f.fetch(`${origin}/api/private/manifest?course=1`, { credentials: 'include', headers: { Accept: 'application/vnd.apple.mpegurl' } });
  await f.fetch('https://cdn.example.test/segment.ts', { headers: { Range: 'bytes=0-187' } });
  await f.fetch('https://courses.example.test:8443/segment.ts');
  await f.fetch('https://sub.courses.example.test/segment.ts');
  assert.deepEqual(f.cookieQueries, [`${origin}/api/private/manifest?course=1`]);
  assert.equal(f.requests[0].headers.get('cookie'), 'session=synthetic-test-cookie');
  assert.equal(f.requests[0].headers.get('accept'), 'application/vnd.apple.mpegurl');
  assert.equal(f.requests[1].headers.get('range'), 'bytes=0-187');
  assert.ok(f.requests.slice(1).every(request => !request.headers.has('cookie')));
  assert.ok(f.requests.every(request => request.redirect === 'manual'));
});

test('cross-origin redirects drop cookies and redirects back reacquire cookies', async () => {
  const f = fixture([
    new Response(null, { status: 302, headers: { Location: 'https://cdn.example.test/route' } }),
    new Response(null, { status: 307, headers: { Location: `${origin}/new-path` } }),
    new Response('ok'),
  ]);
  await f.fetch(`${origin}/start`);
  assert.equal(f.requests[0].headers.get('cookie'), 'session=synthetic-test-cookie');
  assert.equal(f.requests[1].headers.get('cookie'), null);
  assert.equal(f.requests[2].headers.get('cookie'), 'session=synthetic-test-cookie');
  assert.deepEqual(f.cookieQueries, [`${origin}/start`, `${origin}/new-path`]);
});

test('returns the final streaming response without buffering it', async () => {
  let pulls = 0;
  const response = new Response(new ReadableStream({ pull(controller) { pulls += 1; controller.enqueue(new Uint8Array([7])); controller.close(); } }));
  const f = fixture([response]);
  const result = await f.fetch('https://cdn.example.test/segment.ts');
  assert.equal(result, response);
  assert.equal(result.bodyUsed, false);
  assert.deepEqual([...new Uint8Array(await result.arrayBuffer())], [7]);
  assert.equal(pulls, 1);
});

test('cancels redirect bodies and rejects a sixth redirect', async () => {
  let discarded = 0;
  const responses = Array.from({ length: 6 }, () => new Response(new ReadableStream({ cancel() { discarded += 1; } }), {
    status: 302, headers: { Location: '/again' },
  }));
  const f = fixture(responses);
  await assert.rejects(f.fetch(`${origin}/start`), /重新導向次數超過上限/);
  assert.equal(f.requests.length, 6);
  assert.equal(discarded, 6);
});

test('permits five redirects, relative paths and HEAD', async () => {
  const f = fixture([...Array.from({ length: 5 }, () => new Response(null, { status: 302, headers: { Location: '../final' } })), new Response(null)]);
  await f.fetch(`${origin}/a/start`, { method: 'HEAD' });
  assert.equal(f.requests.length, 6);
  assert.ok(f.requests.every(request => request.method === 'HEAD'));
  assert.equal(f.requests[5].url, `${origin}/final`);
});

test('never forwards arbitrary headers, request bodies, or write methods', async () => {
  const f = fixture([]);
  for (const headers of [{ Cookie: 'private' }, { Authorization: 'secret' }, { Referer: origin }, { 'X-Api-Key': 'secret' }]) {
    await assert.rejects(f.fetch(`${origin}/media`, { headers }), /只允許設定/);
  }
  await assert.rejects(f.fetch(`${origin}/media`, { method: 'POST' }), /GET 或 HEAD/);
  await assert.rejects(f.fetch(`${origin}/media`, { body: 'secret' }), /GET 或 HEAD/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.cookieQueries.length, 0);
});

test('rejects credential URLs, unsafe schemes and TLS downgrade redirects', async () => {
  const f = fixture([new Response(null, { status: 302, headers: { Location: 'http://cdn.example.test/a.ts' } })]);
  for (const url of ['file:///a.ts', 'https://user:secret@courses.example.test/a.ts', 'data:text/plain,secret']) {
    await assert.rejects(f.fetch(url), /HTTP\(S\)/);
  }
  await assert.rejects(f.fetch(`${origin}/a.ts`), /HTTPS 重新導向/);
  assert.equal(f.requests.length, 1);
});

test('rejects malformed or credential-bearing redirect locations without leaking them', async () => {
  for (const location of ['http://[bad', 'https://user:topsecret@courses.example.test/private', 'file:///private']) {
    const f = fixture([new Response(null, { status: 302, headers: { Location: location } })]);
    await assert.rejects(f.fetch(`${origin}/start`), error => !error.message.includes('topsecret') && !error.message.includes('private'));
    assert.equal(f.requests.length, 1);
  }
});

test('rejects unsafe auth origins; accepts localhost test origin; no selection means no cookie', async () => {
  const insecure = fixture([], () => 'http://courses.example.test');
  await assert.rejects(insecure.fetch('http://courses.example.test/media'), /登入來源設定無效/);
  assert.equal(insecure.cookieQueries.length, 0);
  const local = fixture([new Response('ok')], () => 'http://localhost:8765');
  await local.fetch('http://localhost:8765/media');
  assert.equal(local.cookieQueries.length, 1);
  const anonymous = fixture([new Response('ok')], () => null);
  await anonymous.fetch(`${origin}/media`);
  assert.equal(anonymous.cookieQueries.length, 0);
});

test('sanitizes network and cookie-reader errors', async () => {
  const f = fixture([() => { throw new Error('network secret=do-not-display https://private'); }]);
  await assert.rejects(f.fetch(`${origin}/media`), { message: '網路請求失敗，請檢查連線後再試。' });
  const fetch = createSessionFetch({ cookies() { throw new Error('cookie secret=do-not-display'); } }, { getAuthOrigin: () => origin });
  await assert.rejects(fetch(`${origin}/media`), { message: '無法讀取本次瀏覽器工作階段的登入狀態。' });
});

test('rejects malformed cookie header values without logging their contents', async () => {
  for (const cookie of [{ name: 'session', value: 'secret\r\nInjected: yes' }, { name: 'bad;name', value: 'secret' }]) {
    let fetched = false;
    const fetch = createSessionFetch({ async cookies() { return [cookie]; } }, {
      getAuthOrigin: () => origin, fetchImpl: async () => { fetched = true; return new Response(); },
    });
    await assert.rejects(fetch(`${origin}/media`), { message: '無法讀取本次瀏覽器工作階段的登入狀態。' });
    assert.equal(fetched, false);
  }
});

test('pre-cancelled request performs no cookie lookup or network access', async () => {
  const controller = new AbortController();
  controller.abort('private-cancellation-reason');
  const f = fixture([]);
  await assert.rejects(f.fetch(`${origin}/media`, { signal: controller.signal }), { name: 'AbortError', message: '已取消操作。' });
  assert.equal(f.requests.length, 0);
  assert.equal(f.cookieQueries.length, 0);
});

test('cancels while awaiting cookies without making a network request', async () => {
  const controller = new AbortController();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let requested = false;
  const fetch = createSessionFetch({ cookies() { started(); return new Promise(() => {}); } }, {
    getAuthOrigin: () => origin, fetchImpl: async () => { requested = true; return new Response(); },
  });
  const pending = fetch(`${origin}/media`, { signal: controller.signal });
  await ready;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(requested, false);
});

test('passes AbortSignal to network and sanitizes cancellation reason', async () => {
  const controller = new AbortController();
  const f = fixture([(_url, options) => {
    assert.equal(options.signal, controller.signal);
    controller.abort(new Error('do-not-display'));
    throw new Error('do-not-display');
  }]);
  await assert.rejects(f.fetch(`${origin}/media`, { signal: controller.signal }), { name: 'AbortError', message: '已取消操作。' });
});

test('launch rejects invalid browser selection and pre-abort without launching anything', async () => {
  await assert.rejects(launchSession({ browser: 'existing-profile' }), /chrome、msedge 或 chromium/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(launchSession({ signal: controller.signal }), { name: 'AbortError' });
});

function driver() {
  const calls = { launch: [], context: [], contextClosed: 0, browserClosed: 0 };
  const page = {};
  const context = {
    async newPage() { return page; },
    async cookies() { return []; },
    async close() { calls.contextClosed += 1; },
  };
  const instance = {
    async newContext(options) { calls.context.push(options); return context; },
    async close() { calls.browserClosed += 1; },
  };
  const load = async () => ({ chromium: { async launch(options) { calls.launch.push(options); return instance; } } });
  return { calls, page, context, instance, load };
}

test('launch uses visible installed browser and an isolated context with no saved state options', async () => {
  const d = driver();
  const messages = [];
  const session = await launchSession({ log: message => messages.push(message) }, d.load);
  assert.equal(session.page, d.page);
  assert.equal(session.context, d.context);
  assert.deepEqual(d.calls.launch, [{ headless: false, channel: 'chrome', timeout: 30_000 }]);
  assert.deepEqual(d.calls.context, [{ acceptDownloads: false }]);
  assert.equal(messages.length, 1);
  session.setAuthOrigin(`${origin}/video/watch?course=1`);
  assert.throws(() => session.setAuthOrigin('http://courses.example.test'), /HTTPS/);
  assert.throws(() => session.setAuthOrigin('https://user:secret@courses.example.test'), /HTTP\(S\)/);
  await session.close();
  await session.close();
  assert.equal(d.calls.contextClosed, 1);
  assert.equal(d.calls.browserClosed, 1);
  assert.throws(() => session.setAuthOrigin(origin), /已關閉/);
});

test('chromium launch omits channel and edge selection is explicit', async () => {
  for (const browser of ['chromium', 'msedge']) {
    const d = driver();
    const session = await launchSession({ browser }, d.load);
    assert.equal(d.calls.launch[0].channel, browser === 'chromium' ? undefined : 'msedge');
    assert.equal(d.calls.launch[0].headless, false);
    await session.close();
  }
});

test('session abort closes context and browser; close removes the abort listener', async () => {
  const controller = new AbortController();
  const d = driver();
  const session = await launchSession({ signal: controller.signal }, d.load);
  controller.abort();
  await session.close();
  assert.equal(d.calls.contextClosed, 1);
  assert.equal(d.calls.browserClosed, 1);
  const secondController = new AbortController();
  const second = driver();
  const closed = await launchSession({ signal: secondController.signal }, second.load);
  await closed.close();
  secondController.abort();
  assert.equal(second.calls.browserClosed, 1);
});

test('abort while launching still closes the returned browser', async () => {
  const controller = new AbortController();
  const d = driver();
  const load = async () => ({ chromium: { async launch() { controller.abort('private'); return d.instance; } } });
  await assert.rejects(launchSession({ signal: controller.signal }, load), { name: 'AbortError', message: '已取消操作。' });
  assert.equal(d.calls.browserClosed, 1);
  assert.equal(d.calls.context.length, 0);
});

test('late-created context is also closed when abort occurs during context creation', async () => {
  const controller = new AbortController();
  const d = driver();
  d.instance.newContext = async () => { controller.abort(); return d.context; };
  await assert.rejects(launchSession({ signal: controller.signal }, d.load), { name: 'AbortError' });
  assert.equal(d.calls.browserClosed, 1);
  assert.equal(d.calls.contextClosed, 1);
});

test('failed page creation closes both browser resources and redacts the raw error', async () => {
  const d = driver();
  d.context.newPage = async () => { throw new Error('private-url secret'); };
  await assert.rejects(launchSession({}, d.load), { message: '無法建立瀏覽器工作階段，請關閉後重試。' });
  assert.equal(d.calls.contextClosed, 1);
  assert.equal(d.calls.browserClosed, 1);
});

test('missing dependency and launch failure return installation hints without original errors', async () => {
  await assert.rejects(launchSession({}, async () => { throw new Error('private-import-path'); }), {
    message: '找不到 Playwright。請先在專案資料夾執行 npm install。',
  });
  const broken = async () => ({ chromium: { async launch() { throw new Error('private-profile-path'); } } });
  await assert.rejects(launchSession({ browser: 'chromium' }, broken), {
    message: '無法啟動 Chromium。請先執行 npx playwright install chromium。',
  });
  await assert.rejects(launchSession({ browser: 'chrome' }, broken), error => error.message.includes('--browser chromium') && !error.message.includes('private'));
});
