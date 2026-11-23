-- Phase 2A: themes, templates, question bank, file uploads, response quality.

-- ── Themes (presentation is not versioned: editing a theme restyles live surveys) ──
create table themes (
  id           uuid primary key,
  org_id       uuid not null references organizations(id) on delete cascade,
  name         text not null,
  tokens       jsonb not null,
  logo_file_id uuid,
  is_default   boolean not null default false,
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index themes_one_default on themes (org_id) where is_default;

alter table surveys
  add column theme_id uuid references themes(id) on delete set null,
  add column is_template boolean not null default false,
  add column template_description text;
create index surveys_templates on surveys (org_id) where is_template and deleted_at is null;

-- ── Global templates: platform content managed by super admins, readable by every org ──
create table global_templates (
  id          uuid primary key,
  name        text not null,
  description text not null default '',
  category    text not null default 'general',
  definition  jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── Question bank ──
create table question_bank_items (
  id         uuid primary key,
  org_id     uuid not null references organizations(id) on delete cascade,
  question   jsonb not null,
  tags       text[] not null default '{}',
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index question_bank_org on question_bank_items (org_id, created_at desc);

-- ── Files (respondent uploads and theme logos) ──
create table files (
  id           uuid primary key,
  org_id       uuid not null references organizations(id) on delete cascade,
  purpose      text not null check (purpose in ('response_upload', 'logo')),
  survey_id    uuid references surveys(id) on delete cascade,
  response_id  uuid references responses(id) on delete cascade,
  question_key text,
  storage_key  text not null,
  filename     text not null,
  mime         text not null,
  size         integer not null,
  sha256       bytea not null,
  -- Nothing is downloadable until a scan says it's clean. Infected files are moved to quarantine.
  scan_status  text not null default 'pending' check (scan_status in ('pending', 'clean', 'infected', 'error')),
  scan_detail  text,
  scanned_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index files_response on files (response_id, question_key);
create index files_org on files (org_id, created_at desc);

-- Anonymous surveys never accept uploads (they can identify the respondent).
create function files_anonymous_guard() returns trigger language plpgsql as $$
begin
  if new.survey_id is not null and exists (select 1 from surveys s where s.id = new.survey_id and s.anonymous) then
    raise exception 'anonymous surveys cannot store uploaded files' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger files_anonymous_guard before insert on files for each row execute function files_anonymous_guard();

create index responses_quality on responses using gin (quality_flags) where quality_flags <> '{}';

-- ── Row-level security for the new tenant tables ──
do $$
declare t text;
begin
  foreach t in array array['themes', 'question_bank_items', 'files'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = app_org_id()) with check (org_id = app_org_id())', t);
  end loop;
end $$;

-- Public theme logos are served by id on the respondent origin. This is the only cross-tenant read,
-- and it returns nothing for anything except a clean logo.
create function public_logo(p_file_id uuid)
returns table (storage_key text, mime text, size integer)
language sql stable security definer set search_path = public as $$
  select f.storage_key, f.mime, f.size from files f
   where f.id = p_file_id and f.purpose = 'logo' and f.scan_status = 'clean'
$$;
revoke all on function public_logo(uuid) from public;
grant execute on function public_logo(uuid) to survey_app;

grant select, insert, update, delete on themes, question_bank_items, files, global_templates to survey_app;
