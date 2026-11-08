# Run K-13 as mkb (after miner has built data/history.sqlite).
# Usage: .\run-mkb.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$env:BOT_NAME = "mkb"
$env:K13_UPSTREAM = if ($env:K13_UPSTREAM) { $env:K13_UPSTREAM } else { "C:\Users\nisch\scrabblebot\spacetimedb" }
$env:K13_MODEL_DB = if ($env:K13_MODEL_DB) { $env:K13_MODEL_DB } else { "data/history.sqlite" }
# Optional: tournaments only
# $env:K13_NO_LADDER = "1"

if (-not (Test-Path ".token-mkb")) {
  Write-Error "Missing .token-mkb — copy from bot-starter or set BOT_TOKEN"
}

if (-not (Test-Path "data/history.sqlite")) {
  Write-Warning "data/history.sqlite missing — start miner first: npm run mine -- --follow --no-backend"
}

Write-Host "Starting K-13 as mkb..."
npm run bot
