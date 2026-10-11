const VIDEO_ID = /^(?:(?:sm|nm|so)\d{1,12}|\d{10})$/;
const HISTORY_KEY = 'radio.niconico.recent';
const HISTORY_LIMIT = 8;

export function parseVideoId(input: string): string | null {
  const value = input.trim();
  if (value.length > 2048) return null;
  if (VIDEO_ID.test(value)) return value;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const path = url.hostname === 'nico.ms' ? /^\/([^/]+)\/?$/ :
      ['nicovideo.jp', 'www.nicovideo.jp', 'm.nicovideo.jp'].includes(url.hostname) ? /^\/watch\/([^/]+)\/?$/ : null;
    const id = path?.exec(url.pathname)?.[1];
    return id && VIDEO_ID.test(id) ? id : null;
  } catch { return null; }
}

export function createNiconico(root: HTMLElement) {
  const document = root.ownerDocument;
  const find = <T extends HTMLElement>(id: string) => {
    const element = root.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`Missing #${id}`);
    return element;
  };
  const input = find<HTMLInputElement>('nico-input');
  const stage = find<HTMLDivElement>('nico-stage');
  const empty = find<HTMLDivElement>('nico-empty');
  const status = find<HTMLParagraphElement>('nico-status');
  const actions = find<HTMLDivElement>('nico-actions');
  const original = find<HTMLAnchorElement>('nico-original');
  const historyList = find<HTMLOListElement>('nico-history');
  const clear = find<HTMLButtonElement>('nico-clear');
  let frame: HTMLIFrameElement | undefined;
  let currentId: string | undefined;
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  let recent: string[] = [];
  try {
    const stored: unknown = JSON.parse(document.defaultView?.localStorage.getItem(HISTORY_KEY) ?? '[]');
    if (Array.isArray(stored)) recent = [...new Set(stored.filter((id): id is string => typeof id === 'string' && VIDEO_ID.test(id)))].slice(0, HISTORY_LIMIT);
  } catch { /* An unavailable or corrupt history must not prevent playback. */ }

  function renderHistory() {
    historyList.replaceChildren();
    for (const id of recent) {
      const item = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.textContent = id; button.setAttribute('aria-label', `打开视频 ${id}`);
      button.addEventListener('click', () => { input.value = id; open(id); });
      item.append(button); historyList.append(item);
    }
    find('nico-history-empty').hidden = recent.length > 0;
    clear.disabled = recent.length === 0;
  }
  function saveHistory() {
    try {
      const storage = document.defaultView?.localStorage;
      if (recent.length) storage?.setItem(HISTORY_KEY, JSON.stringify(recent));
      else storage?.removeItem(HISTORY_KEY);
    } catch { /* Playback also works with storage disabled. */ }
    renderHistory();
  }
  function destroy() {
    clearTimeout(loadTimer);
    frame?.remove(); frame = undefined; currentId = undefined;
    stage.setAttribute('aria-busy', 'false');
    empty.hidden = false; actions.hidden = true; original.removeAttribute('href');
    status.textContent = ''; input.removeAttribute('aria-invalid');
  }
  function open(id: string) {
    destroy();
    currentId = id; empty.hidden = true; actions.hidden = false;
    original.href = `https://www.nicovideo.jp/watch/${id}`;
    stage.setAttribute('aria-busy', 'true');
    status.textContent = '正在打开播放器…';
    const next = document.createElement('iframe');
    next.title = `Niconico 视频 ${id}`;
    next.allow = 'fullscreen; picture-in-picture'; next.allowFullscreen = true;
    next.referrerPolicy = 'strict-origin-when-cross-origin';
    // Construct a fixed-origin URL from a validated ID, never from user HTML.
    next.src = `https://embed.nicovideo.jp/watch/${id}`;
    next.addEventListener('load', () => {
      if (frame !== next) return;
      clearTimeout(loadTimer); stage.setAttribute('aria-busy', 'false');
      // A cross-origin load event also fires on error pages; do not claim playback.
      status.textContent = '在播放器内点击播放，可切换弹幕显示。';
    });
    frame = next; stage.append(next);
    loadTimer = setTimeout(() => {
      if (frame !== next) return;
      stage.setAttribute('aria-busy', 'false');
      status.textContent = '加载时间较长，可以重新加载，或在 Niconico 打开。';
    }, 15_000);
    recent = [id, ...recent.filter(previous => previous !== id)].slice(0, HISTORY_LIMIT);
    saveHistory();
  }
  find<HTMLFormElement>('nico-form').addEventListener('submit', event => {
    event.preventDefault();
    const id = parseVideoId(input.value);
    if (!id) {
      input.setAttribute('aria-invalid', 'true');
      status.textContent = '请输入 Niconico 视频链接或视频编号，例如 sm1097445。';
      input.focus(); return;
    }
    open(id);
  });
  find('nico-close').addEventListener('click', () => { destroy(); input.focus(); });
  find('nico-retry').addEventListener('click', () => { if (currentId) open(currentId); });
  clear.addEventListener('click', () => { recent = []; saveHistory(); });
  renderHistory();
  return { destroy };
}
