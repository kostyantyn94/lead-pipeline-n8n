// Mock LLM that speaks the OpenAI chat-completions shape and answers deterministically, so the pipeline
// can be tested offline and the numbers in the README are reproducible. The real model is one env change away.
// MOCK_LLM_FAIL_EVERY=N makes every Nth call fail with HTTP 500 to exercise retries and the error path.
const http = require('http');

const PORT = Number(process.env.PORT || 8081);
const FAIL_EVERY = Number(process.env.MOCK_LLM_FAIL_EVERY || 0);
const stats = { calls: 0, failures: 0 };

const TOPIC = /(automation|crm|integration|n8n|zapier|make\.com|pipeline|leads|outbound|workflow|dashboard|notification)/;

function pick(text, table, fallback) {
  for (const [re, value] of table) if (re.test(text)) return value;
  return fallback;
}

function qualify(lead) {
  const title = (lead.job_title || '').toLowerCase();
  const msg = (lead.message || '').toLowerCase();
  const company = lead.company || '';
  const blob = `${company.toLowerCase()} ${title} ${msg}`;

  let fit = 0.5;
  if (/(manager|lead|head|director|founder|ceo|cto|coo|cmo|vp|owner|chief|president)/.test(title)) fit += 0.25;
  if (company) fit += 0.1;
  if (lead.is_free_mail) fit -= 0.3;
  if (TOPIC.test(msg)) fit += 0.1;
  if (/(student|intern|homework|thesis|just browsing)/.test(blob)) fit -= 0.4;
  fit = Math.max(0, Math.min(1, Math.round(fit * 100) / 100));

  const segment = pick(blob, [
    [/(saas|software|platform|app|labs|dev|cloud)/, 'saas'],
    [/(agency|studio|consult)/, 'agency'],
    [/(shop|store|e-?commerce|retail)/, 'ecommerce'],
    [/(service|clinic|law|logistic|ops)/, 'services'],
  ], 'other');

  const confidence = !title && !msg ? 0.55 : 0.85;
  const topic = (msg.match(TOPIC) || [])[0] || 'process automation';
  const reason = `Title "${lead.job_title || 'n/a'}" at ${company || 'an unknown company'}; ${lead.is_free_mail ? 'free-mail address' : 'corporate domain'}; message ${msg ? `mentions ${topic}` : 'is empty'}.`;
  const opener = `Hi ${lead.first_name || 'there'}, saw that ${company || 'your team'} is looking into ${topic} - happy to share how similar teams wired this up in about a week.`;
  return { fit_score: fit, segment, confidence, reason, opener };
}

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/stats') return send(res, 200, stats);
  if (req.method === 'POST' && req.url === '/reset') { stats.calls = 0; stats.failures = 0; return send(res, 200, { ok: true }); }
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) return send(res, 404, { error: { message: 'not found' } });

  let buf = '';
  req.on('data', (c) => (buf += c));
  req.on('end', () => {
    stats.calls++;
    if (FAIL_EVERY && stats.calls % FAIL_EVERY === 0) {
      stats.failures++;
      return send(res, 500, { error: { message: 'mock outage (MOCK_LLM_FAIL_EVERY)', type: 'server_error' } });
    }
    let body; try { body = JSON.parse(buf); } catch { return send(res, 400, { error: { message: 'invalid JSON body' } }); }
    const user = (body.messages || []).filter((m) => m.role === 'user').pop();
    let lead = {};
    try { lead = JSON.parse(user?.content || '{}'); } catch { /* the prompt is free text: fall back to an empty lead */ }
    const result = qualify(lead);
    send(res, 200, {
      id: `chatcmpl-mock-${stats.calls}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'mock-qualifier',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(result) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  });
}).listen(PORT, () => console.log(`mock LLM (OpenAI chat-completions shape) listening on :${PORT}`));
