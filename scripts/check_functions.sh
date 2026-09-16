#!/usr/bin/env bash
# Parse every edge function before it goes near the deploy tool. A syntax error
# in the site function takes the whole site down, so this is not optional and it
# is not a hand rolled scanner: esbuild parses it the way Deno will.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v npx >/dev/null || { echo "npx is required"; exit 1; }
fail=0
for dir in supabase/functions/*/; do
  name="$(basename "$dir")"
  if npx --yes esbuild@0.23.1 "$dir/index.ts" --format=esm --outfile=/dev/null >/dev/null 2>&1; then
    printf 'PASS  %s parses\n' "$name"
  else
    printf 'FAIL  %s\n' "$name"
    npx --yes esbuild@0.23.1 "$dir/index.ts" --format=esm --outfile=/dev/null 2>&1 | head -12
    fail=1
  fi
done
exit "$fail"
