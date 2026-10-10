import { allowedUpstreamHostSuffixes } from './data.ts';

export function isAllowedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      allowedUpstreamHostSuffixes.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

// Check every redirect before forwarding the upstream authentication headers.
export async function fetchUpstream(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  let request = new Request(input, init);
  for (let hop = 0; hop < 4; hop++) {
    if (!isAllowedUrl(request.url)) throw new Error('Unsupported upstream address');
    const response = await fetch(request, {
      redirect: 'manual',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('Invalid upstream redirect');
    const target = new URL(location, request.url);
    if (!isAllowedUrl(target.href)) throw new Error('Unsupported upstream redirect');
    request = new Request(target, { headers: request.headers, signal: request.signal });
  }
  throw new Error('Too many upstream redirects');
}
