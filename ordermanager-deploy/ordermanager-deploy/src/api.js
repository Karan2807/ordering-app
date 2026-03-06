/**
 * API Client - Centralized HTTP client with token management
 */

// API base URL resolution is intentionally strict to avoid accidentally
// writing test data to production:
// 1. Use explicit VITE_API_URL when provided.
// 2. If frontend runs on localhost/127.0.0.1, default to local backend.
// 3. For any non-localhost deployment, require VITE_API_URL.
const API_BASE_URL = (() => {
  const configuredUrl = (import.meta.env.VITE_API_URL || '').trim();
  if (configuredUrl) {
    return configuredUrl.replace(/\/+$/, '');
  }

  const origin = window.location.origin;
  const isLocalOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  if (isLocalOrigin) {
    return 'http://localhost:5000/api';
  }

  throw new Error(
    'VITE_API_URL is required for non-localhost frontend deployments. Refusing to guess API URL.'
  );
})();

let authToken = localStorage.getItem('authToken');

// log base URL once so developers can see which backend is being targeted
console.log('API client initialized with base URL:', API_BASE_URL);

export const apiClient = {
  setToken(token) {
    authToken = token;
    if (token) {
      localStorage.setItem('authToken', token);
    } else {
      localStorage.removeItem('authToken');
    }
  },

  getToken() {
    return authToken;
  },

  async request(endpoint, options = {}) {
    const url = `${API_BASE_URL}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }

    const config = {
      ...options,
      headers,
    };

    try {
      const response = await fetch(url, config);

      if (response.status === 401) {
        // Token expired or invalid
        apiClient.setToken(null);
        window.location.href = '/';
        throw new Error('Session expired. Please login again.');
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`API Error [${endpoint}]:`, error);
      throw error;
    }
  },

  // Auth
  auth: {
    login(username, password) {
      return apiClient.request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
    },

    verify(token) {
      return apiClient.request('/auth/verify', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
    },
  },

  // Items
  items: {
    getAll() {
      return apiClient.request('/items');
    },

    create(data) {
      return apiClient.request('/items', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    delete(code) {
      return apiClient.request(`/items/${code}`, { method: 'DELETE' });
    },

    bulkImport(items, mode = 'merge', category = 'vegetables', template = null, vendorKey = null) {
      return apiClient.request('/items/bulk/import', {
        method: 'POST',
        body: JSON.stringify({ items, mode, category, template, vendorKey }),
      });
    },
  },

  // Orders
  orders: {
    getAll(storeId) {
      const query = storeId ? `?storeId=${storeId}` : '';
      return apiClient.request(`/orders${query}`);
    },

    create(data) {
      // data may include { type, items, status, storeId }
      return apiClient.request('/orders', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    process(orderId) {
      return apiClient.request(`/orders/${orderId}/process`, { method: 'POST' });
    },
    sendReminder(type, storeId, category, vendorKey) {
      const body = {};
      if (storeId) body.storeId = storeId;
      if (category) body.category = category;
      if (vendorKey) body.vendorKey = vendorKey;
      return apiClient.request(`/orders/reminders/${type}/send`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    getConsolidated(type) {
      return apiClient.request(`/orders/consolidated/${type}`);
    },

    emailConsolidated(type, category, vendorKey, emailOrEmails, supplierName, reopenedFromId, splitData) {
      const body = Array.isArray(emailOrEmails) ? { emails: emailOrEmails } : { email: emailOrEmails };
      body.category = category || 'vegetables';
      if (vendorKey) body.vendorKey = vendorKey;
      if (supplierName) body.supplierName = supplierName;
      if (reopenedFromId) body.reopenedFromId = reopenedFromId;
      if (splitData) body.splitData = splitData;
      return apiClient.request(`/orders/consolidated/${type}/email`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    consolidatedExcelPreview(type, category, vendorKey, splitData) {
      const body = { category: category || 'vegetables' };
      if (vendorKey) body.vendorKey = vendorKey;
      if (splitData) body.splitData = splitData;
      return apiClient.request(`/orders/consolidated/${type}/excel-preview`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    storeOrderExcelPreview(type, category, vendorKey, items, notes, storeId, date) {
      const body = { type, category: category || 'vegetables', items: items || {}, notes: notes || {} };
      if (vendorKey) body.vendorKey = vendorKey;
      if (storeId) body.storeId = storeId;
      if (date) body.date = date;
      return apiClient.request('/orders/store-order/excel-preview', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    // send arbitrary text email via backend (admin only)
    sendEmail(to, subject, text) {
      return apiClient.request('/orders/email', {
        method: 'POST',
        body: JSON.stringify({ to, subject, text }),
      });
    },
  },

  // Users
  users: {
    getAll() {
      return apiClient.request('/users');
    },

    create(data) {
      return apiClient.request('/users', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    update(userId, data) {
      return apiClient.request(`/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },
    delete(userId) {
      return apiClient.request(`/users/${userId}`, {
        method: 'DELETE',
      });
    },

    toggle(userId) {
      return apiClient.request(`/users/${userId}/toggle`, { method: 'PATCH' });
    },

    resetPassword(userId, password) {
      return apiClient.request(`/users/${userId}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
    },
  },

  async download(endpoint, filename) {
    const url = `${API_BASE_URL}${endpoint}`;
    const headers = {};
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const response = await fetch(url, { headers });
    if (response.status === 401) {
      apiClient.setToken(null);
      window.location.href = '/';
      throw new Error('Session expired. Please login again.');
    }
    if (!response.ok) {
      let msg = `HTTP ${response.status}: ${response.statusText}`;
      try {
        const data = await response.json();
        if (data && data.error) msg = data.error;
      } catch (_) {}
      throw new Error(msg);
    }
    const blob = await response.blob();
    const urlObj = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = urlObj;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(urlObj), 1000);
    return true;
  },

  // Suppliers
  suppliers: {
    getAll() {
      return apiClient.request('/suppliers');
    },

    create(data) {
      return apiClient.request('/suppliers', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    update(id, data) {
      return apiClient.request(`/suppliers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },

    delete(id) {
      return apiClient.request(`/suppliers/${id}`, { method: 'DELETE' });
    },

    assignItems(id, items) {
      return apiClient.request(`/suppliers/${id}/items`, {
        method: 'POST',
        body: JSON.stringify({ items }),
      });
    },
  },

  // Stores
  stores: {
    getAll() {
      return apiClient.request('/stores');
    },

    create(data) {
      return apiClient.request('/stores', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    update(id, data) {
      return apiClient.request(`/stores/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },

    delete(id) {
      return apiClient.request(`/stores/${id}`, { method: 'DELETE' });
    },
  },

  // Notifications
  notifications: {
    getAll() {
      return apiClient.request('/notifications');
    },

    create(data) {
      return apiClient.request('/notifications', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    delete(id) {
      return apiClient.request(`/notifications/${id}`, { method: 'DELETE' });
    },
  },

  // Supplier orders (history/log)
  supplierOrders: {
    getAll() {
      return apiClient.request('/orders/supplier-orders');
    },
    create(data) {
      return apiClient.request('/orders/supplier-orders', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    reopen(id) {
      return apiClient.request(`/orders/supplier-orders/${id}/reopen`, {
        method: 'PATCH',
      });
    },
    downloadExcel(id, filename) {
      return apiClient.download(`/orders/supplier-orders/${id}/excel`, filename);
    },
  },

  // Settings
  settings: {
    getAll() {
      return apiClient.request('/settings');
    },

    updateSchedule(type, day) {
      return apiClient.request(`/settings/schedule/${type}`, {
        method: 'PATCH',
        body: JSON.stringify({ day }),
      });
    },

    updateMessage(type, message) {
      return apiClient.request(`/settings/message/${type}`, {
        method: 'PATCH',
        body: JSON.stringify({ message }),
      });
    },

    // logo may be a base64 data URL string or null
    updateLogo(logo) {
      return apiClient.request('/settings/logo', {
        method: 'PATCH',
        body: JSON.stringify({ logo }),
      });
    },
    updateManualOpen(type) {
      return apiClient.request('/settings/manual-open', {
        method: 'PATCH',
        body: JSON.stringify({ type }),
      });
    },
    updateVendorOrdersOpen(vendorKey) {
      return apiClient.request('/settings/vendor-orders-open', {
        method: 'PATCH',
        body: JSON.stringify({ vendorKey }),
      });
    },
  },
};

export default apiClient;
