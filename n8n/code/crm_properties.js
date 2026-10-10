// Maps a qualified lead to HubSpot CRM v3 contact properties (standard properties only, so it works on a fresh
// HubSpot account; map score/segment to custom properties if your portal has them). Pure function, unit-tested.
function main(items) {
  return items.map((lead) => {
    const tag = `[lead-pipeline] decision=${lead.decision} by=${lead.decided_by} score=${lead.score ?? 'n/a'} segment=${lead.segment ?? 'n/a'}`;
    const properties = {
      email: lead.email || undefined,
      phone: lead.phone || undefined,
      firstname: lead.first_name || undefined,
      lastname: lead.last_name || undefined,
      company: lead.company || undefined,
      jobtitle: lead.job_title || undefined,
      website: lead.domain || undefined,
      country: lead.country || undefined,
      hs_lead_status: 'NEW',
      message: [
        tag,
        lead.reason ? `reason: ${lead.reason}` : null,
        lead.opener ? `opener: ${lead.opener}` : null,
        lead.message ? `original message: ${lead.message}` : null,
      ].filter(Boolean).join('\n'),
    };
    for (const k of Object.keys(properties)) if (properties[k] === undefined) delete properties[k];
    return { lead_id: lead.id, email: lead.email || '', phone: lead.phone || '', properties };
  });
}
