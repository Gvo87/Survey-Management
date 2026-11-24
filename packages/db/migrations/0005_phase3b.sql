-- Phase 3B: languages (translations already live in survey_versions.translations), login-required respondents,
-- single sign-on, AI summaries of open text, usage metrics, retention, the super-admin console and privacy
-- requests (subject export and erasure).

-- ── Login-required respondents (open question Q5: org members only) ─────────
-- `surveys.access.requireLogin` turns it on. The member is stored in responses.respondent_user_id (the 0001
-- trigger already refuses it on anonymous surveys). One response per member and survey.
alter table responses add constraint responses_respondent_user_fk
  foreign key (respondent_user_id) references users(id) on delete set null;
create unique index responses_one_per_member on responses (survey_id, respondent_user_id)
  where respondent_user_id is not null;
create index responses_respondent_user on responses (respondent_user_id) where respondent_user_id is not null;

-- ── Retention ────────────────────────────────────────────────────────────
-- Org default lives in organizations.settings.retention.responsesDays; a survey can override it.
alter table surveys add column retention_days integer check (retention_days between 1 and 3650);

-- ── Single sign-on ───────────────────────────────────────────────────────
create table sso_connections (
  id            uuid primary key,
  org_id        uuid not null references organizations(id) on delete cascade,
  protocol      text not null check (protocol in ('oidc', 'saml')),
  name          text not null,
  -- AES-256-GCM JSON. OIDC: issuer, clientId, clientSecret. SAML: entryPoint, idpIssuer, idpCert.
  config_enc    text not null,
  -- Non-secret details for the UI (issuer, client id, entry point).
  summary       jsonb not null default '{}',
  -- Role given to people provisioned on their first SSO login. Admins are never provisioned automatically.
  default_role  text not null default 'creator' check (default_role in ('creator', 'analyst')),
  enabled       boolean not null default true,
  -- Enforcement can only be switched on after a successful login (a broken connection must not lock people out).
  last_login_at timestamptz,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index sso_connections_org on sso_connections (org_id);

-- Email domains an org claims. Only a verified domain (DNS TXT record) is trusted: SSO logins must assert an
-- email in a verified domain of the connection's org, and enforcement applies to verified domains only.
create table sso_domains (
  org_id             uuid not null references organizations(id) on delete cascade,
  domain             citext not null,
  verification_token text not null,
  verified_at        timestamptz,
  created_at         timestamptz not null default now(),
  primary key (org_id, domain)
);
-- Several orgs may claim a domain; only one can verify it.
create unique index sso_domains_verified on sso_domains (domain) where verified_at is not null;

-- The identity provider's stable subject for a user, per connection.
create table sso_identities (
  org_id        uuid not null,
  connection_id uuid not null references sso_connections(id) on delete cascade,
  subject       text not null,
  user_id       uuid not null references users(id) on delete cascade,
  email         citext not null,
  last_login_at timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  primary key (connection_id, subject)
);
create index sso_identities_user on sso_identities (org_id, user_id);

-- ── AI summaries of open text ────────────────────────────────────────────
create table text_insights (
  id                 uuid primary key,
  org_id             uuid not null,
  survey_id          uuid not null references surveys(id) on delete cascade,
  question_key       text not null,
  status             text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  error_code         text,
  provider           text,
  model              text,
  -- Answers sent to the provider (after redaction) and how many there were in total.
  responses_analysed integer not null default 0,
  responses_total    integer not null default 0,
  summary            text,
  -- [{ label, summary, sentiment, count, responseIds[] }]: response ids are checked against the ids sent.
  themes             jsonb not null default '[]',
  -- { positive, neutral, negative } as counts of answers.
  sentiment          jsonb,
  input_tokens       integer not null default 0,
  output_tokens      integer not null default 0,
  requested_by       uuid references users(id) on delete set null,
  created_at         timestamptz not null default now(),
  generated_at       timestamptz
);
create index text_insights_question on text_insights (survey_id, question_key, created_at desc);

-- ── Usage metrics ────────────────────────────────────────────────────────
-- Counters incremented where the event happens, so purges and erasure don't rewrite history.
create table org_usage_monthly (
  org_id            uuid not null references organizations(id) on delete cascade,
  -- First day of the month (UTC).
  month             date not null,
  responses         integer not null default 0,
  surveys_published integer not null default 0,
  emails_sent       integer not null default 0,
  ai_tokens         integer not null default 0,
  primary key (org_id, month)
);

-- Backfill from what exists.
insert into org_usage_monthly (org_id, month, responses)
  select org_id, date_trunc('month', completed_at at time zone 'UTC')::date, count(*)
    from responses where status = 'completed' and not is_test and completed_at is not null
   group by 1, 2
  on conflict (org_id, month) do update set responses = excluded.responses;
insert into org_usage_monthly (org_id, month, surveys_published)
  select org_id, date_trunc('month', published_at at time zone 'UTC')::date, count(*)
    from survey_versions where status = 'published' and published_at is not null
   group by 1, 2
  on conflict (org_id, month) do update set surveys_published = excluded.surveys_published;
insert into org_usage_monthly (org_id, month, emails_sent)
  select org_id, date_trunc('month', sent_at at time zone 'UTC')::date, count(*) + coalesce(sum(reminders_sent), 0)
    from recipients where sent_at is not null
   group by 1, 2
  on conflict (org_id, month) do update set emails_sent = excluded.emails_sent;

-- ── Privacy requests (subject export and erasure) ────────────────────────
create table privacy_requests (
  id            uuid primary key,
  org_id        uuid not null references organizations(id) on delete cascade,
  kind          text not null check (kind in ('export', 'erase')),
  subject_email citext not null,
  status        text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  -- What was found or erased, as counts (never the data itself).
  result        jsonb not null default '{}',
  storage_key   text,
  filename      text,
  size          integer,
  expires_at    timestamptz,
  failure       text,
  requested_by  uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index privacy_requests_org on privacy_requests (org_id, created_at desc);

-- ── Row-level security ───────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'sso_connections', 'sso_domains', 'sso_identities', 'text_insights', 'org_usage_monthly', 'privacy_requests'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = app_org_id()) with check (org_id = app_org_id())', t);
  end loop;
end $$;

-- ── Narrow cross-tenant functions ────────────────────────────────────────

-- Suspended orgs stop collecting responses (their links answer "not found").
create or replace function resolve_public_survey(p_public_id text)
returns table (org_id uuid, survey_id uuid)
language sql stable security definer set search_path = public as $$
  select s.org_id, s.id from surveys s join organizations o on o.id = s.org_id
   where s.public_id = p_public_id and s.deleted_at is null and o.status = 'active'
$$;

-- Login page: which active org verified this email domain, does it enforce SSO, and which connections can be
-- used? Reveals nothing about users.
create function sso_for_domain(p_domain text)
returns table (org_id uuid, org_name text, enforced boolean, connection_id uuid, connection_name text, protocol text)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, coalesce((o.settings->'sso'->>'enforced')::boolean, false), c.id, c.name, c.protocol
    from sso_domains d
    join organizations o on o.id = d.org_id and o.status = 'active'
    left join sso_connections c on c.org_id = o.id and c.enabled
   where d.domain = p_domain::citext and d.verified_at is not null
   order by c.created_at
$$;

-- Starting a login: the org of a connection (the API then reads the connection in that org's tenant context).
create function sso_connection_org(p_connection_id uuid)
returns table (org_id uuid)
language sql stable security definer set search_path = public as $$
  select c.org_id from sso_connections c join organizations o on o.id = c.org_id
   where c.id = p_connection_id and c.enabled and o.status = 'active'
$$;

-- Daily retention purge: surveys with an effective retention period (own setting, else the org default).
create function retention_targets()
returns table (org_id uuid, survey_id uuid, days integer)
language sql stable security definer set search_path = public as $$
  select s.org_id, s.id, coalesce(s.retention_days, (o.settings->'retention'->>'responsesDays')::integer)
    from surveys s join organizations o on o.id = s.org_id
   where coalesce(s.retention_days, (o.settings->'retention'->>'responsesDays')::integer) is not null
$$;

-- Soft-deleted surveys are purged for good after 30 days.
create function deleted_surveys_due(p_now timestamptz)
returns table (org_id uuid, survey_id uuid)
language sql stable security definer set search_path = public as $$
  select org_id, id from surveys where deleted_at is not null and deleted_at < p_now - interval '30 days' limit 100
$$;

-- Super-admin console: every org with its size and this month's usage. No survey or response content.
create function admin_org_overview(p_month date)
returns table (id uuid, name text, slug text, plan text, status text, created_at timestamptz,
               ai_enabled boolean, ai_token_cap integer, members integer, surveys integer,
               responses integer, surveys_published integer, emails_sent integer, ai_tokens integer)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, o.slug::text, o.plan, o.status, o.created_at,
         coalesce((o.settings->'ai'->>'enabled')::boolean, false),
         (o.settings->'ai'->>'monthlyTokenCap')::integer,
         (select count(*)::int from memberships m where m.org_id = o.id),
         (select count(*)::int from surveys s where s.org_id = o.id and s.deleted_at is null),
         coalesce(u.responses, 0), coalesce(u.surveys_published, 0), coalesce(u.emails_sent, 0), coalesce(u.ai_tokens, 0)
    from organizations o
    left join org_usage_monthly u on u.org_id = o.id and u.month = p_month
   order by o.created_at desc
$$;

-- Subject-export files are kept for 7 days.
create function expired_privacy_exports(p_now timestamptz)
returns table (org_id uuid, request_id uuid, storage_key text)
language sql stable security definer set search_path = public as $$
  select org_id, id, storage_key from privacy_requests where storage_key is not null and expires_at <= p_now limit 500
$$;

revoke all on function sso_for_domain(text), sso_connection_org(uuid), retention_targets(),
  deleted_surveys_due(timestamptz), admin_org_overview(date), expired_privacy_exports(timestamptz) from public;
grant execute on function sso_for_domain(text), sso_connection_org(uuid), retention_targets(),
  deleted_surveys_due(timestamptz), admin_org_overview(date), expired_privacy_exports(timestamptz),
  resolve_public_survey(text) to survey_app;

grant select, insert, update, delete on sso_connections, sso_domains, sso_identities, text_insights,
  org_usage_monthly, privacy_requests to survey_app;
