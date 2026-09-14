-- Job spec applications: one row per spec a recruiter pastes.
create table if not exists public.applications (
  id               bigint generated always as identity primary key,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  qa_log_id        bigint references public.qa_log(id) on delete set null,
  source           text not null default 'site',
  recruiter_email  text,
  recruiter_name   text,
  company          text,
  role_title       text,
  spec_text        text not null,
  fit_score        int,
  fit_json         jsonb,
  fit_report_md    text,
  cv_md            text,
  cover_letter_md  text,
  status           text not null default 'new',
  delivery         text not null default 'draft',
  dan_notes        text,
  prepared_at      timestamptz,
  approved_at      timestamptz,
  sent_at          timestamptz,
  gmail_draft_id   text,
  error_detail     text
);

create index if not exists applications_status_idx on public.applications (status, created_at desc);

-- Roles seen in the market, scored with the nexus job feed model.
create table if not exists public.role_signals (
  id            bigint generated always as identity primary key,
  fingerprint   text not null unique,
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  title         text not null,
  company       text,
  link          text,
  jurisdiction  text,
  source_ids    jsonb not null default '[]'::jsonb,
  pub_date      timestamptz,
  score         int not null default 0,
  tier          text not null default 'COLD',
  matches       jsonb,
  snippet       text,
  seen_by_dan   boolean not null default false
);

create index if not exists role_signals_rank_idx on public.role_signals (score desc, last_seen desc);
create index if not exists role_signals_new_idx on public.role_signals (seen_by_dan, first_seen desc);

-- Seasonality, cached from the nexus seasonality engine.
create table if not exists public.seasonality_cache (
  industry    text not null,
  location    text not null,
  data        jsonb not null,
  source      text not null,
  fetched_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  primary key (industry, location)
);

-- Audit trail for every signal refresh and every batch pass.
create table if not exists public.agent_runs (
  id       bigint generated always as identity primary key,
  ran_at   timestamptz not null default now(),
  kind     text not null,
  ok       boolean not null default true,
  items    int not null default 0,
  detail   jsonb
);

create index if not exists agent_runs_kind_idx on public.agent_runs (kind, ran_at desc);

alter table public.applications      enable row level security;
alter table public.role_signals      enable row level security;
alter table public.seasonality_cache enable row level security;
alter table public.agent_runs        enable row level security;

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

drop trigger if exists applications_touch on public.applications;
create trigger applications_touch before update on public.applications
  for each row execute function public.touch_updated_at();
