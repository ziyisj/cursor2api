#!/bin/sh
# One-step start. Usage: bash deploy.sh [local|public]
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required."
  exit 1
fi
exec node scripts/deploy.mjs "$@"
