#!/usr/bin/env node
// Workflows as code. Run: node n8n/build.js
// The graph of every workflow is declared here; the logic of Code nodes lives in n8n/code/*.js (unit-tested in
// tests/); node ids, positions and connections are generated. The JSON in n8n/workflows/ is what
// `n8n import:workflow` reads, so the repository, not the n8n UI, is the source of truth.
const fs = require('fs');
const path = require('path');

const CODE_DIR = path.join(__dirname, 'code');
const OUT_DIR = path.join(__dirname, 'workflows');

// Fixed ids so workflows can reference each other (Execute Workflow, error workflow) before they exist in n8n.
const ID = {
  intake: 'lp01intake000001',
  qualify: 'lp02qualify00001',
  crm: 'lp03crmsync00001',
  review: 'lp04review000001',
  errors: 'lp05errors000001',
  dashboard: 'lp06dashboard001',
};
const PG_CRED = { postgres: { id: 'pgleads000000001', name: 'Postgres leads' } };

const SYSTEM_PROMPT =
  'You are a B2B lead qualification analyst. Given one inbound lead as JSON, answer with ONLY a JSON object with these keys: ' +
  'fit_score (number 0-1: how well the lead matches the ICP), segment (exactly one of: saas, agency, ecommerce, services, other), ' +
  'confidence (number 0-1: how sure you are given the available data; be low when title or message are missing), ' +
  'reason (one sentence, max 300 characters, cite the concrete signals), ' +
  'opener (one personalized first line for an outreach email, max 300 characters, no placeholders, no exclamation marks). ' +
  'No markdown, no extra keys.';

// ---------- helpers ----------
const expr = (js) => {
  if (js.includes('}}')) throw new Error(`"}}" inside an expression closes it early: ${js}`);
  return `={{ ${js} }}`;
};
const ifTrue = (js) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ id: 'c1', leftValue: expr(js), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
    combinator: 'and',
  },
  options: {},
});
const pg = (query, params) => ({ operation: 'executeQuery', query, options: params ? { queryReplacement: expr(`[${params.join(', ')}]`) } : {} });
const set = (fields, includeOtherFields = false) => ({
  assignments: { assignments: fields.map(([name, value, type = 'string'], i) => ({ id: `a${i + 1}`, name, value, type })) },
  includeOtherFields,
  options: {},
});
const http = (method, url, o = {}) => {
  const p = { method, url, options: { timeout: o.timeout || 30000, ...(o.responseFormat ? { response: { response: { responseFormat: o.responseFormat } } } : {}) } };
  if (o.bearer) { p.sendHeaders = true; p.headerParameters = { parameters: [{ name: 'Authorization', value: `=Bearer {{ ${o.bearer} }}` }] }; }
  if (o.json) { p.sendBody = true; p.specifyBody = 'json'; p.jsonBody = expr(o.json); }
  return p;
};
const subworkflow = (id) => ({ source: 'database', workflowId: { __rl: true, mode: 'id', value: id }, mode: 'once', options: { waitForSubWorkflow: false } });
const schedule = (minutes) => ({ rule: { interval: [{ field: 'minutes', minutesInterval: minutes }] } });

function codeNode(file, { input = '$input.all().map((i) => i.json)', config = false } = {}) {
  const src = fs.readFileSync(path.join(CODE_DIR, file), 'utf8').trim();
  if (!/function main\s*\(/.test(src)) throw new Error(`${file} must define function main(items, config)`);
  const cfg = config ? "$('Config').first().json" : '{}';
  return { jsCode: `${src}\n\nreturn main(${input}, ${cfg}).map((json) => ({ json }));` };
}

class Workflow {
  constructor(name, id, { errorWorkflow } = {}) {
    this.name = name; this.id = id; this.nodes = []; this.connections = {};
    this.settings = { executionOrder: 'v1', ...(errorWorkflow ? { errorWorkflow } : {}) };
  }
  node(name, type, typeVersion, parameters, extra = {}) {
    if (this.nodes.some((n) => n.name === name)) throw new Error(`duplicate node name: ${name}`);
    this.nodes.push({ parameters, name, type, typeVersion, position: [0, 0], ...extra });
    return name;
  }
  note(content, position, width = 420, height = 140) {
    this.nodes.push({ parameters: { content, width, height, color: 7 }, name: `Note ${this.nodes.length + 1}`, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position });
  }
  link(from, to, output = 0) {
    for (const n of [from, to]) if (!this.nodes.some((x) => x.name === n)) throw new Error(`${this.name}: unknown node "${n}"`);
    const c = (this.connections[from] ||= { main: [] });
    while (c.main.length <= output) c.main.push([]);
    c.main[output].push({ node: to, type: 'main', index: 0 });
    return this;
  }
  chain(...names) { for (let i = 0; i < names.length - 1; i++) this.link(names[i], names[i + 1]); return this; }

  // Longest-path layout on the graph without its back edges (loops), so the canvas reads left to right.
  layout() {
    const real = this.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote');
    const out = (n) => (this.connections[n] ? this.connections[n].main.flat().map((c) => c.node) : []);
    const color = new Map(); const back = new Set();
    const dfs = (n) => { color.set(n, 'gray'); for (const t of out(n)) { if (color.get(t) === 'gray') back.add(`${n}->${t}`); else if (!color.has(t)) dfs(t); } color.set(n, 'black'); };
    for (const n of real) if (!color.has(n.name)) dfs(n.name);
    const sources = (n) => real.filter((s) => out(s.name).includes(n) && !back.has(`${s.name}->${n}`)).map((s) => s.name);
    const depth = new Map();
    const dep = (n) => { if (depth.has(n)) return depth.get(n); depth.set(n, 0); const d = sources(n).reduce((m, s) => Math.max(m, dep(s) + 1), 0); depth.set(n, d); return d; };
    const rows = new Map();
    for (const n of real) { const d = dep(n.name); const r = rows.get(d) || 0; rows.set(d, r + 1); n.position = [40 + d * 260, 40 + r * 190]; }
    this.nodes.forEach((n, i) => { n.id = `${this.id}-${String(i + 1).padStart(2, '0')}`; });
  }
  toJSON() {
    this.layout();
    return { id: this.id, name: this.name, nodes: this.nodes, connections: this.connections, settings: this.settings, active: false, pinData: {}, tags: [] };
  }
}

// ---------- 01 Intake ----------
function intake() {
  const w = new Workflow('01 Intake', ID.intake, { errorWorkflow: ID.errors });
  w.note('## 01 Intake\nPOST /webhook/lead → normalize & validate (Code) → idempotent upsert by fingerprint (SQL function) → 202 with lead_id → new leads go to 02 asynchronously. Invalid payloads get a 400 with the reasons.', [40, -160]);
  w.node('Lead webhook', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: 'lead', responseMode: 'responseNode', options: {} }, { webhookId: 'lp-lead-intake' });
  w.node('Normalize & validate', 'n8n-nodes-base.code', 2, codeNode('intake_normalize.js'));
  w.node('Valid?', 'n8n-nodes-base.if', 2.2, ifTrue('$json.ok === true'));
  w.node('Upsert lead', 'n8n-nodes-base.postgres', 2.5, pg('select id::int, is_new from upsert_lead($1, $2::jsonb)', ['$json.fingerprint', 'JSON.stringify($json.lead)']), { credentials: PG_CRED });
  w.node('Respond 202', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'json', responseBody: expr('JSON.stringify({ ok: true, lead_id: $json.id, is_new: $json.is_new })'), options: { responseCode: 202 } });
  w.node('New lead?', 'n8n-nodes-base.if', 2.2, ifTrue('$json.is_new === true'));
  w.node('Lead id', 'n8n-nodes-base.set', 3.4, set([['lead_id', expr('$json.id'), 'number']]));
  w.node('Enrich & qualify (02)', 'n8n-nodes-base.executeWorkflow', 1.1, subworkflow(ID.qualify));
  w.node('Respond 400', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'json', responseBody: expr('JSON.stringify({ ok: false, errors: $json.errors })'), options: { responseCode: 400 } });
  w.chain('Lead webhook', 'Normalize & validate', 'Valid?');
  w.link('Valid?', 'Upsert lead', 0).chain('Upsert lead', 'Respond 202', 'New lead?');
  w.link('New lead?', 'Lead id', 0).chain('Lead id', 'Enrich & qualify (02)');
  w.link('Valid?', 'Respond 400', 1);
  return w;
}

// ---------- 02 Enrich & qualify ----------
function qualify() {
  const w = new Workflow('02 Enrich & qualify', ID.qualify, { errorWorkflow: ID.errors });
  const E = "$('Enrich & apply rules').first().json";
  const C = "$('Config').first().json";
  w.note('## 02 Enrich & qualify\nPer lead: deterministic enrichment (free-mail flag, MX record via DNS-over-HTTPS, optional website title) → rule engine (rules are rows in the database) → only unresolved leads go to the LLM → the answer is validated against a closed schema and thresholds → decision is written through set_decision() (human > rule > ai) → qualified leads go to 03. A schedule re-checks leads left undecided (e.g. the model was down).', [40, -200], 560, 180);
  w.node('When called', 'n8n-nodes-base.executeWorkflowTrigger', 1, {});
  w.node('Every 10 min', 'n8n-nodes-base.scheduleTrigger', 1.2, schedule(10));
  w.node('Pending leads', 'n8n-nodes-base.postgres', 2.5, pg("select id as lead_id from leads where decision is null and created_at < now() - interval '2 minutes' order by id limit 20"), { credentials: PG_CRED });
  w.node('Load lead', 'n8n-nodes-base.postgres', 2.5, pg("select l.*, (select coalesce(jsonb_agg(r), '[]'::jsonb) from rules r where r.enabled) as rules from leads l where l.id = $1", ['$json.lead_id']), { credentials: PG_CRED });
  w.node('Config', 'n8n-nodes-base.set', 3.4, set([
    ['llm_base_url', expr('$env.LLM_BASE_URL')], ['llm_api_key', expr('$env.LLM_API_KEY')], ['llm_model', expr('$env.LLM_MODEL')],
    ['icp', expr('$env.ICP_DESCRIPTION')], ['enrich_website', expr('$env.ENRICH_WEBSITE')],
  ], true));
  w.node('Loop', 'n8n-nodes-base.splitInBatches', 3, { batchSize: 1, options: {} });
  w.node('Lead', 'n8n-nodes-base.noOp', 1, {});
  w.node('MX lookup', 'n8n-nodes-base.httpRequest', 4.2, http('GET', expr("'https://dns.google/resolve?name=' + encodeURIComponent($json.domain || 'invalid.invalid') + '&type=MX'"), { timeout: 5000, responseFormat: 'json' }), { onError: 'continueRegularOutput' });
  w.node('Website on?', 'n8n-nodes-base.if', 2.2, ifTrue(`${C}.enrich_website === 'true' && !!$('Lead').first().json.domain`));
  w.node('Website title', 'n8n-nodes-base.httpRequest', 4.2, http('GET', expr("'https://' + $('Lead').first().json.domain"), { timeout: 6000, responseFormat: 'text' }), { onError: 'continueRegularOutput' });
  w.node('Enrich & apply rules', 'n8n-nodes-base.code', 2, codeNode('enrich_rules.js', {
    input: "[{ lead: $('Lead').first().json, dns: $('MX lookup').first().json, website: (() => { try { return $('Website title').first().json; } catch (e) { return null; } })() }]",
  }));
  w.node('Save enrichment', 'n8n-nodes-base.postgres', 2.5, pg('update leads set is_free_mail = $2, mx_valid = $3, website_title = $4, enriched_at = now() where id = $1 returning id', ['$json.lead_id', '$json.is_free_mail', '$json.mx_valid', '$json.website_title']), { credentials: PG_CRED });
  w.node('Rule matched?', 'n8n-nodes-base.if', 2.2, ifTrue(`${E}.rule !== null`));
  w.node('Decision by rule', 'n8n-nodes-base.postgres', 2.5, pg("select * from set_decision($1, $2, 'rule', $3, null, $4, null, null, $5)", [`${E}.lead_id`, `${E}.rule.decision`, `${E}.rule.score`, `${E}.rule.reason`, `${E}.rule.id`]), { credentials: PG_CRED });
  w.node('Rule qualified?', 'n8n-nodes-base.if', 2.2, ifTrue("$json.decision === 'qualified'"));
  w.node('Log AI call', 'n8n-nodes-base.postgres', 2.5, pg("insert into lead_events (lead_id, event, actor, details) values ($1, 'ai_called', 'ai', $2::jsonb) returning id", [`${E}.lead_id`, `JSON.stringify({ model: ${C}.llm_model })`]), { credentials: PG_CRED });
  w.node('LLM qualify', 'n8n-nodes-base.httpRequest', 4.2, http('POST', expr(`${C}.llm_base_url + '/chat/completions'`), {
    bearer: `${C}.llm_api_key`, timeout: 90000,
    json: `JSON.stringify({ model: ${C}.llm_model, temperature: 0, response_format: { type: 'json_object' }, messages: [ { role: 'system', content: ${JSON.stringify(SYSTEM_PROMPT)} + ' ICP: ' + ${C}.icp }, { role: 'user', content: JSON.stringify(${E}.lead_for_ai) } ] })`,
  }), { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, onError: 'continueErrorOutput' });
  w.node('Validate AI output', 'n8n-nodes-base.code', 2, codeNode('validate_ai.js'));
  w.node('Decision by AI', 'n8n-nodes-base.postgres', 2.5, pg("select * from set_decision($1, $2, 'ai', $3, $4, $5, $6, $7, null)", [`${E}.lead_id`, '$json.decision', '$json.score', '$json.segment', '$json.reason', '$json.opener', '$json.confidence']), { credentials: PG_CRED });
  w.node('AI qualified?', 'n8n-nodes-base.if', 2.2, ifTrue("$json.decision === 'qualified'"));
  w.node('AI unavailable → review', 'n8n-nodes-base.postgres', 2.5, pg("select * from set_decision($1, 'review', 'ai', null, null, $2, null, null, null)", [`${E}.lead_id`, "'ai_unavailable: ' + String(($json.error && $json.error.message) || $json.error || 'unknown error').slice(0, 300)"]), { credentials: PG_CRED });
  w.node('CRM lead id', 'n8n-nodes-base.set', 3.4, set([['lead_id', expr(`${E}.lead_id`), 'number']]));
  w.node('Sync to CRM (03)', 'n8n-nodes-base.executeWorkflow', 1.1, subworkflow(ID.crm));
  w.node('Done', 'n8n-nodes-base.noOp', 1, {});

  w.link('When called', 'Load lead');
  w.chain('Every 10 min', 'Pending leads', 'Load lead', 'Config', 'Loop');
  w.link('Loop', 'Done', 0);
  w.link('Loop', 'Lead', 1).chain('Lead', 'MX lookup', 'Website on?');
  w.link('Website on?', 'Website title', 0).link('Website title', 'Enrich & apply rules');
  w.link('Website on?', 'Enrich & apply rules', 1);
  w.chain('Enrich & apply rules', 'Save enrichment', 'Rule matched?');
  w.link('Rule matched?', 'Decision by rule', 0).chain('Decision by rule', 'Rule qualified?');
  w.link('Rule qualified?', 'CRM lead id', 0).link('Rule qualified?', 'Loop', 1);
  w.link('Rule matched?', 'Log AI call', 1).chain('Log AI call', 'LLM qualify');
  w.link('LLM qualify', 'Validate AI output', 0).chain('Validate AI output', 'Decision by AI', 'AI qualified?');
  w.link('AI qualified?', 'CRM lead id', 0).link('AI qualified?', 'Loop', 1);
  w.link('LLM qualify', 'AI unavailable → review', 1).link('AI unavailable → review', 'Loop');
  w.chain('CRM lead id', 'Sync to CRM (03)', 'Loop');
  return w;
}

// ---------- 03 CRM sync ----------
function crm() {
  const w = new Workflow('03 CRM sync', ID.crm, { errorWorkflow: ID.errors });
  const C = "$('Config').first().json";
  const P = "$('Contact properties').first().json";
  w.note('## 03 CRM sync\nQualified leads become CRM contacts through the HubSpot CRM v3 contacts API (search by email → create or update). The bundled mock speaks the same subset, so CRM_BASE_URL is the only switch. Idempotent: a lead is pushed once (crm_id), and a schedule retries leads that failed to sync.', [40, -200], 560, 160);
  w.node('When called', 'n8n-nodes-base.executeWorkflowTrigger', 1, {});
  w.node('Every 15 min', 'n8n-nodes-base.scheduleTrigger', 1.2, schedule(15));
  w.node('Pending sync', 'n8n-nodes-base.postgres', 2.5, pg("select id as lead_id from leads where decision = 'qualified' and crm_id is null order by id limit 50"), { credentials: PG_CRED });
  w.node('Load lead', 'n8n-nodes-base.postgres', 2.5, pg('select * from leads where id = $1', ['$json.lead_id']), { credentials: PG_CRED });
  w.node('Config', 'n8n-nodes-base.set', 3.4, set([['crm_base_url', expr('$env.CRM_BASE_URL')], ['crm_token', expr('$env.CRM_TOKEN')], ['notify_url', expr('$env.NOTIFY_WEBHOOK_URL')]], true));
  w.node('Loop', 'n8n-nodes-base.splitInBatches', 3, { batchSize: 1, options: {} });
  w.node('Lead', 'n8n-nodes-base.noOp', 1, {});
  w.node('Contact properties', 'n8n-nodes-base.code', 2, codeNode('crm_properties.js'));
  w.node('Search contact', 'n8n-nodes-base.httpRequest', 4.2, http('POST', expr(`${C}.crm_base_url + '/crm/v3/objects/contacts/search'`), {
    bearer: `${C}.crm_token`,
    json: `JSON.stringify({ filterGroups: [ { filters: [ { propertyName: $json.email ? 'email' : 'phone', operator: 'EQ', value: $json.email || $json.phone } ] } ], properties: ['email'], limit: 1 })`,
  }));
  w.node('Exists?', 'n8n-nodes-base.if', 2.2, ifTrue('Number($json.total || 0) > 0'));
  w.node('Update contact', 'n8n-nodes-base.httpRequest', 4.2, http('PATCH', expr(`${C}.crm_base_url + '/crm/v3/objects/contacts/' + $json.results[0].id`), { bearer: `${C}.crm_token`, json: `JSON.stringify({ properties: ${P}.properties })` }));
  w.node('Create contact', 'n8n-nodes-base.httpRequest', 4.2, http('POST', expr(`${C}.crm_base_url + '/crm/v3/objects/contacts'`), { bearer: `${C}.crm_token`, json: `JSON.stringify({ properties: ${P}.properties })` }));
  w.node('Save CRM id', 'n8n-nodes-base.postgres', 2.5, pg('update leads set crm_id = $2, crm_synced_at = now() where id = $1 returning id, crm_id', [`${P}.lead_id`, 'String($json.id)']), { credentials: PG_CRED });
  w.node('Notify on?', 'n8n-nodes-base.if', 2.2, ifTrue(`!!${C}.notify_url`));
  w.node('Notify', 'n8n-nodes-base.httpRequest', 4.2, http('POST', expr(`${C}.notify_url`), { json: `JSON.stringify({ text: 'New qualified lead synced to CRM: ' + ${P}.email + ' (' + (${P}.properties.company || 'no company') + '), CRM id ' + $json.crm_id })` }), { onError: 'continueRegularOutput' });
  w.node('Done', 'n8n-nodes-base.noOp', 1, {});

  w.link('When called', 'Load lead');
  w.chain('Every 15 min', 'Pending sync', 'Load lead', 'Config', 'Loop');
  w.link('Loop', 'Done', 0);
  w.link('Loop', 'Lead', 1).chain('Lead', 'Contact properties', 'Search contact', 'Exists?');
  w.link('Exists?', 'Update contact', 0).link('Exists?', 'Create contact', 1);
  w.chain('Update contact', 'Save CRM id'); w.chain('Create contact', 'Save CRM id');
  w.chain('Save CRM id', 'Notify on?');
  w.link('Notify on?', 'Notify', 0).link('Notify', 'Loop');
  w.link('Notify on?', 'Loop', 1);
  return w;
}

// ---------- 04 Review form ----------
function review() {
  const w = new Workflow('04 Review form', ID.review, { errorWorkflow: ID.errors });
  const P = "$('Prepare').first().json";
  w.note('## 04 Review form\n/form/review: a human approves or rejects a lead from the review queue. The decision outranks rules and AI (set_decision priority) and can become a domain rule, so the same case never needs a human twice. Free-mail domains never become rules.', [40, -180], 560, 140);
  w.node('Lead review', 'n8n-nodes-base.formTrigger', 2.2, {
    formTitle: 'Lead review',
    formDescription: 'Approve or reject a lead from the review queue (ids are on /webhook/dashboard). Your decision outranks rules and AI and can become a rule.',
    formFields: { values: [
      { fieldLabel: 'Lead ID', fieldType: 'number', requiredField: true, placeholder: 'id from the dashboard review queue' },
      { fieldLabel: 'Decision', fieldType: 'dropdown', fieldOptions: { values: [{ option: 'qualified' }, { option: 'rejected' }] }, requiredField: true },
      { fieldLabel: 'Create a rule', fieldType: 'dropdown', fieldOptions: { values: [{ option: 'no' }, { option: 'always qualify this domain' }, { option: 'always reject this domain' }] }, requiredField: true },
      { fieldLabel: 'Note', fieldType: 'textarea', placeholder: 'optional: why' },
    ] },
    options: {},
  }, { webhookId: 'review' }); // Form Trigger 2.x serves the form at /form/<webhookId>
  w.node('Load lead', 'n8n-nodes-base.postgres', 2.5, pg("select l.*, exists (select 1 from rules r where r.kind = 'free_mail' and r.pattern = l.domain) as is_free_domain from leads l where l.id = $1", ["Number($json['Lead ID'])"]), { credentials: PG_CRED, alwaysOutputData: true });
  w.node('Prepare', 'n8n-nodes-base.code', 2, codeNode('review_prepare.js', { input: "[{ form: $('Lead review').first().json, lead: $input.first().json }]" }));
  w.node('Decision by human', 'n8n-nodes-base.postgres', 2.5, pg("select * from set_decision($1, $2, 'human', $3, null, $4, null, null, null)", ['$json.lead_id', '$json.decision', '$json.score', '$json.reason']), { credentials: PG_CRED, alwaysOutputData: true });
  w.node('Rule?', 'n8n-nodes-base.if', 2.2, ifTrue(`${P}.rule_kind !== null`));
  w.node('Save rule', 'n8n-nodes-base.postgres', 2.5, pg("insert into rules (kind, pattern, decision, score, note, created_by) values ($1, $2, $3, $4, $5, 'human') on conflict (kind, pattern) do update set decision = excluded.decision, score = excluded.score, note = excluded.note, enabled = true returning id", [`${P}.rule_kind`, `${P}.pattern`, `${P}.rule_decision`, `${P}.score`, `${P}.note`]), { credentials: PG_CRED });
  w.node('Qualified?', 'n8n-nodes-base.if', 2.2, ifTrue(`${P}.decision === 'qualified'`));
  w.node('CRM lead id', 'n8n-nodes-base.set', 3.4, set([['lead_id', expr(`${P}.lead_id`), 'number']]));
  w.node('Sync to CRM (03)', 'n8n-nodes-base.executeWorkflow', 1.1, subworkflow(ID.crm));
  w.node('Saved', 'n8n-nodes-base.form', 1, {
    operation: 'completion', completionTitle: 'Saved',
    completionMessage: expr(`${P}.warning === 'lead not found' ? 'Lead not found.' : ('Lead ' + ${P}.lead_id + ' → ' + ${P}.decision + (${P}.rule_kind ? ' (rule saved: ' + ${P}.rule_kind + ' ' + ${P}.pattern + ')' : '') + (${P}.warning ? '. ' + ${P}.warning : ''))`),
    options: {},
  });
  w.chain('Lead review', 'Load lead', 'Prepare', 'Decision by human', 'Rule?');
  w.link('Rule?', 'Save rule', 0).chain('Save rule', 'Qualified?');
  w.link('Rule?', 'Qualified?', 1);
  w.link('Qualified?', 'CRM lead id', 0).chain('CRM lead id', 'Sync to CRM (03)', 'Saved');
  w.link('Qualified?', 'Saved', 1);
  return w;
}

// ---------- 05 Error handler ----------
function errors() {
  const w = new Workflow('05 Error handler', ID.errors);
  w.note('## 05 Error handler\nEvery other workflow points here (settings.errorWorkflow). Failures are stored in the errors table with the workflow, the failing node and the message, and optionally posted to a Slack-compatible webhook. The dashboard shows the count.', [40, -160], 560, 120);
  w.node('Error trigger', 'n8n-nodes-base.errorTrigger', 1, {});
  w.node('Log error', 'n8n-nodes-base.postgres', 2.5, pg('insert into errors (workflow, node, message, payload) values ($1, $2, $3, $4::jsonb) returning id', [
    "String(($json.workflow && $json.workflow.name) || '')",
    "String(($json.execution && $json.execution.lastNodeExecuted) || '')",
    "String(($json.execution && $json.execution.error && $json.execution.error.message) || ($json.trigger && $json.trigger.error && $json.trigger.error.message) || 'unknown error').slice(0, 1000)",
    "JSON.stringify({ workflow: $json.workflow, execution: $json.execution ? { id: $json.execution.id, url: $json.execution.url, mode: $json.execution.mode, lastNodeExecuted: $json.execution.lastNodeExecuted, error: $json.execution.error ? { name: $json.execution.error.name, message: $json.execution.error.message, description: $json.execution.error.description } : null } : null, trigger: $json.trigger ? { error: $json.trigger.error ? { name: $json.trigger.error.name, message: $json.trigger.error.message } : null } : null })",
  ]), { credentials: PG_CRED });
  w.node('Notify on?', 'n8n-nodes-base.if', 2.2, ifTrue('!!$env.NOTIFY_WEBHOOK_URL'));
  w.node('Notify', 'n8n-nodes-base.httpRequest', 4.2, http('POST', expr('$env.NOTIFY_WEBHOOK_URL'), {
    json: "JSON.stringify({ text: 'lead-pipeline error in ' + String(($('Error trigger').first().json.workflow && $('Error trigger').first().json.workflow.name) || '?') + ' at node ' + String(($('Error trigger').first().json.execution && $('Error trigger').first().json.execution.lastNodeExecuted) || '?') })",
  }), { onError: 'continueRegularOutput' });
  w.chain('Error trigger', 'Log error', 'Notify on?');
  w.link('Notify on?', 'Notify', 0);
  return w;
}

// ---------- 06 Dashboard ----------
function dashboard() {
  const w = new Workflow('06 Dashboard', ID.dashboard, { errorWorkflow: ID.errors });
  w.note('## 06 Dashboard\nGET /webhook/dashboard renders metrics, the review queue and recent leads from SQL views; GET /webhook/metrics returns the metrics row as JSON for monitoring.', [40, -160], 560, 110);
  w.node('Dashboard webhook', 'n8n-nodes-base.webhook', 2, { httpMethod: 'GET', path: 'dashboard', responseMode: 'responseNode', options: {} }, { webhookId: 'lp-dashboard' });
  w.node('Metrics', 'n8n-nodes-base.postgres', 2.5, pg('select * from v_metrics'), { credentials: PG_CRED, alwaysOutputData: true, executeOnce: true });
  w.node('Queue', 'n8n-nodes-base.postgres', 2.5, pg('select * from v_review_queue limit 50'), { credentials: PG_CRED, alwaysOutputData: true, executeOnce: true });
  w.node('Recent', 'n8n-nodes-base.postgres', 2.5, pg('select id, email, company, job_title, decision, decided_by, score, segment, crm_id, updated_at from leads order by updated_at desc limit 30'), { credentials: PG_CRED, alwaysOutputData: true, executeOnce: true });
  w.node('Render HTML', 'n8n-nodes-base.code', 2, codeNode('dashboard_html.js', {
    input: "[{ metrics: $('Metrics').first().json, queue: $('Queue').all().map((i) => i.json).filter((r) => r && r.id), recent: $('Recent').all().map((i) => i.json).filter((r) => r && r.id) }]",
  }));
  w.node('Respond HTML', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'text', responseBody: expr('$json.html'), options: { responseHeaders: { entries: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }] } } });
  w.node('Metrics webhook', 'n8n-nodes-base.webhook', 2, { httpMethod: 'GET', path: 'metrics', responseMode: 'responseNode', options: {} }, { webhookId: 'lp-metrics' });
  w.node('Metrics JSON', 'n8n-nodes-base.postgres', 2.5, pg('select * from v_metrics'), { credentials: PG_CRED, alwaysOutputData: true, executeOnce: true });
  w.node('Respond JSON', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'json', responseBody: expr('JSON.stringify($json)'), options: {} });
  w.chain('Dashboard webhook', 'Metrics', 'Queue', 'Recent', 'Render HTML', 'Respond HTML');
  w.chain('Metrics webhook', 'Metrics JSON', 'Respond JSON');
  return w;
}

// ---------- build ----------
const workflows = [['01-intake.json', intake()], ['02-enrich-qualify.json', qualify()], ['03-crm-sync.json', crm()], ['04-review-form.json', review()], ['05-error-handler.json', errors()], ['06-dashboard.json', dashboard()]];
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [file, wf] of workflows) {
  const json = wf.toJSON();
  fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify(json, null, 2) + '\n');
  const nodes = json.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote').length;
  const edges = Object.values(json.connections).flatMap((c) => c.main.flat()).length;
  console.log(`${file.padEnd(26)} ${json.name.padEnd(22)} ${String(nodes).padStart(2)} nodes, ${String(edges).padStart(2)} connections`);
}
