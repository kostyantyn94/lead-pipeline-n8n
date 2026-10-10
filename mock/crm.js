// Mock CRM that speaks a subset of the HubSpot CRM v3 Contacts API, so the same n8n workflow runs
// offline and in tests. Switch to the real thing by pointing CRM_BASE_URL at https://api.hubapi.com.
// Node built-ins only: no npm install inside the container.
const http = require('http');

const PORT = Number(process.env.PORT || 8080);
const contacts = new Map(); // id -> { id, properties, createdAt, updatedAt }
let seq = 1000;
const stats = { calls: 0, searches: 0, created: 0, updated: 0 };
const log = [];

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve(null); }
    });
  });
}

function findByEmail(email) {
  const e = (email || '').toLowerCase();
  return [...contacts.values()].filter((c) => (c.properties.email || '').toLowerCase() === e);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  // Test helpers (not counted as API calls)
  if (req.method === 'GET' && path === '/stats') return send(res, 200, { ...stats, contacts: contacts.size });
  if (req.method === 'GET' && path === '/log') return send(res, 200, log.slice(-500));
  if (req.method === 'POST' && path === '/reset') {
    contacts.clear(); log.length = 0;
    for (const k of Object.keys(stats)) stats[k] = 0;
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && path === '/crm/v3/objects/contacts') return send(res, 200, { results: [...contacts.values()] });

  stats.calls++;
  log.push({ at: new Date().toISOString(), method: req.method, path });

  // POST /crm/v3/objects/contacts/search  { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value }] }] }
  if (req.method === 'POST' && path === '/crm/v3/objects/contacts/search') {
    const body = await readJson(req);
    stats.searches++;
    const filter = body?.filterGroups?.[0]?.filters?.find((f) => f.propertyName === 'email');
    const results = filter ? findByEmail(filter.value) : [];
    return send(res, 200, { total: results.length, results });
  }

  // POST /crm/v3/objects/contacts  { properties: { email, ... } }
  if (req.method === 'POST' && path === '/crm/v3/objects/contacts') {
    const body = await readJson(req);
    const email = body?.properties?.email;
    if (!email) return send(res, 400, { status: 'error', message: 'Property "email" is required' });
    if (findByEmail(email).length) return send(res, 409, { status: 'error', message: 'Contact already exists' });
    const id = String(++seq);
    const now = new Date().toISOString();
    contacts.set(id, { id, properties: { ...body.properties, email: email.toLowerCase() }, createdAt: now, updatedAt: now });
    stats.created++;
    return send(res, 201, contacts.get(id));
  }

  // PATCH / GET /crm/v3/objects/contacts/{id}
  const m = path.match(/^\/crm\/v3\/objects\/contacts\/(\d+)$/);
  if (m) {
    const c = contacts.get(m[1]);
    if (!c) return send(res, 404, { status: 'error', message: 'Contact not found' });
    if (req.method === 'GET') return send(res, 200, c);
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      Object.assign(c.properties, body?.properties || {});
      c.updatedAt = new Date().toISOString();
      stats.updated++;
      return send(res, 200, c);
    }
  }

  send(res, 404, { status: 'error', message: `Unknown route ${req.method} ${path}` });
}).listen(PORT, () => console.log(`mock CRM (HubSpot v3 contacts subset) listening on :${PORT}`));
