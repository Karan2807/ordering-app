# 🛒 Apna Bazar Ordering App — Complete Setup Guide for a New Computer

This guide is written so that **anyone**, even with **zero technical experience**, can set up, run, and deploy this project on a brand-new computer. Just follow the steps **in order**, top to bottom. Every step tells you exactly what to click.

> 💡 **Tip:** Keep this document open on your phone or a second screen while you follow the steps on your computer.

---

## 📌 What is this project?

This is the **Apna Bazar Stores Ordering App** — a website where store managers place vegetable/grocery orders and admins manage them. It has two parts:

| Part | What it does | Where it lives online |
|---|---|---|
| **Frontend** (the website people see) | The login page, order forms, dashboards | Hosted on **GoDaddy** at [https://apnabazarstoresordering.com/](https://apnabazarstoresordering.com/) |
| **Backend** (the "engine" behind the scenes) | Saves orders, sends emails, checks passwords | Hosted on **Render** |
| **Database** (where all data is stored) | Stores users, items, orders, suppliers | Hosted on **MongoDB Atlas** |

---

## 🔑 All Account Credentials (Keep this table private!)

⚠️ **IMPORTANT SECURITY NOTE:** This table contains real passwords for real accounts. Do **not** upload this file to a public GitHub repository, do not share it outside your team, and do not post it anywhere online. Treat it like you would treat your online banking password.

| # | Service | Used For | Username / Login | Password / Key | Notes |
|---|---|---|---|---|---|
| 1 | **GitHub Repository** | Where all the project's code is stored and downloaded from | [https://github.com/Karan2807/ordering-app](https://github.com/Karan2807/ordering-app) | — (sign in with your own personal GitHub account) | This is not a login — it's just the web address of the code. See [Step 6](#step-6-clone-download-the-project-from-github) |
| 2 | **Gmail** | Main email account for the business; used to log into Render & GoDaddy; used to send order emails | Username: `apnabazarstores5@gmail.com` | Password: `Apna@gmail123` | This is the main "master" account — you'll use it for almost everything below |
| 3 | **Gmail App Password** (for sending automated emails from the backend) | Lets the backend server send emails through Gmail without using the real password | Username: `apnabazarstores5@gmail.com` | App Password: `kjlj uxo kwzf jwyw` *(enter with or without spaces — Google ignores spaces)* | If this stops working, generate a new one — see [Step 8](#step-8-set-up-gmail-app-password-for-automatic-emails) |
| 4 | **MongoDB Atlas** (database user) | Cloud database that stores all app data (orders, users, items, etc.) | Username: `apnabazarstores5_db_user` | Password: `rJGiEHMXdxCBZVFp` | This is a *database user*, not the same as your Atlas account login. Log into Atlas itself using the Gmail above |
| 5 | **Render** | Hosts the backend (the "brains" of the app) | Sign in with Google → `apnabazarstores5@gmail.com` | (same Gmail password above) | Render will ask you to "Sign in with Google" — just pick this Gmail account |
| 6 | **GoDaddy** | Owns the domain name and hosts the website files | Sign in with Google → `apnabazarstores5@gmail.com` | (same Gmail password above) | Also where you manage the domain `apnabazarstoresordering.com` |
| 7 | **Live Website** | The actual ordering portal customers/staff use | [https://apnabazarstoresordering.com/](https://apnabazarstoresordering.com/) | — | This is the finished, live app |
| 8 | **Sample Store Login** (for testing the live app) | A demo store-manager account to test placing orders | Username: `bothell` | Password: `pass123` | Use this to log into the live site and test that everything works |
| 9 | **Microsoft Azure / Outlook Email** (optional, used only if sending vendor emails through Outlook/Microsoft 365 instead of Gmail) | Lets the backend send emails through an Outlook / Microsoft 365 mailbox | Tenant ID: *(not yet created)* • Client ID: *(not yet created)* | Client Secret: *(not yet created)* | These four values don't exist yet — you (or an admin) must create them once in the Azure Portal. See [Step 8B](#step-8b-optional-set-up-outlookmicrosoft-365-email-via-azure) |

---

## 🧰 Part 1 — Install the Basic Tools

You only need to do Part 1 **once** per computer.

### Step 1: Install Visual Studio Code (the code editor)

1. Go to [https://code.visualstudio.com](https://code.visualstudio.com)
2. Click the big blue **Download** button (it detects Windows/Mac automatically)
3. Open the downloaded file and click **Next → Next → Install → Finish** (keep all default options checked, especially "Add to PATH")

### Step 2: Install Node.js (lets the app run on your computer)

1. Go to [https://nodejs.org](https://nodejs.org)
2. Click the button that says **LTS** (the recommended version)
3. Open the downloaded installer and click **Next → Next → Install → Finish**
4. To check it worked, open VS Code, then open its built-in terminal:
   - Click **Terminal** (top menu) → **New Terminal**
   - Type `node --version` and press Enter — you should see something like `v20.11.0`
   - Type `npm --version` and press Enter — you should see a number like `10.2.4`

### Step 3: Install Git (lets you download/update the project code)

1. Go to [https://git-scm.com/downloads](https://git-scm.com/downloads)
2. Download the version for your operating system and run the installer
3. Click **Next** through all the screens using the default options, then **Install → Finish**
4. In the VS Code terminal, type `git --version` and press Enter — you should see a version number

### Step 4: Sign in to GitHub (where the project's code lives)

1. If you don't already have one, create a free account at [https://github.com](https://github.com)
2. In VS Code, click the **Accounts icon** (bottom-left corner, looks like a small person icon)
3. Click **Sign in with GitHub** and follow the on-screen prompts (it opens your browser to log in, then returns you to VS Code)

### Step 5: Sign in to GitHub Copilot in VS Code (your AI coding assistant)

1. Make sure you completed Step 4 (signed into GitHub) first
2. In VS Code, click the **Copilot icon** in the top-right corner (or press `Ctrl+Alt+I` to open Copilot Chat)
3. If prompted, click **Sign in to use Copilot**
4. Your browser will open — log in with the same GitHub account and click **Authorize**
5. Return to VS Code — you should now see the Copilot Chat panel ready to use

> 📝 Note: Using Copilot requires an active GitHub Copilot subscription (individual, business, or the free tier) on that GitHub account.

---

## 📥 Part 2 — Get the Project Code

### Step 6: Clone (download) the project from GitHub

1. Open VS Code
2. Click **Terminal → New Terminal**
3. Decide where you want the project folder to live (e.g., Desktop), then type:
   ```bash
   cd Desktop
   git clone https://github.com/Karan2807/ordering-app.git
   ```
   This downloads ("clones") a full copy of the project from [https://github.com/Karan2807/ordering-app](https://github.com/Karan2807/ordering-app) onto your computer, inside a new folder named `ordering-app`.
4. Once it finishes downloading, open the folder in VS Code:
   - Click **File → Open Folder**
   - Select the `ordering-app` folder that was just downloaded
   - Click **Select Folder**

You should now see the project structure in the left sidebar, including a `server` folder and an `ordermanager-deploy` folder.

---

## 🗄️ Part 3 — Set Up the Database (MongoDB Atlas)

### Step 7: Get your database connection string

1. Go to [https://www.mongodb.com/cloud/atlas/login](https://www.mongodb.com/cloud/atlas/login)
2. Log in using the Gmail account from the credentials table (`apnabazarstores5@gmail.com`)
3. Once inside, click on your **Cluster** (the database project)
4. Click the **Connect** button
5. Choose **Drivers** (or "Connect your application")
6. Copy the connection string shown — it looks like:
   ```
   mongodb+srv://apnabazarstores5_db_user:<password>@yourcluster.mongodb.net/?retryWrites=true&w=majority
   ```
7. Replace `<password>` with the real database password from the credentials table: `rJGiEHMXdxCBZVFp`
8. Add the database name right after `.net/` and before the `?`, so it reads:
   ```
   mongodb+srv://apnabazarstores5_db_user:rJGiEHMXdxCBZVFp@yourcluster.mongodb.net/ordermanager?retryWrites=true&w=majority
   ```
9. **Keep this full string safe** — you'll paste it into a settings file in Step 9

> 🔒 **Network Access:** If you ever get a "connection refused" error, go to **Security → Network Access** in Atlas and make sure your current IP (or `0.0.0.0/0` for "allow from anywhere," used when hosting on Render) is in the allow-list.

---

## ⚙️ Part 4 — Set Up the Backend (the "engine")

### Step 8: Set up Gmail App Password for automatic emails

The app needs to send emails (like order confirmations) automatically using Gmail. For security, Gmail requires a special 16-character "app password" instead of your normal password.

1. Log into [https://myaccount.google.com](https://myaccount.google.com) with `apnabazarstores5@gmail.com`
2. Make sure **2-Step Verification** is turned on (Security tab) — it's required for app passwords
3. Go to **Security → App passwords** (or search "App Passwords" in the search bar at the top)
4. Create a new app password, name it something like "OrderApp Backend"
5. Google will show you a 16-character password — this is the same type of value already recorded in the credentials table (`kjlj uxo kwzf jwyw`). If that one no longer works, generate a fresh one and update your `.env` file (next step) with the new value

### Step 8B: (Optional) Set up Outlook/Microsoft 365 Email via Azure

> ℹ️ Skip this step if you're only using Gmail to send emails (Step 8 above). This step is only needed if the business wants order/vendor emails to be sent from an **Outlook** or **Microsoft 365** mailbox instead of, or in addition to, Gmail. It is more advanced than the Gmail setup, so take it slowly and follow every click.

This app can send emails through Microsoft's servers using something called an "Azure App Registration." Think of it as creating a special ID card and secret password that lets the backend server say "I'm allowed to send email as this Outlook mailbox" without ever knowing the mailbox's real password.

1. Go to [https://portal.azure.com](https://portal.azure.com) and sign in with the **Microsoft/Outlook account** that owns (or manages) the mailbox you want to send emails from
2. In the search bar at the top, type **App registrations** and open it
3. Click **+ New registration**
   - Name: type something like `OrderApp Mailer`
   - Supported account types: leave the default ("Accounts in this organizational directory only")
   - Click **Register**
4. On the app's **Overview** page, you'll now see two values you need to copy — these act like a **Username** (not secret, but still copy them carefully):
   - **Application (client) ID** → this is your `CLIENT_ID`
   - **Directory (tenant) ID** → this is your `TENANT_ID`
5. In the left menu, click **Certificates & secrets** → **+ New client secret**
   - Add a description like `OrderApp Secret`, choose an expiry (e.g., 24 months), click **Add**
   - Immediately copy the **Value** column (not the "Secret ID") — this is shown **only once** and acts like a **Password**. This becomes your `CLIENT_SECRET`
6. In the left menu, click **API permissions** → **+ Add a permission**
   - Choose **Microsoft Graph** → **Application permissions**
   - Search for and check **Mail.Send**
   - Click **Add permissions**
   - Click the **Grant admin consent** button (you must be an admin, or ask your Microsoft 365 administrator to click this) — this step is required or emails will fail to send
7. Decide which mailbox will actually send the emails (e.g., `orders@yourdomain.com`) — this becomes your `SENDER_EMAIL`
8. Add these values to your `server/.env` file (see Step 9 below) and also to Render's Environment Variables (see Step 13) if deploying live:
   ```
   TENANT_ID=paste-your-directory-tenant-id-here
   CLIENT_ID=paste-your-application-client-id-here
   CLIENT_SECRET=paste-your-client-secret-value-here
   SENDER_EMAIL=orders@yourdomain.com
   GRAPH_SCOPE=https://graph.microsoft.com/.default
   ```

| Value (like a...) | What it means in plain English | Where you got it |
|---|---|---|
| `TENANT_ID` (Username-like ID) | The ID of your organization's Microsoft account | Azure Portal → App registration → Overview |
| `CLIENT_ID` (Username-like ID) | The ID of the "app" you just registered | Azure Portal → App registration → Overview |
| `CLIENT_SECRET` (Password) | The secret password for that app | Azure Portal → Certificates & secrets |
| `SENDER_EMAIL` | The Outlook/Microsoft 365 mailbox address that emails will appear to come from | Decided by your business (e.g., `orders@yourdomain.com`) |

> 🔒 Treat `CLIENT_SECRET` exactly like a password — never share it or commit it to GitHub. If it expires or is lost, just repeat step 5 above to create a new one.

### Step 9: Create the backend settings file (`.env`)

1. In VS Code's sidebar, open the `server` folder
2. Right-click inside the `server` folder → **New File** → name it exactly `.env`
3. Paste the following into it, filling in the real values:

   ```
   PORT=5000
   NODE_ENV=development
   MONGODB_URI=mongodb+srv://apnabazarstores5_db_user:rJGiEHMXdxCBZVFp@yourcluster.mongodb.net/ordermanager?retryWrites=true&w=majority
   JWT_SECRET=choose-any-long-random-sentence-here
   GMAIL_USER=apnabazarstores5@gmail.com
   GMAIL_PASS=kjljuxokwzfjwyw
   EMAIL_FROM=apnabazarstores5@gmail.com
   ```
   - `MONGODB_URI` — paste the full connection string you built in Step 7
   - `JWT_SECRET` — any random long text (this scrambles login sessions securely — just make it long and unique)
   - `GMAIL_USER` / `GMAIL_PASS` — from the credentials table (remove spaces from the app password)
4. Save the file (`Ctrl+S`)

### Step 10: Install and run the backend

1. In the VS Code terminal, type:
   ```bash
   cd server
   npm install
   ```
   This downloads everything the backend needs (only required once, or after updates).
2. Start the backend:
   ```bash
   npm run dev
   ```
3. You should see messages like:
   ```
   ✓ Database initialized
   ✓ Server running on http://localhost:5000
   ```
4. Leave this terminal window running in the background while you test the app.

---

## 💻 Part 5 — Set Up the Frontend (the website part)

### Step 11: Configure the frontend to talk to your backend

1. Open a **second terminal** in VS Code (click the `+` icon in the terminal panel)
2. Navigate to the frontend folder:
   ```bash
   cd ordermanager-deploy/ordermanager-deploy
   ```
3. This folder already has a file called `.env.development` used for local testing, pointing to `http://localhost:5000/api` — no changes needed for local testing.

### Step 12: Install and run the frontend

1. In that same terminal, type:
   ```bash
   npm install
   npm run dev
   ```
2. You'll see a message like:
   ```
   Local:   http://localhost:5173/
   ```
3. Hold `Ctrl` and click that link (or copy it into your browser) to open the app
4. Log in using the sample store login from the credentials table:
   - Username: `bothell`
   - Password: `pass123`

If you see the ordering dashboard, your local setup works! 🎉

---

## ☁️ Part 6 — Deploying to the Internet (so real users can access it)

You only need this part when you want to publish changes live. If you're just testing locally, you can stop here.

### Step 13: Deploy the backend to Render

1. Go to [https://render.com](https://render.com) and click **Sign in**
2. Choose **Sign in with Google** and select `apnabazarstores5@gmail.com`
3. Click **New → Web Service**
4. Connect your GitHub account (if not already connected) and select the `ordering-app` repository
5. Fill in these settings:

   | Setting | Value |
   |---|---|
   | Root Directory | `server` |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Instance Type | Free (or paid, for better uptime) |

6. Under **Environment Variables**, add the same values from your `.env` file (Step 9): `MONGODB_URI`, `JWT_SECRET`, `GMAIL_USER`, `GMAIL_PASS`, `EMAIL_FROM`, and also add:
   ```
   NODE_ENV=production
   CLIENT_ORIGIN=https://apnabazarstoresordering.com
   ```
7. Click **Create Web Service**. Render will build and start the backend automatically. Once it's live, you'll get a URL like `https://ordering-app-uu24.onrender.com`

### Step 14: Point the frontend to the live backend

1. Back in VS Code, open `ordermanager-deploy/ordermanager-deploy/.env.production`
2. Make sure it contains your Render backend URL followed by `/api`:
   ```
   VITE_API_URL=https://ordering-app-uu24.onrender.com/api
   ```

### Step 15: Build the frontend for production

1. In the terminal (inside `ordermanager-deploy/ordermanager-deploy`), run:
   ```bash
   npm run build
   ```
2. This creates a new `dist` folder containing the final website files (HTML, CSS, JS) ready to upload.

### Step 16: Upload the website files to GoDaddy

1. Go to [https://www.godaddy.com](https://www.godaddy.com) and sign in
2. Choose **Sign in with Google** → `apnabazarstores5@gmail.com`
3. Go to **My Products → Web Hosting → Manage**
4. Open **File Manager** (sometimes found inside cPanel)
5. Navigate to the `public_html` folder — this is the root of your website `apnabazarstoresordering.com`
6. Delete or back up any old app files there (but never touch `wp-admin`, `wp-content`, or `wp-*` files if WordPress is also installed)
7. Click **Upload**, then upload **everything inside** your local `dist` folder (not the `dist` folder itself — its *contents*: `index.html`, the `assets` folder, etc.)
8. If a `.htaccess` file exists inside `dist`, upload that too — it prevents "404 Not Found" errors when users refresh the page

### Step 17: Verify the live site

1. Open a browser and go to [https://apnabazarstoresordering.com/](https://apnabazarstoresordering.com/)
2. Log in with the sample store login (`bothell` / `pass123`) or an admin account to confirm everything works
3. Place a test order to confirm the backend + database + email are all connected properly

---

## 🆘 Troubleshooting Cheat-Sheet

| Problem | Likely Cause | Fix |
|---|---|---|
| Blank white page on the live site | Old cached files, or wrong backend URL | Hard refresh (`Ctrl+F5`); double-check `VITE_API_URL` in `.env.production` before building |
| "Cannot connect to database" | Wrong Mongo password, or IP not allowed | Re-check `MONGODB_URI` in Render's environment variables; in Atlas, allow access from `0.0.0.0/0` |
| Emails aren't sending (Gmail) | Gmail app password expired/revoked | Generate a new App Password in Google Account → Security, update `GMAIL_PASS` on Render, then redeploy |
| Emails aren't sending (Outlook/Azure) | `CLIENT_SECRET` expired, or admin consent wasn't granted | In Azure Portal, create a new client secret (Step 8B) and update `CLIENT_SECRET` on Render; confirm **Grant admin consent** was clicked under API permissions |
| Login fails on live site but works locally | `CLIENT_ORIGIN` not set correctly on Render, blocking requests (CORS error) | In Render env vars, set `CLIENT_ORIGIN=https://apnabazarstoresordering.com` and redeploy |
| Refreshing a page on the live site shows 404 | Missing `.htaccess` file on GoDaddy | Re-upload the `.htaccess` file from the `dist` folder into `public_html` |
| Backend goes to sleep / slow to respond | Free-tier Render services "sleep" after inactivity | Upgrade to a paid Render plan, or simply wait ~30-60 seconds for it to wake up |
| Copilot not responding in VS Code | Not signed in, or subscription inactive | Click the Accounts icon (bottom-left) → make sure you're signed into the right GitHub account with an active Copilot plan |

---

## ✅ Quick Recap Checklist

- [ ] VS Code installed
- [ ] Node.js installed
- [ ] Git installed
- [ ] Signed into GitHub in VS Code
- [ ] Signed into GitHub Copilot in VS Code
- [ ] Project cloned from GitHub
- [ ] Logged into MongoDB Atlas and got the connection string
- [ ] Created `server/.env` file with database, JWT, and Gmail settings
- [ ] Backend runs locally (`npm run dev` inside `server`)
- [ ] Frontend runs locally (`npm run dev` inside `ordermanager-deploy/ordermanager-deploy`)
- [ ] Backend deployed to Render
- [ ] Frontend built (`npm run build`) and uploaded to GoDaddy `public_html`
- [ ] Live site tested at [https://apnabazarstoresordering.com/](https://apnabazarstoresordering.com/)

---

*Keep this document somewhere safe and private — it contains real login credentials for your business accounts.*
