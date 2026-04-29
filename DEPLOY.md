# Deployment Guide — Bakos Bookstore ERP

## Platform: Render.com (100% Free)

Render offers a free tier that covers everything this app needs:
- **Web Service** (Docker) — the Node.js API
- **Static Site** — the React frontend
- **PostgreSQL** — free managed database (90-day retention on free tier)
- **Redis** — free managed Redis

> **Free tier note:** Services spin down after 15 minutes of inactivity and take ~30s to wake up on the first request. This is fine for internal/demo use. Upgrade to the $7/month Starter plan to keep services always-on.

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

## Step 3 — Deploy the Database (PostgreSQL)

1. In Render dashboard → click **"New +"** → **"PostgreSQL"**
2. Fill in:
   - **Name:** `bms-db`
   - **Database:** `bms`
   - **User:** `bms`
   - **Region:** Choose closest to you (e.g. Frankfurt for Ethiopia)
   - **Plan:** Free
3. Click **"Create Database"**
4. Wait ~2 minutes for it to provision
5. **Copy the "Internal Database URL"** — you'll need it in Step 5

---

## Step 4 — Deploy Redis

1. In Render dashboard → click **"New +"** → **"Redis"**
2. Fill in:
   - **Name:** `bms-redis`
   - **Plan:** Free
   - **Region:** Same as your database
3. Click **"Create Redis"**
4. **Copy the "Internal Redis URL"** — you'll need it in Step 5

---

## Step 5 — Deploy the Backend API

1. In Render dashboard → click **"New +"** → **"Web Service"**
2. Connect your GitHub repo
3. Fill in:
   - **Name:** `bms-api`
   - **Region:** Same as database
   - **Branch:** `main`
   - **Runtime:** **Docker**
   - **Dockerfile Path:** `./apps/api/Dockerfile`
   - **Docker Context:** `.` (the root)
   - **Plan:** Free
4. Under **"Environment Variables"**, add:

   | Key | Value |
   |-----|-------|
   | `NODE_ENV` | `production` |
   | `PORT` | `3000` |
   | `DATABASE_URL` | *(paste Internal Database URL from Step 3)* |
   | `REDIS_URL` | *(paste Internal Redis URL from Step 4)* |
   | `JWT_SECRET` | *(click "Generate" — Render creates a random secret)* |
   | `COLUMN_ENCRYPTION_KEY` | *(64 hex chars — generate with command below)* |
   | `FRONTEND_URL` | `https://bms-web.onrender.com` *(update after Step 6)* |

   **Generate COLUMN_ENCRYPTION_KEY** (run this on your local machine):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Copy the output (64 hex characters) and paste it as the value.

5. Click **"Create Web Service"**
6. Render will build the Docker image and deploy (~5 minutes)
7. Once deployed, **copy your API URL** (e.g. `https://bms-api.onrender.com`)

---

## Step 6 — Run Database Migrations

After the API deploys, you need to run migrations to create all tables.

1. In Render dashboard → click on `bms-api` service
2. Click **"Shell"** tab (top right)
3. In the shell, run:
   ```bash
   npm run migrate
   ```
4. You should see all 30 migrations run successfully
5. The database is now ready with all tables and seed data (superadmin/admin accounts)

---

## Step 7 — Deploy the Frontend

1. In Render dashboard → click **"New +"** → **"Static Site"**
2. Connect your GitHub repo
3. Fill in:
   - **Name:** `bms-web`
   - **Branch:** `main`
   - **Build Command:** `npm install && npm run build --workspace=apps/web`
   - **Publish Directory:** `apps/web/dist`
4. Under **"Environment Variables"**, add:

   | Key | Value |
   |-----|-------|
   | `VITE_API_URL` | `https://bms-api.onrender.com` *(your API URL from Step 5)* |

5. Click **"Create Static Site"**
6. Render builds the React app (~3 minutes)
7. Your frontend URL will be `https://bms-web.onrender.com`

---

## Step 8 — Update FRONTEND_URL in the API

Now that you have the frontend URL:

1. Go to `bms-api` service → **"Environment"** tab
2. Update `FRONTEND_URL` to your actual frontend URL (e.g. `https://bms-web.onrender.com`)
3. Click **"Save Changes"** — the API will redeploy automatically

---

## Step 9 — Test Your Deployment

1. Open `https://bms-web.onrender.com` in your browser
2. Login with:
   - **Username:** `superadmin` | **Password:** `password` | **Branch:** Main Branch
   - **Username:** `admin` | **Password:** `password` | **Branch:** Main Branch
3. Verify the dashboard loads and you can navigate all modules

> **First load may take 30 seconds** if the free-tier service has spun down. This is normal.

---

## Auto-Deploy on Push

Once connected to GitHub, every `git push` to `main` automatically:
1. Rebuilds the Docker image (API)
2. Rebuilds the React app (Frontend)
3. Deploys both with zero downtime

---

## Environment Variables Summary

| Variable | Where | Description |
|----------|-------|-------------|
| `DATABASE_URL` | API | PostgreSQL connection string |
| `REDIS_URL` | API | Redis connection string |
| `JWT_SECRET` | API | Secret for signing JWTs (keep secret!) |
| `COLUMN_ENCRYPTION_KEY` | API | 64-char hex key for AES-256-GCM encryption |
| `NODE_ENV` | API | Set to `production` |
| `PORT` | API | `3000` |
| `FRONTEND_URL` | API | Your frontend URL (for CORS) |
| `VITE_API_URL` | Frontend | Your API URL (set at build time) |

---

## Troubleshooting

**"Application failed to respond"**
- Check the Render logs for the API service
- Most common cause: `DATABASE_URL` is wrong or migrations haven't run

**"CORS error" in browser console**
- Make sure `FRONTEND_URL` in the API matches your exact frontend URL (no trailing slash)
- Redeploy the API after updating the env var

**"Cannot connect to database"**
- Make sure you used the **Internal** Database URL (not the External one)
- Internal URLs only work between Render services in the same region

**Migrations failed**
- Run them again from the Shell tab
- Check that `DATABASE_URL` is set correctly

**Frontend shows blank page**
- Check browser console for errors
- Make sure `VITE_API_URL` is set correctly (no trailing slash)
- Rebuild the static site after updating env vars

---

## Upgrading from Free Tier

When you're ready to go production:
- **API:** Upgrade to Starter ($7/month) — always-on, no spin-down
- **Database:** Upgrade to Starter ($7/month) — persistent storage, no 90-day limit
- **Redis:** Upgrade to Starter ($10/month) — persistent, no data loss on restart

Total cost for always-on: ~$24/month — still very affordable.

---

## Alternative: Railway.app

If Render doesn't work for you, Railway.app is another free option:
- $5 free credit/month (enough for small usage)
- Supports Docker, PostgreSQL, Redis
- Similar setup process
- Visit https://railway.app

---

## Security Checklist Before Going Live

- [ ] Change default passwords for `superadmin` and `admin` accounts
- [ ] Set a strong, unique `JWT_SECRET` (Render's "Generate" button does this)
- [ ] Set a proper `COLUMN_ENCRYPTION_KEY` (64 random hex chars)
- [ ] Set `FRONTEND_URL` to your exact frontend domain
- [ ] Review staff accounts and remove any test accounts
