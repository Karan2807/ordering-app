/**
 * API Client - Centralized HTTP client with token management
 */

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

let authToken = localStorage.getItem('authToken');

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

    register(data) {
      return apiClient.request('/auth/register', {
        method: 'POST',
        body: JSON.stringify(data),
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

    bulkImport(items, mode = 'merge') {
      return apiClient.request('/items/bulk/import', {
        method: 'POST',
        body: JSON.stringify({ items, mode }),
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

    getConsolidated(type) {
      return apiClient.request(`/orders/consolidated/${type}`);
    },

    emailConsolidated(type, email, supplierName) {
      const body = { email };
      if (supplierName) body.supplierName = supplierName;
      return apiClient.request(`/orders/consolidated/${type}/email`, {
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
      return apiClient.request('/supplier-orders');
    },
    create(data) {
      return apiClient.request('/supplier-orders', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
  },

  // Supplier orders (history/log)
  supplierOrders: {
    getAll() {
      return apiClient.request('/supplier-orders');
    },
    create(data) {
      return apiClient.request('/supplier-orders', {
        method: 'POST',
        body: JSON.stringify(data),
      });
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
  },
};

export default apiClient;
