// Unit tests for the Code-node logic and the sample generator. Run: npm test  (node --test tests/)
// The code files are loaded exactly as n8n would run them: the file defines main(), the wrapper calls it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const load = (file) => new Function(fs.readFileSync(path.join(ROOT, 'n8n/code', file), 'utf8') + '\nreturn main;')();

const RULES = [
  { id: 1, kind: 'free_mail', pattern: 'gmail.com', enabled: true },
  { id: 2, kind: 'domain_block', pattern: 'mailinator.com', decision: 'rejected', score: 0, note: 'disposable mailbox', enabled: true },
  { id: 3, kind: 'title_reject', pattern: '\\b(student|intern)\\b', decision: 'rejected', score: 0.1, enabled: true },
  { id: 4, kind: 'title_qualify', pattern: '\\b(ceo|founder|head of|director)\\b', decision: 'qualified', score: 0.9, enabled: true },
  { id: 5, kind: 'domain_allow', pattern: 'vip.example', decision: 'qualified', score: 1, enabled: true },
  { id: 6, kind: 'title_qualify', pattern: '\\b(disabled rule)\\b', decision: 'qualified', score: 0.9, enabled: false },
];
const DNS_OK = { Status: 0, Answer: [{ type: 15, data: '10 mx.example.' }] };
const DNS_NX = { Status: 3 };

test('intake: aliases, trimming, lower-cased email, phone normalization, fingerprint', () => {
  const main = load('intake_normalize.js');
  const [out] = main([{ body: { Email_Address: '  Anna.Schmidt@Northwind-Labs.IO ', Name: 'Anna  Schmidt', Title: 'Head of Sales', org: 'Northwind Labs', tel: '+1 (555) 010-2030', utm_source: 'linkedin-ad' } }]);
  assert.equal(out.ok, true);
  assert.equal(out.fingerprint, 'email:anna.schmidt@northwind-labs.io');
  assert.deepEqual(out.lead, {
    email: 'anna.schmidt@northwind-labs.io', phone: '+15550102030', first_name: 'Anna', last_name: 'Schmidt', company: 'Northwind Labs',
    job_title: 'Head of Sales', country: '', source: 'linkedin-ad', message: '', domain: 'northwind-labs.io',
  });
});

test('intake: rejects invalid email and phone, requires an identity, accepts phone-only', () => {
  const main = load('intake_normalize.js');
  assert.deepEqual(main([{ body: { email: 'not-an-email', phone: '12' } }])[0].errors, ['invalid email: not-an-email', 'invalid phone: 12']);
  assert.deepEqual(main([{ body: { first_name: 'Nobody' } }])[0].errors, ['email or phone is required']);
  const phoneOnly = main([{ body: { phone: '0049 170 1234567' } }])[0];
  assert.equal(phoneOnly.ok, true);
  assert.equal(phoneOnly.fingerprint, 'phone:+491701234567');
  assert.equal(phoneOnly.lead.source, 'webhook');
});

test('intake: the same person in a different case or spacing gets the same fingerprint', () => {
  const main = load('intake_normalize.js');
  const a = main([{ body: { email: 'mark.novak@quartzops.co' } }])[0];
  const b = main([{ body: { email: '  MARK.NOVAK@QUARTZOPS.CO ' } }])[0];
  assert.equal(a.fingerprint, b.fingerprint);
});

test('rules: fixed order of precedence and the free-mail logic', () => {
  const main = load('enrich_rules.js');
  const run = (lead, dns = DNS_OK) => main([{ lead: { id: 1, rules: RULES, ...lead }, dns, website: null }])[0];
  assert.equal(run({ email: 'ceo@mailinator.com', domain: 'mailinator.com', job_title: 'CEO', company: 'X' }).rule.decision, 'rejected');          // block beats everything
  assert.equal(run({ email: 'x@vip.example', domain: 'vip.example', job_title: 'Student' }).rule.decision, 'qualified');                           // allow beats title reject
  assert.equal(run({ email: 'x@helixsoft.dev', domain: 'helixsoft.dev', job_title: 'Intern', company: 'HelixSoft' }).rule.decision, 'rejected');     // title reject
  assert.equal(run({ email: 'x@gmail.com', domain: 'gmail.com', job_title: 'CEO', company: '' }).rule.decision, 'rejected');                       // free mail, no company
  assert.equal(run({ email: 'x@gmail.com', domain: 'gmail.com', job_title: 'CEO', company: 'Acme' }).rule.decision, 'review');                     // free mail with company
  assert.equal(run({ email: '', phone: '+491701234567', domain: '' }).rule.decision, 'review');                                                    // phone-only
  const exec = run({ email: 'x@helixsoft.dev', domain: 'helixsoft.dev', job_title: 'Head of Growth', company: 'HelixSoft' });
  assert.equal(exec.rule.decision, 'qualified'); assert.equal(exec.rule.id, 4); assert.equal(exec.mx_valid, true);
  const mid = run({ email: 'x@helixsoft.dev', domain: 'helixsoft.dev', job_title: 'Marketing Manager', company: 'HelixSoft' }, DNS_NX);
  assert.equal(mid.rule, null); assert.equal(mid.mx_valid, false);                                                                                  // nothing matched -> LLM
  assert.equal(run({ email: 'x@helixsoft.dev', domain: 'helixsoft.dev', job_title: 'Disabled Rule' }).rule, null);                                 // disabled rules are ignored
});

test('rules: enrichment extracts the website title and never leaks ids or raw data to the model', () => {
  const main = load('enrich_rules.js');
  const [out] = main([{ lead: { id: 7, rules: RULES, email: 'x@helixsoft.dev', domain: 'helixsoft.dev', first_name: 'Olena', raw: { secret: 1 } }, dns: DNS_OK, website: { data: '<html><head><title>  HelixSoft -\n  Workflow tools </title></head></html>' } }]);
  assert.equal(out.website_title, 'HelixSoft - Workflow tools');
  assert.deepEqual(Object.keys(out.lead_for_ai).sort(), ['company', 'country', 'domain', 'first_name', 'is_free_mail', 'job_title', 'message', 'mx_valid', 'source', 'website_title']);
});

test('validate_ai: thresholds, fenced JSON, invalid answers go to review', () => {
  const main = load('validate_ai.js');
  const res = (content, extra = {}) => ({ model: 'm', choices: [{ message: { content } }], ...extra });
  const good = { fit_score: 0.8, segment: 'saas', confidence: 0.9, reason: 'Head of Sales at a SaaS company', opener: 'Hi Anna' };
  assert.equal(main([res(JSON.stringify(good))])[0].decision, 'qualified');
  assert.equal(main([res('```json\n' + JSON.stringify(good) + '\n```')])[0].decision, 'qualified');
  assert.equal(main([res(JSON.stringify({ ...good, fit_score: 0.2 }))])[0].decision, 'rejected');
  assert.equal(main([res(JSON.stringify({ ...good, fit_score: 0.8, confidence: 0.5 }))])[0].decision, 'review');   // not confident -> human
  assert.equal(main([res(JSON.stringify({ ...good, fit_score: 0.55 }))])[0].decision, 'review');                   // middle -> human
  const badSegment = main([res(JSON.stringify({ ...good, segment: 'enterprise' }))])[0];
  assert.equal(badSegment.valid, false); assert.equal(badSegment.decision, 'review'); assert.match(badSegment.reason, /segment must be one of/);
  const notJson = main([res('Sure! Here is my analysis...')])[0];
  assert.equal(notJson.decision, 'review'); assert.match(notJson.reason, /not valid JSON/);
  assert.equal(main([{}])[0].decision, 'review');
});

test('crm_properties: standard HubSpot properties only, empties dropped, pipeline tag in message', () => {
  const main = load('crm_properties.js');
  const [out] = main([{ id: 3, email: 'anna@northwind-labs.io', first_name: 'Anna', last_name: '', company: 'Northwind Labs', domain: 'northwind-labs.io', decision: 'qualified', decided_by: 'rule', score: 0.9, segment: null, reason: 'decision-maker title', opener: 'Hi Anna', message: 'We want automation' }]);
  assert.equal(out.lead_id, 3);
  assert.deepEqual(Object.keys(out.properties).sort(), ['company', 'email', 'firstname', 'hs_lead_status', 'message', 'website']);
  assert.match(out.properties.message, /^\[lead-pipeline\] decision=qualified by=rule score=0.9 segment=n\/a\n/);
  assert.match(out.properties.message, /original message: We want automation$/);
});

test('review_prepare: human decision, rule creation guard for free-mail domains, unknown lead', () => {
  const main = load('review_prepare.js');
  const form = { 'Lead ID': 5, Decision: 'qualified', 'Create a rule': 'always qualify this domain', Note: 'known customer' };
  const corp = main([{ form, lead: { id: 5, domain: 'quartzops.co', is_free_domain: false } }])[0];
  assert.equal(corp.decision, 'qualified'); assert.equal(corp.score, 1); assert.equal(corp.rule_kind, 'domain_allow'); assert.equal(corp.pattern, 'quartzops.co'); assert.equal(corp.rule_decision, 'qualified'); assert.equal(corp.reason, 'human decision: known customer');
  const free = main([{ form, lead: { id: 6, domain: 'gmail.com', is_free_domain: true } }])[0];
  assert.equal(free.rule_kind, null); assert.match(free.warning, /free-mail/);
  const reject = main([{ form: { Decision: 'rejected', 'Create a rule': 'always reject this domain' }, lead: { id: 8, domain: 'spam.biz', is_free_domain: false } }])[0];
  assert.equal(reject.rule_kind, 'domain_block'); assert.equal(reject.rule_decision, 'rejected'); assert.equal(reject.score, 0);
  assert.equal(main([{ form, lead: {} }])[0].warning, 'lead not found');
});

test('dashboard_html: renders metrics, escapes HTML, handles empty tables', () => {
  const main = load('dashboard_html.js');
  const [out] = main([{ metrics: { leads_total: '10', undecided: '2', decided_by_rule: '5', decided_by_human: '1', decided_by_ai: '2', qualified: '4' }, queue: [{ id: 1, email: 'a@b.c', reason: '<script>x</script>' }], recent: [] }]);
  assert.match(out.html, /75%/);                       // (5 + 1) of 8 decided without AI
  assert.match(out.html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(out.html, /<script>x/);
  assert.match(out.html, /no leads yet/);
});

test('gen_leads: deterministic output with the intended mix and 5 near-duplicates', () => {
  const a = execFileSync(process.execPath, [path.join(ROOT, 'scripts/gen_leads.js')], { encoding: 'utf8' });
  const b = execFileSync(process.execPath, [path.join(ROOT, 'scripts/gen_leads.js')], { encoding: 'utf8' });
  assert.equal(a, b);
  const rows = a.trim().split('\n');
  assert.equal(rows.length, 1 + 50 + 5);
  const emails = rows.slice(1).map((r) => r.split(',')[0].trim().toLowerCase());
  assert.equal(new Set(emails).size, 50);
});

test('build: every workflow builds, has an error workflow (except the handler) and a trigger', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'n8n/build.js')], { encoding: 'utf8' });
  const dir = path.join(ROOT, 'n8n/workflows');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 6);
  for (const f of files) {
    const wf = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const names = new Set(wf.nodes.map((n) => n.name));
    for (const [from, c] of Object.entries(wf.connections)) {
      assert.ok(names.has(from), `${f}: connection from unknown node ${from}`);
      for (const t of c.main.flat()) assert.ok(names.has(t.node), `${f}: connection to unknown node ${t.node}`);
    }
    assert.ok(wf.nodes.some((n) => /trigger|webhook/i.test(n.type)), `${f}: no trigger`);
    if (!/error-handler/.test(f)) assert.equal(wf.settings.errorWorkflow, 'lp05errors000001', `${f}: error workflow not set`);
    for (const n of wf.nodes) {
      const text = JSON.stringify(n.parameters);
      for (const m of text.matchAll(/=\{\{([\s\S]*?)\}\}/g)) assert.ok(!m[1].includes('}}'), `${f}/${n.name}: "}}" inside an expression`);
    }
  }
});
