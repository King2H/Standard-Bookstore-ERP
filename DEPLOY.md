# Deployment Guide — Bakos Bookstore ERP

## Platform: Render.com (100% Free)

Render offers a free tier that covers everything this app needs:
- **Web Service** (Docker) — the Node.js API
- **Static Site** — the React frontend
- **PostgreSQL** — free managed database

> **Redis note:** Render removed Redis from their free tier in 2024. This app works perfectly without Redis — it's only used for optional config caching and falls back to the database automatically when `REDIS_URL` is not set.

> **Free tier note:** Web Services spin down after 15 minutes of inactivity and take ~30s to wake up on the first request. This is fine for internal/demo use. Upgrade to the $7/month Starter plan to keep services always-on.

---

## Prerequisites

1. A **GitHub account** — your code must be in a GitHub repository
2. A **Render account** — sign up free at https://render.com (use "Sign in with GitHub")

---

## Step 1 — Push Your Code to GitHub

If you haven't already:

```bash
# In your project root
git init
git add .
git commit -m "Initial commit"

# Create a new repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git branch -M main
git push -u origin main
```

Make sure `.gitignore` excludes secrets. Your `.gitignore` should already have:
```
.env
node_modules/
dist/
```

---

## Step 2 — Create a Render Account

1. Go to https://render.com
2. Click **"Get Started for Free"**
3. Sign in with GitHub (recommended — enables auto-deploy on push)

---

## Step 3 — You Already Have the Database ✅

You've already created the PostgreSQL database. Go to it in Render and copy the **"Internal Database URL"** — you'll need it in the next step.

---

## Step 4 — Deploy the Backend API

1. In Render dashboard → click **"New +"** → **"Web Service"**
2. Connect your GitHub repo
3. Fill in:
   - **Name:** `bms-api`
   - **Region:** Same region as your database
   - **Branch:** `main`
   - **Runtime:** **Docker**
   - **Dockerfile Path:** `./apps/api/Dockerfile`
   - **Docker Context:** `.` (the root — important!)
   - **Plan:** Free
4. Under **"Environment Variables"**, add these:

   | Key | Value |
   |-----|-------|
   | `NODE_ENV` | `production` |
   | `PORT` | `3000` |
   | `DATABASE_URL` | *(paste Internal Database URL from Step 3)* |
   | `JWT_SECRET` | *(click "Generate" — Render creates a random secret)* |
   | `COLUMN_ENCRYPTION_KEY` | *(64 hex chars — see below)* |
   | `FRONTEND_URL` | `https://bms-web.onrender.com` *(update after Step 6)* |

   > `REDIS_URL` is **not needed** — skip it entirely.

   **Generate COLUMN_ENCRYPTION_KEY** — run this on your local machine:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Copy the 64-character output and paste it as the value.

5. Click **"Create Web Service"**
6. Render builds the Docker image and deploys (~5–10 minutes first time)
7. Once deployed, **copy your API URL** (e.g. `https://bms-api.onrender.com`)

---

## Step 5 — Run Database Migrations

After the API deploys, run migrations to create all tables and seed data.

1. In Render dashboard → click on `bms-api` service
2. Click the **"Shell"** tab (in the top navigation of the service page)
3. In the shell, run:
   ```bash
   npm run migrate
   ```
4. You should see all 49 migrations complete successfully
5. The database now has all tables + seed data (superadmin and admin accounts)

---

## Step 6 — Deploy the Frontend

1. In Render dashboard → click **"New +"** → **"Static Site"**
2. Connect your GitHub repo
3. Fill in:
   - **Name:** `bms-web`
   - **Branch:** `main`
   - **Build Command:** `npm install && VITE_API_URL=https://YOUR-API-URL.onrender.com npm run build --workspace=apps/web`
     > Replace `YOUR-API-URL` with your actual API service name from Step 4.
     > Example: `npm install && VITE_API_URL=https://bms-api-gwf2.onrender.com npm run build --workspace=apps/web`
   - **Publish Directory:** `apps/web/dist`
4. Under **"Environment Variables"**, also add (as a backup):

   | Key | Value |
   |-----|-------|
   | `VITE_API_URL` | `https://YOUR-API-URL.onrender.com` |

   > ⚠️ **Critical:** Vite bakes environment variables into the bundle at **build time**. Simply setting `VITE_API_URL` as a runtime env var is NOT enough — it must be present when `vite build` runs. That's why it's in the build command above.

5. Click **"Create Static Site"**
6. Render builds the React app (~3 minutes)
7. Your frontend URL will be something like `https://bms-web.onrender.com`

---

## Step 7 — Update FRONTEND_URL in the API

Now that you have the real frontend URL:

1. Go to `bms-api` service → **"Environment"** tab
2. Update `FRONTEND_URL` to your actual frontend URL (no trailing slash)
   - Example: `https://bms-web.onrender.com`
3. Click **"Save Changes"** — the API redeploys automatically (~2 minutes)

---

## Step 8 — Test Your Deployment

1. Open your frontend URL in a browser (e.g. `https://bms-web.onrender.com`)
2. Login with:
   - **Username:** `superadmin` | **Password:** `password` | **Branch:** Main Branch
   - **Username:** `admin` | **Password:** `password` | **Branch:** Main Branch
3. Verify the dashboard loads and you can navigate all modules

> **First load may take 30 seconds** if the free-tier service has spun down. This is normal — just wait and refresh.

---

## Auto-Deploy on Push

Once connected to GitHub, every `git push` to `main` automatically:
1. Rebuilds the Docker image (API)
2. Rebuilds the React app (Frontend)
3. Deploys both — no manual steps needed

---

## Environment Variables Summary

| Variable | Where | Required | Description |
|----------|-------|----------|-------------|
| `DATABASE_URL` | API | ✅ Yes | PostgreSQL connection string |
| `JWT_SECRET` | API | ✅ Yes | Secret for signing JWTs (keep secret!) |
| `COLUMN_ENCRYPTION_KEY` | API | ✅ Yes | 64-char hex key for AES-256-GCM encryption |
| `NODE_ENV` | API | ✅ Yes | Set to `production` |
| `PORT` | API | ✅ Yes | `3000` |
| `FRONTEND_URL` | API | ✅ Yes | Your frontend URL (for CORS) |
| `VITE_API_URL` | Frontend | ✅ Yes | Your API URL (set at build time) |
| `REDIS_URL` | API | ❌ No | Optional — app works without it |

---

## Troubleshooting

**"Application failed to respond" / API won't start**
- Check the Render logs for the `bms-api` service (Logs tab)
- Most common cause: `DATABASE_URL` is wrong or migrations haven't run yet
- Make sure you used the **Internal** Database URL (not the External one)

**"CORS error" in browser console**
- Make sure `FRONTEND_URL` in the API exactly matches your frontend URL (no trailing slash)
- Redeploy the API after updating the env var

**"Cannot connect to database"**
- Internal URLs only work between Render services in the **same region**
- Make sure API and database are in the same region

**Migrations failed**
- Run them again from the Shell tab
- Check that `DATABASE_URL` is set correctly in the API env vars

**Frontend shows blank page or branch dropdown is empty**
- Open browser DevTools → Network tab — check what URL the `/branches/public` request goes to
- If it's hitting `https://bms-web.onrender.com/api/...` instead of your API URL, `VITE_API_URL` wasn't set at build time
- Fix: Go to the `bms-web` Static Site → Settings → Build & Deploy → update the **Build Command** to include `VITE_API_URL=https://YOUR-API-URL.onrender.com` before `npm run build`
- Then trigger a **Manual Deploy** from the Render dashboard
- After changing env vars, trigger a manual redeploy of the Static Site

**Login works but pages show errors**
- Migrations may not have run — go to Shell and run `npm run migrate` again

---

## Security Checklist Before Sharing with Users

- [ ] Change default passwords for `superadmin` and `admin` accounts (via My Profile page)
- [ ] `JWT_SECRET` is set to a generated random value (not the dev default)
- [ ] `COLUMN_ENCRYPTION_KEY` is set to a proper 64-char hex value
- [ ] `FRONTEND_URL` is set to your exact frontend domain
- [ ] Review and remove any test staff accounts

---

## Upgrading from Free Tier (When Ready)

| Service | Free | Starter | Benefit |
|---------|------|---------|---------|
| API (Web Service) | Spins down | $7/month | Always-on, no cold starts |
| Database | 90-day limit | $7/month | Persistent, no expiry |

Total for always-on: ~$14/month.
