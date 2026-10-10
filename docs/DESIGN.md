# Design notes

Why the pipeline is built the way it is, decision by decision. Short on purpose: each item is something I would want
to be asked about.

## 1. Rules before the model

An LLM call costs money, time and predictability. Most inbound leads are easy: a free-mail address without a company,
a disposable domain, a student, or a CEO at a corporate domain. Those cases are decided by rules that live in the
`rules` table, for free and identically every time. Only the leads that no rule can decide reach the model. On the
bundled sample that is 17 of 51 leads; the rest never touch the LLM.

Rules are rows, not code, for two reasons: operators can add a blocked domain with an `INSERT`, and the review form can
turn a human decision into a rule without anyone editing a workflow.

Precedence is fixed and tested (`tests/code.test.js`): `domain_block` → `domain_allow` → `title_reject` → free-mail
logic → phone-only → `title_qualify` → model. A block always wins; an allow-list beats a title rule; a free-mail address
is rejected without a company and reviewed with one.

## 2. The model is boxed in

- It gets only the fields it needs (`lead_for_ai`): first name, company, title, domain, country, source, message and
  the enrichment flags. No ids, no raw payload, no last names.
- It must answer with one JSON object: `fit_score` and `confidence` in `[0, 1]`, `segment` from a closed list,
  `reason`, `opener`. `temperature: 0`, `response_format: json_object` where the provider supports it.
- The answer is validated in code (`validate_ai.js`). Anything invalid, including fenced JSON that does not parse, a
  segment outside the taxonomy or a score outside the range, goes to the review queue with the reason
  `ai_invalid_output: …`. The run never fails because the model misbehaved.
- Thresholds are explicit: qualified at `fit ≥ 0.7 ∧ confidence ≥ 0.8`, rejected at `fit < 0.4 ∧ confidence ≥ 0.8`,
  otherwise review. Low confidence is a feature: the prompt asks the model to be unsure when data is missing.
- The provider is a URL. Mock, OpenAI, Ollama or any OpenAI-compatible server are the same workflow.

## 3. Humans outrank everything

`set_decision()` in SQL compares priorities: `human` (3) > `rule` (2) > `ai` (1). A decision is applied only if the new
actor's priority is at least the current one. So a scheduled re-run of the model can never overwrite a human; a rule
that is added later can refine an AI decision but not a human one.

The review form is an n8n Form, no extra UI to host. The person sees the lead id on the dashboard, picks a decision and
optionally a domain rule. Free-mail domains and leads without a domain never become rules (`review_prepare.js`),
because "always qualify gmail.com" is a mistake nobody should be able to make.

## 4. The database audits, not the workflow

Triggers on `leads` write `lead_events` for creation, enrichment, every decision change and every CRM sync. Workflows
do not have to remember to log; psql edits and future UIs are logged the same way. `ai_called` is the one event the
workflow writes itself, because the database cannot see an HTTP call. Together they answer "why is this lead here and
what did it cost" for any lead.

## 5. Idempotent on purpose

- Intake upserts by fingerprint (`email:<normalized>` or `phone:<e164>`). Re-sends fill blanks and merge the raw
  payload but never overwrite.
- A lead is enriched and decided once; the 10-minute schedule only picks up leads with no decision.
- A lead is pushed to the CRM once (`crm_id`); the 15-minute schedule only picks up qualified leads without one.
  The CRM step searches by email before creating, so even a duplicate push updates instead of duplicating.
- Measured: sending the same 55 requests twice produced 0 new leads, 0 model calls and 0 CRM calls the second time.

## 6. Failure is a path, not an exception

- The LLM request retries 3 times with a 2 s pause, then continues on the error output: the lead lands in review with
  `ai_unavailable: …` and the run completes. Tested with the mock in "always fail" and "fail every 2nd call" modes.
- HTTP enrichment (`MX lookup`, `Website title`) continues on failure; a missing MX record is a flag, not a verdict.
- Anything else that throws goes to the error workflow, which stores workflow, node and message in `errors` and can
  notify. Tested by pointing `CRM_BASE_URL` at a closed port.

## 7. Workflows as code

`n8n/build.js` declares the graphs; the Code-node logic lives in `n8n/code/*.js` as pure `main(items, config)`
functions that are unit-tested with `node --test` outside n8n. Positions, ids and connections are generated. The
JSON in `n8n/workflows/` is a build artifact that the setup script imports; `scripts/n8n_push.js` updates a running
instance. Reviewing a change means reading a diff of code, not clicking through a canvas.

## 8. What I would do next

Real enrichment providers behind the same step; per-tenant rules and thresholds; a small admin UI over `rules` and
the review queue; outbound sequences after qualification (the `opener` is already there); evaluation of real model
output against human decisions from the audit log to tune the thresholds.
