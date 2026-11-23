// Login relay for the Notework web app (a Cloudflare Worker).
//
// GitHub's login endpoints do not send CORS headers, so a web page cannot call them.
// This Worker forwards only GitHub's login requests. The web app logs in with GitHub's
// redirect flow, and exchanging its one-time code needs the GitHub App's client secret,
// which lives here as a Worker secret and never reaches the browser. The exchange also
// requires the PKCE verifier only the page that started the login holds. The Worker
// stores nothing and never sees file contents. The native app does not use it.
//
// Deploy: create a Worker, paste this file, and set:
//   ALLOWED_ORIGINS  variable: comma-separated web app origins, e.g. https://legitminh.github.io
//   CLIENT_ID        variable: the Notework GitHub App's client ID
//   CLIENT_SECRET    secret (encrypted): a client secret generated on the GitHub App's page
// Then put the Worker's URL in GITHUB_APP.relay (src/lib/github/app.ts).

const routes = {
  '/login/device/code': ['client_id'],
  '/login/oauth/access_token': ['client_id', 'device_code', 'grant_type', 'code', 'code_verifier']
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
    if (body.has('code')) {
      if (!body.get('code_verifier')) return new Response('missing code_verifier', { status: 400, headers: cors });
      if (env.CLIENT_SECRET) body.set('client_secret', env.CLIENT_SECRET);
    }

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
