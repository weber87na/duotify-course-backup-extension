import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const entry = fileURLToPath(new URL('../cli/index.js', import.meta.url));

async function runCli(args) {
  try {
    const result = await execute(process.execPath, [entry, ...args], {
      cwd: projectDirectory, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return { code: 0, ...result };
  } catch (error) {
    if (!Number.isInteger(error.code)) throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function temporaryDirectory(t) {
  const root = resolve(tmpdir());
  const directory = await mkdtemp(join(root, 'course-cli-smoke-'));
  // Cleanup is restricted to the exact directory allocated by this test.
  assert.equal(dirname(directory), root);
  assert.ok(basename(directory).startsWith('course-cli-smoke-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function transportStream(value) {
  const bytes = new Uint8Array(376).fill(value);
  bytes[0] = bytes[188] = 0x47;
  return bytes;
}

async function fixtureServer(t) {
  const keyBytes = new Uint8Array(16).fill(17);
  const iv = Uint8Array.from({ length: 16 }, (_, index) => index);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt']);
  const plaintext = [transportStream(1), transportStream(2)];
  const encrypted = await Promise.all(plaintext.map(bytes => crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, bytes)));
  const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x000102030405060708090a0b0c0d0e0f\n#EXTINF:3,\none.ts\n#EXTINF:3,\ntwo.ts\n#EXT-X-ENDLIST\n';
  const invalidPlaylist = '#EXTM3U\n#EXTINF:3,\ninvalid.ts\n#EXT-X-ENDLIST\n';
  const subtitle = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n本機測試字幕\n';
  const resources = new Map([
    ['/video.m3u8', ['application/vnd.apple.mpegurl', playlist]],
    ['/key.bin', ['application/octet-stream', keyBytes]],
    ['/one.ts', ['video/mp2t', Buffer.from(encrypted[0])]],
    ['/two.ts', ['video/mp2t', Buffer.from(encrypted[1])]],
    ['/captions.vtt', ['text/vtt; charset=utf-8', subtitle]],
    ['/invalid.m3u8', ['application/vnd.apple.mpegurl', invalidPlaylist]],
    ['/invalid.ts', ['video/mp2t', 'not a transport stream']],
  ]);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, cookie: request.headers.cookie, authorization: request.headers.authorization });
    const resource = resources.get(request.url);
    if (!resource) { response.writeHead(404); response.end(); return; }
    const [mime, body] = resource;
    response.writeHead(200, { 'content-type': mime, 'content-length': Buffer.byteLength(body) });
    response.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose());
    server.closeAllConnections();
  }));
  return { origin: `http://127.0.0.1:${server.address().port}`, plaintext: Buffer.concat(plaintext), subtitle, requests };
}

test('real CLI subprocess decrypts local AES HLS and saves subtitle with JSON results', async t => {
  const directory = await temporaryDirectory(t);
  const fixture = await fixtureServer(t);
  const outputDir = join(directory, 'downloads');
  const video = await runCli(['download', '--media', `${fixture.origin}/video.m3u8`, '--out', outputDir, '--title', '合成影片', '--json']);
  assert.equal(video.code, 0, video.stderr);
  const report = JSON.parse(video.stdout);
  assert.equal(report.completed.length, 1);
  assert.deepEqual(report.failed, []);
  assert.equal(report.completed[0].bytes, fixture.plaintext.length);
  assert.equal(report.completed[0].segments, 2);
  assert.equal(report.completed[0].path, join(outputDir, '合成影片.ts'));
  assert.deepEqual(await readFile(report.completed[0].path), fixture.plaintext);

  const captions = await runCli(['download', '--media', `${fixture.origin}/captions.vtt`, '--out', outputDir, '--title', '合成字幕', '--json']);
  assert.equal(captions.code, 0, captions.stderr);
  const subtitleReport = JSON.parse(captions.stdout);
  assert.equal(subtitleReport.completed.length, 1);
  assert.deepEqual(subtitleReport.failed, []);
  assert.equal(await readFile(subtitleReport.completed[0].path, 'utf8'), fixture.subtitle);
  assert.deepEqual((await readdir(outputDir)).sort(), ['合成字幕.vtt', '合成影片.ts']);
  assert.deepEqual(fixture.requests.map(request => request.path), ['/video.m3u8', '/key.bin', '/one.ts', '/two.ts', '/captions.vtt']);
  assert.ok(fixture.requests.every(request => request.cookie === undefined && request.authorization === undefined));
});

test('real CLI subprocess rejects invalid first segment with exit 1 and no output artifacts', async t => {
  const directory = await temporaryDirectory(t);
  const fixture = await fixtureServer(t);
  const result = await runCli(['download', '--media', `${fixture.origin}/invalid.m3u8`, '--out', directory, '--title', '無效影片', '--json']);
  assert.equal(result.code, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.completed, []);
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].reason, /MPEG-TS/);
  assert.deepEqual(await readdir(directory), []);
});

test('real CLI --help and --version succeed without starting a browser', async () => {
  const packageData = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const help = await runCli(['--help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /course-backup download/);
  const version = await runCli(['--version']);
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout.trim(), packageData.version);
});
