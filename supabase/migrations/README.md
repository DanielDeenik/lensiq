# Migrations

Applied to project `hvitxwhfdhsdwhgllaqf` with the Supabase MCP `apply_migration` tool,
or with `supabase db push` if you have the CLI linked. They are idempotent: every
statement is `if not exists` or `create or replace`, so re-running is safe.

Order matters. 001 defines `touch_updated_at`, which 003 depends on.
