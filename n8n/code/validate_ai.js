// Validates the model's answer against a closed schema and turns it into a decision.
// The model never decides alone: invalid output or low confidence always lands in the human review queue.
// Pure function: unit-tested outside n8n. Input item: the raw chat-completions response.
const SEGMENTS = ['saas', 'agency', 'ecommerce', 'services', 'other'];
const ACCEPT = { fit: 0.7, confidence: 0.8 };   // qualified when both are reached
const REJECT = { fit: 0.4, confidence: 0.8 };   // rejected when fit is below and confidence is high
const MAX_TEXT = 500;

function parse(raw) {
  const text = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(text);
}

function main(items) {
  return items.map((res) => {
    const raw = res && res.choices && res.choices[0] && res.choices[0].message ? res.choices[0].message.content : '';
    const problems = [];
    let out = null;
    try { out = parse(raw); } catch { problems.push('not valid JSON'); }
    if (out && typeof out === 'object' && !Array.isArray(out)) {
      const num01 = (k) => typeof out[k] === 'number' && Number.isFinite(out[k]) && out[k] >= 0 && out[k] <= 1;
      if (!num01('fit_score')) problems.push('fit_score must be a number between 0 and 1');
      if (!num01('confidence')) problems.push('confidence must be a number between 0 and 1');
      if (!SEGMENTS.includes(out.segment)) problems.push(`segment must be one of ${SEGMENTS.join('|')}`);
      if (typeof out.reason !== 'string' || !out.reason.trim()) problems.push('reason must be a non-empty string');
      if (typeof out.opener !== 'string') problems.push('opener must be a string');
    } else if (!problems.length) {
      problems.push('answer is not a JSON object');
    }

    if (problems.length) {
      return {
        valid: false, decision: 'review', score: null, segment: null, confidence: null, opener: null,
        reason: `ai_invalid_output: ${problems.join('; ')}`, raw: String(raw ?? '').slice(0, MAX_TEXT),
      };
    }
    const fit = Math.round(out.fit_score * 1000) / 1000;
    const confidence = Math.round(out.confidence * 1000) / 1000;
    const decision = fit >= ACCEPT.fit && confidence >= ACCEPT.confidence ? 'qualified'
      : fit < REJECT.fit && confidence >= REJECT.confidence ? 'rejected'
      : 'review';
    return {
      valid: true, decision, score: fit, segment: out.segment, confidence,
      reason: out.reason.trim().slice(0, MAX_TEXT), opener: out.opener.trim().slice(0, MAX_TEXT),
      model: res.model || null, usage: res.usage || null,
    };
  });
}
