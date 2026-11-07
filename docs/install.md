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

## The shop's lists

A new install has no books, stock or customers. Admin and Manager bring them in from CSV files
on **System → Import / Export**, in this order (#246):

1. **Catalog**: books by ISBN (or SKU for a book without one), with authors, publisher,
   categories, format, language and price.
2. **Opening stock**: the first stock of each book at a location of the branch, and what one
   copy cost (0 if unknown: such books are listed to revalue). Stock staff can also do this, in
   their own locations.
3. **Customers**: found again by code, phone or email.
4. **Customer balances** and 5. **Supplier balances**: what customers owed, their store credit
   and loyalty points, and what the shop owed each supplier. Only before the first sale.

Each starts from its **Template**. In Excel, save the file as "CSV UTF-8" so Amharic text is
kept. A file is checked before anything is saved: each wrong row is listed with its line and the
reason. Fix the file and choose it again, or import only the valid rows. Importing the same file
again creates nothing twice. **Export** gives the catalog, stock and customers in the same
columns, for example to bring them into another install.

### From a shop on v1

A shop moving from v1 gets these files from its v1 database with one command, on any PC with
Docker (it changes no install, and only reads v1):

```powershell
powershell -ExecutionPolicy Bypass -File deploy\import-v1.ps1 -From "<v1 database address>"
```

```bash
bash deploy/import-v1.sh '<v1 database address>'
```

- **What it reads:** the v1 database's external address (on Render: the database, **Connect**,
  External Database URL), or a copy of it made with `pg_dump` (custom, tar or SQL, or gzipped).
  With an address, the copy it makes is kept beside the files as `v1-copy.dump`: keep it as the
  v1 shop's last backup. Stop selling on v1 first, so nothing is missed.
- **The v1 key:** it asks for `COLUMN_ENCRYPTION_KEY` of the v1 API (on Render: the API service,
  **Environment**). The key opens the customers' phones and emails; the command stops if it does
  not open every one.
- **What it writes:** in a new folder `v1-import-<date and time>`, the five files, numbered in the
  order above, and `summary.txt`: what came over and what did not (archived books with no stock,
  damaged copies, a format v2 does not have, whole loyalty points, a supplier paid more than it
  delivered). What the shop owes a supplier is what v1 shows: received, less paid, less credit
  notes. Stock comes at v1's average cost.
- **Then:** create the v1 locations named in `summary.txt` (Organization → Locations), and import the
  files on **Import / Export** in their numbered order, with the same checks. The files hold the
  customers' phones and emails in clear: delete the folder once imported. Staff accounts and sales
  history do not come over: the shop starts its v2 history fresh.

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
  backups existed, it asks for the backup folder and passphrase once. When the folder holds
  another version than the one running, it stops and points to the upgrade (below).
- The version running shows at the bottom of the **My Profile** page (in the sidebar), and in
  `https://<server>/api/v1/health`.
- To stop it: `docker compose -f deploy/compose.yaml stop`; to start it again:
  `docker compose -f deploy/compose.yaml up -d`.

## Upgrading

A new version comes as a new release of this repository. Before, tell the counters to finish
what they are doing: the bookstore stops for a few minutes.

1. Put the new release in the bookstore folder: with git, `git fetch --tags` then
   `git checkout v2.0.1` (the release's tag); from a ZIP, extract it over the folder and
   replace the files. `deploy/.env` and the backups are not in a release and stay as they are.
2. Run the upgrade. **Windows**, PowerShell as administrator:

   ```powershell
   powershell -ExecutionPolicy Bypass -File deploy\upgrade.ps1
   ```

   **Linux:** `bash deploy/upgrade.sh`

It checks the bookstore runs and its data, makes a backup, keeps the running version, builds the
new one, brings the database up to it, starts it, and checks again that it answers with the new
version and that the data check finds no new error. **If any of that fails, it goes back by
itself** to the version before and its data, and says what failed. On success, each counter
reloads the page once (Ctrl+F5).

**Going back after an upgrade.** If the new version turns out wrong after the shop has used it:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\upgrade.ps1 -Rollback
```

(**Linux:** `bash deploy/upgrade.sh --rollback`.) It puts back the version before **and the data
as it was before the upgrade: what was entered since is no longer in the bookstore.** It asks to
type `ROLLBACK` first, and makes a backup of the data as it is, so nothing is lost for good. Then
put back the previous release in the folder (`git checkout` of its tag, or its ZIP), before
running the installer or the upgrade again. Only the last upgrade can be undone this way; before
that, restore a backup (below).

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
- To make a backup now (the upgrade makes one itself):
  `docker compose -f deploy/compose.yaml run --rm --no-deps backup node backup.js run`.
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
| `This PC runs version … and this folder holds …` | The folder holds a new release: run the upgrade, not the installer. |
| `The upgrade to … failed` | The version before runs again, with its data. Keep the output and the `docker compose -f deploy/compose.yaml logs` for support. |
| `Wrong passphrase, or the backup file was changed or damaged` | Check the passphrase; else try the backup before it. |
| Anything else | `docker compose -f deploy/compose.yaml logs api` shows what the bookstore reported. For support, save the logs into one file (below). |

### The logs

Every part of the bookstore (the API, the database, the web server, backups and upgrades) writes
a log that Docker keeps in rotating files: at most about 50 MB each, the oldest lines dropped
first. Each line of the API's log says when, what happened, and for a request its ID, the staff
member, branch and shop. Passwords, keys, tokens and customer phones and emails are never
written.

To send them for support, save the last days into one file (3 unless given), in the folder you
run it from:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\logs.ps1 -Days 3
```

```bash
bash deploy/logs.sh 3
```

Two addresses answer for monitoring: `/api/v1/health/live` (the API is running) and
`/api/v1/health/ready` (it is ready: the database answers and it is not shutting down).

