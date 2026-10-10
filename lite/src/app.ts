import type { BootstrapResponse, StationSummary, NowPlayingResponse, ProgramEntry, OnAirSong } from '../lib/types.ts';

type Theme = 'system' | 'dark' | 'light';
type Playback = { kind: 'idle' | 'loading' | 'playing' | 'paused' } | { kind: 'error'; message: string };
type Session = { streamUrl: string; stationId: string; expiresAtEpochMillis: number; playbackId?: string };
type HlsInstance = {
  loadSource(url: string): void; attachMedia(audio: HTMLAudioElement): void; destroy(): void;
  on(event: string, callback: (event: string, data: { fatal?: boolean }) => void): void;
};
type HlsConstructor = { new (config: object): HlsInstance; isSupported(): boolean; Events: Record<string, string> };
declare global { interface Window { Hls?: HlsConstructor } }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
};
const audio = $<HTMLAudioElement>('audio');
const storage = {
  get(key: string): string | null { try { return localStorage.getItem(`radio.${key}`); } catch { return null; } },
  set(key: string, value: string) { try { localStorage.setItem(`radio.${key}`, value); } catch { /* Private browsing can disallow storage. */ } },
};
function readFavorites(): Set<string> {
  try { const value: unknown = JSON.parse(storage.get('favorites') ?? '[]'); return new Set(Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []); }
  catch { return new Set(); }
}
const state = {
  data: null as BootstrapResponse | null, selected: null as StationSummary | null,
  phase: { kind: 'idle' } as Playback, session: null as Session | null,
  favorites: readFavorites(), favoritesOnly: false, area: storage.get('area') ?? 'JP13', query: '',
  nowPlaying: null as NowPlayingResponse | null, songsForProgram: false, showAllSongs: false,
};
let generation = 0;
let sessionAbort: AbortController | undefined;
let metadataAbort: AbortController | undefined;
let hls: HlsInstance | undefined;
let renewTimer: ReturnType<typeof setTimeout> | undefined;
let sleepDeadline = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const icon = (name: string) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const nameForArea = (id: string) => state.data?.prefectures.find(area => area.id === id)?.names['zh-CN'] ?? id;
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const cleanText = (text: string) => {
  // Parse metadata as text, never insert upstream markup into the page.
  const parsed = new DOMParser().parseFromString(text.replace(/<!\[CDATA\[|\]\]>/g, ''), 'text/html');
  return parsed.body.textContent?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() ?? '';
};

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...options, headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...options.headers }, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000) });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error(navigator.onLine ? '连接超时，请稍后重试。' : '网络已断开，请检查连接后重试。');
  }
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('服务暂时不可用，可能达到托管额度。请稍后重试。');
  const data = await response.json();
  if (!response.ok) throw new Error(withReference(typeof data.message === 'string' ? cleanText(data.message).slice(0, 160) : `服务暂时不可用（${response.status}）。`, data.requestId));
  return data as T;
}

function toast(text: string) {
  $('toast').textContent = text; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
}
function setPhase(phase: Playback) {
  state.phase = phase;
  const playing = phase.kind === 'playing';
  document.body.classList.toggle('is-playing', playing);
  const label = playing ? '暂停' : phase.kind === 'loading' ? '正在连接，点击取消' : '播放';
  for (const id of ['hero-play', 'player-play']) { $(id).innerHTML = icon(playing || phase.kind === 'loading' ? 'pause' : 'play'); $(id).setAttribute('aria-label', label); }
  const descriptions = { idle: '准备播放', loading: '正在连接…', playing: '正在直播', paused: '已暂停' } as const;
  $('play-status').textContent = phase.kind === 'error' ? phase.message : descriptions[phase.kind];
  $('on-air').innerHTML = `<span></span>${playing ? 'ON AIR / LIVE' : phase.kind === 'loading' ? 'TUNING IN…' : 'READY TO TUNE IN'}`;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : phase.kind === 'paused' ? 'paused' : 'none';
}
function withReference(message: string, id?: unknown) {
  return typeof id === 'string' && /^[\da-f]{8}-[\da-f-]{27}$/.test(id) ? `${message}（关联 ID：${id}）` : message;
}
function reportError(error: unknown, playbackId?: string) {
  const message = withReference(error instanceof Error ? error.message : '暂时无法播放，请重试。', playbackId);
  setPhase({ kind: 'error', message }); toast(message);
}
// Native lazy loading can fetch images several screens ahead. Keep requests
// close to the viewport instead, especially when browsing all 109 stations.
const pendingImages = new WeakMap<HTMLImageElement, string>();
const imageObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const image = entry.target as HTMLImageElement, source = pendingImages.get(image);
    if (source && image.isConnected) image.src = source;
    pendingImages.delete(image); imageObserver?.unobserve(image);
  }
}, { rootMargin: '160px' }) : undefined;
function deferImage(image: HTMLImageElement, source: string) {
  image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
  if (imageObserver) { pendingImages.set(image, source); imageObserver.observe(image); }
  else image.src = source;
}
function replaceContent(container: HTMLElement, ...nodes: Node[]) {
  // Do not keep observing detached images after a search, refresh or station switch.
  for (const image of container.querySelectorAll('img')) { pendingImages.delete(image); imageObserver?.unobserve(image); }
  container.replaceChildren(...nodes);
}
function logo(station: StationSummary, className = 'station-logo') {
  const box = document.createElement('span'); box.className = className;
  const image = new Image(); image.alt = ''; image.width = 224; image.height = 100;
  image.addEventListener('error', () => { box.textContent = station.id.slice(0, 5); }, { once: true });
  deferImage(image, station.logoUrl);
  box.append(image); return box;
}

function renderStations() {
  if (!state.data) return;
  const query = state.query.normalize('NFKC').toLocaleLowerCase();
  const stations = state.data.stations.filter(station => (!state.area || state.favoritesOnly || station.areaIds.includes(state.area)) &&
    (!state.favoritesOnly || state.favorites.has(station.id)) && `${station.id} ${station.name}`.normalize('NFKC').toLocaleLowerCase().includes(query));
  $('station-count').textContent = `${stations.length}`;
  $('favorite-count').textContent = `${state.favorites.size}`;
  const fragment = new DocumentFragment();
  for (const station of stations) {
    const card = document.createElement('article'); card.className = `station-card${state.selected?.id === station.id ? ' selected' : ''}`;
    const play = document.createElement('button'); play.className = 'station-select'; play.setAttribute('aria-label', `播放 ${station.name}`);
    const copy = document.createElement('span'); copy.className = 'station-copy';
    copy.innerHTML = `<strong>${escape(station.name)}</strong><small>${escape(nameForArea(station.areaIds[0]!))} · ${escape(station.id)}</small>`;
    play.append(logo(station), copy); play.addEventListener('click', () => { void selectAndPlay(station); });
    const favorite = document.createElement('button'); favorite.className = 'favorite'; favorite.innerHTML = icon('heart');
    favorite.setAttribute('aria-label', `${state.favorites.has(station.id) ? '取消收藏' : '收藏'} ${station.name}`);
    favorite.setAttribute('aria-pressed', `${state.favorites.has(station.id)}`);
    favorite.addEventListener('click', () => toggleFavorite(station.id));
    card.append(play, favorite); fragment.append(card);
  }
  if (!stations.length) {
    const empty = document.createElement('p'); empty.className = 'empty-state';
    empty.textContent = state.favoritesOnly ? '这里还没有收藏。点电台旁的爱心，把喜欢的声音留住。' : '没有匹配的电台。试试其他关键词或选择全部地区。'; fragment.append(empty);
  }
  replaceContent($('station-grid'), fragment); $('station-grid').setAttribute('aria-busy', 'false');
}
function toggleFavorite(id: string) {
  if (state.favorites.has(id)) state.favorites.delete(id); else state.favorites.add(id);
  storage.set('favorites', JSON.stringify([...state.favorites]));
  renderStations(); updateFavorite();
}
function updateFavorite() {
  const active = !!state.selected && state.favorites.has(state.selected.id);
  $('player-favorite').setAttribute('aria-pressed', `${active}`);
  $('player-favorite').setAttribute('aria-label', active ? '取消收藏当前电台' : '收藏当前电台');
}
function selectStation(station: StationSummary) {
  state.selected = station; storage.set('station', station.id);
  state.nowPlaying = null; state.songsForProgram = false; state.showAllSongs = false;
  $('songs-station').textContent = station.name; renderSongHistory();
  $('selected-name').textContent = station.name;
  $('selected-area').textContent = `${nameForArea(station.areaIds[0]!)} / JAPAN LIVE`;
  $('mini-name').textContent = station.name;
  replaceContent($('mini-logo'), logo(station, 'mini-logo'));
  $('player-bar').hidden = false; $<HTMLButtonElement>('hero-play').disabled = false;
  $('program-title').textContent = '正在获取节目信息…'; $('program-time').textContent = 'LIVE RADIO / ラジオ';
  renderStations(); updateFavorite(); updateMediaSession(); void updateProgram();
}
function updateMediaSession(program?: ProgramEntry | null) {
  if (!('mediaSession' in navigator) || !state.selected) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: program ? cleanText(program.title) : state.selected.name,
    artist: state.selected.name, album: 'Radikall Lite', artwork: [{ src: state.selected.logoUrl, sizes: '224x100', type: 'image/png' }] });
}
async function updateProgram() {
  const station = state.selected; if (!station) return;
  metadataAbort?.abort(); metadataAbort = new AbortController();
  const signal = metadataAbort.signal;
  $('song-content').setAttribute('aria-busy', 'true');
  $<HTMLButtonElement>('songs-refresh').disabled = true;
  $('songs-status').hidden = false;
  $('songs-status').textContent = state.nowPlaying ? '正在更新歌曲记录…' : '正在获取歌曲记录…';
  try {
    const data = await api<NowPlayingResponse>(`/api/stations/${encodeURIComponent(station.id)}/now-playing`, { signal });
    if (signal.aborted || state.selected?.id !== station.id) return;
    state.nowPlaying = data; renderSongHistory(); $('songs-status').hidden = true;
    const program = data.currentProgram;
    $('program-title').textContent = program ? cleanText(program.title) : '直播中 · 暂无节目信息';
    $('program-detail').innerHTML = program ? `<p class="program-name">${escape(cleanText(program.title))}</p><p class="program-performer">${escape(cleanText(program.performer ?? ''))}</p><p class="muted">${formatProgramTime(program)}</p>` : '<p class="muted">当前没有节目信息，仍然可以收听直播。</p>';
    if (program) $('program-time').textContent = formatProgramTime(program);
    updateMediaSession(program);
  } catch {
    if (signal.aborted || state.selected?.id !== station.id) return;
    $('program-title').textContent = '节目信息暂不可用 · 点击播放收听';
    $('program-detail').innerHTML = '<p class="muted">节目信息暂不可用，仍然可以尝试播放。</p>';
    $('songs-status').textContent = state.nowPlaying ? '更新暂时失败，显示上次获取的记录。可点击刷新重试。' : '歌曲记录暂时无法获取，请点击刷新重试。';
  } finally {
    if (!signal.aborted && state.selected?.id === station.id) {
      $('song-content').setAttribute('aria-busy', 'false');
      $<HTMLButtonElement>('songs-refresh').disabled = false;
    }
  }
}

function songContent(song: OnAirSong): HTMLElement {
  const row = document.createElement('div'); row.className = 'song-row';
  const artwork = document.createElement('span'); artwork.className = 'song-artwork'; artwork.textContent = '♪'; artwork.setAttribute('aria-hidden', 'true');
  try {
    const url = new URL(song.imageUrl ?? '');
    if (url.protocol === 'https:' && !url.username && !url.password) {
      const image = new Image(); image.alt = ''; image.width = 160; image.height = 160;
      image.addEventListener('error', () => image.remove(), { once: true });
      deferImage(image, url.href); artwork.append(image);
    }
  } catch { /* Missing covers keep the music-note placeholder. */ }
  const copy = document.createElement('div'); copy.className = 'song-copy';
  const title = document.createElement('strong'); title.className = 'song-title'; title.textContent = cleanText(song.title);
  const artist = document.createElement('span'); artist.className = 'song-artist'; artist.textContent = cleanText(song.artist);
  const time = document.createElement('time'); time.className = 'song-time';
  const date = new Date(song.stampDate);
  if (Number.isNaN(date.getTime())) time.textContent = '播出时间未知';
  else {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(part => [part.type, part.value]));
    time.dateTime = date.toISOString(); time.textContent = `${parts.month}/${parts.day} ${parts.hour}:${parts.minute} JST`;
  }
  copy.append(title, artist, time); row.append(artwork, copy); return row;
}

function renderSongHistory() {
  const data = state.nowPlaying, latest = data?.currentSong ?? data?.recentSongs[0] ?? null;
  const current = $('latest-song'); replaceContent(current);
  if (latest) current.append(songContent(latest));
  else { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '电台暂未公布歌曲信息。'; current.append(empty); }
  const source = (state.songsForProgram ? data?.currentProgramSongs : data?.recentSongs) ?? [];
  // Keep repeated songs at different broadcast times; omit only the latest entry.
  const history = source.filter(song => !latest || song.title !== latest.title || song.artist !== latest.artist || song.stampDate !== latest.stampDate);
  $('songs-count').textContent = String(history.length);
  const fragment = new DocumentFragment();
  for (const song of state.showAllSongs ? history : history.slice(0, 4)) {
    const item = document.createElement('li'); item.append(songContent(song)); fragment.append(item);
  }
  replaceContent($('song-history'), fragment);
  $('songs-empty').hidden = history.length > 0 || !data;
  $('songs-empty').textContent = state.songsForProgram ? '暂无本节目更早的歌曲记录，可以切换到全台最近。' : '暂无更早的歌曲记录。';
  const more = $('songs-more'); more.hidden = history.length <= 4;
  more.textContent = state.showAllSongs ? '收起记录' : `展开更多（共 ${history.length} 首）`;
  more.setAttribute('aria-expanded', String(state.showAllSongs));
  for (const [id, active] of [['songs-station-scope', !state.songsForProgram], ['songs-program', state.songsForProgram]] as const) {
    $(id).classList.toggle('active', active); $(id).setAttribute('aria-pressed', String(active));
  }
}

$('songs-refresh').addEventListener('click', () => { void updateProgram(); });
$('songs-more').addEventListener('click', () => { state.showAllSongs = !state.showAllSongs; renderSongHistory(); });
for (const [id, programOnly] of [['songs-station-scope', false], ['songs-program', true]] as const) $(id).addEventListener('click', () => {
  state.songsForProgram = programOnly; state.showAllSongs = false; renderSongHistory();
});
function formatProgramTime(program: ProgramEntry) {
  const fmt = (value: string) => /^\d{14}$/.test(value) ? `${value.slice(8, 10)}:${value.slice(10, 12)}` : '--:--';
  return `${fmt(program.startAt)} — ${fmt(program.endAt)} JST`;
}

let hlsLoading: Promise<HlsConstructor> | undefined;
function loadHls(): Promise<HlsConstructor> {
  if (window.Hls) return Promise.resolve(window.Hls);
  return hlsLoading ??= new Promise<HlsConstructor>((resolve, reject) => {
    const script = document.createElement('script'); script.src = '/vendor/hls.min.js';
    script.onload = () => window.Hls ? resolve(window.Hls) : reject(new Error('播放器加载失败。'));
    script.onerror = () => { script.remove(); reject(new Error('播放器加载失败，请检查网络后重试。')); };
    document.head.append(script);
  }).catch(error => { hlsLoading = undefined; throw error; });
}
function resetAudio() {
  hls?.destroy(); hls = undefined; audio.pause(); audio.removeAttribute('src'); audio.load();
}
async function attach(session: Session, ticket: number) {
  resetAudio();
  if (audio.canPlayType('application/vnd.apple.mpegurl')) { audio.src = session.streamUrl; audio.load(); return; }
  const Hls = await loadHls(); if (ticket !== generation) return;
  if (!Hls.isSupported()) throw new Error('此浏览器不支持直播音频，请使用 Safari 或较新的 Chrome。');
  const instance = hls = new Hls({ enableWorker: true, maxBufferLength: 30, backBufferLength: 15 });
  instance.on(Hls.Events.ERROR!, (_, data) => {
    if (hls !== instance || !data.fatal) return;
    const playbackId = state.session?.playbackId;
    instance.destroy(); hls = undefined; state.session = null;
    audio.pause(); reportError(new Error('播放连接中断，请点击播放重新连接。'), playbackId);
  });
  instance.loadSource(session.streamUrl); instance.attachMedia(audio);
}
async function selectAndPlay(station: StationSummary) {
  if (station.id === state.selected?.id && ['playing', 'loading'].includes(state.phase.kind)) { pause(); return; }
  if (station.id !== state.selected?.id) { pause(); state.session = null; selectStation(station); }
  await start();
}
async function start(force = false) {
  const station = state.selected; if (!station) return;
  if (sleepDeadline && sleepDeadline <= Date.now()) { stopForSleep(); return; }
  const ticket = ++generation; sessionAbort?.abort(); sessionAbort = new AbortController();
  const signal = sessionAbort.signal;
  setPhase({ kind: 'loading' });
  try {
    if (force || !state.session || state.session.stationId !== station.id || state.session.expiresAtEpochMillis < Date.now() + 60_000 || (!audio.src && !hls)) {
      resetAudio();
      const session = await api<Session>('/api/playback/live-session', { method: 'POST', signal,
        body: JSON.stringify({ stationId: station.id, preferredAreaId: station.areaIds.includes(state.area) ? state.area : station.areaIds[0] }) });
      if (ticket !== generation) return;
      state.session = session; await attach(session, ticket);
    }
    if (ticket !== generation) return;
    await audio.play();
    if (ticket !== generation) return;
    setPhase({ kind: 'playing' }); armRenewal();
  } catch (error) {
    if (ticket !== generation || signal.aborted) return;
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      setPhase({ kind: 'paused' }); toast('电台已准备好，请再点一下播放。');
    } else {
      const playbackId = state.session?.playbackId;
      state.session = null; resetAudio();
      // Preserve a more specific media error if it arrived before play() rejected.
      if (state.phase.kind !== 'error') reportError(error instanceof DOMException ? new Error('音频暂时无法播放，请点击播放重试。') : error, playbackId);
    }
  }
}
function pause() {
  ++generation; sessionAbort?.abort(); clearTimeout(renewTimer);
  // Release HLS segment loading as well as the audible element.
  resetAudio(); state.session = null; setPhase({ kind: 'paused' });
}
function togglePlayback() { if (['playing', 'loading'].includes(state.phase.kind)) pause(); else void start(); }
function armRenewal() {
  clearTimeout(renewTimer);
  if (!state.session) return;
  renewTimer = setTimeout(() => { if (state.phase.kind === 'playing') void start(true); }, Math.max(1000, state.session.expiresAtEpochMillis - Date.now() - 5 * 60_000));
}
audio.addEventListener('playing', () => { if (state.phase.kind !== 'paused' && state.phase.kind !== 'idle') setPhase({ kind: 'playing' }); });
audio.addEventListener('pause', () => { if (state.phase.kind === 'playing') { setPhase({ kind: 'paused' }); clearTimeout(renewTimer); } });
audio.addEventListener('error', () => {
  if (state.phase.kind === 'idle' || state.phase.kind === 'paused' || state.phase.kind === 'error') return;
  const playbackId = state.session?.playbackId;
  state.session = null; reportError(new Error('音频暂时无法播放，请点击播放重试。'), playbackId);
});
audio.addEventListener('timeupdate', () => { if (sleepDeadline && Date.now() >= sleepDeadline) stopForSleep(); });
if ('mediaSession' in navigator) {
  for (const [action, callback] of Object.entries({ play: () => { void start(); }, pause, stop: pause })) {
    try { navigator.mediaSession.setActionHandler(action as MediaSessionAction, callback); } catch { /* Optional on older browsers. */ }
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (sleepDeadline && Date.now() >= sleepDeadline) { stopForSleep(); return; }
  if (state.phase.kind === 'playing' && state.session && state.session.expiresAtEpochMillis < Date.now() + 5 * 60_000) void start(true);
  void updateProgram();
});
window.addEventListener('offline', () => { toast('网络已断开。恢复连接后，点击播放继续。'); });
setInterval(() => { if (!document.hidden && state.phase.kind === 'playing') void updateProgram(); }, 60_000);

const systemTheme = matchMedia('(prefers-color-scheme: dark)');
let theme = (['system', 'dark', 'light'].includes(storage.get('theme') ?? '') ? storage.get('theme') : 'system') as Theme;
function applyTheme() {
  const resolved = theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#101412' : '#f5f5ee');
  $('theme').innerHTML = icon(resolved === 'dark' ? 'moon' : 'sun');
  const names = { system: '跟随系统', dark: '深色', light: '浅色' };
  $('theme').setAttribute('aria-label', `当前${names[theme]}，点击切换主题`);
}
$('theme').addEventListener('click', () => {
  theme = ({ system: 'dark', dark: 'light', light: 'system' } as const)[theme]; storage.set('theme', theme); applyTheme();
  toast(`主题：${({ system: '跟随系统', dark: '深色', light: '浅色' } as const)[theme]}`);
});
systemTheme.addEventListener('change', applyTheme); applyTheme();
function tick() {
  $('tokyo-time').textContent = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  if (sleepDeadline && Date.now() >= sleepDeadline) stopForSleep();
  $('sleep-label').textContent = sleepDeadline ? `${Math.ceil((sleepDeadline - Date.now()) / 60_000)} 分钟后停止` : '设置睡眠定时';
  $('player-sleep').setAttribute('aria-label', $('sleep-label').textContent!);
  $('player-sleep').style.color = sleepDeadline ? 'var(--accent)' : '';
}
function stopForSleep() { sleepDeadline = 0; pause(); tick(); toast('睡眠定时已结束。晚安。'); }
setInterval(tick, 1000); tick();
for (const id of ['sleep-open', 'player-sleep']) $(id).addEventListener('click', () => $<HTMLDialogElement>('sleep-dialog').showModal());
$('sleep-options').addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-minutes]'); if (!button) return;
  const minutes = Number(button.dataset.minutes); sleepDeadline = minutes ? Date.now() + minutes * 60_000 : 0;
  $<HTMLDialogElement>('sleep-dialog').close(); tick(); toast(minutes ? `${minutes} 分钟后停止播放` : '已关闭睡眠定时');
});
$('about').addEventListener('click', () => $<HTMLDialogElement>('about-dialog').showModal());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => {
  const rect = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
});
for (const id of ['hero-play', 'player-play']) $(id).addEventListener('click', togglePlayback);
$('player-favorite').addEventListener('click', () => { if (state.selected) toggleFavorite(state.selected.id); });
$<HTMLInputElement>('search').addEventListener('input', event => { state.query = (event.target as HTMLInputElement).value; renderStations(); });
$<HTMLSelectElement>('area').addEventListener('change', event => { state.area = (event.target as HTMLSelectElement).value; storage.set('area', state.area); renderStations(); });
for (const [id, favorites] of [['tab-all', false], ['tab-favorites', true]] as const) $(id).addEventListener('click', () => {
  state.favoritesOnly = favorites;
  for (const [tabId, active] of [['tab-all', !favorites], ['tab-favorites', favorites]] as const) { $(tabId).classList.toggle('active', active); $(tabId).setAttribute('aria-pressed', `${active}`); }
  renderStations();
});
async function bootstrap() {
  $('page-message').hidden = true;
  try {
    state.data = await api<BootstrapResponse>('/api/bootstrap');
    if (state.area && !state.data.prefectures.some(area => area.id === state.area)) state.area = 'JP13';
    const areaSelect = $<HTMLSelectElement>('area'); areaSelect.replaceChildren(new Option('全部地区', ''));
    for (const area of state.data.prefectures) areaSelect.add(new Option(area.names['zh-CN'], area.id));
    areaSelect.value = state.area;
    const station = state.data.stations.find(item => item.id === storage.get('station')) ?? state.data.stations.find(item => item.id === 'FMJ') ?? state.data.stations.find(item => item.areaIds.includes(state.area)) ?? state.data.stations[0];
    renderStations(); if (station) selectStation(station);
  } catch (error) {
    $('station-grid').replaceChildren(); $('station-grid').setAttribute('aria-busy', 'false');
    const message = $('page-message'); message.textContent = error instanceof Error ? error.message : '电台列表加载失败。';
    const retry = document.createElement('button'); retry.textContent = '重试'; retry.addEventListener('click', () => { void bootstrap(); });
    message.append(retry); message.hidden = false;
  }
}
await bootstrap();
