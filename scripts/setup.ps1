# One-command setup on Windows: start the stack, create the n8n Postgres credential, import and activate the workflows.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host "created .env from .env.example" }

# read .env for the credential file (compose reads it on its own)
$envMap = @{}
Get-Content .env | Where-Object { $_ -match '^\s*[^#\s][^=]*=' } | ForEach-Object { $k, $v = $_ -split '=', 2; $envMap[$k.Trim()] = $v.Trim() }
$pgUser = if ($envMap['PG_USER']) { $envMap['PG_USER'] } else { 'n8n' }
$pgPass = if ($envMap['PG_PASSWORD']) { $envMap['PG_PASSWORD'] } else { 'n8npass' }
$pgDb   = if ($envMap['PG_DB']) { $envMap['PG_DB'] } else { 'leads' }

Write-Host "starting containers..."
docker compose up -d --wait
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed" }

# the credential file is generated from .env and never committed (.gitignore)
$cred = (Get-Content n8n/credentials/postgres.template.json -Raw).Replace('__PG_USER__', $pgUser).Replace('__PG_PASSWORD__', $pgPass).Replace('__PG_DB__', $pgDb)
# UTF-8 without BOM: Windows PowerShell's -Encoding utf8 adds a BOM, which n8n's JSON import rejects
[System.IO.File]::WriteAllText((Join-Path (Get-Location) 'n8n/credentials/postgres.generated.json'), $cred, (New-Object System.Text.UTF8Encoding $false))

Write-Host "importing credential and workflows..."
docker compose exec -T n8n n8n import:credentials --input=/import/credentials/postgres.generated.json
docker compose exec -T n8n n8n import:workflow --separate --input=/import/workflows

# workflow ids are fixed in n8n/build.js; publishing activates webhooks, schedules and the error trigger
Write-Host "publishing workflows..."
foreach ($id in @('lp01intake000001', 'lp02qualify00001', 'lp03crmsync00001', 'lp04review000001', 'lp05errors000001', 'lp06dashboard001')) {
  docker compose exec -T n8n n8n publish:workflow --id=$id
}
docker compose restart n8n
docker compose up -d --wait n8n

Write-Host ""
Write-Host "Ready."
Write-Host "  n8n UI:     http://localhost:5678  (create the owner account on first visit)"
Write-Host "  intake:     POST http://localhost:5678/webhook/lead"
Write-Host "  dashboard:  http://localhost:5678/webhook/dashboard"
Write-Host "  review:     http://localhost:5678/form/review"
Write-Host "  demo:       node scripts/send_leads.js samples/leads.csv"
