import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchNiconico } from '../lib/niconico.ts';
import { createHandler } from '../lib/app.ts';

test('public Nico search maps exact tags and keywords to a fixed, bounded upstream request', async () => {
  for (const mode of ['tag', 'keyword'] as const) {
    const result = await searchNiconico('初音ミク', mode, 1, undefined, undefined, async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://snapshot.search.nicovideo.jp');
      assert.equal(url.searchParams.get('targets'), mode === 'tag' ? 'tagsExact' : 'title,description,tags');
      assert.equal(url.searchParams.get('_offset'), '12'); assert.equal(url.searchParams.get('_limit'), '12');
      assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).has('cookie'), false);
      return Response.json({ meta: { status: 200, totalCount: 30 }, data: [
        { contentId: 'sm9', title: '<b>Music</b>', thumbnailUrl: 'http://nicovideo.cdn.nimg.jp/thumbnails/9/9', lengthSeconds: 99, viewCounter: 100, commentCounter: null },
        { contentId: 'sm10', title: 'Unsafe cover', thumbnailUrl: 'https://nimg.jp.evil.test/x' },
        { contentId: 'javascript:bad', title: 'Invalid' },
      ] });
    });
    assert.equal(result.items.length, 2); assert.equal(result.items[0]?.title, '<b>Music</b>');
    assert.equal(result.items[0]?.thumbnailUrl, 'https://nicovideo.cdn.nimg.jp/thumbnails/9/9');
    assert.equal(result.items[1]?.thumbnailUrl, null); assert.equal(result.hasMore, true); assert.equal(result.page, 1);
  }
});

test('search rejects bad queries before fetching, bounds response bodies, and hides upstream errors', async () => {
  const never: typeof fetch = async () => { throw new Error('must not fetch'); };
  for (const [q, page] of [['', 0], ['x'.repeat(121), 0], ['x', -1], ['x', 8334]] as const) await assert.rejects(searchNiconico(q, 'tag', page, undefined, undefined, never), /请输入/);
  await assert.rejects(searchNiconico('x', 'tag', 0, undefined, undefined, async () => new Response('x'.repeat(262_145), { headers: { 'Content-Type': 'application/json' } })), /响应过大/);
  const handle = createHandler({ searchNiconico: async () => { throw new Error('private upstream URL and query'); } });
  const response = await handle(new Request('https://radio.test/api/niconico/search?mode=tag&q=VOCALOID'));
  assert.equal(response.status, 502); assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json(); assert.match(body.message, /Niconico 搜索/); assert.ok(body.requestId); assert.ok(!JSON.stringify(body).includes('private'));
  for (const params of ['mode=bad&q=x', 'mode=tag&q=', 'mode=tag&q=x&page=-1', 'mode=tag&q=x&page=1.5']) assert.equal((await handle(new Request('https://radio.test/api/niconico/search?' + params))).status, 400);
});
