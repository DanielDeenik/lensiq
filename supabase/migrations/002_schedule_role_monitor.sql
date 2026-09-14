create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- The role monitor runs in the database so it does not depend on any agent
-- session being alive. The token is read from app_config, never written here.
create or replace function public.refresh_role_signals() returns bigint
language plpgsql security definer set search_path = public, extensions as $fn$
declare
  tok text;
  base text;
  req_id bigint;
begin
  select value into tok from app_config where key = 'console_token';
  select value into base from app_config where key = 'console_base_url';
  if tok is null or base is null then
    insert into agent_runs (kind, ok, items, detail)
      values ('roles_cron', false, 0, jsonb_build_object('error','console_token or console_base_url missing'));
    return null;
  end if;
  select net.http_get(
    url := base || '/api/roles/refresh',
    headers := jsonb_build_object('x-console-token', tok),
    timeout_milliseconds := 60000
  ) into req_id;
  return req_id;
end;
$fn$;

select cron.schedule('lensiq-role-monitor', '0 4,13 * * *', $cron$select public.refresh_role_signals();$cron$);
