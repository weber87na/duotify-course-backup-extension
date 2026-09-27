import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHls, HlsParseError, UnsupportedHlsError } from '../hls.js';

const base = 'https://learn.example.test/media/master.m3u8?token=secret';
const vod = (...lines) => ['#EXTM3U', '#EXT-X-TARGETDURATION:10', ...lines, '#EXT-X-ENDLIST'].join('\n');
const fails = (text, feature) => assert.throws(() => parseHls(text, base), (error) => {
  assert.ok(error instanceof UnsupportedHlsError);
  assert.equal(error.feature, feature);
  return true;
});

test('finite TS preserves order, relative URL semantics, query tokens and durations', () => {
  const result = parseHls('\uFEFF' + vod(
    '#EXT-X-VERSION:3', '#EXT-X-MEDIA-SEQUENCE:41', '#EXT-X-KEY:METHOD=NONE',
    '#EXTINF:9.125,First, title', 'part-41.ts?sig=one',
    '#EXTINF:2.5,', 'https://cdn.example.test/part-42.ts?sig=two',
  ).replaceAll('\n', '\r\n'), base);
  assert.equal(result.type, 'media');
  assert.equal(result.format, 'ts');
  assert.equal(result.duration, 11.625);
  assert.equal(result.mediaSequence, 41);
  assert.equal(result.targetDuration, 10);
  assert.deepEqual(result.segments.map(({ url }) => url), [
    'https://learn.example.test/media/part-41.ts?sig=one',
    'https://cdn.example.test/part-42.ts?sig=two',
  ]);
  assert.equal(result.map, null);
  assert.equal(result.segments[0].byteRange, null);
  assert.equal(result.segments[0].encryption, null);
});

test('master parses quoted comma values and resolves variant URLs without inheriting query', () => {
  const result = parseHls([
    '#EXTM3U', '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-STREAM-INF:BANDWIDTH=3500000,AVERAGE-BANDWIDTH=3200000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",NAME="High, Full HD"',
    'high/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    '/low.m3u8?sig=a%2Fb',
  ].join('\n'), base);
  assert.equal(result.type, 'master');
  assert.equal(result.variants[0].width, 1920);
  assert.equal(result.variants[0].height, 1080);
  assert.equal(result.variants[0].averageBandwidth, 3200000);
  assert.equal(result.variants[0].codecs, 'avc1.640028,mp4a.40.2');
  assert.equal(result.variants[0].name, 'High, Full HD');
  assert.equal(result.variants[0].url, 'https://learn.example.test/media/high/index.m3u8');
  assert.equal(result.variants[1].url, 'https://learn.example.test/low.m3u8?sig=a%2Fb');
});

test('explicit and implicit byte ranges resolve to absolute offsets', () => {
  const result = parseHls(vod(
    '#EXTINF:5,', '#EXT-X-BYTERANGE:100@20', 'all.ts?sig=x',
    '#EXTINF:5,', '#EXT-X-BYTERANGE:60', 'all.ts?sig=x',
  ), base);
  assert.deepEqual(result.segments.map(({ byteRange }) => byteRange), [
    { offset: 20, length: 100 }, { offset: 120, length: 60 },
  ]);
});

test('implicit byte range cannot accidentally refer to another resource or a whole-file segment', () => {
  for (const text of [
    vod('#EXTINF:1,', '#EXT-X-BYTERANGE:4', 'one.ts'),
    vod('#EXTINF:1,', '#EXT-X-BYTERANGE:4@0', 'one.ts', '#EXTINF:1,', '#EXT-X-BYTERANGE:4', 'two.ts'),
    vod('#EXTINF:1,', 'one.ts', '#EXTINF:1,', '#EXT-X-BYTERANGE:4', 'one.ts'),
    vod('#EXTINF:1,', '#EXT-X-BYTERANGE:9007199254740991@1', 'one.ts'),
  ]) assert.throws(() => parseHls(text, base), HlsParseError);
});

test('fMP4 uses one stable map with an explicit map range', () => {
  const result = parseHls(vod(
    '#EXT-X-MAP:URI="all.mp4",BYTERANGE="100@0"',
    '#EXTINF:5,', '#EXT-X-BYTERANGE:250@100', 'all.mp4',
    '#EXT-X-MAP:URI="all.mp4",BYTERANGE="100@0"',
    '#EXTINF:5,', '#EXT-X-BYTERANGE:180', 'all.mp4',
  ), base);
  assert.equal(result.format, 'fmp4');
  assert.deepEqual(result.map, { url: 'https://learn.example.test/media/all.mp4', byteRange: { offset: 0, length: 100 }, encryption: null });
  assert.deepEqual(result.segments.map(({ byteRange }) => byteRange), [{ offset: 100, length: 250 }, { offset: 350, length: 180 }]);
  for (const segment of result.segments) assert.deepEqual(segment.map, result.map);
});

test('changing or late initialization maps never produce a corrupt single file', () => {
  fails(vod('#EXT-X-MAP:URI="init.mp4"', '#EXTINF:1,', 'a.m4s', '#EXT-X-MAP:URI="other.mp4"', '#EXTINF:1,', 'b.m4s'), 'changing-map');
  fails(vod('#EXTINF:1,', 'a.m4s', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:1,', 'b.m4s'), 'changing-map');
  fails(vod('#EXT-X-MAP:URI="init.mp4",BYTERANGE="100"', '#EXTINF:1,', 'a.m4s'), 'map-byte-range');
});

test('AES-128 default IV preserves media sequence bits above 32 bits and increments per segment', () => {
  const result = parseHls(vod(
    '#EXT-X-MEDIA-SEQUENCE:4294967295',
    '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin?sig=test"',
    '#EXTINF:1,', 'a.ts', '#EXTINF:1,', 'b.ts', '#EXTINF:1,', 'c.ts',
  ), base);
  assert.deepEqual(result.segments.map(({ encryption }) => encryption.iv), [
    [...new Array(12).fill(0), 255, 255, 255, 255],
    [...new Array(11).fill(0), 1, 0, 0, 0, 0],
    [...new Array(11).fill(0), 1, 0, 0, 0, 1],
  ]);
  assert.equal(result.segments[0].encryption.method, 'AES-128');
  assert.equal(result.segments[0].encryption.url, 'https://learn.example.test/media/keys/key.bin?sig=test');
  const maxSequence = parseHls(vod(
    '#EXT-X-MEDIA-SEQUENCE:9007199254740991',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    '#EXTINF:1,', 'a.ts', '#EXTINF:1,', 'b.ts', '#EXTINF:1,', 'c.ts',
  ), base);
  assert.deepEqual(maxSequence.segments[2].encryption.iv, [...new Array(9).fill(0), 32, 0, 0, 0, 0, 0, 1]);
});

test('explicit AES-128 IV, key rotation, and METHOD=NONE retain independent encryption snapshots', () => {
  const result = parseHls(vod(
    '#EXT-X-KEY:METHOD=AES-128,URI="one.key",IV=0xabc,KEYFORMAT="identity",KEYFORMATVERSIONS="1"',
    '#EXTINF:1,', 'a.ts', '#EXTINF:1,', 'b.ts',
    '#EXT-X-KEY:METHOD=AES-128,URI="two.key",IV=0X00112233445566778899AABBCCDDEEFF',
    '#EXTINF:1,', 'c.ts',
    '#EXT-X-KEY:METHOD=NONE', '#EXTINF:1,', 'd.ts',
    '#EXT-X-KEY:METHOD=AES-128,URI="three.key"', '#EXTINF:1,', 'e.ts',
  ), base);
  const keys = result.segments.map(({ encryption }) => encryption);
  assert.deepEqual(keys[0].iv, [...new Array(14).fill(0), 10, 188]);
  assert.deepEqual(keys[1], keys[0]);
  assert.notEqual(keys[1], keys[0]);
  assert.notEqual(keys[1].iv, keys[0].iv);
  assert.equal(keys[2].url, 'https://learn.example.test/media/two.key');
  assert.deepEqual(keys[2].iv, Array.from({ length: 16 }, (_, index) => index * 17));
  assert.equal(keys[3], null);
  assert.equal(keys[4].iv[15], 4);
  keys[0].iv[0] = 99;
  assert.equal(keys[1].iv[0], 0);
});

test('encrypted fMP4 maps require an explicit IV and preserve their key when segment keys change', () => {
  const result = parseHls(vod(
    '#EXT-X-KEY:METHOD=AES-128,URI="init.key",IV=0x1',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-KEY:METHOD=AES-128,URI="segment.key"',
    '#EXTINF:1,', 'a.m4s', '#EXTINF:1,', 'b.m4s',
  ), base);
  assert.equal(result.format, 'fmp4');
  assert.equal(result.map.encryption.url, 'https://learn.example.test/media/init.key');
  assert.deepEqual(result.map.encryption.iv, [...new Array(15).fill(0), 1]);
  assert.equal(result.segments[0].encryption.url, 'https://learn.example.test/media/segment.key');
  assert.equal(result.segments[0].encryption.iv[15], 0);
  assert.equal(result.segments[1].encryption.iv[15], 1);
  assert.throws(() => parseHls(vod(
    '#EXT-X-KEY:METHOD=AES-128,URI="init.key"', '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:1,', 'a.m4s',
  ), base), HlsParseError);
  fails(vod(
    '#EXT-X-KEY:METHOD=AES-128,URI="one.key",IV=0x1', '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:1,', 'a.m4s',
    '#EXT-X-KEY:METHOD=AES-128,URI="two.key",IV=0x1', '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:1,', 'b.m4s',
  ), 'changing-map');
});

test('unsupported encryption methods, key formats, and session keys have precise errors', () => {
  for (const method of ['SAMPLE-AES', 'SAMPLE-AES-CTR', 'AES-256']) {
    fails(vod(`#EXT-X-KEY:METHOD=${method},URI="key.bin"`, '#EXTINF:1,', 'a.ts'), 'encryption-method');
  }
  for (const format of ['com.apple.streamingkeydelivery', 'urn:uuid:example', '']) {
    fails(vod(`#EXT-X-KEY:METHOD=AES-128,URI="key.bin",KEYFORMAT="${format}"`, '#EXTINF:1,', 'a.ts'), 'key-format');
  }
  fails(vod('#EXT-X-KEY:METHOD=AES-128,URI="key.bin",KEYFORMATVERSIONS="2"', '#EXTINF:1,', 'a.ts'), 'key-format-version');
  fails('#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-STREAM-INF:BANDWIDTH=100\nmain.m3u8', 'session-key');
});

test('invalid or unsafe AES-128 key metadata is rejected before downloading', () => {
  for (const key of [
    'URI="key.bin"', 'METHOD=AES-128', 'METHOD=AES-128,URI=""',
    'METHOD=NONE,URI="bad"', 'METHOD=NONE,IV=0x1',
    ...['0x', 'xyz', '0xGG', '0x' + '1'.repeat(33), '-0x1'].map((iv) => `METHOD=AES-128,URI="key.bin",IV=${iv}`),
    'METHOD=AES-128,URI="key.bin",IV=""',
    'METHOD=AES-128,URI="key.bin",KEYFORMATVERSIONS="0"',
    'METHOD=AES-128,URI="key.bin",KEYFORMATVERSIONS="1/"',
    'METHOD=AES-128,URI="key.bin#fragment"',
  ]) assert.throws(() => parseHls(vod(`#EXT-X-KEY:${key}`, '#EXTINF:1,', 'a.ts'), base), HlsParseError);
  for (const uri of ['data:application/octet-stream;base64,AAAA', 'file:///key.bin', 'https://user:pass@example.test/key.bin']) {
    fails(vod(`#EXT-X-KEY:METHOD=AES-128,URI="${uri}"`, '#EXTINF:1,', 'a.ts'), 'url-scheme');
  }
});

test('embedded encryption declarations in comments are never mislabeled as clear media', () => {
  for (const line of ['##EXT-X-KEY:METHOD=AES-128,URI="key.bin"', '# note #EXT-X-KEY:METHOD=AES-128,URI="key.bin"']) {
    fails(vod(line, '#EXTINF:1,', 'a.ts'), 'embedded-key');
  }
});

test('separate audio and subtitle groups are rejected while in-band audio is retained', () => {
  for (const type of ['AUDIO', 'SUBTITLES']) {
    fails(`#EXTM3U\n#EXT-X-MEDIA:TYPE=${type},GROUP-ID="group",NAME="Track",URI="track.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100,${type}="group"\nmain.m3u8`, 'separate-renditions');
  }
  const result = parseHls('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Main"\n#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO="a"\nmain.m3u8', base);
  assert.equal(result.type, 'master');
  fails('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO="missing"\nmain.m3u8', 'separate-renditions');
});

test('unfinished, discontinuous, incomplete and low-latency streams fail clearly', () => {
  fails('#EXTM3U\n#EXTINF:1,\na.ts', 'live');
  fails(vod('#EXTINF:1,', 'a.ts', '#EXT-X-DISCONTINUITY', '#EXTINF:1,', 'b.ts'), 'discontinuity');
  fails(vod('#EXT-X-GAP', '#EXTINF:1,', 'a.ts'), 'gap');
  fails(vod('#EXT-X-I-FRAMES-ONLY', '#EXTINF:1,', 'a.ts'), 'iframes');
  for (const tag of ['EXT-X-PART:DURATION=1,URI="a.ts"', 'EXT-X-SKIP:SKIPPED-SEGMENTS=2', 'EXT-X-PRELOAD-HINT:TYPE=PART,URI="a.ts"']) {
    fails(vod(`#${tag}`, '#EXTINF:1,', 'a.ts'), 'low-latency');
  }
});

test('unsupported containers and missing fMP4 map are rejected', () => {
  fails(vod('#EXTINF:1,', 'a.m4s'), 'missing-map');
  fails(vod('#EXTINF:1,', 'a.vtt'), 'container');
  fails(vod('#EXTINF:1,', 'a.ts', '#EXTINF:1,', 'b.mp4'), 'container');
  fails(vod('#EXT-X-MAP:URI="init.ts"', '#EXTINF:1,', 'a.ts'), 'container');
});

test('unsafe URI schemes, embedded credentials and variables do not reach the downloader', () => {
  for (const url of ['file:///private', 'data:text/plain,secret', 'javascript:alert(1)', 'https://user:pass@example.test/a.ts']) {
    fails(vod('#EXTINF:1,', url), 'url-scheme');
  }
  fails(vod('#EXTINF:1,', '{$cdn}/a.ts'), 'variables');
  fails(vod('#EXT-X-DEFINE:NAME="cdn",VALUE="https://example.test"', '#EXTINF:1,', 'a.ts'), 'variables');
});

test('malformed inputs never silently become successful downloads', () => {
  for (const text of [
    '<html>Please log in</html>', '#EXTM3U\n#EXT-X-ENDLIST',
    vod('#EXTINF:4,'), vod('a.ts'), vod('#EXTINF:NaN,', 'a.ts'),
    vod('#EXTINF:1,', '#EXTINF:2,', 'a.ts'),
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,BANDWIDTH=200\na.m3u8',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,CODECS="broken\na.m3u8',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,\na.m3u8',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\na.m3u8\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST',
  ]) assert.throws(() => parseHls(text, base), HlsParseError);
});
