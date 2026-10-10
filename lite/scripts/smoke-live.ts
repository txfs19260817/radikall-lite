// Opt-in live upstream probe. Never runs in CI and never prints tokens or audio URLs.
import { handle } from '../lib/app.ts';
const env = { RADIKALL_SESSION_SECRET: process.env.RADIKALL_SESSION_SECRET };
const response = await handle(new Request('http://localhost/api/playback/live-session', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ stationId: process.env.TEST_STATION ?? 'FMJ' }),
}), env);
if (!response.ok) throw new Error(`Session failed: ${response.status} ${await response.text()}`);
const session = await response.json();
console.log(`Session OK: ${session.stationId}`);
let path = session.streamUrl as string;
for (let depth = 0; depth < 5; depth++) {
  const result = await handle(new Request(new URL(path, 'http://localhost')), env);
  if (!result.ok) throw new Error(`Playback fetch failed: ${result.status}`);
  const type = result.headers.get('Content-Type') ?? '';
  if (/mpegurl/i.test(type)) {
    const text = await result.text();
    const next = text.split('\n').find(line => line.trim() && !line.startsWith('#'));
    if (!next || !text.startsWith('#EXTM3U')) throw new Error('No playable HLS entries');
    console.log(`Playlist OK: level ${depth + 1}`); path = next.trim();
  } else {
    const reader = result.body?.getReader();
    const chunk = await reader?.read(); await reader?.cancel();
    if (!chunk?.value?.byteLength) throw new Error('Empty audio response');
    console.log(`Audio bytes OK: ${chunk.value.byteLength} bytes read; ${type}`);
    process.exit(0);
  }
}
throw new Error('Too many nested playlists');
