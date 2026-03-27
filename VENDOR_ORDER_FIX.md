# Vendor Order Issues - Root Cause & Fix

## Problem Summary
When placing vendor orders from store login:
- ✗ Order says "submitted" but form didn't lock (stayed editable)
- ✗ Save draft not working (order saved but not reflected in UI)
- ✗ Admin didn't see the orders
- ✓ BUT one entry WAS visible in vendor order history (so order WAS saved to DB)

## Root Cause Analysis

### The Core Issue: Sequence Number Mismatch

When a vendor order is opened by admin, it's assigned a **sequence number (seq)** that's incremented each time the order is opened.

**Timeline of the bug:**
1. Admin opens vendor order → Settings has seq=2 for the vendor
2. Store user's browser has cached seq=1 (from when settings were last fetched)
3. Store user submits order → Backend uses seq=2 (from current Settings)
   - Order saved with week = "2026-03-27-VS2"
4. Frontend refreshes orders → Tries to find order using seq=1 from cached settings
   - Looks for week = "2026-03-27-VS1"
   - Week mismatch! Order not found in the map → `ex = null`
5. Since order not found, form doesn't lock (`done = false`)

### Why This Happened
1. **Backend didn't return the week key** - POST /orders only returned `{ success: true, orderId: xxx }`
2. **Frontend's settings were stale** -`vendorOrderConfigs` weren't refreshed immediately after order operations
3. **refreshOrders didn't refetch settings** - Only fetched orders, not the vendor configs

## Fixes Applied

### 1. Backend Fix (server/routes/orders.js)
```javascript
// Now returns the actual week key and seq used
res.json({ 
  success: true, 
  orderId: order && order.id ? order.id : orderId,
  week: weekKey,           // ← NEW: Tells frontend what week was actually used
  vendorSeq: returnedVendorSeq  // ← NEW: Tells frontend what seq was used
});
```

### 2. Frontend Fix (src/OrderManager.jsx)

#### A. Updated refreshOrders to refetch vendor settings:
```javascript
var refreshOrders = useCallback(async function(storeId){
  // ... fetch orders ...
  
  // NEW: Also refresh vendor settings to ensure seq is current
  try{
    var latestSettings = await apiClient.settings.getAll();
    if(latestSettings){
      var serverVendorOrderConfigs = normalizeVendorOrderConfigs(latestSettings.vendorOrderConfigs);
      setVendorOrderConfigs(prev => sameJson(prev, serverVendorOrderConfigs) ? prev : serverVendorOrderConfigs);
    }
  }catch(settingsErr){
    console.warn("Settings refresh failed (non-critical):", settingsErr);
  }
}, [userKey]);
```

#### B. Updated doSubmit to capture returned seq:
```javascript
var doSubmit = async function(){
  try{
    var resp = await apiClient.orders.create({...status:"submitted"...});
    if(refreshOrders) await refreshOrders(user.storeId);
    
    // NEW: For vendor orders, store the actual seq used
    if(selCategory === "vendor_orders" && resp && resp.vendorSeq){
      unsavedByOrderKeyRef.current[oKey] = {
        ..., 
        _serverVendorSeq: resp.vendorSeq  // ← Store actual seq
      };
    }
    ...
  }catch(e){ ... }
};
```

## How This Fixes All Three Issues

| Issue | Root Cause | How Fixed |
|-------|-----------|-----------|
| **Order doesn't lock after submit** | Seq mismatch prevents finding order in map | Settings now refresh immediately, seq stays current |
| **Draft save not working** | Same seq mismatch issue | Same fix - settings refresh ensures correct lookup |
| **Admin doesn't see orders** | When admin views consolidated, their settings might also be stale | Settings are now refreshed more reliably |

## Deployment Instructions

### 1. Backend Deployment
```bash
cd server/
# Code changes already applied - no rebuild needed
# If running on Render:
# - Push changes to Git
# - Render will auto-redeploy
# - Or manually trigger redeploy from Render dashboard
```

### 2. Frontend Deployment
```bash
cd ordermanager-deploy/ordermanager-deploy/
npm install  # If needed
npm run build  # Rebuild with fixes

# Deploy dist/ folder to GoDaddy
# Upload contents of dist/ to public_html/ or your subdirectory
```

### 3. Test the Fix

**Step-by-step test:**
1. Admin goes to Settings → Opens a vendor order (e.g., "Supplier A")
   - Should show in Dashboard as "Supplier A - Action Required"
2. Store user goes to "Place Order" tab → Selects "Supplier A"
3. Store user enters quantities → Clicks "Submit"
   - Should see toast: "Order submitted!"
   - Form should immediately lock and show: "Supplier A is Submitted"
4. Store user navigates to "Order History"
   - Should see the order listed with status "submitted"
5. Admin goes to "Order Monitor" or "Consolidated"
   - Should see the store's submission for the vendor order

**If still not working:**
- Check browser console (F12) for errors
- Check server logs for messages like: "Vendor order created/updated: vendorKey=..., week=..., seq=..."
- Ensure settings endpoint returns `vendorOrderConfigs` with correct seq values

## Additional Notes

### Why Settings Can Get Out of Sync
- Browser caches in-memory state
- 10-second poll interval means up to 10 seconds of staleness
- Multiple browser tabs can have different states

### Why This Fix Is Robust
- Backend returns the actual week key used (source of truth)
- Frontend now refreshes settings after orders change
- Dual approach means fallback: if settings still stale, returned seq provides correct info

### Performance Impact
- Minimal: One extra settings API call per order operation
- Settings call is lightweight (JSON, ~1KB)
- Worth it for data consistency

## Monitoring After Deployment

Watch for these in server logs:
```
Vendor order created/updated: vendorKey=..., week=..., seq=..., status=...
```

If seq keeps incrementing (+1 each submission), that's a different issue - check if admin is re-opening the order constantly.

If seq is always 1, vendor might not be in system's Supplier list - check Settings.

## Files Modified
- `server/routes/orders.js` - Added week/seq to POST /orders response
- `src/OrderManager.jsx` - Enhanced refreshOrders + doSubmit logic
