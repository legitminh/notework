// Login relay for the Notework web app (a Cloudflare Worker).
//
// GitHub's device-flow login endpoints do not send CORS headers, so a web page cannot
// call them. This Worker forwards exactly those two requests and nothing else. It holds
// no secret: the device flow needs only the GitHub App's public client ID. It stores
// nothing and never sees file contents. The native app does not use it.
//
// Deploy: create a Worker, paste this file, and set two variables:
//   ALLOWED_ORIGINS  comma-separated web app origins, e.g. https://notework.example
//   CLIENT_ID        the Notework GitHub App's client ID
// Then put the Worker's URL in GITHUB_APP.relay (src/lib/github/app.ts).

const routes = {
  '/login/device/code': ['client_id'],
  '/login/oauth/access_token': ['client_id', 'device_code', 'grant_type']
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '';
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    const cors = allowed.includes(origin) ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Accept, Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin'
    } : null;
    if (!cors) return new Response('origin not allowed', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const path = new URL(request.url).pathname;
    const fields = routes[path];
    if (request.method !== 'POST' || !fields) return new Response('not found', { status: 404, headers: cors });

    const input = new URLSearchParams(await request.text());
    if (input.get('client_id') !== env.CLIENT_ID) return new Response('unknown client', { status: 403, headers: cors });
    const body = new URLSearchParams();
    for (const field of fields) if (input.has(field)) body.set(field, input.get(field));

    const reply = await fetch('https://github.com' + path, {
      method: 'POST', redirect: 'manual',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Notework login relay' },
      body
    });
    return new Response(await reply.text(), {
      status: reply.status,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }
};
