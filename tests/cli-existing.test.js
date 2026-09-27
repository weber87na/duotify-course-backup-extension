import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { launchExistingSession } from '../cli/existing.js';

const course = 'https://learn.duotify.com/courses/claude-code';
const chapter = 'https://learn.duotify.com/video/watch?slug=claude-code&sectionId=280';

function fixture() {
  const calls = { connect: [], goto: [], evaluate: [], commands: [], pageClosed: 0, disconnected: 0, detached: 0, newPages: 0 };
  let current = 'about:blank';
  const client = {
    async send(command, params) { calls.commands.push({ command, params }); return { cookies: [{ name: 'session', value: 'synthetic-cookie' }] }; },
    async detach() { calls.detached += 1; },
  };
  const page = {
    url: () => current,
    isClosed: () => !!calls.pageClosed,
    async goto(url, options) { calls.goto.push({ url, options }); current = url; },
    async evaluate(fn, ...args) {
      calls.evaluate.push({ fn, args });
      const context = vm.createContext({ URL, location: { href: current }, args, testValue: 42 });
      return vm.runInContext(`(${fn.toString()})(...args)`, context);
    },
    async createCDPSession() { return client; },
    async close() { calls.pageClosed += 1; },
  };
  const browser = {
    async newPage() { calls.newPages += 1; return page; },
    async disconnect() { calls.disconnected += 1; },
    close() { assert.fail('Never close the existing browser.'); },
    pages() { assert.fail('Never enumerate user tabs.'); },
    defaultBrowserContext() { assert.fail('Never enumerate the existing context.'); },
  };
  const load = async () => ({ async connect(options) { calls.connect.push(options); return browser; } });
  return { calls, client, page, browser, load, navigate: value => { current = value; } };
}

test('connects by official Chrome channel with a visible viewport and narrow target filter', async () => {
  const f = fixture();
  const session = await launchExistingSession({ url: course }, f.load);
  const options = f.calls.connect[0];
  assert.equal(options.channel, 'chrome');
  assert.equal(options.defaultViewport, null);
  assert.equal(options.networkEnabled, false);
  assert.equal(options.issuesEnabled, false);
  assert.equal(options.protocolTimeout, 30_000);
  assert.equal(options.browserURL, undefined);
  assert.equal(options.browserWSEndpoint, undefined);
  assert.equal(options.transport, undefined);
  const allows = (url, type = 'page') => options.targetFilter({ url: () => url, type: () => type });
  assert.ok(allows('', 'browser'));
  assert.ok(allows('about:blank'));
  assert.ok(allows('', 'tab'));
  assert.ok(allows('', 'page'));
  assert.ok(allows('about:blank', 'tab'));
  assert.ok(allows(course));
  assert.ok(allows(chapter));
  assert.ok(allows(chapter, 'tab'));
  for (const url of ['https://mail.example.test/', 'chrome://settings', 'chrome-extension://private/page',
    'https://learn.duotify.com/login', 'https://learn.duotify.com/courses/other', 'https://learn.duotify.com/video/watch?slug=other&sectionId=280']) {
    assert.equal(allows(url), false);
    assert.equal(allows(url, 'tab'), false);
  }
  assert.equal(allows(course, 'service_worker'), false);
  assert.equal(f.calls.newPages, 1);
  await session.close();
  assert.equal(f.calls.pageClosed, 1);
  assert.equal(f.calls.disconnected, 1);
});

test('rejects non-course URLs before connecting or loading dependencies', async () => {
  let imported = false;
  const load = async () => { imported = true; assert.fail(); };
  for (const url of ['http://learn.duotify.com/courses/claude-code', 'https://user:password@learn.duotify.com/courses/claude-code',
    'https://elsewhere.example/courses/claude-code', 'https://learn.duotify.com/login',
    'https://learn.duotify.com/api/video/watch?slug=claude-code', 'https://learn.duotify.com/courses/..',
    'https://learn.duotify.com/video/watch?slug=claude-code', 'https://learn.duotify.com/video/watch?slug=claude-code&sectionId=0',
    'https://learn.duotify.com/video/watch?slug=claude-code&slug=other&sectionId=280']) {
    await assert.rejects(launchExistingSession({ url }, load));
  }
  assert.equal(imported, false);
});

test('only navigates our new tab to this course and never inspects login forms', async () => {
  const f = fixture();
  const session = await launchExistingSession({ url: chapter }, f.load);
  session.setAuthOrigin(course);
  await session.page.goto(chapter, { timeout: 60_000 });
  assert.deepEqual(f.calls.goto[0], { url: chapter, options: { timeout: 30_000, waitUntil: 'domcontentloaded' } });
  assert.equal(await session.page.evaluate(value => testValue + value, 3), 45);
  await assert.rejects(session.page.goto('https://learn.duotify.com/courses/other'), /本次指定課程/);
  assert.throws(() => session.setAuthOrigin('https://learn.duotify.com/courses/other'), /本次指定/);
  f.navigate('https://learn.duotify.com/login');
  await assert.rejects(session.page.evaluate(() => document.cookie), /不是本次指定/);
  assert.equal(f.calls.evaluate.length, 1);
  await session.close();
});

test('in-page guard prevents reading a changed page after the Node-side scope check', async () => {
  const f = fixture();
  const session = await launchExistingSession({ url: chapter }, f.load);
  await session.page.goto(chapter);
  let inspected = false;
  const original = f.page.evaluate;
  f.page.evaluate = async (fn, ...args) => {
    f.navigate('https://learn.duotify.com/login');
    const context = vm.createContext({ URL, location: { href: f.page.url() }, inspect() { inspected = true; } });
    return vm.runInContext(`(${fn.toString()})()`, context);
  };
  await assert.rejects(session.page.evaluate(() => inspect()), /無法讀取指定課程頁/);
  assert.equal(inspected, false);
  f.page.evaluate = original;
  await session.close();
});

test('cookie adapter requests only the exact approved URL through its own page session', async () => {
  const f = fixture();
  const session = await launchExistingSession({ url: chapter }, f.load);
  await session.page.goto(chapter);
  const manifest = 'https://learn.duotify.com/api/video/watch/?slug=claude-code&type=m3u8';
  const cookies = await session.context.cookies(manifest);
  assert.deepEqual(cookies, [{ name: 'session', value: 'synthetic-cookie' }]);
  assert.deepEqual(f.calls.commands, [{ command: 'Network.getCookies', params: { urls: [manifest] } }]);
  for (const url of ['https://cdn.example.test/a.ts', 'https://learn.duotify.com:8443/api/media', 'http://learn.duotify.com/api/media',
    'https://user:secret@learn.duotify.com/api/media', 'https://learn.duotify.com/api/video/watch/?slug=other',
    'https://learn.duotify.com/api/video/watch/?slug=claude-code&slug=other']) {
    await assert.rejects(session.context.cookies(url), /本次多奇課程來源/);
  }
  assert.equal(f.calls.commands.length, 1);
  await session.close();
  assert.equal(f.calls.detached, 1);
});

test('close and abort only close our page and disconnect, and are idempotent', async () => {
  const f = fixture();
  const controller = new AbortController();
  const session = await launchExistingSession({ url: course, signal: controller.signal }, f.load);
  controller.abort('do-not-display');
  await session.close();
  await session.close();
  assert.equal(f.calls.pageClosed, 1);
  assert.equal(f.calls.disconnected, 1);
  assert.equal(session.page.isClosed(), true);
});

test('pre-abort does not import, connect or open a page', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(launchExistingSession({ url: course, signal: controller.signal }, () => assert.fail()), { name: 'AbortError' });
});

test('connection cancellation disconnects a late browser without closing it or its tabs', async () => {
  const f = fixture();
  const controller = new AbortController();
  let finishConnect;
  const load = async () => ({ connect: () => new Promise(resolve => { finishConnect = resolve; }) });
  const pending = launchExistingSession({ url: course, signal: controller.signal }, load);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  finishConnect(f.browser);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.disconnected, 1);
  assert.equal(f.calls.newPages, 0);
  assert.equal(f.calls.pageClosed, 0);
});

test('synchronous cancellation as connect returns does not leak the browser connection', async () => {
  const f = fixture();
  const controller = new AbortController();
  const load = async () => ({ connect() { controller.abort(); return f.browser; } });
  await assert.rejects(launchExistingSession({ url: course, signal: controller.signal }, load), { name: 'AbortError' });
  assert.equal(f.calls.disconnected, 1);
  assert.equal(f.calls.newPages, 0);
});

test('connection timeout is bounded, actionable and cleans a late browser result', async () => {
  const f = fixture();
  let finishConnect;
  const load = async () => ({ connect: () => new Promise(resolve => { finishConnect = resolve; }) });
  await assert.rejects(launchExistingSession({ url: course, timeoutMs: 10 }, load), error =>
    error.message.includes('Chrome 144') && error.message.includes('chrome://inspect/#remote-debugging') && error.message.includes('允許'));
  finishConnect(f.browser);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.disconnected, 1);
  assert.equal(f.calls.newPages, 0);
});

test('new-page failure disconnects without closing any existing page', async () => {
  const f = fixture();
  f.browser.newPage = async () => { throw new Error('private-token-and-url'); };
  await assert.rejects(launchExistingSession({ url: course }, f.load), { message: '無法建立課程分頁。請保持 Chrome 開啟並允許本次連線後重試。' });
  assert.equal(f.calls.disconnected, 1);
  assert.equal(f.calls.pageClosed, 0);
});

test('late new page is closed before disconnect after cancellation', async () => {
  const f = fixture();
  const controller = new AbortController();
  let finishPage;
  const order = [];
  f.browser.newPage = () => new Promise(resolve => { finishPage = resolve; });
  f.page.close = async () => { order.push('page closed'); f.calls.pageClosed += 1; };
  f.browser.disconnect = async () => { order.push('disconnected'); f.calls.disconnected += 1; };
  const pending = launchExistingSession({ url: course, signal: controller.signal }, f.load);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(order, []);
  finishPage(f.page);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['page closed', 'disconnected']);
  assert.equal(f.calls.pageClosed, 1);
});

test('a permanently stalled new-page request still disconnects after a bounded grace period', async () => {
  const f = fixture();
  f.browser.newPage = () => new Promise(() => {});
  await assert.rejects(launchExistingSession({ url: course, timeoutMs: 10 }, f.load), /無法建立課程分頁/);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.calls.disconnected, 1);
  assert.equal(f.calls.pageClosed, 0);
});

test('dependency, connection and page errors do not expose raw library errors', async () => {
  await assert.rejects(launchExistingSession({ url: course }, async () => { throw new Error('private-path'); }), {
    message: '找不到 Puppeteer。請先在專案資料夾執行 npm install。',
  });
  await assert.rejects(launchExistingSession({ url: course }, async () => ({ connect() { throw new Error('private-profile-cookie'); } })),
    error => error.message.includes('Chrome 144') && !error.message.includes('private'));
  const f = fixture();
  const session = await launchExistingSession({ url: course }, f.load);
  f.page.goto = async () => { throw new Error('secret-navigation-url'); };
  await assert.rejects(session.page.goto(course), { message: '無法開啟指定課程頁，請確認登入狀態及網路。' });
  await session.close();
});
