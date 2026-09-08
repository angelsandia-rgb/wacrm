param([string]$ProjectRef)
$ErrorActionPreference = 'Stop'
if ($ProjectRef -notmatch '^[a-z]{20}$') { throw 'A valid project reference is required' }
if (-not $env:SUPABASE_ACCESS_TOKEN) { throw 'SUPABASE_ACCESS_TOKEN is required' }
$auditHeaders = @{ Authorization = 'Bearer ' + $env:SUPABASE_ACCESS_TOKEN }
$auditBase = 'https://api.supabase.com/v1/projects/' + $ProjectRef
$auditSql = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'audit-capacity.sql'))
$auditResult = Invoke-RestMethod -Method Post -Uri ($auditBase + '/database/query/read-only') -Headers $auditHeaders -ContentType 'application/json' -Body (@{query=$auditSql} | ConvertTo-Json) -TimeoutSec 45
$auditResult | ConvertTo-Json -Depth 10
