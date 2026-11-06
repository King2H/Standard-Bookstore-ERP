# Rebuilds the bookstore on this Windows PC from one backup file (#244,
# owner decision 4a): the database, the install's .env and the shop's
# certificate authority, then checks the data. For a new PC, or this one after
# its install was removed. Needs Docker Desktop and this folder. In
# PowerShell, as administrator:
#   powershell -ExecutionPolicy Bypass -File deploy\restore.ps1 -Backup D:\BookstoreBackups\bookstore-YYYYMMDD-HHMMSS.bmsbak
# It asks for the backup passphrase.
param([Parameter(Mandatory = $true)][string]$Backup)
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Say($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "Error: $text" -ForegroundColor Red; exit 1 }
function Invoke-Docker { & docker @args; if ($LASTEXITCODE -ne 0) { Fail "docker $($args -join ' ') failed" } }

if (-not (Test-Path $Backup)) { Fail "No such file: $Backup" }
$Backup = (Resolve-Path $Backup).Path
& docker info *> $null; if ($LASTEXITCODE -ne 0) { Fail 'Docker Desktop is not running: start it and wait until it says it is running.' }
if (Test-Path .env) { Fail 'deploy\.env exists: this PC already has an install. Restore onto a clean PC, or remove the install first (docker compose down -v, then delete deploy\.env).' }
$project = if ($env:COMPOSE_PROJECT_NAME) { $env:COMPOSE_PROJECT_NAME } else { 'bookstore' }
& docker volume inspect "${project}_pgdata18" *> $null
if ($LASTEXITCODE -eq 0) { Fail "A bookstore database already exists on this PC (volume ${project}_pgdata18). Remove it first: docker compose down -v." }

$secure = Read-Host -AsSecureString 'Backup passphrase'
$env:BMS_BACKUP_PASSPHRASE = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))

$work = Join-Path $env:TEMP ("bookstore-restore-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  Say 'Opening the backup'
  $secret = @()
  if ($env:BMS_EXTRA_CA_FILE) { $secret = @('--secret', "id=extra_ca,src=$($env:BMS_EXTRA_CA_FILE)") }
  Invoke-Docker build -q -f Dockerfile --target backup @secret -t bookstore-backup:local ..
  & docker run --rm -e BMS_BACKUP_PASSPHRASE -v "$(Split-Path $Backup):/in:ro" -v "${work}:/out" bookstore-backup:local node backup.js unpack "/in/$(Split-Path $Backup -Leaf)" /out
  $opened = $LASTEXITCODE -eq 0
  Remove-Item Env:BMS_BACKUP_PASSPHRASE
  if (-not $opened) { Fail 'The backup could not be opened (see above).' }
  Get-Content (Join-Path $work 'manifest.json') | Write-Host

  Say 'The install settings from the backup'
  Copy-Item (Join-Path $work 'install.env') (Join-Path $PSScriptRoot '.env')
  & icacls .env /inheritance:r /grant:r "${env:USERNAME}:F" '*S-1-5-32-544:F' *> $null
  $backupDir = ((Get-Content .env | Where-Object { $_ -like 'BMS_BACKUP_DIR=*' }) -replace '^BMS_BACKUP_DIR=', '' | Select-Object -First 1)
  if ([string]::IsNullOrWhiteSpace($backupDir)) { $backupDir = './backups' }
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

  Say 'Building the images'
  Invoke-Docker compose build

  Say 'Restoring the database'
  Invoke-Docker compose up -d --wait postgres
  # The role the API works as is the cluster's, not the database's: made before the data that grants to it.
  Invoke-Docker compose exec -T postgres psql -q -U bms -d bms -v ON_ERROR_STOP=1 -c "DO `$`$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bms_app') THEN CREATE ROLE bms_app NOLOGIN; END IF; END `$`$;"
  # pg_restore reads the dump inside the container: PowerShell pipes text, not bytes.
  Invoke-Docker compose cp (Join-Path $work 'db.dump') postgres:/tmp/db.dump
  Invoke-Docker compose exec -T postgres pg_restore -U bms -d bms --exit-on-error /tmp/db.dump
  Invoke-Docker compose exec -T postgres rm -f /tmp/db.dump

  Say "Restoring the shop's certificate authority"
  Invoke-Docker compose run --rm --no-deps -T -v "${work}:/restore:ro" --entrypoint sh web -c 'tar -C /data -xf /restore/caddy-data.tar'

  Say 'Bringing the database up to this version, and starting'
  Invoke-Docker compose run --rm -T migrate
  Invoke-Docker compose up -d --wait

  Say 'Checking the data'
  Invoke-Docker compose run --rm --no-deps -T migrate node db-check.js
} finally {
  # The unpacked backup holds the secrets: it does not stay on disk.
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

$first = ((Get-Content .env | Where-Object { $_ -like 'BMS_SITE_ADDRESSES=*' }) -replace '^BMS_SITE_ADDRESSES=', '' -split ',' | Select-Object -First 1).Trim()
Write-Host @"

Restored. Open https://$first. The counters keep trusting the same certificate authority.
Sign in with the passwords the shop had when the backup was made.
"@
