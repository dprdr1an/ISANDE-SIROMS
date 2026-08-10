/* ============================================================
   SIROMS — API client & state store
   ------------------------------------------------------------
   Replaces the prototype's hardcoded arrays. MongoDB is the only
   source of truth: this module fetches it, caches it for render,
   and re-fetches after every mutation (brief §14, §23).

   The cache is a RENDER BUFFER, never authoritative — nothing is
   written to it directly; it is only ever replaced by a server read.
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------------- low-level fetch ---------------- */
  async function request(method, path, body) {
    let res;
    try {
      res = await fetch(`/api${path}`, {
        method,
        credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (networkErr) {
      // Requirement §28: never pretend an action succeeded.
      throw new ApiFailure('Cannot reach the SIROMS server. Your change was not saved.', 0);
    }
    const isJSON = (res.headers.get('content-type') || '').includes('application/json');
    const payload = isJSON ? await res.json().catch(() => ({})) : {};
    if (!res.ok) {
      const detail = payload.details
        ? Object.values(payload.details).join(' ')
        : (payload.message || payload.error || `Request failed (${res.status})`);
      throw new ApiFailure(detail, res.status, payload.details);
    }
    return payload;
  }

  class ApiFailure extends Error {
    constructor(message, status, details) {
      super(message);
      this.name = 'ApiFailure';
      this.status = status;
      this.details = details;
    }
  }

  const get   = (p)    => request('GET', p);
  const post  = (p, b) => request('POST', p, b);
  const patch = (p, b) => request('PATCH', p, b);

  /* ---------------- endpoint map ---------------- */
  const api = {
    ApiFailure,
    health: () => get('/health'),

    auth: {
      login:  (pin) => post('/auth/login', { pin }),
      logout: ()    => post('/auth/logout'),
      me:     ()    => get('/auth/me')
    },

    users:        (q = '')        => get(`/users${q}`),
    rooms:        (q = '')        => get(`/rooms${q}`),
    room:         (id)            => get(`/rooms/${id}`),
    updateRoom:   (id, body)      => patch(`/rooms/${id}`, body),

    reservations:      (q = '')   => get(`/reservations${q}`),
    reservation:       (id)       => get(`/reservations/${id}`),
    createReservation: (body)     => post('/reservations', body),
    updateReservation: (id, body) => patch(`/reservations/${id}`, body),
    checkIn:           (id, body) => post(`/reservations/${id}/check-in`, body),
    walkIn:            (body)     => post('/reservations/walk-in', body),
    startCheckout:     (id, body) => post(`/reservations/${id}/start-checkout`, body),
    completeCheckout:  (id, body) => post(`/reservations/${id}/complete-checkout`, body),

    guestRequests:       (q = '')       => get(`/guest-requests${q}`),
    createGuestRequest:  (body)         => post('/guest-requests', body),
    assignGuestRequest:  (id, hkId)     => patch(`/guest-requests/${id}/assign`, { housekeeperId: hkId }),
    advanceGuestRequest: (id)           => patch(`/guest-requests/${id}/advance`),

    tasks:        (q = '')        => get(`/housekeeping/tasks${q}`),
    createTask:   (body)          => post('/housekeeping/tasks', body),
    updateTask:   (id, body)      => patch(`/housekeeping/tasks/${id}`, body),
    advanceTask:  (id)            => patch(`/housekeeping/tasks/${id}/advance`),
    reviewTask:   (id, body)      => patch(`/housekeeping/tasks/${id}/review`, body),

    inspections:      (q = '')     => get(`/inspections${q}`),
    inspection:       (id)         => get(`/inspections/${id}`),
    submitInspection: (id, body)   => patch(`/inspections/${id}/submit`, body),

    incidents:       (q = '')          => get(`/incidents${q}`),
    updateIncident:  (code, body)      => patch(`/incidents/${code}`, body),

    tickets:      (q = '')        => get(`/maintenance/tickets${q}`),
    reportIssue:  (body)          => post('/maintenance/tickets', body),
    assessTicket: (id, body)      => patch(`/maintenance/tickets/${id}/assess`, body),
    updateTicket: (id, body)      => patch(`/maintenance/tickets/${id}`, body),

    lostFound:       (q = '')     => get(`/lost-found${q}`),
    createLostItem:  (body)       => post('/lost-found', body),
    updateLostItem:  (id, body)   => patch(`/lost-found/${id}`, body),

    inventory:       (q = '')     => get(`/inventory${q}`),
    createInventory: (body)       => post('/inventory', body),
    updateInventory: (id, body)   => patch(`/inventory/${id}`, body),
    restockRequests: (q = '')     => get(`/restock-requests${q}`),
    requestRestock:  (body)       => post('/restock-requests', body),

    transactions:      (q = '')   => get(`/transactions${q}`),
    createTransaction: (body)     => post('/transactions', body),

    notifications:  (q = '')      => get(`/notifications${q}`),
    markRead:       (id)          => patch(`/notifications/${id}`),
    markAllRead:    ()            => patch('/notifications'),

    dashboard: () => get('/dashboard')
  };

  /* ---------------- state store ----------------
     `store` mirrors the prototype's array names so existing render
     code keeps working, but every field is filled from the server. */
  const store = {
    currentUser: null, permissions: [],
    users: [], rooms: [], reservations: [], guestRequests: [], tasks: [],
    inspections: [], incidents: [], tickets: [], lostItems: [],
    inventory: [], restockRequests: [], transactions: [], notifications: [],
    dashboard: {}
  };

  /** Pull everything the signed-in role is allowed to see. */
  async function refreshAll() {
    if (!store.currentUser) return store;
    const role = store.currentUser.role;
    const wanted = [
      ['rooms',         () => api.rooms()],
      ['reservations',  () => api.reservations()],
      ['guestRequests', () => api.guestRequests()],
      ['tasks',         () => api.tasks()],
      ['inspections',   () => api.inspections()],
      ['incidents',     () => api.incidents()],
      ['tickets',       () => api.tickets()],
      ['lostItems',     () => api.lostFound()],
      ['inventory',     () => api.inventory()],
      ['notifications', () => api.notifications()],
      ['users',         () => api.users()],
      ['dashboard',     () => api.dashboard()]
    ];
    if (['manager'].includes(role)) wanted.push(['transactions', () => api.transactions()]);
    if (['supervisor', 'manager'].includes(role)) wanted.push(['restockRequests', () => api.restockRequests()]);

    const results = await Promise.allSettled(wanted.map(([, fn]) => fn()));
    results.forEach((r, i) => {
      const key = wanted[i][0];
      // 403s are expected for role-restricted data — keep the empty default.
      if (r.status === 'fulfilled') store[key] = r.value;
    });
    return store;
  }

  /** Refresh only what a given mutation could have touched. */
  const AFFECTS = {
    guestRequest: ['guestRequests', 'notifications', 'dashboard', 'reservations'],
    checkin:      ['rooms', 'reservations', 'transactions', 'notifications', 'dashboard'],
    checkout:     ['rooms', 'reservations', 'inspections', 'incidents', 'tasks', 'transactions', 'notifications', 'dashboard'],
    task:         ['tasks', 'rooms', 'notifications', 'dashboard'],
    inspection:   ['inspections', 'incidents', 'reservations', 'tasks', 'rooms', 'notifications', 'dashboard'],
    ticket:       ['tickets', 'rooms', 'notifications', 'dashboard'],
    lostfound:    ['lostItems', 'notifications'],
    inventory:    ['inventory', 'restockRequests', 'notifications', 'dashboard']
  };
  const LOADERS = {
    rooms: () => api.rooms(), reservations: () => api.reservations(),
    guestRequests: () => api.guestRequests(), tasks: () => api.tasks(),
    inspections: () => api.inspections(), incidents: () => api.incidents(),
    tickets: () => api.tickets(), lostItems: () => api.lostFound(),
    inventory: () => api.inventory(), restockRequests: () => api.restockRequests(),
    transactions: () => api.transactions(), notifications: () => api.notifications(),
    users: () => api.users(), dashboard: () => api.dashboard()
  };

  async function refresh(scope) {
    const keys = AFFECTS[scope] || Object.keys(LOADERS);
    const out = await Promise.allSettled(keys.map((k) => LOADERS[k]()));
    out.forEach((r, i) => { if (r.status === 'fulfilled') store[keys[i]] = r.value; });
    return store;
  }

  async function login(pin) {
    const { user, permissions } = await api.auth.login(pin);
    store.currentUser = user;
    store.permissions = permissions;
    await refreshAll();
    return user;
  }

  async function logout() {
    await api.auth.logout().catch(() => {});
    store.currentUser = null; store.permissions = [];
    Object.keys(LOADERS).forEach((k) => { store[k] = Array.isArray(store[k]) ? [] : {}; });
  }

  /** Restore an existing session on page load. */
  async function restoreSession() {
    try {
      const { user, permissions } = await api.auth.me();
      store.currentUser = user; store.permissions = permissions;
      await refreshAll();
      return user;
    } catch { return null; }
  }

  global.SIROMS = { api, store, refresh, refreshAll, login, logout, restoreSession, ApiFailure };
})(window);
