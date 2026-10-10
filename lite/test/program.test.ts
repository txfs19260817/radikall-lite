import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNowPlayingResponse } from '../lib/program.ts';

test('song covers prefer small provider images and omit placeholders and unsafe URLs', async context => {
  const images = [
    { medium: 'https://images.example/160.jpg', small: 'https://images.example/75.jpg', large: 'https://images.example/500.jpg' },
    { small: 'https://images.example/75.jpg', large: 'https://images.example/500.jpg' },
    { large: 'https://images.example/500.jpg' },
    { medium: 'https://ac-static.cf.radiko.jp/jacket_placeholder.png', large: 'https://ac-static.cf.radiko.jp/jacket_placeholder_large.jpeg' },
    { medium: 'http://images.example/insecure.jpg' },
    { medium: 'https://user:password@images.example/160.jpg' },
    {},
  ];
  context.mock.method(globalThis, 'fetch', async (request: Request) => {
    if (new URL(request.url).pathname.endsWith('.xml')) return new Response('<radiko/>');
    return Response.json({ data: images.map((image, index) => ({
      title: `Song ${index}`, artist_name: 'Artist', displayed_start_time: '2026-10-11T06:45:00+09:00', music: { image },
    })) });
  });
  const result = await buildNowPlayingResponse('FMJ');
  assert.deepEqual(result.recentSongs.map(song => song.imageUrl), [
    'https://images.example/160.jpg', 'https://images.example/75.jpg', 'https://images.example/500.jpg', null, null, null, null,
  ]);
  assert.equal(result.currentSong?.title, 'Song 0');
});
