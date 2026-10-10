// Normalizes and validates one inbound lead (the webhook body). Pure function: unit-tested outside n8n.
// Output: { ok: true, fingerprint, lead } or { ok: false, errors, received }.
const ALIASES = {
  email_address: 'email', e_mail: 'email', mail: 'email',
  title: 'job_title', position: 'job_title', role: 'job_title', jobtitle: 'job_title',
  org: 'company', organization: 'company', organisation: 'company', company_name: 'company',
  firstname: 'first_name', lastname: 'last_name', name: 'full_name', full_name: 'full_name', fullname: 'full_name',
  msg: 'message', comment: 'message', comments: 'message', notes: 'message', note: 'message',
  tel: 'phone', telephone: 'phone', mobile: 'phone', phone_number: 'phone',
  utm_source: 'source', lead_source: 'source',
};
const FIELDS = ['email', 'phone', 'first_name', 'last_name', 'company', 'job_title', 'country', 'source', 'message'];
const MAX_LEN = { message: 2000 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function str(v) {
  return v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
}

// E.164-ish: keep digits, accept 00 and bare national formats, require 7..15 digits. Returns null when invalid.
function normalizePhone(value) {
  let s = str(value).replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) s = '+' + s;
  const digits = s.slice(1).replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? '+' + digits : null;
}

function main(items) {
  return items.map((item) => {
    const body = item && typeof item.body === 'object' && item.body !== null ? item.body : item || {};
    const lead = {};
    const errors = [];

    for (const [rawKey, value] of Object.entries(body)) {
      const key = ALIASES[String(rawKey).toLowerCase()] || String(rawKey).toLowerCase();
      if (key === 'full_name') {
        const parts = str(value).split(' ');
        if (!lead.first_name) lead.first_name = parts.shift() || '';
        if (!lead.last_name) lead.last_name = parts.join(' ');
        continue;
      }
      if (FIELDS.includes(key)) lead[key] = str(value).slice(0, MAX_LEN[key] || 200);
    }
    for (const f of FIELDS) if (lead[f] === undefined) lead[f] = '';

    lead.email = lead.email.toLowerCase();
    if (lead.email && !EMAIL_RE.test(lead.email)) errors.push(`invalid email: ${lead.email}`);
    if (lead.phone) {
      const phone = normalizePhone(lead.phone);
      if (phone === null) errors.push(`invalid phone: ${lead.phone}`);
      else lead.phone = phone;
    }
    if (!lead.email && !lead.phone) errors.push('email or phone is required');

    lead.domain = lead.email ? lead.email.split('@')[1] : '';
    if (!lead.source) lead.source = 'webhook';

    if (errors.length) return { ok: false, errors, received: body };
    // The fingerprint is the normalized identity, so re-sends of the same person dedupe at the database level.
    const fingerprint = lead.email ? `email:${lead.email}` : `phone:${lead.phone}`;
    return { ok: true, fingerprint, lead };
  });
}
