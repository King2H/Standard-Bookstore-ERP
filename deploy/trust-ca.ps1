# Makes this Windows PC trust the shop's certificate authority, once (#31),
# so Edge and Chrome open the bookstore over HTTPS without a warning. In
# PowerShell, as administrator:
#   powershell -ExecutionPolicy Bypass -File trust-ca.ps1 -Server <server name or address>
# Compare the fingerprint it shows with the one the installer printed.
param([Parameter(Mandatory = $true)][string]$Server)
$ErrorActionPreference = 'Stop'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host 'Run PowerShell as administrator.' -ForegroundColor Red; exit 1 }

$file = Join-Path $env:TEMP 'bookstore-ca.crt'
Invoke-WebRequest -Uri "http://$Server/ca.crt" -OutFile $file -UseBasicParsing
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $file
$fingerprint = ($cert.GetCertHash([System.Security.Cryptography.HashAlgorithmName]::SHA256) | ForEach-Object { $_.ToString('X2') }) -join ':'
Write-Host "Certificate: $($cert.Subject)"
Write-Host "SHA256 fingerprint: $fingerprint"
$answer = Read-Host 'Does it match the one the installer printed? (yes/no)'
if ($answer -ne 'yes') { Remove-Item $file; Write-Host 'Not trusted. Check the server address.'; exit 1 }

Import-Certificate -FilePath $file -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Remove-Item $file
Write-Host "Trusted. Open https://$Server"
