import test from 'node:test';
import assert from 'node:assert/strict';
import { transferHls } from '../transfer.js';

const url = name => `https://media.example.test/${name}`;
const ts = (value = 1) => {
  const bytes = new Uint8Array(376).fill(value);
  bytes[0] = bytes[188] = 0x47;
  return bytes;
};
function box(type, payload = new Uint8Array(4)) {
  const bytes = new Uint8Array(payload.length + 8);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set([...type].map(letter => letter.charCodeAt(0)), 4);
  bytes.set(payload, 8);
  return bytes;
}
function concat(...parts) {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
const playlist = (count = 2) => ({
  type: 'media', endList: true, format: 'ts', map: null,
  segments: Array.from({ length: count }, (_, index) => ({ url: url(`${index}.ts`), duration: 3, byteRange: null, map: null })),
});
function destination() {
  const writes = [];
  return {
    writes,
    async write(bytes) { writes.push(bytes.slice()); },
    close() { assert.fail('The caller owns close.'); },
    abort() { assert.fail('The caller owns abort.'); },
  };
}

const aesKey = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
const aesInfo = (sequence = 0, keyName = 'key.bin') => ({
  method: 'AES-128', url: url(keyName), iv: [...new Uint8Array(15), sequence],
});
async function encrypt(bytes, encryption, rawKey = aesKey) {
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-CBC', false, ['encrypt']);
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(encryption.iv) }, key, bytes));
}

test('writes segments in order, includes credentials, reports committed progress', async () => {
  const writable = destination();
  const requests = [];
  const progress = [];
  const result = await transferHls({ playlist: playlist(), writable, onProgress: value => progress.push(value),
    fetchImpl: async (target, options) => {
      requests.push(target);
      assert.equal(options.credentials, 'include');
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(writable.writes.length, requests.length - 1);
      return new Response(ts(requests.length));
    },
  });
  assert.deepEqual(requests, [url('0.ts'), url('1.ts')]);
  assert.deepEqual(writable.writes, [ts(1), ts(2)]);
  assert.deepEqual(result, { bytes: 752, segments: 2 });
  assert.deepEqual(progress, [{ completed: 0, total: 2, bytes: 0 }, { completed: 1, total: 2, bytes: 376 }, { completed: 2, total: 2, bytes: 752 }]);
});

test('retries a failed response body without writing duplicate partial bytes', async () => {
  const writable = destination();
  let calls = 0;
  await transferHls({ playlist: playlist(1), writable, fetchImpl: async () => {
    calls++;
    if (calls === 1) {
      let reads = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (reads++ === 0) controller.enqueue(ts().subarray(0, 188));
        else controller.error(new Error('secret signed URL must not leak'));
      } }));
    }
    assert.equal(writable.writes.length, 0);
    return new Response(ts());
  } });
  assert.equal(calls, 2);
  assert.deepEqual(writable.writes, [ts()]);
});

test('retries 429 and 5xx up to three total attempts', async () => {
  let calls = 0;
  const writable = destination();
  await transferHls({ playlist: playlist(1), writable, fetchImpl: async () => {
    calls++;
    return calls < 3 ? new Response('', { status: calls === 1 ? 429 : 503 }) : new Response(ts());
  } });
  assert.equal(calls, 3);
  assert.equal(writable.writes.length, 1);
});

for (const status of [401, 403, 404]) {
  test(`does not retry HTTP ${status}`, async () => {
    let calls = 0;
    const writable = destination();
    await assert.rejects(transferHls({ playlist: playlist(1), writable,
      fetchImpl: async () => { calls++; return new Response('', { status }); },
    }), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
    assert.equal(writable.writes.length, 0);
  });
}

test('rejects HTML content types and HTML disguised as binary before writing', async () => {
  for (const contentType of ['text/html', 'text/plain', 'application/octet-stream']) {
    const writable = destination();
    let calls = 0;
    await assert.rejects(transferHls({ playlist: playlist(1), writable,
      fetchImpl: async () => { calls++; return new Response('<html>Sign in</html>', { headers: { 'content-type': contentType } }); },
    }), /網頁或文字|不是支援的 MPEG-TS/);
    assert.equal(calls, 1);
    assert.equal(writable.writes.length, 0);
  }
});

test('allows valid TS bytes mislabeled as text/plain', async () => {
  const writable = destination();
  const result = await transferHls({ playlist: playlist(1), writable,
    fetchImpl: async () => new Response(ts(), { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
  });
  assert.deepEqual(writable.writes, [ts()]);
  assert.deepEqual(result, { bytes: 376, segments: 1 });
});

test('validates Range request, Content-Range, and exact response length', async () => {
  const media = playlist(1);
  media.segments[0].byteRange = { offset: 100, length: 376 };
  const writable = destination();
  await transferHls({ playlist: media, writable, fetchImpl: async (_, options) => {
    assert.equal(options.headers.Range, 'bytes=100-475');
    return new Response(ts(), { status: 206, headers: { 'Content-Range': 'bytes 100-475/1000' } });
  } });
  assert.deepEqual(writable.writes, [ts()]);
  for (const [status, range, data] of [
    [200, null, ts()], [206, 'bytes 0-375/1000', ts()], [206, 'bytes 100-475/400', ts()],
    [206, 'bytes 100-475/1000', concat(ts(), ts())],
  ]) {
    const output = destination();
    await assert.rejects(transferHls({ playlist: media, writable: output, fetchImpl: async () => new Response(data, {
      status, headers: range ? { 'Content-Range': range } : {},
    }) }), /位元組範圍/);
    assert.equal(output.writes.length, 0);
  }
});

test('retries truncated range bodies but never writes them', async () => {
  const media = playlist(1);
  media.segments[0].byteRange = { offset: 0, length: 376 };
  let calls = 0;
  const writable = destination();
  await assert.rejects(transferHls({ playlist: media, writable, fetchImpl: async () => {
    calls++;
    return new Response(ts().subarray(0, 188), { status: 206, headers: { 'Content-Range': 'bytes 0-375/1000' } });
  } }), /長度不正確/);
  assert.equal(calls, 3);
  assert.equal(writable.writes.length, 0);
});

test('outer cancellation aborts an in-flight request and is never retried', async () => {
  const controller = new AbortController();
  const writable = destination();
  let calls = 0;
  const pending = transferHls({ playlist: playlist(1), writable, signal: controller.signal,
    fetchImpl: async (_, options) => {
      calls++;
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    },
  });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal(writable.writes.length, 0);
});

test('cancellation stops a retry backoff immediately', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = transferHls({ playlist: playlist(1), writable: destination(), signal: controller.signal,
    fetchImpl: async () => { calls++; return new Response('', { status: 503 }); },
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('cancellation after writing a segment prevents subsequent downloads', async () => {
  const controller = new AbortController();
  let calls = 0;
  let writes = 0;
  await assert.rejects(transferHls({ playlist: playlist(), signal: controller.signal,
    writable: { async write() { writes++; controller.abort(); } },
    fetchImpl: async () => { calls++; return new Response(ts()); },
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal(writes, 1);
});

test('timeout covers stalled response bodies and stops after three attempts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const writable = destination();
  const pending = transferHls({ playlist: playlist(1), writable,
    fetchImpl: async (_, options) => {
      calls++;
      return new Response(new ReadableStream({ start(stream) {
        options.signal.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), { once: true });
      } }));
    },
  });
  const rejection = assert.rejects(pending, /下載逾時/);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(calls, attempt + 1);
    t.mock.timers.tick(45_000);
    await flush();
    if (attempt < 2) {
      t.mock.timers.tick(200 * 2 ** attempt);
      await flush();
    }
  }
  await rejection;
  assert.equal(calls, 3);
  assert.equal(writable.writes.length, 0);
});

test('a destination write failure is propagated without re-fetching media', async () => {
  let calls = 0;
  const diskError = new Error('Destination disk is full.');
  await assert.rejects(transferHls({ playlist: playlist(),
    writable: { async write() { throw diskError; } },
    fetchImpl: async () => { calls++; return new Response(ts()); },
  }), error => error === diskError);
  assert.equal(calls, 1);
});

test('writes one initialization map then valid fragmented MP4 segments', async () => {
  const map = { url: url('init.mp4'), byteRange: null };
  const media = { ...playlist(), format: 'fmp4', map };
  media.segments.forEach(segment => { segment.map = { ...map }; });
  const init = concat(box('ftyp'), box('moov'));
  const fragment = concat(box('styp'), box('moof'), box('mdat'));
  const requests = [];
  const writable = destination();
  const result = await transferHls({ playlist: media, writable, fetchImpl: async target => {
    requests.push(target);
    return new Response(target === map.url ? init : fragment);
  } });
  assert.deepEqual(requests, [map.url, url('0.ts'), url('1.ts')]);
  assert.deepEqual(writable.writes, [init, fragment, fragment]);
  assert.equal(result.bytes, init.length + fragment.length * 2);
});

test('rejects changing maps and unsafe URLs before fetching or writing', async () => {
  const map = { url: url('init.mp4'), byteRange: null };
  const media = { ...playlist(), format: 'fmp4', map };
  media.segments[1].map = { url: url('different.mp4'), byteRange: null };
  for (const sample of [media, { ...playlist(1), segments: [{ url: 'file:///secret.ts' }] }]) {
    await assert.rejects(transferHls({ playlist: sample, writable: destination(), fetchImpl: async () => assert.fail('No request expected') }));
  }
});

test('rejects malformed MP4 before writing its segment', async () => {
  const map = { url: url('init.mp4'), byteRange: null };
  const media = { ...playlist(1), format: 'fmp4', map };
  const invalid = box('moof');
  new DataView(invalid.buffer).setUint32(0, 1000);
  const writable = destination();
  await assert.rejects(transferHls({ playlist: media, writable,
    fetchImpl: async target => new Response(target === map.url ? box('moov') : invalid),
  }), /資料區塊無效或不完整/);
  assert.equal(writable.writes.length, 1);
});

test('rejects zero-size MP4 boxes that would consume later concatenated fragments', async () => {
  const map = { url: url('init.mp4'), byteRange: null };
  const media = { ...playlist(1), format: 'fmp4', map };
  const openEnded = type => {
    const bytes = box(type);
    new DataView(bytes.buffer).setUint32(0, 0);
    return bytes;
  };
  // The same unsafe form may appear in either the map or a media fragment.
  for (const initialization of [true, false]) {
    const writable = destination();
    await assert.rejects(transferHls({ playlist: media, writable,
      fetchImpl: async target => new Response(target === map.url
        ? initialization ? openEnded('moov') : box('moov')
        : concat(box('moof'), openEnded('mdat'))),
    }), /未指定長度，無法安全合併/);
    assert.equal(writable.writes.length, initialization ? 0 : 1);
  }
});

test('network error messages do not leak signed media URLs', async () => {
  await assert.rejects(transferHls({ playlist: playlist(1), writable: destination(),
    fetchImpl: async () => { throw new Error('https://host.test/video?secret=123'); },
  }), error => error.message === '網路錯誤中斷了影片下載。');
});

test('decrypts AES-128 segments with their IVs, reuses keys, then writes clear segments', async () => {
  const media = playlist(3);
  media.segments[0].encryption = aesInfo(17);
  media.segments[1].encryption = aesInfo(18);
  media.segments[2].encryption = null;
  const encrypted = await Promise.all(media.segments.slice(0, 2).map((segment, index) => encrypt(ts(index + 1), segment.encryption)));
  const requests = [];
  const writable = destination();
  const progress = [];
  const result = await transferHls({ playlist: media, writable, onProgress: item => progress.push(item), fetchImpl: async (target, options) => {
    requests.push(target);
    assert.equal(options.credentials, 'include');
    assert.ok(options.signal instanceof AbortSignal);
    const data = target === url('key.bin') ? aesKey : target === url('0.ts') ? encrypted[0] : target === url('1.ts') ? encrypted[1] : ts(3);
    return new Response(data, { headers: { 'content-type': 'text/plain' } });
  } });
  assert.deepEqual(requests, [url('key.bin'), url('0.ts'), url('1.ts'), url('2.ts')]);
  assert.deepEqual(writable.writes, [ts(1), ts(2), ts(3)]);
  assert.deepEqual(result, { bytes: 1128, segments: 3 });
  assert.deepEqual(progress.at(-1), { completed: 3, total: 3, bytes: 1128 });
});

test('does not retain an AES key between separate transfers', async () => {
  const media = playlist(1);
  media.segments[0].encryption = aesInfo();
  const encrypted = await encrypt(ts(), aesInfo());
  let keyRequests = 0;
  const fetchImpl = async target => {
    if (target === url('key.bin')) { keyRequests++; return new Response(aesKey); }
    return new Response(encrypted);
  };
  for (let index = 0; index < 2; index++) {
    await transferHls({ playlist: media, writable: destination(), fetchImpl });
  }
  assert.equal(keyRequests, 2);
});

test('downloads a new key for an AES-128 key URI rotation', async () => {
  const media = playlist();
  const secondKey = new Uint8Array(16).fill(19);
  const requests = [];
  media.segments[0].encryption = aesInfo(0, 'first.key');
  media.segments[1].encryption = aesInfo(1, 'second.key');
  const encrypted = [await encrypt(ts(1), media.segments[0].encryption), await encrypt(ts(2), media.segments[1].encryption, secondKey)];
  const writable = destination();
  await transferHls({ playlist: media, writable, fetchImpl: async target => {
    requests.push(target);
    return new Response(target === url('first.key') ? aesKey : target === url('second.key') ? secondKey : target === url('0.ts') ? encrypted[0] : encrypted[1]);
  } });
  assert.deepEqual(requests, [url('first.key'), url('0.ts'), url('second.key'), url('1.ts')]);
  assert.deepEqual(writable.writes, [ts(1), ts(2)]);
});

test('decrypts and validates encrypted MP4 initialization maps and fragments', async () => {
  const map = { url: url('init.mp4'), byteRange: null, encryption: aesInfo(5) };
  const media = { ...playlist(1), format: 'fmp4', map };
  media.segments[0].map = { ...map };
  media.segments[0].encryption = aesInfo(6);
  const init = concat(box('ftyp'), box('moov'));
  const fragment = concat(box('moof'), box('mdat'));
  const encryptedInit = await encrypt(init, map.encryption);
  const encryptedFragment = await encrypt(fragment, media.segments[0].encryption);
  const writable = destination();
  await transferHls({ playlist: media, writable, fetchImpl: async target => new Response(target === url('key.bin') ? aesKey : target === map.url ? encryptedInit : encryptedFragment) });
  assert.deepEqual(writable.writes, [init, fragment]);
});

test('rejects invalid AES keys, padding, ciphertext length and decrypted non-media before writing', async () => {
  const media = playlist(1);
  media.segments[0].encryption = aesInfo();
  const encrypted = await encrypt(ts(), aesInfo());
  const badPadding = encrypted.slice();
  // Flip the previous CBC block to make the final padding byte zero.
  badPadding[badPadding.length - 17] ^= 8;
  const cases = [
    [new Uint8Array(15), encrypted, /金鑰必須恰為 16/],
    [new Uint8Array(17), encrypted, /金鑰必須恰為 16/],
    [new Uint8Array(16).fill(77), encrypted, /解密失敗|MPEG-TS/],
    [aesKey, badPadding, /解密失敗/],
    [aesKey, encrypted.subarray(0, -1), /長度無效或不完整/],
    [aesKey, await encrypt(new TextEncoder().encode('<html>Sign in</html>'), aesInfo()), /不是支援的 MPEG-TS/],
  ];
  for (const [keyBytes, cipher, expected] of cases) {
    const writable = destination();
    let calls = 0;
    await assert.rejects(transferHls({ playlist: media, writable, fetchImpl: async target => {
      calls++;
      return new Response(target === url('key.bin') ? keyBytes : cipher);
    } }), expected);
    assert.equal(calls, keyBytes.length === 16 ? 2 : 1);
    assert.equal(writable.writes.length, 0);
  }
});

test('rejects invalid encryption declarations and encrypted byte ranges before requesting keys', async () => {
  const samples = [
    { ...aesInfo(), method: 'SAMPLE-AES' },
    { ...aesInfo(), url: 'file:///key.bin' },
    { ...aesInfo(), iv: new Array(16) },
    { ...aesInfo(), iv: [...new Uint8Array(15), 256] },
    { ...aesInfo(), iv: [0] },
  ];
  for (const encryption of samples) {
    const media = playlist(1);
    media.segments[0].encryption = encryption;
    await assert.rejects(transferHls({ playlist: media, writable: destination(), fetchImpl: () => assert.fail('No request expected') }));
  }
  const media = playlist(1);
  media.segments[0].encryption = aesInfo();
  media.segments[0].byteRange = { offset: 0, length: 384 };
  await assert.rejects(transferHls({ playlist: media, writable: destination(), fetchImpl: () => assert.fail('No request expected') }), /加密 HLS 的位元組範圍/);
});

test('rejects changing an encrypted initialization map IV before fetching', async () => {
  const map = { url: url('init.mp4'), encryption: aesInfo(1) };
  const media = { ...playlist(), format: 'fmp4', map };
  media.segments[0].map = map;
  media.segments[1].map = { ...map, encryption: aesInfo(2) };
  await assert.rejects(transferHls({ playlist: media, writable: destination(), fetchImpl: () => assert.fail('No request expected') }), /初始化區段會改變/);
});

test('AES key HTTP errors identify the key request, never leak URLs or retry authentication failures', async () => {
  const media = playlist(1);
  media.segments[0].encryption = aesInfo();
  for (const status of [401, 403, 404]) {
    let calls = 0;
    await assert.rejects(transferHls({ playlist: media, writable: destination(), fetchImpl: async target => {
      calls++;
      assert.equal(target, url('key.bin'));
      return new Response('', { status });
    } }), error => error.message.includes('解密金鑰') && error.message.includes(`HTTP ${status}`) && !error.message.includes('https:'));
    assert.equal(calls, 1);
  }
});

test('AES key transient failures retry with the same bounded policy as media', async () => {
  const media = playlist(1);
  media.segments[0].encryption = aesInfo();
  const encrypted = await encrypt(ts(), aesInfo());
  let keyCalls = 0;
  const writable = destination();
  await transferHls({ playlist: media, writable, fetchImpl: async target => {
    if (target === url('key.bin')) {
      keyCalls++;
      return keyCalls < 3 ? new Response('', { status: 503 }) : new Response(aesKey);
    }
    return new Response(encrypted);
  } });
  assert.equal(keyCalls, 3);
  assert.deepEqual(writable.writes, [ts()]);
});

test('AES key timeout is bounded to three attempts and writes no media', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const media = playlist(1);
  media.segments[0].encryption = aesInfo();
  let calls = 0;
  const writable = destination();
  const pending = transferHls({ playlist: media, writable, fetchImpl: async (target, options) => {
    assert.equal(target, url('key.bin'));
    calls++;
    return new Response(new ReadableStream({ start(stream) {
      options.signal.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), { once: true });
    } }));
  } });
  const rejection = assert.rejects(pending, /解密金鑰下載逾時/);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(calls, attempt + 1);
    t.mock.timers.tick(45_000);
    await flush();
    if (attempt < 2) { t.mock.timers.tick(200 * 2 ** attempt); await flush(); }
  }
  await rejection;
  assert.equal(calls, 3);
  assert.equal(writable.writes.length, 0);
});

const memoryInfo = sequence => ({ method: 'AES-128', source: 'duotify-memory', iv: aesInfo(sequence).iv });
const memoryKey = () => crypto.subtle.importKey('raw', aesKey, 'AES-CBC', false, ['decrypt']);

test('uses a trusted in-memory CryptoKey without making a key URL request', async () => {
  const media = playlist(3);
  media.segments[0].encryption = memoryInfo(1);
  media.segments[1].encryption = memoryInfo(2);
  media.segments[2].encryption = null;
  const encrypted = [await encrypt(ts(1), memoryInfo(1)), await encrypt(ts(2), memoryInfo(2))];
  const requests = [];
  const writable = destination();
  let keyCalls = 0;
  await transferHls({ playlist: media, writable, resolveKey: async (encryption, signal) => {
    keyCalls++;
    assert.deepEqual(encryption, memoryInfo(1));
    assert.ok(signal instanceof AbortSignal);
    return memoryKey();
  }, fetchImpl: async target => {
    requests.push(target);
    return new Response(target === url('0.ts') ? encrypted[0] : target === url('1.ts') ? encrypted[1] : ts(3));
  } });
  assert.equal(keyCalls, 1);
  assert.deepEqual(requests, [url('0.ts'), url('1.ts'), url('2.ts')]);
  assert.deepEqual(writable.writes, [ts(1), ts(2), ts(3)]);
});

test('does not reuse an in-memory CryptoKey between transfers or apply it to URI keys', async () => {
  const media = playlist(2);
  media.segments[0].encryption = memoryInfo(1);
  media.segments[1].encryption = aesInfo(2);
  const cipher = [await encrypt(ts(1), memoryInfo(1)), await encrypt(ts(2), aesInfo(2))];
  let keyCalls = 0;
  let keyFetches = 0;
  for (let index = 0; index < 2; index++) {
    const writable = destination();
    await transferHls({ playlist: media, writable, resolveKey: () => { keyCalls++; return memoryKey(); }, fetchImpl: async target => {
      if (target === url('key.bin')) { keyFetches++; return new Response(aesKey); }
      return new Response(target === url('0.ts') ? cipher[0] : cipher[1]);
    } });
    assert.deepEqual(writable.writes, [ts(1), ts(2)]);
  }
  assert.equal(keyCalls, 2);
  assert.equal(keyFetches, 2);
});

test('rejects missing resolver, unknown memory source, and mixed URI/source declarations before fetching', async () => {
  const cases = [memoryInfo(0), { ...memoryInfo(0), source: 'site-supplied' }, { ...memoryInfo(0), url: url('key.bin') }];
  for (const encryption of cases) {
    const media = playlist(1);
    media.segments[0].encryption = encryption;
    await assert.rejects(transferHls({ playlist: media, writable: destination(), fetchImpl: () => assert.fail('No fetch expected') }), /記憶體.*金鑰來源/);
  }
});

test('rejects extractable, wrong-algorithm, wrong-size and non-decryption CryptoKeys', async () => {
  const media = playlist(1);
  media.segments[0].encryption = memoryInfo(0);
  const keys = [
    await crypto.subtle.importKey('raw', aesKey, 'AES-CBC', true, ['decrypt']),
    await crypto.subtle.importKey('raw', aesKey, 'AES-GCM', false, ['decrypt']),
    await crypto.subtle.importKey('raw', new Uint8Array(32), 'AES-CBC', false, ['decrypt']),
    await crypto.subtle.importKey('raw', aesKey, 'AES-CBC', false, ['encrypt']),
    aesKey,
    { type: 'secret', algorithm: { name: 'AES-CBC', length: 128 }, extractable: false, usages: ['decrypt'] },
    null,
  ];
  for (const key of keys) {
    await assert.rejects(transferHls({ playlist: media, writable: destination(), resolveKey: () => key,
      fetchImpl: () => assert.fail('No fetch expected'),
    }), /不可匯出的 AES-CBC 128 位元解密金鑰/);
  }
});

test('sanitizes in-memory resolver errors and does not retry or fetch media', async () => {
  const media = playlist(1);
  media.segments[0].encryption = memoryInfo(0);
  let calls = 0;
  await assert.rejects(transferHls({ playlist: media, writable: destination(), resolveKey: () => {
    calls++;
    throw new Error('private cookie or key value must not leak');
  }, fetchImpl: () => assert.fail('No fetch expected') }), error => error.message === '無法取得課程播放金鑰，請保持已登入且可播放的課程分頁開啟。');
  assert.equal(calls, 1);
});

test('cancels a pending in-memory resolver and signals its work to stop', async () => {
  const media = playlist(1);
  media.segments[0].encryption = memoryInfo(0);
  const controller = new AbortController();
  let resolverSignal;
  const pending = transferHls({ playlist: media, writable: destination(), signal: controller.signal,
    resolveKey: (_, signal) => { resolverSignal = signal; return new Promise(() => {}); },
    fetchImpl: () => assert.fail('No fetch expected'),
  });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(resolverSignal.aborted, true);
});

test('bounds the lifetime of a stalled in-memory resolver without fetching media', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const media = playlist(1);
  media.segments[0].encryption = memoryInfo(0);
  let resolverSignal;
  const pending = transferHls({ playlist: media, writable: destination(),
    resolveKey: (_, signal) => { resolverSignal = signal; return new Promise(() => {}); },
    fetchImpl: () => assert.fail('No fetch expected'),
  });
  const rejection = assert.rejects(pending, /取得課程播放金鑰逾時/);
  await Promise.resolve();
  t.mock.timers.tick(45_000);
  await rejection;
  assert.equal(resolverSignal.aborted, true);
});
