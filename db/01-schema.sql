-- Lead pipeline schema. Runs once on first start of the postgres container (docker-entrypoint-initdb.d).
-- Design: rules are data, decisions are priority-protected (human > rule > ai), every change is audited by trigger.

create table if not exists rules (
  id          serial primary key,
  kind        text not null check (kind in ('domain_block', 'domain_allow', 'free_mail', 'title_reject', 'title_qualify')),
  pattern     text not null,                 -- exact domain for domain_* and free_mail, case-insensitive regex for title_*
  decision    text check (decision in ('qualified', 'rejected', 'review')),
  score       numeric(4,3),
  note        text,
  enabled     boolean not null default true,
  created_by  text not null default 'seed',  -- seed | human
  created_at  timestamptz not null default now(),
  unique (kind, pattern)
);

create table if not exists leads (
  id              bigserial primary key,
  fingerprint     text not null unique,      -- sha256 of the normalized email (or phone when no email)
  email           text,
  phone           text,
  first_name      text,
  last_name       text,
  company         text,
  domain          text,
  job_title       text,
  country         text,
  source          text,
  message         text,
  raw             jsonb not null,
  -- enrichment (deterministic, no paid APIs)
  is_free_mail    boolean,
  mx_valid        boolean,
  website_title   text,
  enriched_at     timestamptz,
  -- qualification
  score           numeric(4,3),
  segment         text,
  decision        text check (decision in ('qualified', 'rejected', 'review')),
  decided_by      text check (decided_by in ('human', 'rule', 'ai')),
  reason          text,
  opener          text,                      -- AI-personalized first line for outreach
  llm_confidence  numeric(4,3),
  rule_id         int references rules(id),
  -- CRM sync
  crm_id          text,
  crm_synced_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists leads_decision_idx on leads (decision, decided_by);
create index if not exists leads_domain_idx on leads (domain);

create table if not exists lead_events (
  id          bigserial primary key,
  lead_id     bigint references leads(id) on delete cascade,
  event       text not null,                 -- created | enriched | ai_called | decision | crm_synced
  actor       text,                          -- intake | enrich | ai | rule | human | crm
  details     jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists lead_events_lead_idx on lead_events (lead_id, created_at);

create table if not exists errors (
  id          bigserial primary key,
  workflow    text,
  node        text,
  message     text,
  payload     jsonb,
  created_at  timestamptz not null default now()
);

-- updated_at maintenance
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists leads_touch on leads;
create trigger leads_touch before update on leads for each row execute function touch_updated_at();

-- Audit log: every meaningful change on a lead becomes an event, whoever made it (n8n, psql, a future UI).
create or replace function leads_audit() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into lead_events (lead_id, event, actor, details)
    values (new.id, 'created', 'intake', jsonb_build_object('source', new.source, 'domain', new.domain));
  else
    if new.enriched_at is distinct from old.enriched_at then
      insert into lead_events (lead_id, event, actor, details)
      values (new.id, 'enriched', 'enrich', jsonb_build_object('free_mail', new.is_free_mail, 'mx_valid', new.mx_valid, 'website_title', new.website_title));
    end if;
    if new.decision is distinct from old.decision or new.decided_by is distinct from old.decided_by then
      insert into lead_events (lead_id, event, actor, details)
      values (new.id, 'decision', new.decided_by, jsonb_build_object('from', old.decision, 'to', new.decision, 'score', new.score, 'rule_id', new.rule_id, 'reason', new.reason));
    end if;
    if new.crm_id is distinct from old.crm_id then
      insert into lead_events (lead_id, event, actor, details)
      values (new.id, 'crm_synced', 'crm', jsonb_build_object('crm_id', new.crm_id));
    end if;
  end if;
  return new;
end $$;
drop trigger if exists leads_audit_trg on leads;
create trigger leads_audit_trg after insert or update on leads for each row execute function leads_audit();

-- Decision priority: a human decision is never overwritten by a rule, a rule decision is never overwritten by AI.
create or replace function decision_priority(p text) returns int language sql immutable as $$
  select case p when 'human' then 3 when 'rule' then 2 when 'ai' then 1 else 0 end
$$;

create or replace function set_decision(
  p_lead_id bigint, p_decision text, p_by text, p_score numeric, p_segment text,
  p_reason text, p_opener text, p_confidence numeric, p_rule_id int
) returns table (applied boolean, decision text, decided_by text) language plpgsql as $$
declare cur record;
begin
  select l.decision, l.decided_by into cur from leads l where l.id = p_lead_id for update;
  if not found then
    return query select false, null::text, null::text; return;
  end if;
  if cur.decided_by is not null and decision_priority(p_by) < decision_priority(cur.decided_by) then
    return query select false, cur.decision, cur.decided_by; return;
  end if;
  update leads set
    decision = p_decision, decided_by = p_by, score = p_score,
    segment = coalesce(p_segment, segment), reason = p_reason,
    opener = coalesce(p_opener, opener), llm_confidence = coalesce(p_confidence, llm_confidence),
    rule_id = p_rule_id
  where id = p_lead_id;
  return query select true, p_decision, p_by;
end $$;

-- Idempotent intake: same fingerprint -> same row. Re-sends only fill blanks and merge raw payloads, never overwrite.
create or replace function upsert_lead(p_fingerprint text, p jsonb)
returns table (id bigint, is_new boolean) language plpgsql as $$
declare v_id bigint; v_new boolean;
begin
  insert into leads (fingerprint, email, phone, first_name, last_name, company, domain, job_title, country, source, message, raw)
  values (p_fingerprint, p->>'email', p->>'phone', p->>'first_name', p->>'last_name', p->>'company', p->>'domain',
          p->>'job_title', p->>'country', p->>'source', p->>'message', p)
  on conflict (fingerprint) do update set
    phone      = coalesce(leads.phone, excluded.phone),
    first_name = coalesce(leads.first_name, excluded.first_name),
    last_name  = coalesce(leads.last_name, excluded.last_name),
    company    = coalesce(leads.company, excluded.company),
    job_title  = coalesce(leads.job_title, excluded.job_title),
    country    = coalesce(leads.country, excluded.country),
    message    = coalesce(leads.message, excluded.message),
    raw        = leads.raw || excluded.raw
  returning leads.id, (xmax = 0) into v_id, v_new;
  return query select v_id, v_new;
end $$;

-- One-row metrics view for the dashboard and the README.
create or replace view v_metrics as
select
  (select count(*) from leads)                                   as leads_total,
  (select count(*) from leads where decision = 'qualified')      as qualified,
  (select count(*) from leads where decision = 'review')         as in_review,
  (select count(*) from leads where decision = 'rejected')       as rejected,
  (select count(*) from leads where decision is null)            as undecided,
  (select count(*) from leads where decided_by = 'rule')         as decided_by_rule,
  (select count(*) from leads where decided_by = 'ai')           as decided_by_ai,
  (select count(*) from leads where decided_by = 'human')        as decided_by_human,
  (select count(*) from lead_events where event = 'ai_called')   as llm_calls,
  (select count(*) from leads where crm_id is not null)          as crm_synced,
  (select count(*) from rules where created_by = 'human')        as rules_from_humans,
  (select count(*) from errors)                                  as errors;

create or replace view v_review_queue as
select id, email, company, job_title, country, score, llm_confidence, reason, created_at
from leads where decision = 'review' order by created_at;
