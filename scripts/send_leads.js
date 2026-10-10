// Posts every row of a CSV to the intake webhook, one JSON request per lead, and prints a summary.
// Usage: node scripts/send_leads.js [samples/leads.csv] [http://localhost:5678/webhook/lead]
const fs = require('fs');

const file = process.argv[2] || 'samples/leads.csv';
const url = process.argv[3] || 'http://localhost:5678/webhook/lead';

// Minimal RFC 4180 parser (quoted fields, doubled quotes, newlines inside quotes).
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows.filter((r) => r.length > 1 || r[0]);
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

(async () => {
  const leads = parseCsv(fs.readFileSync(file, 'utf8'));
  const t0 = Date.now();
  const summary = { sent: 0, accepted: 0, new: 0, duplicates: 0, rejected: 0, failed: 0 };
  for (const lead of leads) {
    summary.sent++;
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lead) });
      const body = await res.json().catch(() => ({}));
      if (res.status === 202) { summary.accepted++; body.is_new ? summary.new++ : summary.duplicates++; }
      else if (res.status === 400) { summary.rejected++; console.log(`400 ${lead.email}: ${body.errors?.join('; ') || 'invalid'}`); }
      else { summary.failed++; console.log(`${res.status} ${lead.email}: ${JSON.stringify(body)}`); }
    } catch (e) { summary.failed++; console.log(`ERR ${lead.email}: ${e.message}`); }
  }
  console.log(JSON.stringify({ ...summary, seconds: (Date.now() - t0) / 1000 }));
})();
