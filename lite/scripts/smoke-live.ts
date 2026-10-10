// Opt-in probe: TEST_ORIGIN=https://... tests a deployment; otherwise use the
// local handler with an ephemeral key. Never prints tokens or audio URLs.
import { handle } from '../lib/app.ts';
const origin = process.env.TEST_ORIGIN ?? 'http://localhost';
const env = { RADIKALL_SESSION_SECRET: process.env.RADIKALL_SESSION_SECRET ?? crypto.randomUUID() + crypto.randomUUID() };
async function request(stage: string, path: string, init: RequestInit = {}) {
  const url = new URL(path, origin);
  if (url.origin !== new URL(origin).origin || !url.pathname.startsWith('/api/playback/')) throw new Error('Unexpected proxy origin or route');
  const req = new Request(url, { ...init, signal: AbortSignal.timeout(25_000) });
  const result = process.env.TEST_ORIGIN ? await fetch(req) : await handle(req, env);
  const type = result.headers.get('content-type') ?? '';
  console.log(JSON.stringify({ stage,
    status: result.status, contentType: type, requestId: result.headers.get('x-request-id') ?? result.headers.get('x-vercel-id') }));
  if (!result.ok) { await result.body?.cancel(); throw new Error(`Playback fetch failed: ${result.status}`); }
  return result;
}
const response = await request('session', '/api/playback/live-session', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ stationId: process.env.TEST_STATION ?? 'FMJ', preferredAreaId: process.env.TEST_AREA ?? 'JP13' }),
});
const session = await response.json();
console.log(`Session OK: ${session.stationId}`);
let path = session.streamUrl as string;
for (let depth = 0; depth < 5; depth++) {
  // Match the native browser request that originally reproduced the 502.
  const result = await request(depth === 0 ? 'master' : 'media', path, { headers: { Range: 'bytes=0-' } });
  const text = await result.text();
  const entries = text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (!text.startsWith('#EXTM3U') || !entries.length) throw new Error('No playable HLS entries');
  console.log(`Playlist OK: level ${depth + 1}`);
  if (text.includes('#EXTINF:')) {
    if (entries.length < 3) throw new Error('Need at least three consecutive segments');
    for (const segment of entries.slice(0, 3)) {
      const audio = await request('segment', segment);
      const reader = audio.body?.getReader();
      if (!reader) throw new Error('Empty audio response');
      let bytes = 0;
      try {
        while (bytes < 16_384) {
          const chunk = await reader.read(); if (chunk.done) break;
          if (!bytes) {
            const b = chunk.value;
            // ADTS AAC, MPEG-TS, ID3-prefixed audio, or ISO BMFF boxes.
            const prefix = new TextDecoder().decode(b.slice(0, 12));
            if (!(b[0] === 0xff && (b[1]! & 0xf0) === 0xf0) && b[0] !== 0x47 && !prefix.startsWith('ID3') && !/ftyp|styp|moof/.test(prefix)) throw new Error('Unrecognized audio bytes');
          }
          bytes += chunk.value.byteLength;
        }
      } finally { await reader.cancel(); }
      if (!bytes) throw new Error('Empty audio response');
      console.log(`Audio OK: ${bytes} bytes read, then cancelled`);
    }
    process.exit(0);
  }
  path = entries[0]!;
}
throw new Error('Too many nested playlists');
