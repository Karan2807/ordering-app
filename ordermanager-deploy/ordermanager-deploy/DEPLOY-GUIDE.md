# OrderManager — GoDaddy WordPress Deployment Guide

**Version 3.1.0**
_Last updated February 2026_

## Overview

Your OrderManager app is a React application that needs to be **built** into static files (HTML, JS, CSS), then uploaded to a subdirectory on your GoDaddy hosting. It will run **independently** from WordPress at a URL like `yourdomain.com/orders/`.

> ⚙️ The frontend communicates with a backend API; set the API base URL in `VITE_API_URL` before building. The backend itself is configured via environment variables (see `/server/.env.example`).

---

## Prerequisites

You need **Node.js** (v18+) installed on your local computer.

- **Windows**: Download from https://nodejs.org → choose LTS version
- **Mac**: `brew install node` or download from https://nodejs.org

Verify installation:
```bash
node --version    # Should show v18.x or higher
npm --version     # Should show 9.x or higher
```

---

## Step 1: Build the App Locally

1. Download and unzip the `ordermanager-deploy.zip` file

2. Open Terminal (Mac) or Command Prompt (Windows) and navigate to the folder:
```bash
cd ordermanager-deploy
```

3. Install dependencies:
```bash
npm install
```

4. **Edit the base path** in `vite.config.js` (line 9) if you intend to deploy under a folder other than `/orders/`:
```js
base: '/orders/',   // ← Change this to match your desired URL path
```
Also be sure to set `VITE_API_URL` in your `.env` before running the build (e.g. `VITE_API_URL=https://api.yourdomain.com/api`).
For example:
| You want the URL to be...         | Set base to...  |
|-----------------------------------|-----------------|
| `yourdomain.com/orders/`          | `'/orders/'`    |
| `yourdomain.com/app/`             | `'/app/'`       |
| `yourdomain.com/ordermanager/`    | `'/ordermanager/'` |

5. Build the production files:
```bash
npm run build
```

6. This creates a `dist/` folder containing your ready-to-deploy files:
```
dist/
├── index.html
├── assets/
│   ├── index-XXXX.js      (your bundled app)
│   └── index-XXXX.css     (your styles)
```

7. **(Optional)** Test locally before uploading:
```bash
npm run preview
```
Open the URL shown in terminal (usually `http://localhost:4173/orders/`)

---

## Step 2: Create the Directory on GoDaddy

### Option A: Via GoDaddy File Manager (Easiest)

1. Log in to your **GoDaddy account** → My Products → your hosting plan → **Manage**
2. Click **File Manager** (under cPanel or Hosting Dashboard)
3. Navigate to `public_html/`
4. Click **+ Folder** → name it `orders` (or whatever you chose as base path)

### Option B: Via FTP

1. In your GoDaddy hosting dashboard, find your **FTP credentials**
   - Host: usually `ftp.yourdomain.com`
   - Username & Password: shown in dashboard
   - Port: `21`
2. Use an FTP client like **FileZilla** (free, download from https://filezilla-project.org)
3. Connect and navigate to `/public_html/`
4. Create the `orders` directory

---

## Step 3: Upload the Built Files

### Via File Manager:

1. Open the `orders` folder you just created
2. Click **Upload**
3. Upload the **contents** of your local `dist/` folder:
   - `index.html` → upload to `/public_html/orders/`
   - `assets/` folder → upload entire folder to `/public_html/orders/assets/`
4. Also upload the `.htaccess` file to `/public_html/orders/`

Your directory should look like:
```
public_html/
├── wp-content/       ← your WordPress stuff (don't touch)
├── wp-admin/
├── index.php
└── orders/           ← your new folder
    ├── .htaccess
    ├── index.html
    └── assets/
        ├── index-abc123.js
        └── index-abc123.css
```

### Via FTP (FileZilla):

1. In the left panel (local), navigate to your `dist/` folder
2. In the right panel (remote), navigate to `/public_html/orders/`
3. Select all files/folders in `dist/` and drag to the right panel
4. Also upload the `.htaccess` file

---

## Step 4: Verify

Open your browser and go to:
```
https://yourdomain.com/orders/
```

You should see the OrderManager login page. Test with `admin / admin123`.

---

## Linking from WordPress (Optional)

To add a link to OrderManager from your WordPress site:

### Option 1: Menu Link
1. WordPress Admin → **Appearance** → **Menus**
2. Add a **Custom Link**:
   - URL: `https://yourdomain.com/orders/`
   - Link Text: `Order Manager`
3. Save Menu

### Option 2: Embed in a Page via iframe
1. Create a new **Page** in WordPress
2. Switch to **HTML/Code editor**
3. Add:
```html
<iframe 
  src="/orders/" 
  style="width: 100%; height: 90vh; border: none;"
  title="Order Manager">
</iframe>
```
4. Publish

### Option 3: Button/Link in any page
```html
<a href="/orders/" target="_blank" 
   style="display:inline-block; padding:12px 24px; background:#4F8CFF; color:#fff; border-radius:8px; text-decoration:none; font-weight:bold;">
  Open Order Manager
</a>
```

---

## Updating the App

When you get an updated `OrderManager.jsx` from Claude:

1. Replace `src/OrderManager.jsx` with the new file
2. Run `npm run build` again
3. Upload the new `dist/` contents to GoDaddy (overwrite existing files)

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Blank page | Check `base` in `vite.config.js` matches your folder name exactly |
| 404 errors on assets | Make sure the `assets/` folder was uploaded inside `orders/` |
| Page works but refreshing gives 404 | Upload the `.htaccess` file to the `orders/` directory |
| WordPress login page shows instead | Make sure folder name doesn't conflict with WP routes (avoid `admin`, `login`, `wp-*`) |
| Can't find File Manager | In GoDaddy, go to: My Products → Hosting → Manage → cPanel → File Manager |

---

## Security Note

This app currently stores data **in-memory only** (it resets when you refresh the page). For production use with real persistent data, you would need a backend/database. The current version is ideal for:
- Demo / evaluation purposes
- Training staff on the ordering workflow
- Planning your order process before investing in a full backend

When you're ready for persistent data, consider connecting it to a backend like Firebase, Supabase, or a custom API.
