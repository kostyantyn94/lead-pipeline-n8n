#!/usr/bin/env bash
# One-command setup on Linux/macOS: start the stack, create the n8n Postgres credential, import and activate the workflows.
# Usage: bash scripts/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { cp .env.example .env; echo "created .env from .env.example"; }

# read .env for the credential file (compose reads it on its own)
PG_USER=$(grep -E '^PG_USER=' .env | cut -d= -f2- || true);      PG_USER=${PG_USER:-n8n}
PG_PASSWORD=$(grep -E '^PG_PASSWORD=' .env | cut -d= -f2- || true); PG_PASSWORD=${PG_PASSWORD:-n8npass}
PG_DB=$(grep -E '^PG_DB=' .env | cut -d= -f2- || true);          PG_DB=${PG_DB:-leads}

echo "starting containers..."
docker compose up -d --wait

# the credential file is generated from .env and never committed (.gitignore)
sed -e "s/__PG_USER__/${PG_USER}/" -e "s/__PG_PASSWORD__/${PG_PASSWORD}/" -e "s/__PG_DB__/${PG_DB}/" \
  n8n/credentials/postgres.template.json > n8n/credentials/postgres.generated.json

echo "importing credential and workflows..."
docker compose exec -T n8n n8n import:credentials --input=/import/credentials/postgres.generated.json
docker compose exec -T n8n n8n import:workflow --separate --input=/import/workflows

# workflow ids are fixed in n8n/build.js; publishing activates webhooks, schedules and the error trigger
echo "publishing workflows..."
for id in lp01intake000001 lp02qualify00001 lp03crmsync00001 lp04review000001 lp05errors000001 lp06dashboard001; do
  docker compose exec -T n8n n8n publish:workflow --id="$id"
done
docker compose restart n8n
docker compose up -d --wait n8n

cat <<EOF

Ready.
  n8n UI:     http://localhost:5678  (create the owner account on first visit)
  intake:     POST http://localhost:5678/webhook/lead
  dashboard:  http://localhost:5678/webhook/dashboard
  review:     http://localhost:5678/form/review
  demo:       node scripts/send_leads.js samples/leads.csv
EOF
