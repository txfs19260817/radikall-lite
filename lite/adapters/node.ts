import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handle } from '../lib/app.ts';

const root = new URL('../public/', import.meta.url);
const files: Record<string, string> = {
  '/': 'text/html; charset=utf-8', '/index.html': 'text/html; charset=utf-8',
  '/app.js': 'text/javascript; charset=utf-8', '/styles.css': 'text/css; charset=utf-8',
  '/manifest.webmanifest': 'application/manifest+json', '/icon.svg': 'image/svg+xml',
  '/icon-192.png': 'image/png', '/icon-512.png': 'image/png',
  '/vendor/hls.min.js': 'text/javascript; charset=utf-8',
};

export async function nodeHandler(req: IncomingMessage, res: ServerResponse) {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  try {
    // The origin comes from the browser only for comparing same-origin POSTs.
    const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const url = new URL(req.url ?? '/', `${protocol}://${req.headers.host ?? 'localhost'}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const init = { method: req.method, headers, signal: controller.signal,
      ...(!['GET', 'HEAD'].includes(req.method ?? 'GET') ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
    } as RequestInit;
    let response: Response;
    if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
      response = await handle(new Request(url, init), { RADIKALL_SESSION_SECRET: process.env.RADIKALL_SESSION_SECRET });
    } else if (['GET', 'HEAD'].includes(req.method ?? 'GET') && Object.hasOwn(files, url.pathname)) {
      const bytes = await readFile(new URL(url.pathname === '/' ? 'index.html' : url.pathname.slice(1), root));
      response = new Response(req.method === 'HEAD' ? null : bytes, { headers: {
        'Content-Type': files[url.pathname]!, 'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      } });
    } else response = new Response('Not found', { status: 404 });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body && req.method !== 'HEAD') await pipeline(Readable.fromWeb(response.body as never), res);
    else res.end();
  } catch {
    if (res.headersSent) res.destroy();
    else { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"message":"服务暂时不可用。"}'); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  createServer(nodeHandler).listen(port, '0.0.0.0', () => console.log(`Radikall Lite · http://localhost:${port}`));
}
