import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHandler, rewritePlaylist } from '../lib/app.ts';
import { encryptPlaybackToken, decryptPlaybackToken } from '../lib/crypto.ts';
import { isAllowedUrl, fetchUpstream } from '../lib/network.ts';
import { nodeHandler } from '../adapters/node.ts';
import vercel from '../api/index.ts';
import netlify from '../netlify/functions/radio.ts';
import worker from '../adapters/cloudflare.ts';
import type { PlaybackTokenPayload } from '../lib/types.ts';

const env = { RADIKALL_SESSION_SECRET: 'test-only-secret-at-least-32-characters' };
const payload: PlaybackTokenPayload = {
  stationId: 'FMJ', resolvedAreaId: 'JP13', authToken: 'private-upstream-token', userAgent: 'test-agent',
  upstreamMasterUrl: 'https://example.smartstream.ne.jp/master.m3u8',
  issuedAtEpochMillis: Date.now(), expiresAtEpochMillis: Date.now() + 600_000,
};
const post = (value: unknown, headers = {}) => new Request('https://radio.test/api/playback/live-session', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value),
});
const stub = { authenticate: async () => ({ token: payload.authToken, areaId: 'JP13', userAgent: 'test-agent' }), buildLiveStreamUrl: async () => payload.upstreamMasterUrl };

test('encrypted sessions hide credentials and reject tampering, malformed input and wrong secrets', async () => {
  const token = await encryptPlaybackToken(env.RADIKALL_SESSION_SECRET, payload);
  assert.ok(!token.includes(payload.authToken));
  assert.deepEqual(await decryptPlaybackToken(env.RADIKALL_SESSION_SECRET, token), payload);
  for (const bad of ['x', '%%.@@', `${token}.extra`, token.slice(0, -8) + 'AAAAAAAA']) assert.equal(await decryptPlaybackToken(env.RADIKALL_SESSION_SECRET, bad), null);
  assert.equal(await decryptPlaybackToken('another-secret', token), null);
});

test('rewrites nested playlists, audio segments, keys and initialization maps', () => {
  const text = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"\nchild.m3u8\nsegment.aac\n';
  const result = rewritePlaylist('session', 'https://example.smartstream.ne.jp/live/master.m3u8', text);
  for (const path of ['key.bin', 'live/init.mp4', 'live/audio.m3u8', 'live/child.m3u8', 'live/segment.aac']) assert.ok(result.includes(encodeURIComponent(`https://example.smartstream.ne.jp/${path}`)));
  assert.throws(() => rewritePlaylist('session', payload.upstreamMasterUrl, '#EXTM3U\nhttp://127.0.0.1/private'));
});

test('proxy allowlist rejects host suffix tricks, credentials, non-HTTPS and arbitrary ports', () => {
  for (const address of ['https://evilradiko.jp/a', 'https://radiko.jp.evil.com/a', 'http://radiko.jp/a', 'https://user:pass@radiko.jp/a', 'https://radiko.jp:8080/a', 'https://127.0.0.1/a']) assert.equal(isAllowedUrl(address), false, address);
  assert.equal(isAllowedUrl(payload.upstreamMasterUrl), true);
});

test('validation rejects oversized and malformed JSON, missing secret and wrong area', async () => {
  const handle = createHandler(stub);
  assert.equal((await handle(post({ stationId: 'unknown' }), env)).status, 400);
  assert.equal((await handle(post({ stationId: 'FMJ', preferredAreaId: 'JP1' }), env)).status, 400);
  assert.equal((await handle(post({ stationId: 'FMJ' }), {})).status, 503);
  assert.equal((await handle(post({ stationId: 'FMJ', padding: 'x'.repeat(5000) }), env)).status, 413);
  assert.equal((await handle(post({ stationId: 'FMJ' }, { Origin: 'https://evil.test' }), env)).status, 403);
  assert.equal((await handle(new Request('https://radio.test/api/playback/live-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid' }), env)).status, 400);
});

test('creates stateless sessions without requiring program metadata; expired sessions return 410', async () => {
  const handle = createHandler({ ...stub, buildNowPlayingResponse: async () => { throw new Error('must not run'); } });
  const response = await handle(post({ stationId: 'FMJ', preferredAreaId: 'JP13' }), env);
  assert.equal(response.status, 200);
  const body = await response.json(); assert.ok(body.streamUrl.startsWith('/api/playback/live/'));
  assert.ok(!JSON.stringify(body).includes(payload.authToken));
  const token = await encryptPlaybackToken(env.RADIKALL_SESSION_SECRET, { ...payload, expiresAtEpochMillis: Date.now() - 1 });
  assert.equal((await handle(new Request(`https://radio.test/api/playback/live/${token}/master.m3u8`), env)).status, 410);
});

test('passes Range, streams binary audio and keeps raw upstream errors out of JSON', async () => {
  let mode = 'audio';
  const handle = createHandler({ ...stub, fetchUpstream: async (_input, init) => {
    if (mode === 'html') return new Response('<html>private error page</html>', { headers: { 'Content-Type': 'text/html' } });
    if (mode === 'error') throw new Error('secret credential details');
    assert.equal(new Headers(init?.headers).get('Range'), 'bytes=0-2');
    return new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { 'Content-Type': 'audio/aac', 'Content-Range': 'bytes 0-2/99' } });
  } });
  const token = await encryptPlaybackToken(env.RADIKALL_SESSION_SECRET, payload);
  const url = `https://radio.test/api/playback/live/${token}/proxy?target=${encodeURIComponent('https://example.smartstream.ne.jp/segment.aac')}`;
  const response = await handle(new Request(url, { headers: { Range: 'bytes=0-2' } }), env);
  assert.equal(response.status, 206); assert.equal(response.headers.get('Content-Range'), 'bytes 0-2/99');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
  for (mode of ['html', 'error']) { const result = await handle(new Request(url), env); assert.equal(result.status, 502); assert.ok(!(await result.text()).match(/private|credential|<html>/)); }
});

test('native HLS open-ended Range does not turn an extensionless media playlist into 502', async () => {
  const handle = createHandler({ ...stub, fetchUpstream: async (_input, init) => new Response(
    new Headers(init?.headers).has('Range') ? '200 OK' : '#EXTM3U\n#EXTINF:5,\nsegment.aac\n',
    { headers: { 'Content-Type': 'application/x-mpegURL' } },
  ) });
  const token = await encryptPlaybackToken(env.RADIKALL_SESSION_SECRET, payload);
  const url = `https://radio.test/api/playback/live/${token}/proxy?target=${encodeURIComponent('https://example.smartstream.ne.jp/medialist')}`;
  const response = await handle(new Request(url, { headers: { Range: 'bytes=0-' } }), env);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /^#EXTM3U\n#EXTINF:5,\n\/api\/playback\/live\//);
});

test('extensionless playlists requested with a bounded Range are refetched whole before rewriting', async () => {
  const ranges: (string | null)[] = [];
  const handle = createHandler({ ...stub, fetchUpstream: async (_input, init) => {
    const range = new Headers(init?.headers).get('Range'); ranges.push(range);
    return new Response(range ? 'EXTM3U' : '#EXTM3U\nsegment.aac\n', {
      status: range ? 206 : 200, headers: { 'Content-Type': 'application/x-mpegURL',
        ...(range ? { 'Content-Range': 'bytes 1-6/100', 'Accept-Ranges': 'bytes' } : {}) },
    });
  } });
  const token = await encryptPlaybackToken(env.RADIKALL_SESSION_SECRET, payload);
  const url = `https://radio.test/api/playback/live/${token}/proxy?target=${encodeURIComponent('https://example.smartstream.ne.jp/medialist')}`;
  const response = await handle(new Request(url, { headers: { Range: 'bytes=1-6' } }), env);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /^#EXTM3U/);
  assert.deepEqual(ranges, ['bytes=1-6', null]);
  assert.equal(response.headers.get('Content-Range'), null);
  assert.equal(response.headers.get('Accept-Ranges'), null);
});

test('redirect validation prevents forwarding authentication to another host', async context => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(null, { status: 302, headers: { Location: 'https://evil.test/steal' } }); });
  await assert.rejects(fetchUpstream(payload.upstreamMasterUrl, { headers: { 'X-Radiko-AuthToken': 'secret' } }), /Unsupported upstream redirect/);
  assert.equal(calls, 1);
});

test('Vercel rewritten routes, Netlify and Cloudflare share the real catalog', async () => {
  for (const response of [
    await vercel.fetch(new Request('https://radio.test/api/index?__route=bootstrap')),
    await netlify(new Request('https://radio.test/api/bootstrap')),
    await worker.fetch(new Request('https://radio.test/api/bootstrap'), { ...env, ASSETS: { fetch: async () => new Response('asset') } }),
  ]) { assert.equal(response.status, 200); assert.ok((await response.json()).stations.length > 100); }
  const response = await worker.fetch(new Request('https://radio.test/'), { ...env, ASSETS: { fetch: async () => new Response('asset') } });
  assert.equal(await response.text(), 'asset');
});

test('Node host serves the interface and API, never private source files', async () => {
  const server = createServer(nodeHandler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.ok((await (await fetch(base)).text()).includes('Radikall Lite'));
    assert.equal((await fetch(`${base}/api/bootstrap`)).status, 200);
    for (const path of ['/.env', '/lib/catalog.json', '/package.json', '/missing']) assert.equal((await fetch(base + path)).status, 404);
    assert.equal((await fetch(base, { method: 'HEAD' })).status, 200);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
