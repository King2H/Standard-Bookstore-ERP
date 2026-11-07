# Reads a v1 shop's lists into the files of the Import / Export page (#246,
# owner decisions 1a-4a): catalog, opening stock, customers, customer
# balances and supplier balances, with summary.txt saying what came over.
# Import them on that page, in their numbered order, with its checks.
# Needs Docker Desktop and this folder; it changes no install. In PowerShell:
#   powershell -ExecutionPolicy Bypass -File deploy\import-v1.ps1 -From <v1 database address, or a copy of it> [-Folder <folder>]
# The address is the v1 database's external URL (postgres://...); a copy is a
# pg_dump file (custom, tar or SQL, or gzipped). The folder defaults to
# v1-import-<date and time> where it is run. It asks for the v1 key
# (COLUMN_ENCRYPTION_KEY of the v1 API), which opens the customers' phones
# and emails. The copy is loaded into a temporary database in a container
# that is removed at the end; v1 is only read.
param([Parameter(Mandatory = $true)][string]$From, [string]$Folder)
$ErrorActionPreference = 'Stop'
$here = (Get-Location).Path

function Say($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "Error: $text" -ForegroundColor Red; exit 1 }
# Runs docker and returns what it wrote, with its exit code in $script:Code.
# Windows PowerShell stops at a redirected native error line under 'Stop'.
function Get-Docker { $ErrorActionPreference = 'Continue'; $lines = & docker @args 2>&1 | ForEach-Object { "$_" }; $script:Code = $LASTEXITCODE; $lines }

if (-not $Folder) { $Folder = "v1-import-$(Get-Date -Format 'yyyyMMdd-HHmmss')" }
# Paths given are read from where the command was run.
if (-not [IO.Path]::IsPathRooted($Folder)) { $Folder = Join-Path $here $Folder }
$mount = @()
if ($From -match '^postgres(ql)?://') {
  $arg = $From
} else {
  if (-not [IO.Path]::IsPathRooted($From)) { $From = Join-Path $here $From }
  if (-not (Test-Path $From -PathType Leaf)) { Fail "No such file: $From" }
  $From = (Resolve-Path $From).Path
  $mount = @('-v', "$(Split-Path $From):/in:ro")
  $arg = "/in/$(Split-Path $From -Leaf)"
}
$null = Get-Docker info; if ($script:Code -ne 0) { Fail 'Docker Desktop is not running: start it and wait until it says it is running.' }
New-Item -ItemType Directory -Force -Path $Folder | Out-Null
$Folder = (Resolve-Path $Folder).Path
# The files hold customer contacts: only this user (and administrators) may read them.
& icacls $Folder /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" '*S-1-5-32-544:(OI)(CI)F' *> $null

if (-not $env:BMS_V1_KEY) {
  Write-Host 'The v1 key: COLUMN_ENCRYPTION_KEY of the v1 API (on Render: the API service, Environment).'
  $secure = Read-Host -AsSecureString 'v1 key'
  $env:BMS_V1_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
if ($env:BMS_V1_KEY -notmatch '^[0-9a-fA-F]{64}$') { Fail 'The v1 key is 64 hexadecimal characters (0-9, a-f).' }

Set-Location -Path $PSScriptRoot
$name = "bookstore-v1-import-$PID"
try {
  Say 'Preparing the tools'
  $secret = @()
  if ($env:BMS_EXTRA_CA_FILE) { $secret = @('--secret', "id=extra_ca,src=$($env:BMS_EXTRA_CA_FILE)") }
  $out = Get-Docker build -q -f Dockerfile --target backup @secret -t bookstore-backup:local ..
  if ($script:Code -ne 0) { $out | Write-Host; Fail 'The tools could not be built (see above).' }

  Say 'Starting the temporary database'
  $out = Get-Docker run -d --name $name -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=v1 @mount -v "${Folder}:/out" bookstore-backup:local postgres
  if ($script:Code -ne 0) { $out | Write-Host; Fail 'The temporary database could not be started (see above).' }
  # It answers over TCP only once its first start is over.
  $ready = $false
  for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
    $null = Get-Docker exec $name pg_isready -q -h 127.0.0.1 -U postgres -d v1
    if ($script:Code -eq 0) { $ready = $true } else { Start-Sleep -Seconds 1 }
  }
  if (-not $ready) { Fail 'The temporary database did not start.' }

  Say 'Reading the v1 shop'
  # The address and the key go in the environment: a command line is seen by every user of the PC.
  $env:BMS_V1_SOURCE = $arg
  & docker exec -e BMS_V1_KEY -e BMS_V1_SOURCE $name node import-v1.js /out
  if ($LASTEXITCODE -ne 0) { Fail 'No files were written: see the message above.' }
} finally {
  Remove-Item Env:BMS_V1_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:BMS_V1_SOURCE -ErrorAction SilentlyContinue
  $null = Get-Docker rm -f $name
  Set-Location -Path $here
}

Write-Host @"

The files are in $Folder (summary.txt says what came over).
They hold customers' phones and emails in clear: keep them private, and
delete the folder once imported. Import them on the Import / Export page, in
their numbered order.
"@
