-- Google Calendar is the booking system. Everything dropped below was a
-- parallel one: a slot grid, holds, expiry, decision tokens and a console to
-- work them. Every user facing failure came from that layer, none from Google.
-- A recruiter now says when suits them in their own words, the agent finds a
-- real free slot and sends a Google invitation Dan accepts or declines.
alter table public.applications add column if not exists call_preference  text;
alter table public.applications add column if not exists call_event_id    text;
alter table public.applications add column if not exists call_proposed_at timestamptz;
alter table public.applications add column if not exists kind             text not null default 'spec';
alter table public.applications alter column spec_text drop not null;

create index if not exists applications_call_pending_idx
  on public.applications (call_proposed_at)
  where call_preference is not null and call_event_id is null;

drop table if exists public.action_links;
drop table if exists public.call_requests;
drop table if exists public.calendar_busy;
drop function if exists public.mint_action_link(text, bigint, text, text);
