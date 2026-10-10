import { authenticate } from './auth.ts';
import { encryptPlaybackToken, decryptPlaybackToken } from './crypto.ts';
import { bootstrapData, stationById, gpsCoordinates } from './data.ts';
import { buildNowPlayingResponse, buildScheduleResponse } from './program.ts';
import { buildLiveStreamUrl } from './stream.ts';
import { fetchUpstream, isAllowedUrl } from './network.ts';
import type { PlaybackTokenPayload } from './types.ts';

export type Settings = { RADIKALL_SESSION_SECRET?: string };
const TTL = 55 * 60_000;
const deps = { authenticate, buildLiveStreamUrl, buildNowPlayingResponse, buildScheduleResponse, fetchUpstream };
type Dependencies = typeof deps;
const json = (body: unknown, status = 200, cache = 'no-store') => Response.json(body, {
  status, headers: { 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' },
});
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// Bounded, best-effort cache. Correctness never depends on a warm instance.
function cached<T>(loader: (key: string) => Promise<T>, ttl: number) {
  const entries = new Map<string, { until: number; pending: Promise<T> }>();
  return (key: string): Promise<T> => {
    const hit = entries.get(key);
    if (hit && hit.until > Date.now()) return hit.pending;
    if (entries.size > 200) entries.clear();
    const pending = loader(key).catch(error => { entries.delete(key); throw error; });
    entries.set(key, { until: Date.now() + ttl, pending });
    return pending;
  };
}

async function smallJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new HttpError(415, '请发送 JSON 请求。');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, '请求内容为空。');
  let text = '', size = 0;
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) { await reader.cancel(); throw new HttpError(413, '请求过大。'); }
    text += decoder.decode(value, { stream: true });
  }
  try {
    const body: unknown = JSON.parse(text + decoder.decode());
    if (typeof body !== 'object' || !body || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new HttpError(400, 'JSON 格式错误。'); }
}

export function rewritePlaylist(token: string, base: string, text: string): string {
  const proxied = (value: string) => {
    const target = new URL(value, base).href;
    if (!isAllowedUrl(target)) throw new HttpError(502, '音频地址不在允许的上游列表中。');
    return `/api/playback/live/${encodeURIComponent(token)}/proxy?target=${encodeURIComponent(target)}`;
  };
  return text.split('\n').map(line => {
    const value = line.trim();
    if (!value) return line;
    // Includes encryption keys, fMP4 init maps, alternate audio, and nested playlists.
    if (value.startsWith('#')) return line.replace(/\bURI="([^"]+)"/g, (_, uri: string) => `URI="${proxied(uri)}"`);
    return proxied(value);
  }).join('\n');
}

export function createHandler(overrides: Partial<Dependencies> = {}) {
  const services = { ...deps, ...overrides };
  const nowPlaying = cached(services.buildNowPlayingResponse, 45_000);
  const schedule = cached(services.buildScheduleResponse, 300_000);
  return async function handle(request: Request, env: Settings = {}): Promise<Response> {
    try {
      const url = new URL(request.url), path = url.pathname;
      if (path === '/health' || path === '/api/health') return json({ status: 'ok', configured: (env.RADIKALL_SESSION_SECRET?.length ?? 0) >= 32 });
      if (path === '/api/bootstrap' && request.method === 'GET') return json(bootstrapData, 200, 'public, max-age=3600');
      const program = path.match(/^\/api\/stations\/([^/]+)\/(now-playing|schedule)$/);
      if (program && request.method === 'GET') {
        const id = decodeURIComponent(program[1]!);
        if (!stationById.has(id)) throw new HttpError(404, '找不到这个电台。');
        return json(await (program[2] === 'schedule' ? schedule(id) : nowPlaying(id)));
      }
      if (path === '/api/playback/live-session' && request.method === 'POST') {
        // Same-origin browser usage; native players can omit Origin.
        const origin = request.headers.get('origin');
        if (origin && origin !== url.origin) throw new HttpError(403, '不接受跨站播放请求。');
        const body = await smallJson(request);
        if (typeof body.stationId !== 'string' || !stationById.has(body.stationId)) throw new HttpError(400, '请选择有效电台。');
        const station = stationById.get(body.stationId)!;
        const area = typeof body.preferredAreaId === 'string' ? body.preferredAreaId : station.areaIds[0]!;
        if (!Object.hasOwn(gpsCoordinates, area) || !station.areaIds.includes(area)) throw new HttpError(400, '电台与地区不匹配。');
        const secret = requireSecret(env);
        const [auth, stream] = await Promise.all([services.authenticate(area), services.buildLiveStreamUrl(station.id)]);
        if (!isAllowedUrl(stream)) throw new HttpError(502, '上游播放地址无效。');
        const issuedAtEpochMillis = Date.now(), expiresAtEpochMillis = issuedAtEpochMillis + TTL;
        const token = await encryptPlaybackToken(secret, {
          stationId: station.id, resolvedAreaId: auth.areaId, authToken: auth.token,
          userAgent: auth.userAgent, upstreamMasterUrl: stream, issuedAtEpochMillis, expiresAtEpochMillis,
        });
        return json({ stationId: station.id, expiresAtEpochMillis, streamUrl: `/api/playback/live/${token}/master.m3u8` });
      }
      const playback = path.match(/^\/api\/playback\/live\/([^/]+)\/(master\.m3u8|proxy)$/);
      if (playback && request.method === 'GET') {
        const token = playback[1]!;
        const session = await decryptPlaybackToken(requireSecret(env), token);
        if (!session || !Number.isFinite(session.expiresAtEpochMillis) || Date.now() >= session.expiresAtEpochMillis) {
          throw new HttpError(410, '播放会话已过期，请重新播放。');
        }
        const target = playback[2] === 'master.m3u8' ? session.upstreamMasterUrl : url.searchParams.get('target');
        if (!target || !isAllowedUrl(target)) throw new HttpError(400, '不支持的音频地址。');
        return await proxy(request, session, token, target, services.fetchUpstream);
      }
      return json({ message: '找不到这个接口。' }, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ message: error.message }, error.status);
      // Never display upstream HTML, authentication tokens or full proxy URLs.
      return json({ message: '暂时无法连接电台服务，请稍后重试。' }, 502);
    }
  };
}

function requireSecret(env: Settings): string {
  const secret = env.RADIKALL_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new HttpError(503, '服务尚未配置播放密钥，请联系部署者。');
  return secret;
}

async function proxy(request: Request, session: PlaybackTokenPayload, token: string, target: string, fetcher: Dependencies['fetchUpstream']) {
  const headers = new Headers({ 'X-Radiko-AuthToken': session.authToken, 'X-Radiko-AreaId': session.resolvedAreaId, 'User-Agent': session.userAgent });
  if (request.headers.has('range')) headers.set('Range', request.headers.get('range')!);
  const upstream = await fetcher(target, { headers, signal: request.signal });
  if (!upstream.ok) {
    await upstream.body?.cancel();
    throw new HttpError(upstream.status === 429 ? 503 : 502, '电台暂时无法播放，请稍后重试。');
  }
  const type = upstream.headers.get('content-type') ?? 'application/octet-stream';
  if (type.includes('text/html')) { await upstream.body?.cancel(); throw new HttpError(502, '电台返回了错误页面，请稍后重试。'); }
  const output = new Headers({ 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  for (const key of ['content-range', 'accept-ranges']) if (upstream.headers.has(key)) output.set(key, upstream.headers.get(key)!);
  if (new URL(target).pathname.endsWith('.m3u8') || /mpegurl/i.test(type)) {
    const text = await upstream.text();
    if (!text.trimStart().startsWith('#EXTM3U')) throw new HttpError(502, '电台播放列表无效。');
    output.set('Content-Type', 'application/vnd.apple.mpegurl');
    return new Response(rewritePlaylist(token, target, text), { headers: output });
  }
  return new Response(upstream.body, { status: upstream.status, headers: output });
}

export const handle = createHandler();
