// Keyless handler contract checks. Environment and fetch are replaced before import;
// no socket is opened, no credential file or real environment value is read.
const settings = new Map<string, string>();
Deno.env.get = (name: string) => settings.get(name);
let handler: (request: Request) => Promise<Response>;
Deno.serve = ((callback: typeof handler) => { handler = callback; return {}; }) as unknown as typeof Deno.serve;
let requests: string[] = [];
globalThis.fetch = (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  requests.push(url);
  if (url.includes('/auth/v1/user')) return Promise.resolve(Response.json({id:'11111111-1111-4111-8111-111111111111'}));
  if (url.includes('/rest/v1/runs?')) return Promise.resolve(Response.json(null));
  throw new Error(`Unexpected network path in keyless test: ${new URL(url).pathname}`);
};
await import('./index.ts');
function assert(ok: unknown, message: string) { if (!ok) throw new Error(message); }
const request = (body: BodyInit | null = '{}') => new Request('http://localhost/forecast', {method:'POST', headers:{Authorization:'Bearer synthetic-user'}, body});
const body = JSON.stringify({runId:'33333333-3333-4333-8333-333333333333',questionId:'q1',arm:'no_research',requestKey:'44444444-4444-4444-8444-444444444444'});
function platform() {
  settings.set('SUPABASE_URL','http://127.0.0.1:23002');
  settings.set('SUPABASE_ANON_KEY','synthetic-anon');
  settings.set('SUPABASE_SERVICE_ROLE_KEY','synthetic-service');
  requests=[];
}
Deno.test('what_bug_this_catches: browser preflight blocked or wrong origin', async () => {
  settings.set('APP_ORIGIN','https://s14.example');
  const r=await handler(new Request('http://localhost/forecast',{method:'OPTIONS',headers:{Origin:'https://s14.example'}}));
  assert(r.status===204,'OPTIONS status');
  assert(r.headers.get('Access-Control-Allow-Origin')==='https://s14.example','allowed origin');
  assert(requests.length===0,'preflight must not call backend');
});
Deno.test('what_bug_this_catches: unauthenticated or unconfigured invocation reaches backend', async () => {
  const unauthorized=await handler(new Request('http://localhost/forecast',{method:'POST',body:'{}'}));
  assert(unauthorized.status===401,'missing session');
  const unavailable=await handler(request());
  assert(unavailable.status===503,'missing platform config');
  assert((await unavailable.json()).error==='configuration_required','public configuration code');
  assert(requests.length===0,'no backend calls without config');
});
Deno.test('what_bug_this_catches: malformed or oversized streamed input reaches auth/provider', async () => {
  platform();
  for (const invalid of ['{','{}','x'.repeat(16385),new Uint8Array([0xff])]) {
    const r=await handler(request(invalid));
    assert(r.status===400,`invalid request status ${r.status}`);
  }
  assert(requests.length===0,'invalid input must not call auth/provider');
});
Deno.test('what_bug_this_catches: cross-owner or missing run uses privileged operations', async () => {
  platform();
  const r=await handler(request(body));
  assert(r.status===404,'unknown owned run must be not_found');
  assert(requests.length===2,'only user auth and RLS lookup allowed');
  assert(requests.every(u=>u.startsWith('http://127.0.0.1:23002/')),'no external network');
});
