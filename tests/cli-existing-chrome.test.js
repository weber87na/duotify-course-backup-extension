import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, join, resolve, isAbsolute } from 'node:path';
import { launchExistingSession } from '../cli/existing.js';

// Opt in with an explicit installed Chrome executable. This launches a separate
// headless fixture with a disposable profile; it never attaches to user Chrome.
const executablePath = process.env.COURSE_BACKUP_TEST_CHROME;

test('real isolated Chrome preserves its original tab while the adapter creates and closes only its own tab', {
  skip: !executablePath,
  timeout: 30_000,
}, async t => {
  assert.ok(isAbsolute(executablePath), 'COURSE_BACKUP_TEST_CHROME must be an absolute executable path.');
  const { default: puppeteer } = await import('puppeteer-core');
  const root = resolve(tmpdir());
  const temporary = await mkdtemp(join(root, 'course-existing-chrome-test-'));
  assert.equal(dirname(temporary), root);
  assert.ok(basename(temporary).startsWith('course-existing-chrome-test-'));
  let fixtureBrowser;
  let session;
  t.after(async () => {
    await session?.close();
    // This browser was explicitly launched by this test, never the user's one.
    await fixtureBrowser?.close();
    await rm(temporary, { recursive: true, force: true });
  });
  fixtureBrowser = await puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir: join(temporary, 'isolated-profile'),
    timeout: 10_000,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'],
  });
  const original = await fixtureBrowser.newPage();
  await original.goto('data:text/html,<title>Local fixture</title><p id="marker">original fixture tab</p>');
  const before = await fixtureBrowser.pages();
  const originalTargets = new Set(before.map(page => page.target()));
  const started = Date.now();
  const decisions = [];
  try { session = await launchExistingSession({ url: 'https://learn.duotify.com/courses/synthetic-fixture', timeoutMs: 5_000 }, async () => ({
    // This test-only loader injects the fixture's endpoint. Production code only
    // uses Chrome's permission-based channel auto-connect and accepts no endpoint.
    connect(options) {
      const { channel, ...fixtureOptions } = options;
      assert.equal(channel, 'chrome');
      return puppeteer.connect({ ...fixtureOptions, browserWSEndpoint: fixtureBrowser.wsEndpoint(),
        targetFilter(target) {
          const accepted = options.targetFilter(target);
          decisions.push({ type: target.type(), url: target.url(), accepted });
          return accepted;
        },
      });
    },
  })); } catch (error) {
    throw new Error(`${error.message}\nSynthetic fixture target decisions: ${JSON.stringify(decisions)}`);
  }
  assert.ok(Date.now() - started < 5_000, 'Creating the owned page must not hang behind target filtering.');
  assert.equal(session.page.url(), 'about:blank');
  assert.equal((await fixtureBrowser.pages()).length, before.length + 1);
  // Do not navigate to any live website: the adapter's scope check must reject
  // evaluation while its newly-created page is still blank.
  await assert.rejects(session.page.evaluate(() => document.title), /不是本次指定/);
  await session.close();
  assert.equal(fixtureBrowser.connected, true);
  assert.equal(original.isClosed(), false);
  assert.equal(await original.evaluate(() => document.querySelector('#marker').textContent), 'original fixture tab');
  const after = await fixtureBrowser.pages();
  assert.equal(after.length, before.length);
  assert.ok(after.every(page => originalTargets.has(page.target())));
});
