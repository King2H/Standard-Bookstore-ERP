# Installs the bookstore on this Windows PC, or brings an install up to date
# (#31). Needs Docker Desktop (WSL 2). In PowerShell, as administrator:
#   powershell -ExecutionPolicy Bypass -File deploy\install.ps1
# The first run asks how the counters reach this PC and the passwords of the
# Super_Admin and Admin accounts, and writes deploy\.env with fresh secrets.
# Later runs keep .env as it is: it holds the key the customer data is
# encrypted with. Add -SetPasswords to set the two passwords again on an
# install whose accounts still have the original one.
param([switch]$SetPasswords)
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Say($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "Error: $text" -ForegroundColor Red; exit 1 }
function Invoke-Docker { & docker @args; if ($LASTEXITCODE -ne 0) { Fail "docker $($args -join ' ') failed" } }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'Docker Desktop is not installed: https://www.docker.com/products/docker-desktop/' }
& docker compose version *> $null; if ($LASTEXITCODE -ne 0) { Fail 'Docker Desktop is too old: update it.' }
& docker info *> $null; if ($LASTEXITCODE -ne 0) { Fail 'Docker Desktop is not running: start it and wait until it says it is running.' }

function New-Secret([int]$bytes, [switch]$Hex) {
  $buffer = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
  if ($Hex) { return -join ($buffer | ForEach-Object { $_.ToString('x2') }) }
  return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Read-Password($prompt) {
  while ($true) {
    $a = Read-Host -AsSecureString $prompt
    $b = Read-Host -AsSecureString 'Again'
    $pa = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($a))
    $pb = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($b))
    if ($pa -ne '' -and $pa -ceq $pb) { return $pa }
    Write-Host 'They differ, or are empty. Try again.'
  }
}

$firstInstall = $false
if (-not (Test-Path .env)) {
  $firstInstall = $true
  Say 'How the counters reach this PC'
  $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Docker|Loopback' } |
    ForEach-Object { $_.IPAddress }
  $default = (@($env:COMPUTERNAME.ToLower()) + $ips + @('localhost')) -join ', '
  Write-Host "Names and addresses, separated by commas. Press Enter for: $default"
  $addresses = Read-Host
  if ([string]::IsNullOrWhiteSpace($addresses)) { $addresses = $default }
  $origins = ($addresses -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ } | ForEach-Object { "https://$_" }) -join ','

  $content = @(
    "# Written by install.ps1 on $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mmZ')). Keep a copy somewhere safe and private:",
    '# without BMS_COLUMN_ENCRYPTION_KEY, customer names, phones and emails cannot be read.',
    "BMS_SITE_ADDRESSES=$addresses",
    "BMS_ORIGINS=$origins",
    "BMS_DB_OWNER_PASSWORD=$(New-Secret 24 -Hex)",
    "BMS_DB_API_PASSWORD=$(New-Secret 24 -Hex)",
    "BMS_JWT_SECRET=$(New-Secret 48)",
    "BMS_COLUMN_ENCRYPTION_KEY=$(New-Secret 32 -Hex)"
  )
  [IO.File]::WriteAllLines((Join-Path $PSScriptRoot '.env'), $content)
  # Readable by administrators and this user only.
  & icacls .env /inheritance:r /grant:r "${env:USERNAME}:F" '*S-1-5-32-544:F' *> $null
  Write-Host 'Wrote deploy\.env with new secrets.'
}

Say 'Building the images (a few minutes the first time)'
Invoke-Docker compose build

Say 'Starting the database and applying the migrations'
Invoke-Docker compose up -d postgres
Invoke-Docker compose run --rm -T migrate

if ($firstInstall -or $SetPasswords) {
  Say 'The first accounts'
  Write-Host 'Passwords: at least 10 characters, with upper- and lower-case letters, a digit and another character.'
  while ($true) {
    $env:BMS_SUPERADMIN_PASSWORD = Read-Password 'Password for superadmin (the shop owner)'
    $env:BMS_ADMIN_PASSWORD = Read-Password 'Password for admin (day-to-day administration)'
    & docker compose run --rm --no-deps -T -e BMS_SUPERADMIN_PASSWORD -e BMS_ADMIN_PASSWORD migrate node first-accounts.js
    $ok = $LASTEXITCODE -eq 0
    Remove-Item Env:BMS_SUPERADMIN_PASSWORD, Env:BMS_ADMIN_PASSWORD
    if ($ok) { break }
    Write-Host 'Choose the passwords again.'
  }
}

Say 'Starting the bookstore'
Invoke-Docker compose up -d --wait

Say "The shop's certificate authority"
$root = '/data/caddy/pki/authorities/local/root.crt'
for ($i = 0; $i -lt 30; $i++) {
  & docker compose exec -T web test -f $root *> $null
  if ($LASTEXITCODE -eq 0) { break }
  try { Invoke-WebRequest -Uri 'https://localhost/' -UseBasicParsing -TimeoutSec 2 *> $null } catch { }
  Start-Sleep -Seconds 1
}
$pem = (& docker compose exec -T web cat $root) -join "`n"
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'bookstore-ca.crt'), $pem + "`n")
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (Join-Path $PSScriptRoot 'bookstore-ca.crt')
$fingerprint = ($cert.GetCertHash([System.Security.Cryptography.HashAlgorithmName]::SHA256) | ForEach-Object { $_.ToString('X2') }) -join ':'

# This PC trusts it too, and lets the counters reach it.
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($admin) {
  Import-Certificate -FilePath (Join-Path $PSScriptRoot 'bookstore-ca.crt') -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
  if (-not (Get-NetFirewallRule -DisplayName 'Bookstore (HTTP, HTTPS)' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'Bookstore (HTTP, HTTPS)' -Direction Inbound -Protocol TCP -LocalPort 80,443 -Action Allow -Profile Private,Domain | Out-Null
  }
} else {
  Write-Host 'Not run as administrator: this PC does not trust the certificate yet, and the firewall was not opened for the counters.' -ForegroundColor Yellow
}

$first = (Get-Content .env | Where-Object { $_ -like 'BMS_SITE_ADDRESSES=*' }) -replace '^BMS_SITE_ADDRESSES=', '' -split ',' | Select-Object -First 1
$first = $first.Trim()
Write-Host @"

Done. Open https://$first on this PC or any counter.

Each counter PC trusts this shop's certificate authority once:
  Windows: deploy\trust-ca.ps1 -Server $first   (as administrator)
  Linux:   sudo bash deploy/trust-ca.sh $first
Check that it shows this fingerprint:
  $fingerprint
The certificate is also in deploy\bookstore-ca.crt.

Keep a copy of deploy\.env somewhere safe and private.
"@
