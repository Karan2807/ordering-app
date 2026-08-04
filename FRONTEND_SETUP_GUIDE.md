# OrderManager Frontend — Technical Setup & Reference Guide

## Overview

The frontend is a **single-page React application** built with **Vite**. It's the UI store managers, warehouse staff, and admins interact with in the browser. It talks to the backend exclusively over the REST API (see [BACKEND_SETUP_GUIDE.md](BACKEND_SETUP_GUIDE.md)) — it holds no business logic of its own beyond presentation, client-side validation, and document/export generation for the browser (CSV/Excel/DOCX parsing on upload).

- **Location in repo**: `ordermanager-deploy/ordermanager-deploy/`
- **Framework**: React 18 (function components + hooks, no class components)
- **Build tool**: Vite 5
- **Package manager**: npm

---

## Prerequisites

- Node.js 18+ and npm (see [BACKEND_SETUP_GUIDE.md](BACKEND_SETUP_GUIDE.md) for install steps)
- A running backend API (locally on `http://localhost:5000`, or a deployed Render URL)

---

## Project Structure

```
ordermanager-deploy/
└── ordermanager-deploy/
    ├── index.html              # HTML shell, mounts #root
    ├── package.json            # Scripts & dependencies
    ├── vite.config.js          # Build config (base path, chunking, output)
    ├── .env.development        # Local dev API URL (used by `npm run dev`)
    ├── .env.production         # Live API URL (used by `npm run build`)
    ├── .env.example            # Documents the required variable
    └── src/
        ├── main.jsx            # React entry point — renders <App/> inside <AuthProvider/>
        ├── AuthContext.jsx     # Global auth state (user, login, logout, token check on load)
        ├── api.js              # Centralized fetch wrapper + JWT token handling
        └── OrderManager.jsx    # The entire application UI (all pages/components)
```

> 📝 There are two nested `ordermanager-deploy` folders — always `cd` into the **inner** one before running npm commands.

---

## Environment Variables

The frontend reads exactly one environment variable, `VITE_API_URL`, which tells it where the backend API lives.

| File | Used when | Typical value |
|---|---|---|
| `.env.development` | Running `npm run dev` (local dev server) | `http://localhost:5000/api` |
| `.env.production` | Running `npm run build` (production bundle) | `https://ordering-app-uu24.onrender.com/api` |

`src/api.js` resolves the base URL with a safety rule (see `API_BASE_URL` at the top of the file):
- If the page is running on `localhost`/`127.0.0.1`, it always uses (or falls back to) a local backend URL — this prevents accidentally testing against the live production database from a dev environment.
- For any other origin (a real deployed site), `VITE_API_URL` **must** be set, or the app throws an error instead of guessing — this prevents silently pointing a live deployment at the wrong API.

To point the frontend at a different backend, edit the relevant `.env.*` file and restart `npm run dev` (Vite only reads env files at startup).

---

## Local Development

### 1. Install dependencies
```bash
cd ordermanager-deploy/ordermanager-deploy
npm install
```

### 2. Start the dev server
```bash
npm run dev
```
Vite starts on `http://localhost:5173` by default (or the next free port) with hot module reload — most edits to `OrderManager.jsx` appear instantly without a full page refresh.

### 3. Log in
Use one of the seeded demo accounts from the backend (see [BACKEND_SETUP_GUIDE.md](BACKEND_SETUP_GUIDE.md#demo-accounts)), e.g. `admin` / `admin123`.

---

## Key Files Explained

### `src/main.jsx`
The React entry point. Wraps the whole app in `<AuthProvider>` (from `AuthContext.jsx`) so every component can access the logged-in user via context, then renders `OrderManager.jsx` as `<App/>`.

### `src/AuthContext.jsx`
A React Context provider that:
- On first load, checks `localStorage` for a saved JWT token and calls `POST /api/auth/verify` to see if it's still valid, restoring the session automatically
- Exposes `login(username, password)`, `logout()`, `user`, `loading`, and `error` to the rest of the app
- Calls `apiClient.setToken(...)` to persist/clear the token in `localStorage` under the key `authToken`

### `src/api.js`
A single centralized HTTP client (`apiClient`) used by the entire app instead of raw `fetch` calls scattered around components:
- Automatically attaches `Authorization: Bearer <token>` to every request once logged in
- Automatically logs the user out and redirects to `/` if the backend responds `401 Unauthorized` (expired/invalid token)
- Sends/receives JSON by default
- Exposes grouped helpers matching the backend route groups (`apiClient.auth`, `apiClient.orders`, `apiClient.items`, `apiClient.users`, `apiClient.suppliers`, `apiClient.stores`, `apiClient.settings`, `apiClient.notifications`)

### `src/OrderManager.jsx`
The main (and largest) file — it contains essentially the entire UI as one component tree, including:
- **Login screen**
- **Role-aware navigation** (different nav items for `admin`/`warehouse` vs `manager`, built from the `role` on the logged-in user)
- **Dashboard** views (`AdminDash`, manager dashboard) summarizing open order cycles and pending submissions
- **Place Order / Order Monitor / Consolidated / Supplier Orders / Warehouse Inventory / Item Master / Suppliers / Users / Settings** — one component per screen, described in [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md#5-feature-walkthrough-screen-by-screen)
- Client-side helpers for parsing uploaded CSV/Excel/DOCX templates (using the `xlsx` and `mammoth` packages) before sending structured data to the backend
- `sessionStorage`-backed persistence for things like the selected Consolidated view and reopen targets, so a hard refresh doesn't lose the admin's place

---

## Dependencies

| Package | Purpose |
|---|---|
| `react`, `react-dom` | Core UI framework |
| `xlsx` | Parsing/generating Excel files client-side (e.g., previewing an uploaded item template) |
| `mammoth` | Extracting text/structure from uploaded `.docx` supplier templates |
| `vite`, `@vitejs/plugin-react` | Dev server + build tooling (dev dependencies) |

Install/update with `npm install` from the `ordermanager-deploy/ordermanager-deploy` folder.

---

## Building for Production

```bash
cd ordermanager-deploy/ordermanager-deploy
npm run build
```

This runs `vite build` and produces a `dist/` folder:
```
dist/
├── index.html
└── assets/
    ├── index.[hash].js
    ├── react-vendor.[hash].js   # react + react-dom split into their own chunk
    └── index.[hash].css
```

- `vite.config.js` sets `base: '/'`, meaning the build assumes it will be served from the **root** of a domain (matching the current production setup at `apnabazarstoresordering.com`). If you ever need to deploy under a subfolder (e.g., `/orders/`) instead, change `base` accordingly — see [DEPLOY-GUIDE.md](DEPLOY-GUIDE.md).
- `npm run preview` serves the built `dist/` folder locally so you can sanity-check the production build before uploading it.

Once built, upload the **contents** of `dist/` to the hosting target (GoDaddy `public_html/`) — full walkthrough in [DEPLOY-GUIDE.md](DEPLOY-GUIDE.md) and [NEW_SYSTEM_SETUP_GUIDE.md](NEW_SYSTEM_SETUP_GUIDE.md).

---

## npm Scripts Reference

| Script | Command | Purpose |
|---|---|---|
| `npm run dev` | `vite` | Start local dev server with hot reload |
| `npm run build` | `vite build` | Produce the optimized production `dist/` bundle |
| `npm run preview` | `vite preview` | Serve the built `dist/` bundle locally to test it |

---

## Troubleshooting

| Problem | Likely Cause | Fix |
|---|---|---|
| Blank page locally | Backend not running, or wrong API URL | Confirm backend is up at `http://localhost:5000`; check `.env.development` |
| `VITE_API_URL is required...` error thrown in console | Deployed build has no `VITE_API_URL` set | Ensure `.env.production` has a value before running `npm run build` |
| Changes to `.env.*` don't take effect | Vite only reads env files on server start | Stop and restart `npm run dev` |
| 401 errors / instantly logged out | Expired or invalid JWT (24h expiry) | Log in again; check backend `JWT_SECRET` matches between restarts |
| CORS errors in browser console | Backend doesn't allow the frontend's origin | Add the frontend's URL to `CLIENT_ORIGIN` in the backend `.env` (see [BACKEND_SETUP_GUIDE.md](BACKEND_SETUP_GUIDE.md)) |
| Excel/DOCX template upload looks wrong | Parsing edge case in `OrderManager.jsx` | Check the repository's `/memories/repo/` engineering notes on template/upload parsing conventions before changing this logic |

---

## Related Documents

| Document | What it covers |
|---|---|
| [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) | Full project scope, features, architecture, and data model |
| [BACKEND_SETUP_GUIDE.md](BACKEND_SETUP_GUIDE.md) | Backend setup, environment variables, full API endpoint list |
| [DEPLOY-GUIDE.md](DEPLOY-GUIDE.md) | Building and uploading the frontend to GoDaddy hosting |
| [NEW_SYSTEM_SETUP_GUIDE.md](NEW_SYSTEM_SETUP_GUIDE.md) | Beginner-friendly full setup on a new computer, with credentials |
