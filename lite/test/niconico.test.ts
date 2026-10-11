import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { readFile } from 'node:fs/promises';
import { parseVideoId, createNiconico } from '../src/niconico.ts';
import type { NiconicoSearchResult } from '../lib/niconico.ts';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
function fixture(search: Parameters<typeof createNiconico>[1]['search'] = async () => ({ items: [], total: 0, page: 0, hasMore: false })) {
  const window = new Window({ url: 'https://radio.test', settings: { disableIframePageLoading: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  const document = window.document; document.write(html);
  window.localStorage.setItem('radio.niconico.recent', '["sm9","sm9","javascript:bad",null]');
  // happy-dom DOM types differ structurally from lib.dom's browser interfaces.
  const controller = createNiconico(document.querySelector('#nico-view') as unknown as HTMLElement, {
    search, deferImage: (image, source) => { image.src = source; }, replaceContent: (container, ...nodes) => container.replaceChildren(...nodes),
  });
  return { window, document, controller };
}

test('Niconico accepts canonical video IDs and known watch links, never arbitrary embed URLs', () => {
  for (const value of ['sm1097445', ' https://www.nicovideo.jp/watch/sm1097445?from=share#t=2 ', 'https://nico.ms/sm1097445', 'http://nicovideo.jp/watch/sm1097445/']) {
    assert.equal(parseVideoId(value), 'sm1097445');
  }
  for (const id of ['nm123', 'so123', '1234567890']) assert.equal(parseVideoId(id), id);
  for (const value of ['', 'javascript:alert(1)', '<iframe src=x>', 'https://evil.test/watch/sm9', 'https://nicovideo.jp.evil.test/watch/sm9', 'https://nicovideo.jp@evil.test/watch/sm9', 'https://user:pass@nicovideo.jp/watch/sm9', 'https://nicovideo.jp:444/watch/sm9', 'https://www.nicovideo.jp/watch/sm9/extra', 'https://nico.ms/%73m9', 'https://nicovideo.jp/mylist/123', 'sm9?x=1', 'sm' + '9'.repeat(100)]) {
    assert.equal(parseVideoId(value), null, value);
  }
});

test('Niconico creates one player on demand, bounds history, and releases it on close or source change', async () => {
  const { window, document, controller } = fixture();
  const input = document.querySelector('#nico-form')!.querySelector('input')!;
  const submit = (value: string) => { input.value = value; document.querySelector('#nico-form')!.dispatchEvent(new window.Event('submit', { cancelable: true })); };
  try {
    assert.equal(document.querySelectorAll('iframe').length, 0);
    assert.equal(document.querySelectorAll('li').length, 1);
    submit('https://www.nicovideo.jp/watch/sm1097445?untrusted=ignored');
    const oldFrame = document.querySelector('iframe')!;
    assert.equal(oldFrame.src, 'https://embed.nicovideo.jp/watch/sm1097445');
    submit('https://evil.test/watch/sm9');
    assert.equal(document.querySelector('iframe'), oldFrame);
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    for (let i = 1; i <= 12; i++) submit(`sm${i}`);
    assert.equal(document.querySelectorAll('iframe').length, 1);
    assert.equal(oldFrame.isConnected, false);
    assert.equal(document.querySelectorAll('li').length, 8);
    assert.deepEqual(JSON.parse(window.localStorage.getItem('radio.niconico.recent')!), ['sm12', 'sm11', 'sm10', 'sm9', 'sm8', 'sm7', 'sm6', 'sm5']);
    oldFrame.dispatchEvent(new window.Event('load'));
    assert.equal(document.querySelector('#nico-stage')!.getAttribute('aria-busy'), 'true');
    document.querySelector('iframe')!.dispatchEvent(new window.Event('load'));
    assert.equal(document.querySelector('#nico-stage')!.getAttribute('aria-busy'), 'false');
    document.querySelector('#nico-clear')!.dispatchEvent(new window.Event('click'));
    assert.equal(window.localStorage.getItem('radio.niconico.recent'), null);
    assert.equal(document.querySelectorAll('iframe').length, 1);
    document.querySelector('#nico-close')!.dispatchEvent(new window.Event('click'));
    assert.equal(document.querySelectorAll('iframe').length, 0);
    submit('sm9'); controller.destroy();
    assert.equal(document.querySelectorAll('iframe').length, 0);
    assert.equal(document.querySelector('#nico-actions')!.hasAttribute('hidden'), true);
  } finally { controller.destroy(); await window.happyDOM.close(); }
});

test('Nico search cancels stale requests, treats titles as text, replaces pages, and releases results', async () => {
  const pending: { signal: AbortSignal; resolve(value: NiconicoSearchResult): void; page: number }[] = [];
  const { window, document, controller } = fixture(async (_query, mode, page, signal) => {
    assert.equal(mode, 'keyword'); return new Promise(resolve => pending.push({ signal, resolve, page }));
  });
  const flush = () => new Promise(resolve => setTimeout(resolve, 30));
  const result = (title: string, page = 0): NiconicoSearchResult => ({ items: [{ id: 'sm9', title, thumbnailUrl: null, duration: 99, views: 100, comments: 1, publishedAt: null }], page, total: 13, hasMore: page === 0 });
  const mode = document.querySelector('#nico-form')!.querySelector('select')!;
  const input = document.querySelector('#nico-form')!.querySelector('input')!;
  const submit = (value: string) => { input.value = value; document.querySelector('#nico-form')!.dispatchEvent(new window.Event('submit', { cancelable: true })); };
  try {
    mode.value = 'keyword'; mode.dispatchEvent(new window.Event('change'));
    submit('older'); submit('newer');
    assert.equal(pending[0]!.signal.aborted, true);
    pending[1]!.resolve(result('<img src=x onerror=alert(1)>')); await flush();
    pending[0]!.resolve(result('Old result')); await flush();
    assert.equal(document.querySelector('.nico-result strong')!.textContent, '<img src=x onerror=alert(1)>');
    assert.equal(document.querySelector('.nico-result img'), null);
    document.querySelector('#nico-next')!.dispatchEvent(new window.Event('click')); await flush();
    assert.equal(pending[2]!.page, 1); pending[2]!.resolve(result('Second page', 1)); await flush();
    assert.equal(document.querySelectorAll('.nico-result').length, 1);
    assert.equal(document.querySelector('.nico-result strong')!.textContent, 'Second page');
    document.querySelector('.nico-result')!.dispatchEvent(new window.Event('click'));
    assert.equal(document.querySelector('iframe')!.src, 'https://embed.nicovideo.jp/watch/sm9');
    submit('last'); await flush(); controller.destroy();
    assert.equal(pending.at(-1)!.signal.aborted, true); pending.at(-1)!.resolve(result('Too late')); await flush();
    assert.equal(document.querySelectorAll('iframe,.nico-result').length, 0);
  } finally { controller.destroy(); await window.happyDOM.close(); }
});
