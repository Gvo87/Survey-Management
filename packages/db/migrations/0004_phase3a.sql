-- Phase 3A: collaboration (folders, teams, comments on drafts, approvals, notifications) and the platform
-- API (API keys, idempotency keys, outgoing webhooks, integrations).

-- ── Folders ──────────────────────────────────────────────────────────────
-- At most three levels. The API checks depth and cycles while holding a lock on the org's folders.
create table folders (
  id         uuid primary key,
  org_id     uuid not null references organizations(id) on delete cascade,
  parent_id  uuid references folders(id) on delete cascade,
  name       text not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index folders_name on folders
  (org_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create index folders_parent on folders (parent_id);

alter table surveys add column folder_id uuid references folders(id) on delete set null;
create index surveys_folder on surveys (folder_id) where folder_id is not null;

-- ── Teams ────────────────────────────────────────────────────────────────
create table teams (
  id         uuid primary key,
  org_id     uuid not null references organizations(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);
create unique index teams_name on teams (org_id, lower(name));

create table team_members (
  org_id   uuid not null,
  team_id  uuid not null references teams(id) on delete cascade,
  user_id  uuid not null references users(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index team_members_user on team_members (org_id, user_id);

-- A survey shared with a team. Each member's role is still capped by their org role (analysts: viewer).
create table survey_team_collaborators (
  org_id     uuid not null,
  survey_id  uuid not null references surveys(id) on delete cascade,
  team_id    uuid not null references teams(id) on delete cascade,
  role       text not null check (role in ('editor', 'viewer')),
  added_by   uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (survey_id, team_id)
);
create index survey_team_collaborators_team on survey_team_collaborators (team_id);

-- ── Comments on drafts ───────────────────────────────────────────────────
-- Stored apart from the survey definition, so respondents can never receive them.
create table comments (
  id          uuid primary key,
  org_id      uuid not null,
  survey_id   uuid not null references surveys(id) on delete cascade,
  -- A question or page key; null means the survey as a whole.
  anchor_key  text,
  -- Replies point at the first comment of their thread (one level).
  parent_id   uuid references comments(id) on delete cascade,
  author_id   uuid references users(id) on delete set null,
  body        text not null,
  resolved_at timestamptz,
  resolved_by uuid references users(id) on delete set null,
  edited_at   timestamptz,
  created_at  timestamptz not null default now()
);
create index comments_survey on comments (survey_id, created_at);

-- ── Approval before publishing ───────────────────────────────────────────
create table approval_requests (
  id            uuid primary key,
  org_id        uuid not null,
  survey_id     uuid not null references surveys(id) on delete cascade,
  -- The draft and revision that were reviewed. Approving publishes exactly this revision.
  version_id    uuid references survey_versions(id) on delete set null,
  revision      integer not null,
  status        text not null default 'pending'
                  check (status in ('pending', 'approved', 'rejected', 'superseded', 'cancelled')),
  requested_by  uuid not null references users(id),
  request_note  text,
  decided_by    uuid references users(id),
  decision_note text,
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);
create unique index approval_requests_one_pending on approval_requests (survey_id) where status = 'pending';
create index approval_requests_org on approval_requests (org_id, status, created_at desc);

-- ── Notifications ────────────────────────────────────────────────────────
create table notification_rules (
  id         uuid primary key,
  org_id     uuid not null,
  survey_id  uuid not null references surveys(id) on delete cascade,
  kind       text not null check (kind in ('new_response', 'nps_detractor', 'threshold', 'closing')),
  config     jsonb not null default '{}',
  channels   text[] not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index notification_rules_survey on notification_rules (survey_id);

-- A rule fires at most once per event, even when the job that evaluates it is retried.
create table notification_firings (
  org_id     uuid not null,
  rule_id    uuid not null references notification_rules(id) on delete cascade,
  event_id   text not null,
  created_at timestamptz not null default now(),
  primary key (rule_id, event_id)
);

create table notification_preferences (
  org_id     uuid not null,
  user_id    uuid not null references users(id) on delete cascade,
  -- kind → the channels this user accepts. A kind that's absent accepts every channel.
  channels   jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table notifications (
  id         uuid primary key,
  org_id     uuid not null,
  user_id    uuid not null references users(id) on delete cascade,
  kind       text not null,
  title      text not null,
  body       text not null default '',
  link       text,
  survey_id  uuid references surveys(id) on delete cascade,
  in_app     boolean not null default true,
  email      boolean not null default false,
  emailed_at timestamptz,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_inbox on notifications (user_id, org_id, created_at desc) where in_app;

-- ── Public API: keys and idempotency ─────────────────────────────────────
create table api_keys (
  id           uuid primary key,
  org_id       uuid not null references organizations(id) on delete cascade,
  name         text not null,
  -- The first characters, so people can recognise a key. Only a hash of the whole key is stored.
  prefix       text not null,
  key_hash     bytea not null unique,
  scopes       text[] not null,
  created_by   uuid not null references users(id),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index api_keys_org on api_keys (org_id, created_at desc);

-- Replays of a POST with the same Idempotency-Key get the first response. Kept for 24 hours.
create table idempotency_keys (
  org_id       uuid not null,
  -- The caller (API key or user) and the header value, so callers can't collide.
  key          text not null,
  request_hash bytea not null,
  status       text not null default 'processing' check (status in ('processing', 'done')),
  status_code  integer,
  content_type text,
  response     text,
  created_at   timestamptz not null default now(),
  primary key (org_id, key)
);
create index idempotency_keys_age on idempotency_keys (created_at);

-- ── Outgoing webhooks ────────────────────────────────────────────────────
create table webhooks (
  id                         uuid primary key,
  org_id                     uuid not null references organizations(id) on delete cascade,
  url                        text not null,
  description                text,
  events                     text[] not null,
  -- null: every survey in the org.
  survey_ids                 uuid[],
  -- AES-256-GCM with the data encryption key: the secret is needed to sign, so it can't be a hash.
  secret_enc                 text not null,
  -- After a rotation the old secret also signs for 24 hours.
  previous_secret_enc        text,
  previous_secret_expires_at timestamptz,
  active                     boolean not null default true,
  -- Events that failed every attempt in a row. 50 disables the endpoint.
  consecutive_failures       integer not null default 0,
  disabled_reason            text,
  created_by                 uuid references users(id) on delete set null,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);
create index webhooks_org on webhooks (org_id) where active;

create table webhook_deliveries (
  id               uuid primary key,
  org_id           uuid not null,
  webhook_id       uuid not null references webhooks(id) on delete cascade,
  -- Stable across retries and redeliveries, so receivers can drop duplicates.
  event_id         text not null,
  event_type       text not null,
  payload          jsonb not null,
  status           text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
  attempts         integer not null default 0,
  last_http_status integer,
  next_attempt_at  timestamptz,
  created_at       timestamptz not null default now(),
  finished_at      timestamptz,
  unique (webhook_id, event_id)
);
create index webhook_deliveries_list on webhook_deliveries (webhook_id, created_at desc);
create index webhook_deliveries_age on webhook_deliveries (created_at);

create table webhook_attempts (
  id               bigint generated always as identity primary key,
  org_id           uuid not null,
  delivery_id      uuid not null references webhook_deliveries(id) on delete cascade,
  attempt          integer not null,
  manual           boolean not null default false,
  http_status      integer,
  error            text,
  duration_ms      integer not null,
  response_snippet text,
  created_at       timestamptz not null default now()
);
create index webhook_attempts_delivery on webhook_attempts (delivery_id, attempt);

-- ── Integrations ─────────────────────────────────────────────────────────
create table integrations (
  org_id     uuid not null references organizations(id) on delete cascade,
  kind       text not null check (kind in ('slack', 'hubspot', 'google_sheets')),
  -- Encrypted JSON (webhook URLs and tokens are secrets).
  config_enc text not null,
  -- Non-secret details for the UI.
  summary    jsonb not null default '{}',
  status     text not null default 'connected' check (status in ('connected', 'error')),
  last_error text,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (org_id, kind)
);

-- ── Row-level security ───────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'folders', 'teams', 'team_members', 'survey_team_collaborators', 'comments', 'approval_requests',
    'notification_rules', 'notification_firings', 'notification_preferences', 'notifications', 'api_keys',
    'idempotency_keys', 'webhooks', 'webhook_deliveries', 'webhook_attempts', 'integrations'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = app_org_id()) with check (org_id = app_org_id())', t);
  end loop;
end $$;

-- ── Narrow cross-tenant functions ────────────────────────────────────────

-- A request carries `Authorization: Bearer sk_…`: which org and key is it? The key only works while the
-- org is active and the admin who created it is still an admin there.
create function api_key_by_hash(p_key_hash bytea)
returns table (id uuid, org_id uuid, name text, scopes text[], created_by uuid, expires_at timestamptz,
               revoked_at timestamptz, last_used_at timestamptz, creator_is_admin boolean)
language sql stable security definer set search_path = public as $$
  select k.id, k.org_id, k.name, k.scopes, k.created_by, k.expires_at, k.revoked_at, k.last_used_at,
         exists (select 1 from memberships m
                  where m.org_id = k.org_id and m.user_id = k.created_by and m.role = 'org_admin')
    from api_keys k join organizations o on o.id = k.org_id
   where k.key_hash = p_key_hash and o.status = 'active'
$$;

-- Daily housekeeping across orgs: idempotency records expire after 24 hours, finished webhook deliveries
-- (which can hold answers) after 30 days.
create function purge_platform_records(p_now timestamptz)
returns void language sql volatile security definer set search_path = public as $$
  delete from idempotency_keys where created_at < p_now - interval '24 hours';
  delete from webhook_deliveries where created_at < p_now - interval '30 days' and status <> 'pending';
$$;

revoke all on function api_key_by_hash(bytea), purge_platform_records(timestamptz) from public;
grant execute on function api_key_by_hash(bytea), purge_platform_records(timestamptz) to survey_app;

grant select, insert, update, delete on folders, teams, team_members, survey_team_collaborators, comments,
  approval_requests, notification_rules, notification_firings, notification_preferences, notifications, api_keys,
  idempotency_keys, webhooks, webhook_deliveries, webhook_attempts, integrations to survey_app;
grant usage on all sequences in schema public to survey_app;
