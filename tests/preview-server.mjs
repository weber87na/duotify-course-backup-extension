/** Local-only manager integration preview; no dependencies or production edits. */
import { createServer } from 'node:http';
import { createCipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 8765);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 through 65535.');
const allowedFiles = new Map([
  ['/manager.html', ['manager.html', 'text/html; charset=utf-8']],
  ['/manager.js', ['manager.js', 'text/javascript; charset=utf-8']],
  ['/manager.css', ['manager.css', 'text/css; charset=utf-8']],
  ['/hls.js', ['hls.js', 'text/javascript; charset=utf-8']],
  ['/transfer.js', ['transfer.js', 'text/javascript; charset=utf-8']],
  ['/duotify.js', ['duotify.js', 'text/javascript; charset=utf-8']],
  ['/duotify-binding.js', ['duotify-binding.js', 'text/javascript; charset=utf-8']],
  ['/util.js', ['util.js', 'text/javascript; charset=utf-8']],
  ['/tests/browser-mock.js', ['tests/browser-mock.js', 'text/javascript; charset=utf-8']],
]);
const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n本機字幕測試。\n';
// Synthetic fixture key only; it has no relationship to any course or account.
const fixtureKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const firstHighSequence = 17;
const segmentCounts = new Map([
  ['first-high-1.ts', 2], ['first-high-2.ts', 2],
  ['first-low-1.ts', 1], ['first-low-2.ts', 1],
  ['second-1.ts', 2], ['second-2.ts', 2], ['second-3.ts', 2],
]);

function tsPackets(count, marker) {
  const data = Buffer.alloc(188 * count, marker);
  for (let index = 0; index < count; index++) {
    const start = index * 188;
    data[start] = 0x47; data[start + 1] = 0x1f; data[start + 2] = 0xff;
    data[start + 3] = 0x10 | index;
  }
  return data;
}
function mediaPlaylist(origin, prefix, count) {
  return ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:3', '#EXT-X-PLAYLIST-TYPE:VOD',
    ...(prefix === 'first-high' ? [
      `#EXT-X-MEDIA-SEQUENCE:${firstHighSequence}`,
      `#EXT-X-KEY:METHOD=AES-128,URI="${origin}/fixtures/first-high.key"`,
    ] : []),
    ...Array.from({ length: count }, (_, index) => `#EXTINF:3.000,\n${origin}/fixtures/${prefix}-${index + 1}.ts`),
    '#EXT-X-ENDLIST', ''].join('\n');
}
function encryptFirstHigh(data, segmentName) {
  const segmentNumber = Number(/^first-high-(\d+)\.ts$/.exec(segmentName)[1]);
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(firstHighSequence + segmentNumber - 1), 8);
  const cipher = createCipheriv('aes-128-cbc', fixtureKey, iv);
  // Node adds standard PKCS#7 padding; WebCrypto must remove it before writing.
  return Buffer.concat([cipher.update(data), cipher.final()]);
}
function send(response, status, type, body) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  response.writeHead(status, {
    'Content-Type': type, 'Content-Length': data.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  });
  response.end(data);
}

const server = createServer(async (request, response) => {
  try {
    // Do not derive fixture origins from an arbitrary Host header.
    const hostname = request.headers.host?.split(':')[0];
    if (!['localhost', '127.0.0.1'].includes(hostname)) return send(response, 403, 'text/plain', 'Localhost only.');
    const origin = `http://${hostname}:${port}`;
    const target = new URL(request.url, origin);
    if (!['GET', 'HEAD'].includes(request.method)) return send(response, 405, 'text/plain', 'Read-only fixture server.');
    if (target.pathname === '/') {
      response.writeHead(302, { Location: '/manager.html?scan=scan-deadbeef' });
      return response.end();
    }
    const file = allowedFiles.get(target.pathname);
    if (file) {
      let data = await readFile(resolve(root, file[0]));
      if (target.pathname === '/manager.html') {
        data = Buffer.from(data.toString('utf8').replace(
          '<script type="module" src="manager.js"></script>',
          '<script src="/tests/browser-mock.js"></script>\n  <script type="module" src="manager.js"></script>',
        ));
      }
      return send(response, 200, file[1], data);
    }
    if (target.pathname === '/video/watch' && target.searchParams.get('slug') === 'local-fixture' && target.searchParams.get('sectionId') === '290') {
      return send(response, 200, 'text/html; charset=utf-8', '<!doctype html><html lang="zh-Hant"><head><title>第二章</title></head><body><video data-src="/fixtures/second.m3u8"></video></body></html>');
    }
    if (target.pathname === '/fixtures/first.m3u8') {
      return send(response, 200, 'application/vnd.apple.mpegurl', [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"',
        `${origin}/fixtures/first-high.m3u8`,
        '#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"',
        `${origin}/fixtures/first-low.m3u8`, '',
      ].join('\n'));
    }
    for (const [name, count] of [['first-high', 2], ['first-low', 2], ['second', 3]]) {
      if (target.pathname === `/fixtures/${name}.m3u8`) return send(response, 200, 'application/vnd.apple.mpegurl', mediaPlaylist(origin, name, count));
    }
    if (target.pathname === '/fixtures/first.vtt') return send(response, 200, 'text/vtt; charset=utf-8', vtt);
    if (target.pathname === '/fixtures/first-high.key') return send(response, 200, 'application/octet-stream', fixtureKey);
    const segmentName = target.pathname.startsWith('/fixtures/') ? target.pathname.slice('/fixtures/'.length) : '';
    if (segmentCounts.has(segmentName)) {
      const data = tsPackets(segmentCounts.get(segmentName), segmentName.length);
      const encrypted = segmentName.startsWith('first-high-');
      return send(response, 200, encrypted ? 'application/octet-stream' : 'video/mp2t', encrypted ? encryptFirstHigh(data, segmentName) : data);
    }
    return send(response, 404, 'text/plain', 'Fixture not found.');
  } catch (error) {
    console.error('Local fixture server:', error.message);
    if (!response.headersSent) send(response, 500, 'text/plain', 'Fixture server error.');
    else response.end();
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Local integration preview: http://localhost:${port}/manager.html?scan=scan-deadbeef`);
  console.log('Only synthetic fixtures are served; all saved files stay in browser memory.');
});
