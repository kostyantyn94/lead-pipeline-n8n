// Renders the dashboard page from the metrics row, the review queue and the recent leads. Pure function, unit-tested.
// Input item: { metrics, queue: [...], recent: [...] }
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function n(v) { return Number(v || 0); }

function main(items) {
  return items.map(({ metrics, queue, recent }) => {
    const m = metrics || {};
    const total = n(m.leads_total), undecided = n(m.undecided);
    const decided = total - undecided;
    const withoutAi = n(m.decided_by_rule) + n(m.decided_by_human);
    const pct = decided ? Math.round((withoutAi / decided) * 100) : 0;
    const tile = (label, value, hint) => `<div class="tile"><b>${esc(value)}</b><span>${esc(label)}</span>${hint ? `<small>${esc(hint)}</small>` : ''}</div>`;
    const row = (cells) => `<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="15">
<title>Lead pipeline</title>
<style>
  body{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:24px;color:#1b1f27;background:#f6f7fb}
  h1{margin:0 0 4px;font-size:22px} .sub{color:#667;margin-bottom:18px}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:22px}
  .tile{background:#fff;border:1px solid #e3e6ef;border-radius:10px;padding:12px 14px}
  .tile b{display:block;font-size:24px;color:#2f5bea} .tile span{display:block;font-size:12px;color:#556;text-transform:uppercase;letter-spacing:.4px;margin-top:2px}
  .tile small{display:block;color:#889;margin-top:4px}
  h2{font-size:15px;margin:18px 0 8px} table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3e6ef;border-radius:10px;overflow:hidden;font-size:13px}
  th,td{padding:7px 10px;text-align:left;border-bottom:1px solid #eef0f5;vertical-align:top} th{background:#f0f2f8;font-weight:600}
  .muted{color:#889} a{color:#2f5bea}
</style></head><body>
<h1>Lead pipeline</h1>
<div class="sub">n8n + PostgreSQL + LLM. Rules first, the model for the rest, a human for the doubtful cases. Review form: <a href="/form/review">/form/review</a> · JSON: <a href="/webhook/metrics">/webhook/metrics</a></div>
<div class="tiles">
${tile('leads', total)}${tile('qualified', n(m.qualified))}${tile('in review', n(m.in_review))}${tile('rejected', n(m.rejected))}
${tile('decided without AI', `${pct}%`, `${withoutAi} of ${decided} decided`)}${tile('by rule', n(m.decided_by_rule))}${tile('by AI', n(m.decided_by_ai))}${tile('by human', n(m.decided_by_human))}
${tile('LLM calls', n(m.llm_calls))}${tile('synced to CRM', n(m.crm_synced))}${tile('rules from humans', n(m.rules_from_humans))}${tile('errors', n(m.errors))}
</div>
<h2>Review queue (${queue.length})</h2>
<table><tr><th>id</th><th>email</th><th>company</th><th>title</th><th>country</th><th>score</th><th>confidence</th><th>reason</th></tr>
${queue.length ? queue.map((q) => row([q.id, q.email, q.company, q.job_title, q.country, q.score, q.llm_confidence, q.reason])).join('') : '<tr><td colspan="8" class="muted">empty</td></tr>'}
</table>
<h2>Recent leads (${recent.length})</h2>
<table><tr><th>id</th><th>email</th><th>company</th><th>title</th><th>decision</th><th>by</th><th>score</th><th>segment</th><th>CRM id</th></tr>
${recent.length ? recent.map((l) => row([l.id, l.email, l.company, l.job_title, l.decision, l.decided_by, l.score, l.segment, l.crm_id])).join('') : '<tr><td colspan="9" class="muted">no leads yet - POST one to /webhook/lead</td></tr>'}
</table>
</body></html>`;
    return { html };
  });
}
