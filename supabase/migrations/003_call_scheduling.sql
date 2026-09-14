-- A recruiter picks a slot, it is held, and nothing reaches Dan's calendar
-- until he confirms it in the console. Same approval shape as the CV pack.
create table if not exists public.call_requests (
  id                bigint generated always as identity primary key,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  application_id    bigint references public.applications(id) on delete set null,
  requester_name    text,
  requester_email   text not null,
  company           text,
  role_title        text,
  note              text,
  slot_start        timestamptz not null,
  slot_end          timestamptz not null,
  duration_minutes  int not null,
  timezone          text not null,
  status            text not null default 'held',
  calendar_event_id text,
  meet_link         text,
  confirmed_at      timestamptz,
  declined_reason   text,
  ip_hash           text,
  error_detail      text
);

create index if not exists call_requests_status_idx on public.call_requests (status, slot_start);
create unique index if not exists call_requests_live_slot_idx
  on public.call_requests (slot_start)
  where status in ('held', 'confirmed');

-- Dan's real busy blocks, written by the agent from Google Calendar so the
-- public slot grid never offers a time he is already committed to.
create table if not exists public.calendar_busy (
  id         bigint generated always as identity primary key,
  start_at   timestamptz not null,
  end_at     timestamptz not null,
  source     text not null default 'google',
  synced_at  timestamptz not null default now()
);

create index if not exists calendar_busy_window_idx on public.calendar_busy (start_at, end_at);

alter table public.call_requests enable row level security;
alter table public.calendar_busy enable row level security;

drop trigger if exists call_requests_touch on public.call_requests;
create trigger call_requests_touch before update on public.call_requests
  for each row execute function public.touch_updated_at();
