import { handle, type Settings } from '../lib/app.ts';
type Env = Settings & { ASSETS: { fetch(request: Request): Promise<Response> } };
export default {
  fetch(request: Request, env: Env) {
    const path = new URL(request.url).pathname;
    return path.startsWith('/api/') || path === '/health' ? handle(request, env) : env.ASSETS.fetch(request);
  },
};
