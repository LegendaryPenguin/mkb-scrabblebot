# Run 60x2 evolve gens for $Minutes. On IMPROVED: commit, push, restart live bot.
param(
  [int]$Minutes = 10,
  [int]$Pop = 60,
  [int]$Deals = 2,
  [int]$Elite = 5
)

$ErrorActionPreference = "Continue"
Set-Location (Split-Path $PSScriptRoot -Parent)
$end = (Get-Date).AddMinutes($Minutes)
$gen = 0
$env:K13_UPSTREAM = if ($env:K13_UPSTREAM) { $env:K13_UPSTREAM } else { "C:\Users\nisch\scrabblebot\spacetimedb" }

function Restart-LiveBot {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'src/bot\.ts|src\\bot\.ts' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  $env:BOT_NAME = "mkb"
  $env:K13_TELEMETRY = "0"
  # Burst owns evolve; keep live bot from stacking parallel gens.
  $env:K13_EVOLVE = "0"
  Start-Process -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList "/c","npm run bot" -WorkingDirectory (Get-Location)
}

Write-Output "AGENT_LOOP_TICK_evolve_burst {`"prompt`":`"Burst started: 60 mutants x 2 deals for $Minutes min. Report each IMPROVED gen.`",`"event`":`"start`"}"

while ((Get-Date) -lt $end) {
  $gen++
  $left = [math]::Max(0, [int]($end - (Get-Date)).TotalSeconds)
  Write-Host "[burst] gen $gen starting (${left}s left in window)"
  $out = & npm run evolve -- --pop $Pop --deals $Deals --elite $Elite --write 2>&1 | Out-String
  Write-Host $out
  $improved = $out -match "IMPROVED"
  $line = if ($out -match "\[evolve\] done[^\r\n]+") { $Matches[0] } else { "gen $gen finished" }

  if ($improved) {
    git add data/params.json
    $msg = "Evolve burst gen ${gen}: adopt improved 60x2 params.`n`n$line"
    git commit -m $msg 2>&1 | Out-Host
    git push origin HEAD 2>&1 | Out-Host
    Restart-LiveBot
    $payload = @{
      prompt = "EVOLVE IMPROVED gen $gen ($line). Params pushed to GitHub and live bot restarted on new params. Acknowledge briefly; next gen already starting if time remains."
      event = "improved"
      gen = $gen
    } | ConvertTo-Json -Compress
    Write-Output "AGENT_LOOP_TICK_evolve_burst $payload"
  } else {
    $payload = @{
      prompt = "EVOLVE gen $gen kept incumbent ($line). No push. Next gen starting if time remains."
      event = "kept"
      gen = $gen
    } | ConvertTo-Json -Compress
    Write-Output "AGENT_LOOP_TICK_evolve_burst $payload"
  }
}

Write-Output "AGENT_LOOP_TICK_evolve_burst {`"prompt`":`"Burst window done after $gen gens. Summarize improvements pushed.`",`"event`":`"done`",`"gen`":$gen}"
