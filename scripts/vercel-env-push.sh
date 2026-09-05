#!/usr/bin/env bash
#
# Push .env.local into a linked Vercel project.
#
# Values are piped to `vercel env add` on stdin — they are never passed as
# command arguments (which land in shell history and `ps` output) and never
# echoed. The script prints variable NAMES and whether each was set, nothing
# more.
#
#   ./scripts/vercel-env-push.sh production https://leakproof.vercel.app
#
set -euo pipefail

TARGET="${1:-production}"
APP_URL="${2:-}"

if [ ! -f .env.local ]; then echo "no .env.local here" >&2; exit 1; fi
if ! vercel whoami >/dev/null 2>&1; then
  echo "not logged in — run: vercel login" >&2; exit 1
fi
if [ ! -f .vercel/project.json ]; then
  echo "project not linked — run: vercel link" >&2; exit 1
fi

# Local-only or unset: pushing these would be wrong or pointless.
#   NEXT_PUBLIC_APP_URL is set separately, to the live origin.
#   UPSTASH_*/WHATSAPP_* are empty; the code treats absent and empty alike and
#   an empty var reads as "configured" to a human scanning the dashboard.
SKIP="NEXT_PUBLIC_APP_URL|UPSTASH_REDIS_REST_URL|UPSTASH_REDIS_REST_TOKEN|WHATSAPP_TOKEN|WHATSAPP_PHONE_NUMBER_ID"

pushed=0; skipped=0
while IFS= read -r line; do
  case "$line" in ''|\#*) continue ;; esac
  key="${line%%=*}"
  val="${line#*=}"
  val="${val%\"}"; val="${val#\"}"
  case "$key" in
    *[!A-Z_]*) continue ;;
  esac
  if [ -z "$val" ]; then
    printf '  %-28s skipped (empty locally)\n' "$key"; skipped=$((skipped+1)); continue
  fi
  if printf '%s' "$key" | grep -qE "^($SKIP)$"; then
    printf '  %-28s skipped (handled separately)\n' "$key"; skipped=$((skipped+1)); continue
  fi
  vercel env rm "$key" "$TARGET" --yes >/dev/null 2>&1 || true
  printf '%s' "$val" | vercel env add "$key" "$TARGET" >/dev/null 2>&1
  printf '  %-28s pushed\n' "$key"; pushed=$((pushed+1))
done < .env.local

if [ -n "$APP_URL" ]; then
  vercel env rm NEXT_PUBLIC_APP_URL "$TARGET" --yes >/dev/null 2>&1 || true
  printf '%s' "$APP_URL" | vercel env add NEXT_PUBLIC_APP_URL "$TARGET" >/dev/null 2>&1
  printf '  %-28s pushed (%s)\n' "NEXT_PUBLIC_APP_URL" "$APP_URL"
  pushed=$((pushed+1))
else
  echo
  echo "NEXT_PUBLIC_APP_URL not set: pass the live origin as the second argument." >&2
  echo "Payment links build their callback from it; left at localhost they break." >&2
fi

echo
echo "$pushed pushed, $skipped skipped, target=$TARGET"
