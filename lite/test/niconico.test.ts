import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { parseVideoId, createNiconico } from '../src/niconico.ts';

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
  const window = new Window({ url: 'https://radio.test', settings: { disableIframePageLoading: true } });
  const document = window.document;
  document.body.innerHTML = '<section><form id="nico-form"><input id="nico-input"></form><div id="nico-stage"><div id="nico-empty"></div></div><p id="nico-status"></p><div id="nico-actions" hidden><a id="nico-original"></a><button id="nico-close"></button><button id="nico-retry"></button></div><ol id="nico-history"></ol><p id="nico-history-empty"></p><button id="nico-clear"></button></section>';
  window.localStorage.setItem('radio.niconico.recent', '["sm9","sm9","javascript:bad",null]');
  // happy-dom DOM types differ structurally from lib.dom's browser interfaces.
  const controller = createNiconico(document.querySelector('section') as unknown as HTMLElement);
  const input = document.querySelector('input')!;
  const submit = (value: string) => { input.value = value; document.querySelector('form')!.dispatchEvent(new window.Event('submit', { cancelable: true })); };
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
