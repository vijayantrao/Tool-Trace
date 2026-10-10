/**
 * Same-origin proxy to the ToolTrace API (a small "backend for frontend").
 *
 * The browser only ever talks to this web app, so the session cookie is
 * first-party and SameSite=Strict works. The target is read from API_URL at
 * request time, so one build can be deployed against any API.
 */
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

const API_URL = (process.env.API_URL ?? 'http://localhost:8080').replace(/\/$/, '');

// Only these request headers are forwarded. Everything else is dropped.
const FORWARD_REQUEST = ['cookie', 'content-type', 'origin', 'user-agent', 'sec-fetch-site', 'accept'];
// Only these response headers are passed back to the browser (plus every Set-Cookie).
const FORWARD_RESPONSE = [
  'content-type',
  'cache-control',
  'ratelimit-limit',
  'ratelimit-remaining',
  'retry-after',
  'x-accel-buffering',
];

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (path.some((p) => p === '..' || p === '.' || p.includes('/'))) {
    return Response.json({ error: { code: 'bad_path', message: 'Invalid path' } }, { status: 400 });
  }
  const target = `${API_URL}/api/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;

  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const v = req.headers.get(name);
    if (v) headers.set(name, v);
  }
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (clientIp) headers.set('x-forwarded-for', clientIp);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
      redirect: 'manual',
      cache: 'no-store',
      // Live event streams: when the browser goes away, close the upstream connection too.
      signal: req.signal,
    });
  } catch {
    return Response.json(
      { error: { code: 'api_unreachable', message: 'The ToolTrace server is not reachable right now. Try again shortly.' } },
      { status: 502 },
    );
  }

  const out = new Headers();
  for (const name of FORWARD_RESPONSE) {
    const v = upstream.headers.get(name);
    if (v) out.set(name, v);
  }
  for (const cookie of upstream.headers.getSetCookie()) out.append('set-cookie', cookie);

  return new Response(upstream.status === 204 ? null : upstream.body, { status: upstream.status, headers: out });
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE, proxy as PUT };
