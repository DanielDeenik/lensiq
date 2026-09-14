-- A decision link must survive an email client, an autolinker and a copy paste.
-- Query strings do not: an ampersand turned into &amp; silently breaks every
-- parameter after the first, and the reader gets an error instead of a decision.
-- So the whole decision is one opaque path segment.
create table if not exists public.action_links (
  token       text primary key,
  kind        text not null,
  row_id      bigint not null,
  action      text not null,
  label       text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 days',
  used_at     timestamptz
);

create index if not exists action_links_target_idx on public.action_links (kind, row_id, action);
alter table public.action_links enable row level security;

-- Mint or reuse a link for one row and one action. Lowercase hex only, so case
-- folding cannot garble it.
create or replace function public.mint_action_link(p_kind text, p_row_id bigint, p_action text, p_label text default null)
returns text language plpgsql as $fn$
declare
  t text;
begin
  select token into t from public.action_links
   where kind = p_kind and row_id = p_row_id and action = p_action
     and used_at is null and expires_at > now()
   limit 1;
  if t is not null then
    return t;
  end if;
  t := encode(gen_random_bytes(11), 'hex');
  insert into public.action_links (token, kind, row_id, action, label)
  values (t, p_kind, p_row_id, p_action, p_label);
  return t;
end;
$fn$;
