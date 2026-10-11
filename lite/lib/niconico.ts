import { noteResponse, type Diagnostic } from './diagnostics.ts';

export const SEARCH_MODES = { tag: 'tag', keyword: 'keyword' } as const;
export type NiconicoSearchMode = typeof SEARCH_MODES[keyof typeof SEARCH_MODES];
export interface NiconicoVideo {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  duration: number | null;
  views: number | null;
  comments: number | null;
  publishedAt: string | null;
}
export interface NiconicoSearchResult {
  items: NiconicoVideo[];
  total: number;
  page: number;
  hasMore: boolean;
}
export class NiconicoSearchError extends Error {
  status: number;
  code = 'UPSTREAM_HTTP';
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const PAGE_SIZE = 12;
const MAX_PAGE = Math.floor(100_000 / PAGE_SIZE);
const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

function thumbnail(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || !url.hostname.endsWith('.nimg.jp')) return null;
    url.protocol = 'https:';
    return url.href;
  } catch { return null; }
}

// Public snapshot search only. Never forward browser credentials or accept a
// caller-supplied host, target, fields or redirect. Radiko's allowlist stays separate.
export async function searchNiconico(query: string, mode: NiconicoSearchMode, page: number, signal?: AbortSignal, trace?: Diagnostic, fetcher: typeof fetch = fetch): Promise<NiconicoSearchResult> {
  if (!query.trim() || query.length > 120 || !Object.hasOwn(SEARCH_MODES, mode) || !Number.isInteger(page) || page < 0 || page > MAX_PAGE) {
    throw new NiconicoSearchError(400, '请输入 1–120 个字符的关键词或标签，并选择有效页码。');
  }
  const url = new URL('https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search');
  url.search = new URLSearchParams({
    q: query.trim(), targets: mode === 'tag' ? 'tagsExact' : 'title,description,tags',
    fields: 'contentId,title,thumbnailUrl,lengthSeconds,viewCounter,commentCounter,startTime',
    _sort: '-viewCounter', _offset: String(page * PAGE_SIZE), _limit: String(PAGE_SIZE), _context: 'radikall-lite',
  }).toString();
  if (trace) trace.host = url.hostname;
  const response = await fetcher(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'radikall-lite/1.0' }, redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  noteResponse(trace, response);
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    throw new NiconicoSearchError(response.status === 400 ? 400 : response.status === 429 || response.status === 503 ? 503 : 502,
      response.status === 400 ? '搜索表达式无效，请简化关键词后重试。' : 'Niconico 搜索暂时不可用，请稍后重试。');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new NiconicoSearchError(502, 'Niconico 搜索返回了空响应。');
  const decoder = new TextDecoder(); let text = '', bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 262_144) throw new NiconicoSearchError(502, 'Niconico 搜索响应过大，请稍后重试。');
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel(); }
  const data = record(JSON.parse(text + decoder.decode())), meta = record(data.meta);
  const total = count(meta.totalCount);
  if (meta.status !== 200 || total === null || !Array.isArray(data.data)) throw new NiconicoSearchError(502, 'Niconico 搜索返回了无效数据。');
  const items: NiconicoVideo[] = [];
  for (const value of data.data.slice(0, PAGE_SIZE)) {
    const item = record(value);
    if (typeof item.contentId !== 'string' || !/^(?:(?:sm|nm|so)\d{1,12}|\d{10})$/.test(item.contentId) || typeof item.title !== 'string') continue;
    items.push({
      id: item.contentId, title: item.title.slice(0, 300), thumbnailUrl: thumbnail(item.thumbnailUrl),
      duration: count(item.lengthSeconds), views: count(item.viewCounter), comments: count(item.commentCounter),
      publishedAt: typeof item.startTime === 'string' && item.startTime.length <= 40 && Number.isFinite(Date.parse(item.startTime)) ? item.startTime : null,
    });
  }
  return { items, total, page, hasMore: page < MAX_PAGE && (page + 1) * PAGE_SIZE < total };
}
