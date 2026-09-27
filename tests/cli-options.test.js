import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions } from '../cli/options.js';

test('CLI chooses one chapter by default and accepts explicit batch selection', () => {
  const value = parseOptions(['download', 'https://learn.duotify.com/courses/example', '--chapters', '3,1,3', '--out', 'backup']);
  assert.equal(value.command, 'download'); assert.equal(value.all, false);
  assert.deepEqual(value.chapters, [3, 1]); assert.equal(value.browser, 'existing');
  assert.equal(value.waitLoginMs, 600000); assert.equal(value.subtitles, true);
  assert.equal(parseOptions(['scan', 'https://example.test', '--json']).json, true);
});

test('CLI direct download has no browser requirement and validates selection flags', () => {
  assert.equal(parseOptions(['download', '--media', 'https://example.test/a.m3u8']).direct, true);
  for (const argv of [
    ['download', 'https://example.test', '--all', '--chapters', '1'],
    ['download', 'https://example.test', '--chapters', '0,1'],
    ['download', 'https://example.test', '--wait-login', 'NaN'],
    ['download', 'https://example.test', '--max-height', '0'],
    ['download', 'https://example.test', '--quality', 'wrong'],
    ['download', 'https://example.test', '--browser', 'cdp'],
    ['download', '--media', 'https://example.test/a.mp4', '--all'],
    ['scan', 'https://example.test', '--chapters', '1'],
    ['download', 'https://example.test', '--cookie', 'secret'],
  ]) assert.throws(() => parseOptions(argv));
});

test('CLI rejects credential URLs, browser internals and remote cleartext URLs without echoing them', () => {
  for (const url of ['chrome://extensions', 'chrome-extension://some-id/manager.html', 'file:///tmp/a', 'https://me:private@example.test', 'http://example.test']) {
    assert.throws(() => parseOptions(['scan', url]), error => !error.message.includes('private') && !error.message.includes(url));
  }
  assert.equal(parseOptions(['scan', 'http://127.0.0.1:8000']).url, 'http://127.0.0.1:8000/');
  assert.equal(parseOptions([]).command, 'help');
  assert.equal(parseOptions(['--version']).command, 'version');
});
