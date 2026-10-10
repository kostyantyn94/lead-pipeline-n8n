// Deterministic enrichment plus the rule engine. Rules are rows from the database (lead.rules, loaded with the lead),
// applied in a fixed order; a null rule means "no rule applies, ask the model". Pure function: unit-tested outside n8n.
// Input item: { lead, dns, website } where dns is the Google DNS-over-HTTPS JSON (or an error item) and website is the
// raw homepage response ({ data: '<html>...' }) or null when website enrichment is off.
function main(items) {
  return items.map(({ lead, dns, website }) => {
    const rules = (lead.rules || []).filter((r) => r.enabled !== false);
    const domain = (lead.domain || '').toLowerCase();
    const title = lead.job_title || '';
    const byKind = (kind) => rules.filter((r) => r.kind === kind);
    const domainRule = (kind) => byKind(kind).find((r) => r.pattern.toLowerCase() === domain) || null;
    const titleRule = (kind) => byKind(kind).find((r) => {
      try { return new RegExp(r.pattern, 'i').test(title); } catch { return false; }
    }) || null;

    const freeMail = domainRule('free_mail');
    const is_free_mail = !!freeMail;
    const mx_valid = !!(dns && dns.Status === 0 && Array.isArray(dns.Answer) && dns.Answer.some((a) => a.type === 15));
    const website_title = website && typeof website.data === 'string'
      ? ((website.data.match(/<title[^>]*>([^<]{1,200})/i) || [])[1] || '').replace(/\s+/g, ' ').trim() || null
      : null;

    let rule = null;
    let r;
    if ((r = domainRule('domain_block'))) {
      rule = { id: r.id, decision: 'rejected', score: r.score ?? 0, reason: `blocked domain ${domain}${r.note ? ': ' + r.note : ''}` };
    } else if ((r = domainRule('domain_allow'))) {
      rule = { id: r.id, decision: r.decision || 'qualified', score: r.score ?? 1, reason: `allow-listed domain ${domain}${r.note ? ': ' + r.note : ''}` };
    } else if ((r = titleRule('title_reject'))) {
      rule = { id: r.id, decision: 'rejected', score: r.score ?? 0.1, reason: `title "${title}" matches a reject rule${r.note ? ' (' + r.note + ')' : ''}` };
    } else if (is_free_mail && !lead.company) {
      rule = { id: freeMail.id, decision: 'rejected', score: 0.1, reason: `free-mail address (${domain}) without a company` };
    } else if (is_free_mail && lead.company) {
      rule = { id: freeMail.id, decision: 'review', score: 0.4, reason: `free-mail address (${domain}) but a company is given: ${lead.company}` };
    } else if (!lead.email && lead.phone) {
      rule = { id: null, decision: 'review', score: 0.3, reason: 'phone-only lead: nothing to enrich or score, needs a human' };
    } else if ((r = titleRule('title_qualify'))) {
      rule = { id: r.id, decision: 'qualified', score: r.score ?? 0.9, reason: `decision-maker title "${title}" at corporate domain ${domain}` };
    }

    // Only what the model needs: no ids, no raw payload, no PII beyond the first name.
    const lead_for_ai = {
      first_name: lead.first_name || '', company: lead.company || '', job_title: title, domain,
      country: lead.country || '', source: lead.source || '', message: lead.message || '',
      is_free_mail, mx_valid, website_title,
    };
    return { lead_id: lead.id, is_free_mail, mx_valid, website_title, rule, lead_for_ai };
  });
}
