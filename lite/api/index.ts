import { handle } from '../lib/app.ts';
export default {
  fetch(request: Request) {
    const url = new URL(request.url);
    const route = url.searchParams.get('__route');
    if (route !== null) { url.pathname = `/api/${route}`; url.searchParams.delete('__route'); }
    return handle(new Request(url, request), { RADIKALL_SESSION_SECRET: process.env.RADIKALL_SESSION_SECRET });
  },
};
