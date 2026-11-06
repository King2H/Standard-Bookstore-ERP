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

The installer asks two things:

1. **How the counters reach this PC**: its name and its addresses on the network,
   separated by commas. It proposes this PC's name, its addresses and `localhost`; press
   Enter to take them. A counter must use one of these to open the bookstore.
2. **The passwords of the two first accounts**: `superadmin` (the shop owner: shop
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
| The data | the `bookstore_pgdata18` Docker volume | Backed up by the backup step (#244). |
| The certificate authority | the `bookstore_caddy_data` Docker volume | Losing it means the counters trust a new one once. |

The database is not reachable from the network: only the bookstore's own services use it.

## Day to day

- The bookstore starts by itself with Docker (Docker Desktop: *Start when you sign in*).
- Running the installer again rebuilds and restarts the bookstore with the software in the
  folder; it keeps `.env`, the data and the certificate authority. Updates and rolling back
  are #245; backups #244.
- To stop it: `docker compose -f deploy/compose.yaml stop`; to start it again:
  `docker compose -f deploy/compose.yaml up -d`.

## If something goes wrong

| What you see | What to do |
|---|---|
| `Docker Desktop is not running` | Start Docker Desktop, wait until it says it is running, run the installer again. |
| A counter cannot open the address | Use one of the addresses given at install. Check the server's firewall (ports 80 and 443) and that the counter is on the same network. |
| The browser warns about the certificate | Run `trust-ca` on that counter. On the server itself, run the installer as administrator. |
| The build fails with `SELF_SIGNED_CERT_IN_CHAIN` | The network inspects HTTPS through a proxy. Copy the proxy's certificate authority to `deploy/extra-ca.pem`, add `BMS_EXTRA_CA_FILE=./extra-ca.pem` to `deploy/.env`, run the installer again. It is used for the build only. |
| `Choose the passwords again` | A password does not meet the rule above. |
| Anything else | `docker compose -f deploy/compose.yaml logs api` shows what the bookstore reported. |
