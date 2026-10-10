// Generates a deterministic sample of inbound leads (fictional people and domains) for the demo and the tests.
// Usage: node scripts/gen_leads.js > samples/leads.csv
// The mix is intentional: decision makers at corporate domains (rules qualify), free-mail without a company
// (rules reject), placeholder domains and students (rules reject), free-mail with a company (rules send to
// review), ambiguous mid-level titles at corporate domains (only these reach the LLM) and 5 near-duplicates.

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261010);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const FIRST = ['Anna', 'Mark', 'Olena', 'Tom', 'Sofia', 'Daniel', 'Iryna', 'Lucas', 'Maria', 'Jonas', 'Kateryna', 'Peter', 'Emma', 'Andriy', 'Laura'];
const LAST = ['Schmidt', 'Novak', 'Kovalenko', 'Brown', 'Rossi', 'Fischer', 'Melnyk', 'Jansen', 'Garcia', 'Weber', 'Shevchenko', 'Smith', 'Dubois', 'Bondar', 'Meyer'];
const CORP = [
  ['northwind-labs.io', 'Northwind Labs'], ['brightpath.agency', 'BrightPath Agency'], ['lumen-retail.com', 'Lumen Retail'],
  ['quartzops.co', 'QuartzOps'], ['helixsoft.dev', 'HelixSoft'], ['meridian-logistics.com', 'Meridian Logistics'],
  ['oakline-clinic.com', 'Oakline Clinic'], ['vektor.studio', 'Vektor Studio'], ['cloudmesa.app', 'CloudMesa'], ['pinefield-saas.com', 'Pinefield'],
];
const FREE = ['gmail.com', 'outlook.com', 'yahoo.com', 'ukr.net', 'proton.me'];
const BLOCKED = ['mailinator.com', 'example.com', 'test.com'];
const EXEC = ['CEO', 'Founder', 'Co-founder', 'Head of Sales', 'VP Marketing', 'Director of Operations', 'Owner', 'CTO'];
const MID = ['Marketing Manager', 'Sales Operations Specialist', 'Growth Lead', 'RevOps Analyst', 'Software Developer', 'Customer Success Manager', 'Product Manager', 'Office Administrator', 'Data Analyst'];
const REJECT = ['Student', 'Intern', 'Unemployed'];
const COUNTRY = ['US', 'UK', 'Germany', 'Ukraine', 'Poland', 'Netherlands', 'Canada', 'Spain'];
const SOURCE = ['website-form', 'linkedin-ad', 'webinar', 'referral'];
const MSG = [
  'We want to automate lead routing from our website into HubSpot',
  'Looking for n8n help to sync Pipedrive with Slack',
  'Just browsing',
  '',
  'Need a workflow that enriches inbound leads and alerts sales',
  'Can you integrate our CRM with Zoom and calendars?',
  'Homework question about APIs',
  'Pricing?',
  'We run an agency and need outbound automation for 3 clients',
  'Interested in AI qualification of inbound leads',
  'Our store needs order notifications in Telegram',
  'Internal tooling: dashboards and reports from Postgres',
];

function person() {
  const f = pick(FIRST), l = pick(LAST);
  return { f, l, local: `${f}.${l}`.toLowerCase() };
}
function lead(kind) {
  const p = person();
  const base = { first_name: p.f, last_name: p.l, country: pick(COUNTRY), source: pick(SOURCE), message: pick(MSG), phone: rand() < 0.5 ? `+${Math.floor(10000000000 + rand() * 89999999999)}` : '' };
  if (kind === 'exec') { const [d, c] = pick(CORP); return { ...base, email: `${p.local}@${d}`, company: c, job_title: pick(EXEC) }; }
  if (kind === 'mid') { const [d, c] = pick(CORP); return { ...base, email: `${p.local}@${d}`, company: c, job_title: pick(MID) }; }
  if (kind === 'free_nocompany') return { ...base, email: `${p.local}${Math.floor(rand() * 90)}@${pick(FREE)}`, company: '', job_title: rand() < 0.5 ? pick(MID) : '' };
  if (kind === 'free_company') { const [, c] = pick(CORP); return { ...base, email: `${p.local}${Math.floor(rand() * 90)}@${pick(FREE)}`, company: c, job_title: pick(MID) }; }
  if (kind === 'blocked') return { ...base, email: `${p.local}@${pick(BLOCKED)}`, company: pick(CORP)[1], job_title: pick(EXEC) };
  if (kind === 'reject_title') { const [d, c] = pick(CORP); return { ...base, email: `${p.local}@${d}`, company: c, job_title: pick(REJECT) }; }
  throw new Error(kind);
}

const plan = [['exec', 12], ['mid', 17], ['free_nocompany', 8], ['free_company', 5], ['blocked', 4], ['reject_title', 4]];
let rows = [];
for (const [kind, n] of plan) for (let i = 0; i < n; i++) rows.push(lead(kind));
// shuffle deterministically
for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
// near-duplicates: same person, different letter case / whitespace / missing fields -> must dedupe on the fingerprint
const dups = rows.slice(0, 5).map((r, i) => ({ ...r, email: i % 2 ? ` ${r.email.toUpperCase()} ` : r.email, phone: '', message: 'Following up on my earlier request', source: 'email-reply' }));
rows = rows.concat(dups);

const cols = ['email', 'phone', 'first_name', 'last_name', 'company', 'job_title', 'country', 'source', 'message'];
const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
process.stdout.write(cols.join(',') + '\n' + rows.map((r) => cols.map((c) => esc(r[c])).join(',')).join('\n') + '\n');
