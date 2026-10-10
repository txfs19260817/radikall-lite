import { handle } from '../../lib/app.ts';
export default (request: Request) => handle(request, { RADIKALL_SESSION_SECRET: process.env.RADIKALL_SESSION_SECRET });
export const config = { path: '/api/*' };
