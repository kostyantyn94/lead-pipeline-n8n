// Dev loop for "workflows as code": push one or more built workflow JSON files into a running n8n and activate them.
// `n8n import:workflow` only creates workflows that do not exist yet, so updates go through n8n's REST API instead.
// Usage: N8N_EMAIL=you@example.com N8N_PASSWORD=... node scripts/n8n_push.js n8n/workflows/02-enrich-qualify.json [...]
//   (set N8N_URL to target another instance; default http://localhost:5678)
const fs = require('fs');

const base = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
const email = process.env.N8N_EMAIL;
const password = process.env.N8N_PASSWORD;
const files = process.argv.slice(2);
if (!email || !password || !files.length) {
  console.error('usage: N8N_EMAIL=... N8N_PASSWORD=... node scripts/n8n_push.js <workflow.json> [...]');
  process.exit(1);
}

async function api(method, route, cookie, body) {
  const res = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html error page */ }
  return { status: res.status, json, text, headers: res.headers };
}

(async () => {
  const login = await api('POST', '/rest/login', null, { emailOrLdapLoginId: email, password });
  if (login.status !== 200) { console.error(`login failed: ${login.status} ${login.text.slice(0, 200)}`); process.exit(1); }
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

  for (const file of files) {
    const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
    const current = await api('GET', `/rest/workflows/${wf.id}`, cookie);
    if (current.status === 404) {
      console.log(`${wf.id} ${wf.name}: not found, use "n8n import:workflow" for new workflows`);
      continue;
    }
    // optimistic locking: n8n rejects a PATCH without the version it currently holds
    const patch = await api('PATCH', `/rest/workflows/${wf.id}`, cookie, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings, versionId: current.json.data.versionId });
    if (patch.status !== 200) { console.error(`${wf.id}: PATCH ${patch.status} ${patch.text.slice(0, 200)}`); process.exit(1); }
    const activate = await api('POST', `/rest/workflows/${wf.id}/activate`, cookie, { versionId: patch.json.data.versionId });
    console.log(`${wf.id} ${wf.name}: updated, activate ${activate.status === 200 ? 'ok' : activate.status + ' ' + activate.text.slice(0, 120)}`);
  }
})();
