# Installing the bookstore in a shop

This guide installs the bookstore on one PC in the shop, the **server**, so that the
counters (that PC and the others on the shop's network) use it in their browsers over
HTTPS. It is the on-premise install of `v2.0.0` (#31, owner decisions 1a–4a, 2026-11-06).
For a development setup, see [`development.md`](development.md).

## What you need

| | |
|---|---|
| Server | Windows 10 or 11 (64-bit), or a Linux PC; 8 GB of memory, 20 GB free disk |
| Windows | [Docker Desktop](https://www.docker.com/products/docker-desktop/) with WSL 2, virtualization turned on in the BIOS. Docker Desktop is free for businesses with fewer than 250 employees and less than US$10 million a year in revenue. |
| Linux | [Docker Engine](https://docs.docker.com/engine/install/) with the compose plugin |
| Network | The counters on the same network as the server; a fixed address for the server (a reservation on the router) |
| Internet | For the first install and for updates, to download the software |
| The software | This repository, as a ZIP of a release or a `git clone` |

## Install the server

**Windows.** Start Docker Desktop and wait until it says it is running. Open PowerShell
**as administrator** in the bookstore folder, then:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\install.ps1
```

**Linux.** In the bookstore folder:

```bash
bash deploy/install.sh
```

The installer asks:

1. **How the counters reach this PC**: its name and its addresses on the network,
   separated by commas. It proposes this PC's name, its addresses and `localhost`; press
   Enter to take them. A counter must use one of these to open the bookstore.
2. **Where the backups go, and their passphrase** (see [Backups](#backups)): a folder on
   another disk, a USB drive or a network share, and a passphrase of at least 12
   characters. **Write the passphrase down and keep it apart from the PC**: without it,
   the backups cannot be restored.
3. **The passwords of the two first accounts**: `superadmin` (the shop owner: shop
   settings, branches, staff) and `admin` (day-to-day administration). At least 10
   characters, with upper- and lower-case letters, a digit and another character. They
   are used from the first sign-in; the shop never runs with a published password.

It then builds the software (a few minutes the first time), creates the database,
starts everything, and shows the address to open and the **fingerprint** of the shop's
certificate authority. Note the fingerprint: the counters check it.

On Windows, run as administrator, the installer also makes the server trust the
certificate authority and opens ports 80 and 443 in the firewall for the counters.

## Each counter PC, once

The bookstore uses HTTPS with the shop's own certificate authority, made at install. Each
counter trusts it once, then opens the bookstore with no warning.

**Windows**, PowerShell as administrator, with the `deploy` folder copied to the counter
(or from the server's folder over the network):

```powershell
powershell -ExecutionPolicy Bypass -File trust-ca.ps1 -Server <server name or address>
```

**Linux:** `sudo bash trust-ca.sh <server name or address>`.

Both show the fingerprint: it must be the one the installer showed. Edge and Chrome on
Windows use the Windows list; Firefox and Chrome on Linux may need the certificate
(`deploy/bookstore-ca.crt`) imported in their own settings too.

Then open `https://<server name or address>`.

## What the install keeps, and where

| What | Where | |
|---|---|---|
| The secrets | `deploy/.env` | **Keep a copy somewhere safe and private** (a USB key in a safe). It holds `BMS_COLUMN_ENCRYPTION_KEY`: without it, customer names, phones and emails cannot be read, even from a backup. The installer never overwrites it. |
| The data | the `bookstore_pgdata18` Docker volume | In every backup. |
| The backups | the folder chosen at install (`BMS_BACKUP_DIR` in `.env`) | Encrypted with the backup passphrase. |
| The certificate authority | the `bookstore_caddy_data` Docker volume | Losing it means the counters trust a new one once. |

The database is not reachable from the network: only the bookstore's own services use it.

## Day to day

- The bookstore starts by itself with Docker (Docker Desktop: *Start when you sign in*).
- Running the installer again rebuilds and restarts the bookstore with the software in the
  folder; it keeps `.env`, the data and the certificate authority. On an install made before
  backups existed, it asks for the backup folder and passphrase once. Updates and rolling
  back are #245.
- To stop it: `docker compose -f deploy/compose.yaml stop`; to start it again:
  `docker compose -f deploy/compose.yaml up -d`.

## Backups

Each night at 02:30 (shop time), and when the bookstore starts if the last good backup is
older than a day (a PC switched off at night still gets one a day), the bookstore writes one
file to the backup folder, `bookstore-YYYYMMDD-HHMMSS.bmsbak`. It holds:

- the database, as it was at that moment;
- `deploy/.env`, with the key the customer data is encrypted with;
- the shop's certificate authority, so the counters keep trusting a restored install.

The file is encrypted with the backup passphrase (AES-256-GCM): a copy that is lost or stolen
cannot be read without it, and a changed or damaged file is refused. The newest 14 backups
are kept, and the newest of each of the last 8 weeks; other files in the folder are never
touched.

- **Copy a backup off the PC regularly** (a USB drive kept elsewhere), unless the folder is
  already on another machine.
- Admin and Super_Admin see a red warning across the bookstore when there has been no good
  backup for more than a day, with the reason the last attempt failed (a drive unplugged, a
  full disk).
- To make a backup now (before an update, say):
  `docker compose -f deploy/compose.yaml run --rm backup node backup.js run`.
- The time can be changed with `BMS_BACKUP_TIME=HH:MM` in `deploy/.env`, the time zone with
  `BMS_TIMEZONE` (default `Africa/Addis_Ababa`); run the installer again after.

## Restoring

On a new PC (or this one after its install was removed), with Docker and the bookstore
folder, and the backup file and its passphrase:

**Windows**, PowerShell as administrator:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\restore.ps1 -Backup D:\BookstoreBackups\bookstore-20261106-023000.bmsbak
```

**Linux:** `bash deploy/restore.sh /media/usb/bookstore-20261106-023000.bmsbak`

It asks for the passphrase, puts back `.env`, the database and the certificate authority,
brings the database up to the version in the folder, starts the bookstore and checks the data
(`0 error row(s)` at the end). The shop signs in with the passwords it had when the backup was
made, and the counters need nothing new. The restore refuses to run over an existing install:
remove it first (`docker compose -f deploy/compose.yaml down -v`, then delete `deploy/.env`).

If the server's name or address changed, edit `BMS_SITE_ADDRESSES` and `BMS_ORIGINS` in
`deploy/.env` and run the installer again.

## If something goes wrong

| What you see | What to do |
|---|---|
| `Docker Desktop is not running` | Start Docker Desktop, wait until it says it is running, run the installer again. |
| A counter cannot open the address | Use one of the addresses given at install. Check the server's firewall (ports 80 and 443) and that the counter is on the same network. |
| The browser warns about the certificate | Run `trust-ca` on that counter. On the server itself, run the installer as administrator. |
| The build fails with `SELF_SIGNED_CERT_IN_CHAIN` | The network inspects HTTPS through a proxy. Copy the proxy's certificate authority to `deploy/extra-ca.pem`, add `BMS_EXTRA_CA_FILE=./extra-ca.pem` to `deploy/.env`, run the installer again. It is used for the build only. |
| `Choose the passwords again` | A password does not meet the rule above. |
| The backup warning: no backup for more than a day | Check the backup folder is there (the USB drive plugged in, the share reachable) and has space; `docker compose -f deploy/compose.yaml logs backup` shows why. A backup runs again within the hour, or make one now (above). |
| `Wrong passphrase, or the backup file was changed or damaged` | Check the passphrase; else try the backup before it. |
| Anything else | `docker compose -f deploy/compose.yaml logs api` shows what the bookstore reported. |
