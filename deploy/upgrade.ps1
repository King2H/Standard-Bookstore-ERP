# Brings the bookstore on this Windows PC up to the version in this folder,
# or back to the one before (#245, owner decision 2a). Needs the install made
# by install.ps1, and the new release in this folder (git checkout of the
# release's tag, or its ZIP extracted over the folder). In PowerShell, as
# administrator:
#   powershell -ExecutionPolicy Bypass -File deploy\upgrade.ps1             upgrade
#   powershell -ExecutionPolicy Bypass -File deploy\upgrade.ps1 -Rollback   back to the version
#                                     before the last upgrade, with the data of then
# An upgrade first makes a backup and keeps the running version's images. If
# a step fails once the bookstore was stopped, it goes back to them, and to
# the data of the backup, by itself.
param([switch]$Rollback)
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Say($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "Error: $text" -ForegroundColor Red; exit 1 }
# Runs docker and returns what it wrote, with its exit code in $script:Code.
# Windows PowerShell stops at a redirected native error line under 'Stop'.
function Get-Docker { $ErrorActionPreference = 'Continue'; $lines = & docker @args 2>&1 | ForEach-Object { "$_" }; $script:Code = $LASTEXITCODE; $lines }
# Runs docker, its output on the screen; true when it succeeded.
function Use-Docker { & docker @args | Out-Host; $LASTEXITCODE -eq 0 }
$State = '.upgrade-state'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'Docker Desktop is not installed.' }
$null = Get-Docker info; if ($script:Code -ne 0) { Fail 'Docker Desktop is not running: start it and wait until it says it is running.' }
if (-not (Test-Path .env)) { Fail 'No install here (deploy\.env is missing): install with install.ps1 first.' }

$images = @(Get-Docker compose config --images | Where-Object { $_ -like 'bookstore-*' } | Sort-Object -Unique)
$apiImage = $images | Where-Object { $_ -like 'bookstore-api:*' } | Select-Object -First 1
function Get-Previous($image) { $image -replace ':[^:/]+$', ':previous' }
function Get-InstalledVersion($image) {
  $v = Get-Docker run --rm --entrypoint cat $image /app/VERSION
  if ($script:Code -eq 0) { "$v".Trim() } else { 'unknown' }
}
function Get-FolderVersion { (Get-Content (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json).version }
# True when $a is a later version than $b (by their numbers: 2.0.10 after 2.0.9).
function Test-Later($a, $b) { [version]($a -replace '-.*$', '') -gt [version]($b -replace '-.*$', '') }
# The version the API answers with, once it is up.
function Get-ServedVersion {
  $v = Get-Docker compose exec -T api node -e "fetch('http://127.0.0.1:3000/api/v1/health').then((r) => r.json()).then((b) => console.log(b.status === 'ok' ? (b.version ?? 'unknown') : 'down'), () => console.log('down'))"
  if ($script:Code -eq 0) { "$($v | Select-Object -Last 1)".Trim() } else { 'down' }
}
# The number of error rows the data check finds; $null when it cannot run.
function Get-DataErrors {
  $found = Get-Docker compose run --rm --no-deps -T migrate node db-check.js | Select-String ' rules: (\d+) error row' | Select-Object -Last 1
  if ($found) { [int]$found.Matches[0].Groups[1].Value } else { $null }
}
function Invoke-Backup {
  $out = Get-Docker compose run --rm --no-deps -T backup node backup.js run
  $out | Write-Host
  if ($script:Code -ne 0) { return $null }
  $line = $out | Select-String '^Backup written: (\S+)' | Select-Object -Last 1
  if ($line) { $line.Matches[0].Groups[1].Value } else { $null }
}
# Back to the kept images and the backup's data; false when a step fails.
function Restore-Previous($backup) {
  Say "Putting back the database of $backup"
  $null = Get-Docker compose stop api web backup
  if (-not (Use-Docker compose up -d --wait postgres)) { return $false }
  if (-not (Use-Docker compose run --rm --no-deps -T backup node backup.js replace-database "/backups/$backup")) { return $false }
  Say 'Putting back the software'
  foreach ($image in $images) { if (-not (Use-Docker tag (Get-Previous $image) $image)) { return $false } }
  Use-Docker compose up -d --wait
}
function Stop-RestoreFailed($backup) {
  Fail "Going back failed too (see above). Restore the backup made before the upgrade, $backup, with restore.ps1 (docs/install.md, Restoring), and keep this output for support."
}

function Invoke-Upgrade {
  $installed = Get-InstalledVersion $apiImage
  $available = Get-FolderVersion
  if (-not $available) { Fail 'No version in package.json: this folder does not hold a release of the bookstore.' }
  if ($installed -eq $available) { Write-Host "The bookstore is already at ${available}: nothing to do."; return }
  if ($installed -ne 'unknown' -and (Test-Later $installed $available)) {
    Fail "This folder holds $available, older than the installed $installed. To go back after an upgrade: deploy\upgrade.ps1 -Rollback."
  }
  Say "Upgrading the bookstore from $installed to $available"

  Say 'Checking the bookstore as it is'
  if (-not (Use-Docker compose up -d --wait)) { Fail 'The bookstore does not start as it is: see docker compose -f deploy\compose.yaml logs api.' }
  $before = Get-DataErrors
  if ($null -eq $before) { Fail 'The data check does not run: see the output of docker compose -f deploy\compose.yaml run --rm migrate node db-check.js.' }
  Write-Host "Data check: $before error row(s)."

  Say 'A backup first'
  $backup = Invoke-Backup
  if (-not $backup) { Fail 'The backup failed: an upgrade needs one. Check the backup folder (docs/install.md, Backups).' }

  Say "Keeping $installed for a rollback"
  foreach ($image in $images) { if (-not (Use-Docker tag $image (Get-Previous $image))) { Fail 'The images could not be kept: nothing was changed.' } }
  Set-Content -Path $State -Value @("from=$installed", "to=$available", "backup=$backup", "at=$(Get-Date -Format 'yyyy-MM-dd HH:mm')")

  Say "Building $available (a few minutes)"
  if (-not (Use-Docker compose build)) {
    foreach ($image in $images) { $null = Get-Docker tag (Get-Previous $image) $image }
    Remove-Item -Force $State -ErrorAction SilentlyContinue
    Fail "The build failed (see above): nothing was changed, $installed still runs."
  }

  $reason = $null
  Say 'Stopping the bookstore, bringing the database up to the new version, starting'
  if (-not ((Use-Docker compose stop api web backup) -and (Use-Docker compose run --rm --no-deps -T migrate))) {
    $reason = 'the database could not be brought up to the new version'
  } elseif (-not (Use-Docker compose up -d --wait)) {
    $reason = 'the new version does not start'
  } elseif ((Get-ServedVersion) -ne $available) {
    $reason = "the bookstore does not answer as $available"
  } else {
    $after = Get-DataErrors
    if ($null -eq $after) { $reason = 'the data check does not run' }
    elseif ($after -gt $before) { $reason = "the data check finds $after error row(s), against $before before" }
  }
  if ($reason) {
    Write-Host "`nThe upgrade failed: $reason. Going back to $installed." -ForegroundColor Red
    if (-not (Restore-Previous $backup)) { Stop-RestoreFailed $backup }
    Remove-Item -Force $State -ErrorAction SilentlyContinue
    Fail "The upgrade to $available failed ($reason). $installed runs again, with its data as it was before the upgrade. See docker compose -f deploy\compose.yaml logs, and keep this output for support."
  }
  Write-Host "Data check: $after error row(s)."
  Write-Host @"

Upgraded from $installed to $available. Open the bookstore and check it.
Each counter reloads the page once (Ctrl+F5) to get the new screens.
If something is wrong: deploy\upgrade.ps1 -Rollback puts back $installed
with the data of the backup made before the upgrade ($backup).
"@
}

function Invoke-Rollback {
  if (-not (Test-Path $State)) { Fail 'There is no upgrade to go back from.' }
  $s = Get-Content $State -Raw | ConvertFrom-StringData
  foreach ($image in $images) {
    $null = Get-Docker image inspect (Get-Previous $image)
    if ($script:Code -ne 0) { Fail "The images of $($s.from) are no longer on this PC: restore a backup instead (docs/install.md, Restoring)." }
  }
  Write-Host @"

This puts back $($s.from), and the data as it was before the upgrade to $($s.to) ($($s.at)):
everything entered since then (sales, payments, stock, customers) is lost
from the bookstore. A backup of the data as it is now is made first, so it can
still be restored later.
"@
  if ((Read-Host 'Type ROLLBACK to go on') -cne 'ROLLBACK') { Fail 'Nothing was changed.' }

  Say 'A backup of the data as it is now'
  $now = Invoke-Backup
  if (-not $now) { Fail 'The backup failed, so nothing was changed. Check the backup folder (docs/install.md, Backups).' }
  if (-not (Restore-Previous $s.backup)) { Stop-RestoreFailed $s.backup }
  Remove-Item -Force $State -ErrorAction SilentlyContinue
  if ((Get-ServedVersion) -ne $s.from) { Fail "The bookstore does not answer as $($s.from) after the rollback: see docker compose -f deploy\compose.yaml logs api." }
  Write-Host @"

Back on $($s.from), with the data of $($s.at). The data as it was on $($s.to) is in $now.
This folder still holds $($s.to): put back the $($s.from) release in the folder before
running install.ps1 or this script again.
"@
}

if ($Rollback) { Invoke-Rollback } else { Invoke-Upgrade }
