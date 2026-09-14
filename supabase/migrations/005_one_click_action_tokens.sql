-- One click approval. Each row carries its own token so an email link can act on
-- that row alone, and forwarding the email never hands anyone the console.
alter table public.applications  add column if not exists action_token text;
alter table public.call_requests add column if not exists action_token text;

create or replace function public.ensure_action_token() returns trigger
language plpgsql as $fn$
begin
  if new.action_token is null then
    new.action_token := encode(gen_random_bytes(12), 'hex');
  end if;
  return new;
end;
$fn$;

drop trigger if exists applications_action_token on public.applications;
create trigger applications_action_token before insert on public.applications
  for each row execute function public.ensure_action_token();

drop trigger if exists call_requests_action_token on public.call_requests;
create trigger call_requests_action_token before insert on public.call_requests
  for each row execute function public.ensure_action_token();

update public.applications  set action_token = encode(gen_random_bytes(12), 'hex') where action_token is null;
update public.call_requests set action_token = encode(gen_random_bytes(12), 'hex') where action_token is null;

create index if not exists applications_action_token_idx  on public.applications (action_token);
create index if not exists call_requests_action_token_idx on public.call_requests (action_token);
