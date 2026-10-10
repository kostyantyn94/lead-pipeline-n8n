-- Seed rules. Rules are data: operators add or change them without touching workflows,
-- and the review form turns human decisions into new rows here.

-- Free-mail providers: not a decision by themselves (see the rule engine): free mail + no company -> rejected, free mail + company -> review.
insert into rules (kind, pattern, decision, score, note) values
  ('free_mail', 'gmail.com',      null, null, 'free-mail provider'),
  ('free_mail', 'googlemail.com', null, null, 'free-mail provider'),
  ('free_mail', 'yahoo.com',      null, null, 'free-mail provider'),
  ('free_mail', 'outlook.com',    null, null, 'free-mail provider'),
  ('free_mail', 'hotmail.com',    null, null, 'free-mail provider'),
  ('free_mail', 'live.com',       null, null, 'free-mail provider'),
  ('free_mail', 'icloud.com',     null, null, 'free-mail provider'),
  ('free_mail', 'proton.me',      null, null, 'free-mail provider'),
  ('free_mail', 'protonmail.com', null, null, 'free-mail provider'),
  ('free_mail', 'aol.com',        null, null, 'free-mail provider'),
  ('free_mail', 'mail.ru',        null, null, 'free-mail provider'),
  ('free_mail', 'yandex.ru',      null, null, 'free-mail provider'),
  ('free_mail', 'ukr.net',        null, null, 'free-mail provider'),
  ('free_mail', 'i.ua',           null, null, 'free-mail provider')
on conflict do nothing;

-- Disposable / placeholder domains: never a lead.
insert into rules (kind, pattern, decision, score, note) values
  ('domain_block', 'example.com',       'rejected', 0, 'placeholder domain'),
  ('domain_block', 'example.org',       'rejected', 0, 'placeholder domain'),
  ('domain_block', 'test.com',          'rejected', 0, 'placeholder domain'),
  ('domain_block', 'mailinator.com',    'rejected', 0, 'disposable mailbox'),
  ('domain_block', '10minutemail.com',  'rejected', 0, 'disposable mailbox'),
  ('domain_block', 'guerrillamail.com', 'rejected', 0, 'disposable mailbox')
on conflict do nothing;

-- Job-title rules: JavaScript regular expressions (case-insensitive), evaluated by the rule engine in n8n/code/enrich_rules.js.
-- Qualify rules apply only to corporate (non-free-mail) addresses.
insert into rules (kind, pattern, decision, score, note) values
  ('title_reject',  '\b(student|intern|internship|unemployed|job seeker|looking for (a )?job)\b', 'rejected', 0.1, 'not a buyer'),
  ('title_qualify', '\b(ceo|cto|coo|cmo|cro|founder|co-founder|cofounder|owner|president|vp|vice president|head of|director|chief)\b', 'qualified', 0.9, 'decision maker')
on conflict do nothing;
