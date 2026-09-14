-- A watchlist row comes from a named firm's own public ATS rather than an
-- aggregator, and is ranked ahead of higher scoring aggregator rows.
alter table public.role_signals add column if not exists watchlist boolean not null default false;
create index if not exists role_signals_watchlist_idx on public.role_signals (watchlist, score desc, last_seen desc);
