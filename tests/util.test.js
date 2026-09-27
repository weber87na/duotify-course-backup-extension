import test from 'node:test';
import assert from 'node:assert/strict';
import {safeName,httpUrl,originPattern,uniqueFile} from '../util.js';

test('Windows filenames retain Chinese and cannot escape a selected directory', () => {
  assert.equal(safeName('../課程:影片?. '), '_課程_影片_');
  assert.equal(safeName('CON.txt'), '_CON.txt');
  assert.equal(safeName('...'), '課程影片');
  assert.ok(!/[\\/]/.test(safeName('a/b\\c')));
});
test('HTTP URL validation preserves signed queries and rejects credentials', () => {
  assert.equal(httpUrl('/video.m3u8?sig=a%2Fb&z=1', 'https://example.test/x'), 'https://example.test/video.m3u8?sig=a%2Fb&z=1');
  assert.equal(originPattern('https://example.test:8443/x?secret=abc'), 'https://example.test:8443/*');
  assert.throws(() => httpUrl('javascript:alert(1)'));
  assert.throws(() => httpUrl('https://name:password@example.test/x'));
});
test('file allocation never overwrites an existing filename', async () => {
  const files = new Set(['課程.ts', '課程 (1).ts']);
  const directory = { async getFileHandle(name, options) {
    if (options?.create) { files.add(name); return {name}; }
    if (files.has(name)) return {name};
    throw new DOMException('missing','NotFoundError');
  }};
  assert.equal((await uniqueFile(directory,'課程.ts')).name, '課程 (2).ts');
  assert.equal((await uniqueFile(directory,'課程.ts')).name, '課程 (3).ts');
});
