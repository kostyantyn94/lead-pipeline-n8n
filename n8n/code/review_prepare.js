// Turns a review-form submission plus the loaded lead into a human decision and, optionally, a new rule.
// Guard: domain rules are never created for free-mail domains or leads without a domain. Pure function, unit-tested.
function main(items) {
  return items.map(({ form, lead }) => {
    if (!lead || !lead.id) {
      return { lead_id: null, decision: null, score: null, reason: null, rule_kind: null, pattern: null, rule_decision: null, note: null, warning: 'lead not found' };
    }
    const decision = String(form['Decision']) === 'qualified' ? 'qualified' : 'rejected';
    const want = String(form['Create a rule'] || 'no').toLowerCase();
    const note = String(form['Note'] || '').trim();
    let rule_kind = want.startsWith('always qualify') ? 'domain_allow' : want.startsWith('always reject') ? 'domain_block' : null;
    let warning = null;
    if (rule_kind && (!lead.domain || lead.is_free_domain)) {
      warning = `no domain rule created for "${lead.domain || 'a lead without email'}": free-mail provider or missing domain`;
      rule_kind = null;
    }
    return {
      lead_id: lead.id,
      decision,
      score: decision === 'qualified' ? 1 : 0,
      reason: `human decision${note ? ': ' + note : ''}`,
      rule_kind,
      pattern: rule_kind ? lead.domain : null,
      rule_decision: rule_kind === 'domain_allow' ? 'qualified' : 'rejected',
      note: note || `created from lead ${lead.id} via the review form`,
      warning,
    };
  });
}
