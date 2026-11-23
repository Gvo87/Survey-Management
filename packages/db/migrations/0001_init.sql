-- Phase 1 schema (docs/02-data-model.md §2.6).
-- Runs as the database owner. The owner must be a superuser or have BYPASSRLS, because the
-- SECURITY DEFINER functions below read across tenants on purpose.

create extension if not exists citext;

-- The role the API and worker log in as. Created NOLOGIN here so grants work everywhere;
-- local dev gets LOGIN + password from docker/postgres/init.sql, production from infrastructure code.
do $$
begin
  if not exists (select from pg_roles where rolname = 'survey_app') then
    create role survey_app nologin;
  end if;
end $$;

-- Tenant context, set per transaction with set_config(..., true). Unset → NULL → no rows match.
create function app_org_id() returns uuid language sql stable as $$
  select nullif(current_setting('app.org_id', true), '')::uuid
$$;

-- ── Identity and tenancy ─────────────────────────────────────────────
create table organizations (
  id          uuid primary key,
  name        text not null,
  slug        citext not null unique,
  plan        text not null default 'free',
  status      text not null default 'active' check (status in ('active', 'suspended')),
  settings    jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table users (
  id                uuid primary key,
  email             citext not null unique,
  name              text not null,
  password_hash     text,
  is_super_admin    boolean not null default false,
  email_verified_at timestamptz,
  last_login_at     timestamptz,
  disabled_at       timestamptz,
  created_at        timestamptz not null default now()
);

create table memberships (
  org_id     uuid not null references organizations(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  role       text not null check (role in ('org_admin', 'creator', 'analyst')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user on memberships (user_id);

create table invitations (
  id          uuid primary key,
  org_id      uuid not null references organizations(id) on delete cascade,
  email       citext not null,
  role        text not null check (role in ('org_admin', 'creator', 'analyst')),
  token_hash  bytea not null unique,
  invited_by  uuid not null references users(id),
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index invitations_org on invitations (org_id, created_at desc);

create table sessions (
  id_hash       bytea primary key,
  user_id       uuid not null references users(id) on delete cascade,
  active_org_id uuid references organizations(id) on delete set null,
  ip            inet,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null
);
create index sessions_user on sessions (user_id);
create index sessions_expiry on sessions (expires_at);

create table auth_tokens (
  token_hash bytea primary key,
  user_id    uuid not null references users(id) on delete cascade,
  purpose    text not null check (purpose in ('password_reset', 'email_verify')),
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index auth_tokens_user on auth_tokens (user_id, purpose);

-- ── Surveys ──────────────────────────────────────────────────────────
create table surveys (
  id                 uuid primary key,
  org_id             uuid not null references organizations(id),
  title              text not null,
  public_id          text not null unique,
  status             text not null default 'draft' check (status in ('draft', 'live', 'closed', 'archived')),
  current_version_id uuid,
  anonymous          boolean not null default false,
  access             jsonb not null default '{"closesAt": null, "quota": null, "onePerBrowser": false}',
  completed_count    integer not null default 0,
  closed_reason      text check (closed_reason in ('manual', 'close_date', 'quota')),
  closed_at          timestamptz,
  created_by         uuid not null references users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
create index surveys_org_list on surveys (org_id, updated_at desc) where deleted_at is null;

create table survey_versions (
  id             uuid primary key,
  org_id         uuid not null,
  survey_id      uuid not null references surveys(id) on delete cascade,
  version_number integer not null,
  status         text not null check (status in ('draft', 'published')),
  definition     jsonb not null,
  translations   jsonb not null default '{}',
  revision       integer not null default 0,
  created_by     uuid not null references users(id),
  updated_by     uuid references users(id),
  published_by   uuid references users(id),
  published_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (survey_id, version_number)
);
create unique index survey_versions_one_draft on survey_versions (survey_id) where status = 'draft';
alter table surveys add constraint surveys_current_version_fk
  foreign key (current_version_id) references survey_versions(id);

-- Published versions are immutable: enforced here, not trusted to application code.
create function survey_versions_immutable() returns trigger language plpgsql as $$
begin
  if old.status = 'published' and (
       new.definition is distinct from old.definition
    or new.status <> 'published'
    or new.version_number <> old.version_number
    or new.survey_id <> old.survey_id) then
    raise exception 'published survey versions are immutable (version %)', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger survey_versions_immutable before update on survey_versions
  for each row execute function survey_versions_immutable();

create table survey_collaborators (
  org_id     uuid not null,
  survey_id  uuid not null references surveys(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  role       text not null check (role in ('owner', 'editor', 'viewer')),
  added_by   uuid references users(id),
  created_at timestamptz not null default now(),
  primary key (survey_id, user_id)
);
create unique index survey_one_owner on survey_collaborators (survey_id) where role = 'owner';
create index survey_collaborators_user on survey_collaborators (org_id, user_id);

-- ── Distribution ─────────────────────────────────────────────────────
create table distributions (
  id                   uuid primary key,
  org_id               uuid not null,
  survey_id            uuid not null references surveys(id) on delete cascade,
  channel              text not null check (channel in ('link', 'embed', 'email')),
  name                 text not null,
  token                text not null unique,
  is_default           boolean not null default false,
  preset_hidden_fields jsonb not null default '{}',
  config               jsonb not null default '{}',
  created_by           uuid not null references users(id),
  created_at           timestamptz not null default now(),
  disabled_at          timestamptz
);
create unique index distributions_one_default on distributions (survey_id) where is_default;

-- ── Responses ────────────────────────────────────────────────────────
create table responses (
  id                 uuid primary key,
  org_id             uuid not null,
  survey_id          uuid not null references surveys(id) on delete cascade,
  version_id         uuid not null references survey_versions(id),
  distribution_id    uuid references distributions(id) on delete set null,
  response_key_hash  bytea not null,
  status             text not null check (status in ('in_progress', 'completed', 'disqualified')),
  is_test            boolean not null default false,
  seq                integer not null default 0,
  current_page_key   text,
  furthest_page_key  text,
  last_question_key  text,
  locale             text not null,
  hidden_fields      jsonb not null default '{}',
  device_type        text check (device_type in ('mobile', 'tablet', 'desktop')),
  quality_flags      text[] not null default '{}',
  started_at         timestamptz not null,
  last_activity_at   timestamptz not null,
  completed_at       timestamptz,
  duration_ms        integer,
  -- Set exactly once when the response's answers are added to question_counts (idempotent jobs).
  aggregated_at      timestamptz,
  recipient_id       uuid,
  respondent_user_id uuid,
  country            text,
  unique (survey_id, response_key_hash)
);
create index responses_survey_status on responses (survey_id, status, completed_at);
create index responses_survey_started on responses (survey_id, started_at);

-- Anonymous surveys never link a response to a person (data model §2.7).
create function responses_anonymous_guard() returns trigger language plpgsql as $$
begin
  if (new.recipient_id is not null or new.respondent_user_id is not null or new.country is not null)
     and exists (select 1 from surveys s where s.id = new.survey_id and s.anonymous) then
    raise exception 'anonymous survey responses cannot store identifying data'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger responses_anonymous_guard before insert or update on responses
  for each row execute function responses_anonymous_guard();

create table answers (
  org_id        uuid not null,
  survey_id     uuid not null,
  response_id   uuid not null references responses(id) on delete cascade,
  question_key  text not null,
  sub_key       text not null default '',
  value_text    text,
  value_number  numeric,
  value_choices text[],
  value_date    date,
  value_json    jsonb,
  other_text    text,
  updated_at    timestamptz not null default now(),
  primary key (survey_id, response_id, question_key, sub_key)
);
create index answers_by_question on answers (survey_id, question_key, sub_key)
  include (response_id, value_choices, value_number);
create index answers_by_response on answers (response_id);

-- ── Analytics pre-aggregation ────────────────────────────────────────
create table question_counts (
  org_id       uuid not null,
  survey_id    uuid not null references surveys(id) on delete cascade,
  version_id   uuid not null,
  question_key text not null,
  sub_key      text not null default '',
  bucket       text not null,
  count        integer not null default 0,
  primary key (survey_id, version_id, question_key, sub_key, bucket)
);

-- ── Audit ────────────────────────────────────────────────────────────
create table audit_logs (
  id          bigint generated always as identity primary key,
  org_id      uuid,
  actor_type  text not null check (actor_type in ('user', 'api_key', 'system')),
  actor_id    uuid,
  action      text not null,
  entity_type text,
  entity_id   uuid,
  metadata    jsonb not null default '{}',
  ip          inet,
  created_at  timestamptz not null default now()
);
create index audit_logs_org_time on audit_logs (org_id, created_at desc);

-- ── Row-level security ───────────────────────────────────────────────
alter table organizations enable row level security;
alter table organizations force row level security;
create policy tenant_isolation on organizations
  using (id = app_org_id()) with check (id = app_org_id());

do $$
declare t text;
begin
  foreach t in array array[
    'memberships', 'invitations', 'surveys', 'survey_versions', 'survey_collaborators',
    'distributions', 'responses', 'answers', 'question_counts', 'audit_logs'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = app_org_id()) with check (org_id = app_org_id())', t);
  end loop;
end $$;

-- ── Narrow cross-tenant functions (the only sanctioned RLS bypasses) ─
-- Public respondent routes: public_id → tenant.
create function resolve_public_survey(p_public_id text)
returns table (org_id uuid, survey_id uuid)
language sql stable security definer set search_path = public as $$
  select s.org_id, s.id from surveys s where s.public_id = p_public_id and s.deleted_at is null
$$;

-- Session bootstrap: the orgs a user belongs to (for login and the org switcher).
create function user_memberships(p_user_id uuid)
returns table (org_id uuid, org_name text, org_slug text, role text)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, o.slug::text, m.role
  from memberships m join organizations o on o.id = m.org_id
  where m.user_id = p_user_id and o.status = 'active'
  order by o.name
$$;

-- Invitation acceptance: look up an invitation by token hash before the user is a member.
create function invitation_by_token(p_token_hash bytea)
returns table (id uuid, org_id uuid, org_name text, email text, role text,
               expires_at timestamptz, accepted_at timestamptz, revoked_at timestamptz)
language sql stable security definer set search_path = public as $$
  select i.id, i.org_id, o.name, i.email::text, i.role, i.expires_at, i.accepted_at, i.revoked_at
  from invitations i join organizations o on o.id = i.org_id
  where i.token_hash = p_token_hash
$$;

-- Worker: close surveys whose close date has passed. Returns what it closed.
create function close_expired_surveys()
returns table (org_id uuid, survey_id uuid)
language sql volatile security definer set search_path = public as $$
  update surveys s
     set status = 'closed', closed_reason = 'close_date', closed_at = now(), updated_at = now()
   where s.status = 'live'
     and s.deleted_at is null
     and s.access->>'closesAt' is not null
     and (s.access->>'closesAt')::timestamptz <= now()
  returning s.org_id, s.id
$$;

-- Worker: surveys with completed responses since a timestamp (nightly aggregate repair).
create function surveys_with_activity_since(p_since timestamptz)
returns table (org_id uuid, survey_id uuid)
language sql stable security definer set search_path = public as $$
  select distinct r.org_id, r.survey_id from responses r where r.completed_at >= p_since
$$;

revoke all on function resolve_public_survey(text), user_memberships(uuid), invitation_by_token(bytea),
  close_expired_surveys(), surveys_with_activity_since(timestamptz) from public;
grant execute on function resolve_public_survey(text), user_memberships(uuid), invitation_by_token(bytea),
  close_expired_surveys(), surveys_with_activity_since(timestamptz), app_org_id() to survey_app;

-- ── Grants for the application role ──────────────────────────────────
grant usage on schema public to survey_app;
grant select, insert, update, delete on
  organizations, users, memberships, invitations, sessions, auth_tokens, surveys, survey_versions,
  survey_collaborators, distributions, responses, answers, question_counts
  to survey_app;
-- Audit log is append-only for the application.
grant select, insert on audit_logs to survey_app;
grant usage on all sequences in schema public to survey_app;
