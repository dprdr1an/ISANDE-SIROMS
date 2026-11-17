/* ============================================================
   SIROMS · API client
   One place for every request to the Express backend:
   - sends the session cookie and the CSRF header
   - turns JSON error bodies into ApiError objects
   - reports expired sessions once, centrally
   - never claims success unless the server confirmed it
   ============================================================ */
const API = (() => {
  // Same origin by default (Express serves this folder). To serve the
  // frontend elsewhere, set window.SIROMS_API_BASE before this script.
  const BASE = String(window.SIROMS_API_BASE || '').replace(/\/$/, '');

  class ApiError extends Error {
    constructor(status, code, message, details) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }

  let onExpired = () => {};

  async function request(method, path, body) {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['X-SIROMS-Request'] = '1'; }
    let res;
    try {
      res = await fetch(BASE + path, { method, credentials: 'include', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (_) {
      throw new ApiError(0, 'NETWORK', 'Can’t reach the SIROMS server. Check the connection and try again — retrying the same action won’t create a duplicate.');
    }
    let payload = null;
    try { payload = await res.json(); } catch (_) { /* non-JSON response */ }
    if (res.ok && payload && payload.ok) return payload.data;
    const err = (payload && payload.error) || {};
    const e = new ApiError(res.status, err.code || `HTTP_${res.status}`, err.message || `The server could not complete the request (${res.status}).`, err.details);
    if (res.status === 401 && !['/api/auth/login', '/api/auth/me'].includes(path)) onExpired(e);
    throw e;
  }

  // Key sent with "create" requests so a retried submit can't create a duplicate.
  function newRequestId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('').replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
  }

  return {
    get: path => request('GET', path),
    post: (path, body = {}) => request('POST', path, body),
    patch: (path, body = {}) => request('PATCH', path, body),
    onSessionExpired: fn => { onExpired = fn; },
    newRequestId,
    ApiError
  };
})();
