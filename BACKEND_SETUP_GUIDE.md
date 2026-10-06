# OrderManager Backend + Frontend Setup Guide

## Overview
The OrderManager app has been converted from a fully client-side application to a full-stack system with:
- **Backend**: Node.js/Express API with MongoDB database
- **Frontend**: React with API client wrapper, authentication context, and loading/error states
- **Authentication**: JWT token-based system

## Prerequisites

### System Requirements
- Node.js 18+ (for backend)
- MongoDB 5+ (database)
- npm or yarn (package manager)

### Windows Setup (Recommended)

#### 1. Install MongoDB
- Download from https://www.mongodb.com/try/download/community
- During installation choose "Install MongoDB as a Service" or run manually with `mongod`
- By default the server listens on `mongodb://localhost:27017`

#### 2. Create Database (optional)
MongoDB will create the database automatically when you first write to it.  No manual SQL commands are required.
You can still create a dedicated database and user using the `mongo` shell or `mongosh`:
```bash
# start shell
mongosh

# in shell:
use ordermanager
db.createUser({user: 'ordermanager', pwd: 'password', roles:['readWrite']})
exit
```
---

## Backend Setup

### Step 1: Install Dependencies
```bash
cd server
npm install
```

### Step 2: Configure Environment
Create `.env` file in the `server` folder:
```
PORT=5000
MONGODB_URI=mongodb://localhost:27017/ordermanager
JWT_SECRET=your_jwt_secret_key_change_in_production
# Optional: SMTP transport for sending emails.  You can provide a full
# SMTP URL for any provider:
#   SMTP_URL=smtp://user:pass@smtp.example.com
#   SMTP_URL=smtp://user:pass@smtp.gmail.com:587
# Optional: Outlook-specific SMTP settings (takes priority when set):
#   OUTLOOK_HOST=smtp.office365.com
#   OUTLOOK_PORT=587
#   OUTLOOK_SECURE=false
#   OUTLOOK_USER=your@outlook.com
#   OUTLOOK_PASS=your-password
# Or use Gmail-specific vars (recommended if you're using a Gmail
# account with an app-password):
#   GMAIL_USER=your@gmail.com
#   GMAIL_PASS=app-password-here
# If neither SMTP_URL nor Gmail creds are set, messages will only be
# logged to the console (development fallback).
# Optional: from address used when sending emails
EMAIL_FROM=noreply@yourdomain.com
NODE_ENV=development
```

Replace:
- `MONGODB_URI` with the connection string for your MongoDB server (including credentials if you created a user)
- `JWT_SECRET` with a secure random string (e.g., `openssl rand -base64 32`)

### Step 3: Start Backend Server
```bash
npm run dev
```

Expected output:
```
✓ Database initialized
✓ Database seeded with demo data
✓ Server running on http://localhost:5000
```

The backend will:
- Create all necessary database tables
- Import seed data (stores, items, users, suppliers, etc.)
- Start listening on port 5000

---

## Frontend Setup

### Step 1: Install Dependencies
```bash
cd ordermanager-deploy/ordermanager-deploy
npm install
```

### Step 2: Configure Environment
The `.env.local` file is already configured:
```
VITE_API_URL=http://localhost:5000/api
```

If your backend is on a different host, update this accordingly.

### Step 3: Start Development Server
```bash
npm run dev
```

The frontend will start on `http://localhost:5173` (or another port if 5173 is busy).

---

## Architecture Overview

### Data Flow
```
Frontend → API Client → Backend API → MongoDB Database
```

### Key Components

#### Frontend
- **AuthContext** (`AuthContext.jsx`) - Manages user auth state and login
- **API Client** (`api.js`) - Centralized HTTP requests with token management
- **OrderManager** (`OrderManager.jsx`) - Main React component with UI

#### Backend
- **server.js** - Express app, routes setup
- **db.js** - MongoDB / Mongoose connection
- **database.js** - Schema creation and seeding
- **auth.js** - JWT token generation and verification
- **routes/** - API endpoints organized by feature
  - `auth.js` - Login, verify token
  - `items.js` - Item CRUD, CSV import
  - `orders.js` - Order management
  - `users.js` - User management (admin)
  - `suppliers.js` - Supplier management (admin)
  - `stores.js` - Store location management (admin)
  - `notifications.js` - Notification management (admin)
  - `settings.js` - Schedule and messages (admin)

### API Endpoints

#### Authentication
- `POST /api/auth/login` - Login with username/password
- `POST /api/auth/verify` - Verify JWT token

#### Items
- `GET /api/items` - Get all items
- `POST /api/items` - Create item (admin)
- `DELETE /api/items/:code` - Delete item (admin)
- `POST /api/items/bulk/import` - Bulk import from CSV (admin)

*(The endpoints remain the same; implementation now uses MongoDB.)*

#### Orders
- `GET /api/orders` - Get user's orders
- `POST /api/orders` - Create/update order
- `POST /api/orders/:orderId/process` - Process order (admin)
- `GET /api/orders/consolidated/:type` - Consolidated view (admin)
- `POST /api/orders/consolidated/:type/email` - Send consolidated order summary to email (admin)
- `POST /api/orders/email` - Generic text email sender; body must include `to`, `subject`, and `text` (admin). Useful for supplier/order emails.

#### Users
- `GET /api/users` - Get all users (admin)
- `POST /api/users` - Create user (admin)
- `PATCH /api/users/:userId/toggle` - Enable/disable user (admin)
- `POST /api/users/:userId/reset-password` - Reset password (admin)

#### Suppliers
- `GET /api/suppliers` - Get all suppliers (admin)
- `POST /api/suppliers` - Create supplier (admin)
- `PATCH /api/suppliers/:supplierId` - Update supplier (admin)
- `DELETE /api/suppliers/:supplierId` - Delete supplier (admin)
- `POST /api/suppliers/:supplierId/items` - Assign items (admin)

#### Stores
- `GET /api/stores` - Get all stores
- `POST /api/stores` - Create store (admin)
- `PATCH /api/stores/:storeId` - Update store (admin)
- `DELETE /api/stores/:storeId` - Delete store (admin)

#### Notifications
- `GET /api/notifications` - Get all notifications
- `POST /api/notifications` - Create notification (admin)
- `DELETE /api/notifications/:notifId` - Delete notification (admin)

#### Settings
- `GET /api/settings` - Get all settings
- `PATCH /api/settings/schedule/:type` - Update order schedule (admin)
- `PATCH /api/settings/message/:type` - Update order message (admin)

---

## Demo Accounts

Once seeded, use these accounts to login (seed script inserts into MongoDB):

### Admin
- **Username**: admin
- **Password**: admin123

### Store Managers
- **Username**: store1 (also store2, store3, store4, store5)
- **Password**: pass123

Each store manager account is associated with their respective store.

---

## Testing the Integration

### 1. Login
1. Go to http://localhost:5173
2. Enter credentials (e.g., admin / admin123)
3. You should be redirected to the dashboard

### 2. Create Order (Manager)
1. Login as store1
2. Click "Place Order"
3. Add quantities for items
4. Click "Submit"
5. Order is saved to database

### 3. Monitor Orders (Admin)
1. Login as admin
2. Click "Order Monitor"
3. View all submitted orders
4. Click "Process" to mark as processed in database

### 4. CSV Import
1. Login as admin
2. Go to "Item Master"
3. Click "Upload CSV"
4. Select items mode (merge/replace)
5. Items are imported to database

---

## Troubleshooting

### Backend Issues

**Port 5000 already in use**
```bash
# Change PORT in .env
PORT=5001
```

**Database connection error**
```
Check MONGODB_URI in .env
Verify MongoDB is running
Verify credentials in .env
```

**JWT verification failures**
- Clear browser localStorage: `localStorage.clear()`
- Login again to get new token

### Frontend Issues

**API not found errors**
- Verify backend is running on http://localhost:5000
- Check `VITE_API_URL` in `.env.local`
- Check browser console for CORS errors

**Blank page after login**
- Open browser DevTools (F12)
- Check console for errors
- Clear cache: Ctrl+F5

---

## Production Deployment

### Backend
1. Install production dependencies: `npm install --production`
2. Update `.env`:
   - Set `NODE_ENV=production`
   - Use strong `JWT_SECRET`
   - Update `MONGODB_URI` to production database
   - Set `PORT` to 80/443 or use reverse proxy
3. Use process manager: `pm2`, `forever`, or systemd
4. Set up reverse proxy with Nginx/Apache for SSL

### Frontend
1. Build: `npm run build`
2. Copy `dist/` folder to web server
3. Configure CORS on backend to allow frontend domain
4. Update `VITE_API_URL` to production backend URL

---

## File Structure

```
ordering-app/
├── server/                          # Backend
│   ├── server.js                    # Express app
│   ├── db.js                        # MongoDB / Mongoose connection
│   ├── database.js                  # Schema + seed
│   ├── auth.js                      # JWT utilities
│   ├── package.json
│   ├── .env.example
│   └── routes/
│       ├── auth.js
│       ├── items.js
│       ├── orders.js
│       ├── users.js
│       ├── suppliers.js
│       ├── stores.js
│       ├── notifications.js
│       └── settings.js
│
└── ordermanager-deploy/
    └── ordermanager-deploy/         # Frontend
        ├── src/
        │   ├── OrderManager.jsx      # Main React component
        │   ├── AuthContext.jsx       # Auth state management
        │   ├── api.js                # API client wrapper
        │   └── main.jsx              # React entry point
        ├── package.json
        ├── vite.config.js
        ├── .env.local
        └── index.html
```

---

## Next Steps

### Features to Add
- [ ] Password hashing (bcryptjs is installed but not used yet)
- [ ] Request validation and sanitization
- [ ] Rate limiting
- [ ] Caching strategy
- [ ] Backend logging
- [ ] Email notifications
- [ ] Advanced filtering/search
- [ ] Data export (CSV, PDF)

### Performance Optimizations
- [ ] Database indexes optimization
- [ ] Query pagination
- [ ] Frontend code splitting
- [ ] API response caching
- [ ] Gzip compression

### Security Improvements
- [ ] Implement password hashing
- [ ] Add HTTPS/SSL
- [ ] CORS configuration
- [ ] Input validation
- [ ] SQL injection prevention
- [ ] XSS protection

---

## Support & Documentation

For more information:
- Backend API: RESTful endpoints using Express
- Frontend: React with Hooks and Context API
- Database: MongoDB document database
- Authentication: JWT tokens stored in localStorage

---

Generated: February 17, 2026
