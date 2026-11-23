-- Phase 2B: contacts and email campaigns, response tags and notes, full-text search, exports and
-- scheduled reports.

-- ── Contacts ─────────────────────────────────────────────────────────────
create table contacts (
  id              uuid primary key,
  org_id          uuid not null references organizations(id) on delete cascade,
  email           citext not null,
  first_name      text,
  last_name       text,
  attributes      jsonb not null default '{}',
  -- Never emailed again once set (unsubscribe link, hard bounce, spam complaint).
  unsubscribed_at timestamptz,
  bounced_at      timestamptz,
  complained_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, email)
);
create index contacts_org_created on contacts (org_id, created_at desc);

create table contact_lists (
  id         uuid primary key,
  org_id     uuid not null references organizations(id) on delete cascade,
  name       text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create unique index contact_lists_name on contact_lists (org_id, lower(name));

create table contact_list_members (
  org_id     uuid not null,
  list_id    uuid not null references contact_lists(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  added_at   timestamptz not null default now(),
  primary key (list_id, contact_id)
);
create index contact_list_members_contact on contact_list_members (contact_id);

create table contact_imports (
  id               uuid primary key,
  org_id           uuid not null references organizations(id) on delete cascade,
  list_id          uuid references contact_lists(id) on delete set null,
  storage_key      text not null,
  filename         text not null,
  column_mapping   jsonb not null,
  status           text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  total            integer not null default 0,
  created          integer not null default 0,
  updated          integer not null default 0,
  skipped          integer not null default 0,
  -- The first errors, for the UI. The full list is in the error report file.
  errors           jsonb not null default '[]',
  error_report_key text,
  failure          text,
  created_by       uuid references users(id),
  created_at       timestamptz not null default now(),
  finished_at      timestamptz
);
create index contact_imports_org on contact_imports (org_id, created_at desc);

-- Addresses that must never be emailed, for every org: hard bounces and spam complaints reported by SES.
create table email_suppressions (
  email      citext primary key,
  reason     text not null check (reason in ('bounce', 'complaint')),
  detail     text,
  created_at timestamptz not null default now()
);

-- ── Campaigns ────────────────────────────────────────────────────────────
create table campaigns (
  id                  uuid primary key,
  org_id              uuid not null references organizations(id) on delete cascade,
  survey_id           uuid not null references surveys(id) on delete cascade,
  distribution_id     uuid references distributions(id) on delete set null,
  list_id             uuid references contact_lists(id) on delete set null,
  name                text not null,
  subject             text not null,
  body                text not null,
  status              text not null default 'draft'
                        check (status in ('draft', 'scheduled', 'sending', 'sent', 'cancelled')),
  scheduled_at        timestamptz,
  timezone            text not null default 'UTC',
  reminder_after_days integer check (reminder_after_days between 1 and 60),
  reminder_max        integer not null default 0 check (reminder_max between 0 and 5),
  started_at          timestamptz,
  finished_at         timestamptz,
  created_by          uuid references users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index campaigns_survey on campaigns (survey_id, created_at desc);

create table recipients (
  id             uuid primary key,
  org_id         uuid not null,
  campaign_id    uuid not null references campaigns(id) on delete cascade,
  contact_id     uuid not null references contacts(id) on delete cascade,
  -- sha256 of the personal link token. The token itself is derived (HMAC of the recipient id), never stored.
  token_hash     bytea not null unique,
  status         text not null default 'pending'
                   check (status in ('pending', 'sent', 'failed', 'suppressed', 'bounced', 'responded')),
  sent_at        timestamptz,
  last_sent_at   timestamptz,
  reminders_sent integer not null default 0,
  -- Hour precision for anonymous surveys, so it can't be matched with a response's time.
  responded_at   timestamptz,
  error          text,
  unique (campaign_id, contact_id)
);
create index recipients_reminders on recipients (campaign_id, last_sent_at) where status = 'sent';

-- One response per recipient. Anonymous surveys never set responses.recipient_id (trigger from 0001).
create unique index responses_one_per_recipient on responses (recipient_id) where recipient_id is not null;

-- ── Response tags and notes ──────────────────────────────────────────────
create table tags (
  id         uuid primary key,
  org_id     uuid not null,
  survey_id  uuid not null references surveys(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);
create unique index tags_survey_name on tags (survey_id, lower(name));

create table response_tags (
  org_id      uuid not null,
  response_id uuid not null references responses(id) on delete cascade,
  tag_id      uuid not null references tags(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (response_id, tag_id)
);
create index response_tags_tag on response_tags (tag_id);

create table response_notes (
  id          uuid primary key,
  org_id      uuid not null,
  response_id uuid not null references responses(id) on delete cascade,
  author_id   uuid references users(id) on delete set null,
  body        text not null,
  created_at  timestamptz not null default now()
);
create index response_notes_response on response_notes (response_id, created_at);

-- Full-text search over open answers (and "Other" text). The query must use the same expression.
create index answers_fulltext on answers
  using gin (to_tsvector('simple', coalesce(value_text, '') || ' ' || coalesce(other_text, '')))
  where value_text is not null or other_text is not null;

-- ── Exports and scheduled reports ────────────────────────────────────────
create table exports (
  id           uuid primary key,
  org_id       uuid not null references organizations(id) on delete cascade,
  survey_id    uuid not null references surveys(id) on delete cascade,
  requested_by uuid references users(id) on delete set null,
  format       text not null check (format in ('csv', 'xlsx', 'pdf')),
  options      jsonb not null default '{}',
  status       text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  storage_key  text,
  filename     text,
  size         integer,
  row_count    integer,
  failure      text,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz,
  expires_at   timestamptz
);
create index exports_survey on exports (survey_id, created_at desc);
create index exports_expiry on exports (expires_at) where storage_key is not null;

create table scheduled_reports (
  id              uuid primary key,
  org_id          uuid not null references organizations(id) on delete cascade,
  survey_id       uuid not null references surveys(id) on delete cascade,
  name            text not null,
  frequency       text not null check (frequency in ('daily', 'weekly', 'monthly')),
  -- weekly: 1 (Monday) to 7; monthly: 1 to 28.
  day             integer,
  hour            integer not null check (hour between 0 and 23),
  timezone        text not null,
  format          text not null check (format in ('csv', 'xlsx', 'pdf')),
  options         jsonb not null default '{}',
  -- Org members only: reports go to people who could open the survey themselves.
  recipient_ids   uuid[] not null,
  active          boolean not null default true,
  next_run_at     timestamptz not null,
  last_run_at     timestamptz,
  last_status     text,
  created_by      uuid references users(id),
  created_at      timestamptz not null default now()
);
create index scheduled_reports_due on scheduled_reports (next_run_at) where active;

-- ── Row-level security ───────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'contacts', 'contact_lists', 'contact_list_members', 'contact_imports', 'campaigns', 'recipients',
    'tags', 'response_tags', 'response_notes', 'exports', 'scheduled_reports'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = app_org_id()) with check (org_id = app_org_id())', t);
  end loop;
end $$;

-- ── Narrow cross-tenant functions ────────────────────────────────────────

-- A respondent opens a personal link: which org, survey and recipient is it? Nothing else is revealed.
create function resolve_recipient(p_token_hash bytea)
returns table (org_id uuid, survey_id uuid, recipient_id uuid, contact_id uuid)
language sql stable security definer set search_path = public as $$
  select r.org_id, c.survey_id, r.id, r.contact_id
    from recipients r join campaigns c on c.id = r.campaign_id
   where r.token_hash = p_token_hash
$$;

-- SES reports a hard bounce or a complaint: suppress the address everywhere and flag matching contacts.
create function record_email_suppression(p_email text, p_reason text, p_detail text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into email_suppressions (email, reason, detail) values (p_email, p_reason, p_detail)
    on conflict (email) do nothing;
  if p_reason = 'bounce' then
    update contacts set bounced_at = coalesce(bounced_at, now()), updated_at = now() where email = p_email::citext;
    update recipients r set status = 'bounced'
      from contacts c where c.id = r.contact_id and c.email = p_email::citext and r.status in ('pending', 'sent');
  else
    update contacts set complained_at = coalesce(complained_at, now()),
                        unsubscribed_at = coalesce(unsubscribed_at, now()), updated_at = now()
     where email = p_email::citext;
  end if;
end $$;

-- Scheduled work across orgs (the worker then switches into each org's tenant context).
create function due_scheduled_reports(p_now timestamptz)
returns table (org_id uuid, report_id uuid)
language sql stable security definer set search_path = public as $$
  select org_id, id from scheduled_reports where active and next_run_at <= p_now order by next_run_at limit 100
$$;

create function campaigns_needing_reminders()
returns table (org_id uuid, campaign_id uuid)
language sql stable security definer set search_path = public as $$
  select c.org_id, c.id from campaigns c
   where c.status = 'sent' and c.reminder_max > 0 and c.reminder_after_days is not null
     and exists (
       select 1 from recipients r
        where r.campaign_id = c.id and r.status = 'sent' and r.reminders_sent < c.reminder_max
          and r.last_sent_at <= now() - make_interval(days => c.reminder_after_days))
$$;

create function expired_exports(p_now timestamptz)
returns table (org_id uuid, export_id uuid, storage_key text)
language sql stable security definer set search_path = public as $$
  select org_id, id, storage_key from exports where storage_key is not null and expires_at <= p_now limit 500
$$;

revoke all on function resolve_recipient(bytea), record_email_suppression(text, text, text),
  due_scheduled_reports(timestamptz), campaigns_needing_reminders(), expired_exports(timestamptz) from public;
grant execute on function resolve_recipient(bytea), record_email_suppression(text, text, text),
  due_scheduled_reports(timestamptz), campaigns_needing_reminders(), expired_exports(timestamptz) to survey_app;

grant select, insert, update, delete on contacts, contact_lists, contact_list_members, contact_imports, campaigns,
  recipients, tags, response_tags, response_notes, exports, scheduled_reports to survey_app;
grant select on email_suppressions to survey_app;
