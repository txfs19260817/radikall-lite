import type { NiconicoSearchMode, NiconicoSearchResult } from '../lib/niconico.ts';

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

interface NiconicoOptions {
  search(query: string, mode: NiconicoSearchMode, page: number, signal: AbortSignal): Promise<NiconicoSearchResult>;
  deferImage(image: HTMLImageElement, source: string): void;
  replaceContent(container: HTMLElement, ...nodes: Node[]): void;
}
interface SearchQuery { query: string; mode: NiconicoSearchMode; page: number }

export function createNiconico(root: HTMLElement, options: NiconicoOptions) {
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
  const mode = find<HTMLSelectElement>('nico-mode');
  const go = find<HTMLButtonElement>('nico-go');
  const watch = find<HTMLDivElement>('nico-watch');
  const results = find<HTMLElement>('nico-results');
  const resultList = find<HTMLOListElement>('nico-result-list');
  const searchStatus = find<HTMLParagraphElement>('nico-search-status');
  const previous = find<HTMLButtonElement>('nico-prev'), nextPage = find<HTMLButtonElement>('nico-next');
  let searchAbort: AbortController | undefined;
  let submitted: SearchQuery | undefined;
  let nextSearchAt = 0;
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
      button.addEventListener('click', () => { mode.value = 'video'; updateMode(); input.value = id; open(id); });
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
  function closePlayer() {
    clearTimeout(loadTimer);
    frame?.remove(); frame = undefined; currentId = undefined;
    stage.setAttribute('aria-busy', 'false');
    empty.hidden = false; actions.hidden = true; original.removeAttribute('href');
    status.textContent = ''; input.removeAttribute('aria-invalid'); watch.hidden = !results.hidden;
  }
  function cancelSearch() {
    searchAbort?.abort(); searchAbort = undefined; go.disabled = false;
    results.setAttribute('aria-busy', 'false');
  }
  function clearResults() {
    cancelSearch(); options.replaceContent(resultList); results.hidden = true;
    find('nico-pages').hidden = true; submitted = undefined; watch.hidden = false;
  }
  function destroy() { clearResults(); closePlayer(); }
  function open(id: string) {
    closePlayer(); watch.hidden = false;
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
      if (!input.hasAttribute('aria-invalid')) status.textContent = '在播放器内点击播放，可切换弹幕显示。';
    });
    frame = next; stage.append(next);
    loadTimer = setTimeout(() => {
      if (frame !== next) return;
      stage.setAttribute('aria-busy', 'false');
      if (!input.hasAttribute('aria-invalid')) status.textContent = '加载时间较长，可以重新加载，或在 Niconico 打开。';
    }, 15_000);
    recent = [id, ...recent.filter(previous => previous !== id)].slice(0, HISTORY_LIMIT);
    saveHistory();
    stage.scrollIntoView?.({ block: 'nearest' });
  }
  function updateMode() {
    clearResults(); status.textContent = ''; input.removeAttribute('aria-invalid');
    const video = mode.value === 'video';
    input.maxLength = video ? 2048 : 120; go.textContent = video ? '打开' : '搜索';
    input.placeholder = video ? 'sm1097445 或视频链接' : mode.value === 'tag' ? '例如 VOCALOID' : '例如 初音ミク';
    input.setAttribute('aria-label', video ? '视频编号或链接' : mode.value === 'tag' ? '标签' : '关键词');
  }
  async function search(query: SearchQuery) {
    cancelSearch();
    const controller = searchAbort = new AbortController(), signal = controller.signal;
    go.disabled = true; previous.disabled = true; nextPage.disabled = true;
    input.removeAttribute('aria-invalid'); status.textContent = '';
    results.hidden = false; watch.hidden = !frame; results.setAttribute('aria-busy', 'true');
    options.replaceContent(resultList); find('nico-pages').hidden = true;
    find('nico-result-count').textContent = ''; searchStatus.textContent = '正在搜索…';
    let started = 0;
    try {
      // Snapshot API asks sequential callers to wait for the previous request's
      // duration. No typeahead requests, background polling or speculative pages.
      const delay = nextSearchAt - performance.now();
      if (delay > 0) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      if (signal.aborted) return;
      started = performance.now();
      const data = await options.search(query.query, query.mode, query.page, signal);
      if (signal.aborted) return;
      submitted = query;
      const number = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
      find('nico-result-count').textContent = `${number.format(data.total)} 个结果 · 按播放量`;
      searchStatus.textContent = data.items.length ? '' : '没有找到视频，试试其他关键词或切换搜索方式。';
      for (const video of data.items) {
        const item = document.createElement('li'), button = document.createElement('button');
        button.type = 'button'; button.className = 'nico-result';
        const art = document.createElement('span'); art.className = 'nico-thumbnail'; art.textContent = '♪';
        if (video.thumbnailUrl) {
          const image = document.createElement('img'); image.alt = ''; image.width = 240; image.height = 135; image.decoding = 'async';
          image.addEventListener('error', () => image.remove(), { once: true });
          art.append(image); options.deferImage(image, video.thumbnailUrl);
        }
        if (video.duration !== null) {
          const duration = document.createElement('span'); duration.className = 'nico-duration';
          duration.textContent = `${Math.floor(video.duration / 60)}:${String(video.duration % 60).padStart(2, '0')}`; art.append(duration);
        }
        const copy = document.createElement('span'); copy.className = 'nico-result-copy';
        const title = document.createElement('strong'); title.textContent = video.title;
        const info = document.createElement('span'); info.className = 'nico-result-info';
        const details = [video.id];
        if (video.publishedAt) details.push(new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Tokyo' }).format(new Date(video.publishedAt)));
        if (video.views !== null) details.push(`播放 ${number.format(video.views)}`);
        if (video.comments !== null) details.push(`评论 ${number.format(video.comments)}`);
        for (const detail of details) { const span = document.createElement('span'); span.textContent = detail; info.append(span); }
        copy.append(title, info); button.append(art, copy);
        button.addEventListener('click', () => open(video.id)); item.append(button); resultList.append(item);
      }
      previous.disabled = query.page === 0; nextPage.disabled = !data.hasMore;
      find('nico-page').textContent = `第 ${query.page + 1} 页`; find('nico-pages').hidden = data.total === 0;
      results.scrollIntoView?.({ block: 'start' });
    } catch (error) {
      if (!signal.aborted) searchStatus.textContent = error instanceof Error ? error.message : '搜索失败，请重新搜索。';
    } finally {
      if (started) nextSearchAt = performance.now() + (performance.now() - started);
      if (searchAbort === controller) { go.disabled = false; results.setAttribute('aria-busy', 'false'); searchAbort = undefined; }
    }
  }
  find<HTMLFormElement>('nico-form').addEventListener('submit', event => {
    event.preventDefault();
    if (mode.value === 'tag' || mode.value === 'keyword') {
      const query = input.value.trim();
      if (!query || query.length > 120) { input.setAttribute('aria-invalid', 'true'); status.textContent = '请输入 1–120 个字符的关键词或标签。'; input.focus(); return; }
      void search({ query, mode: mode.value, page: 0 }); return;
    }
    const id = parseVideoId(input.value);
    if (!id) {
      input.setAttribute('aria-invalid', 'true');
      status.textContent = '请输入 Niconico 视频链接或视频编号，例如 sm1097445。';
      input.focus(); return;
    }
    clearResults(); open(id);
  });
  mode.addEventListener('change', updateMode);
  previous.addEventListener('click', () => { if (submitted && submitted.page > 0) void search({ ...submitted, page: submitted.page - 1 }); });
  nextPage.addEventListener('click', () => { if (submitted) void search({ ...submitted, page: submitted.page + 1 }); });
  find('nico-close').addEventListener('click', () => { closePlayer(); input.focus(); });
  find('nico-retry').addEventListener('click', () => { if (currentId) open(currentId); });
  clear.addEventListener('click', () => { recent = []; saveHistory(); });
  renderHistory();
  return { destroy };
}
