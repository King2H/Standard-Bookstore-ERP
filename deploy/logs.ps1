# Saves the bookstore's logs of the last days into one file, to send for
# support (#32, owner decision 2a): every service (API, database, web, backup,
# migrations), with times. Docker keeps them in rotating files: at most about
# 50 MB a service. Passwords, keys and customer contacts are never in them.
# In PowerShell:
#   powershell -ExecutionPolicy Bypass -File deploy\logs.ps1 [-Days 3]
# The file is written where the command is run.
param([ValidateRange(1, 999)][int]$Days = 3)
$ErrorActionPreference = 'Stop'
$here = (Get-Location).Path
Set-Location -Path $PSScriptRoot

function Fail($text) { Write-Host "Error: $text" -ForegroundColor Red; exit 1 }
# Runs docker and returns what it wrote, with its exit code in $script:Code.
# Windows PowerShell stops at a redirected native error line under 'Stop'.
function Get-Docker { $ErrorActionPreference = 'Continue'; $lines = & docker @args 2>&1 | ForEach-Object { "$_" }; $script:Code = $LASTEXITCODE; $lines }

try {
  $null = Get-Docker info; if ($script:Code -ne 0) { Fail 'Docker Desktop is not running: start it and wait until it says it is running.' }
  if (-not (Test-Path .env)) { Fail 'No install in this folder (deploy\.env is missing).' }

  $file = Join-Path $here ("bookstore-logs-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".txt")
  $lines = @("Bookstore logs of the last $Days day(s), saved $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mmZ'))")
  $lines += Get-Docker compose ps --all --format 'table {{.Service}}\t{{.Status}}'
  $lines += ''
  $lines += Get-Docker compose logs --no-color --timestamps --since "$($Days * 24)h"
  $lines | Set-Content -Path $file -Encoding UTF8
  & icacls $file /inheritance:r /grant:r "${env:USERNAME}:F" '*S-1-5-32-544:F' *> $null
  Write-Host "Saved $(Split-Path $file -Leaf) ($([math]::Round((Get-Item $file).Length / 1KB)) KB) in $here."
} finally {
  Set-Location -Path $here
}
