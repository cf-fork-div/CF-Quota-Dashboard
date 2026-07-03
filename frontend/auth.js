const API_BASE = window.location.origin;

export async function checkAuth() {
  const resp = await fetch(`${API_BASE}/api/me`, { credentials: 'include' });
  return resp.json();
}

export async function login(password) {
  const resp = await fetch(`${API_BASE}/api/login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Login failed');
  return data;
}

export async function logout() {
  await fetch(`${API_BASE}/api/logout`, {
    method: 'POST',
    credentials: 'include',
  });
}

export function redirectToLogin(returnPath) {
  const next = returnPath || window.location.pathname;
  window.location.href = `/login?next=${encodeURIComponent(next)}`;
}

export async function requirePageAuth() {
  const me = await checkAuth();
  if (me.authEnabled && !me.authenticated) {
    redirectToLogin(window.location.pathname);
    return false;
  }
  return me;
}

export async function setupNavAuth(navEl) {
  if (!navEl) return;

  const me = await checkAuth();

  if (!me.authEnabled) {
    navEl.innerHTML = `<span class="chip chip--dev">Dev mode</span>`;
  } else if (me.authenticated) {
    navEl.innerHTML = `
      <span class="form-hint">${me.username}</span>
      <button id="logout-btn" class="btn btn-ghost btn-sm">Logout</button>
    `;
  } else {
    navEl.innerHTML = `<a href="/login" class="nav-link">登录</a>`;
  }

  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await logout();
      window.location.href = '/';
    });
  }
}

export async function authFetch(url, options = {}) {
  const resp = await fetch(url, { credentials: 'include', ...options });
  if (resp.status === 401) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }
  return resp;
}

/** Parse JSON response; fall back to a friendly message for non-JSON error bodies. */
export async function parseJsonResponse(resp) {
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return resp.json();
  }

  const text = await resp.text();
  if (!resp.ok) {
    return { error: resp.status >= 500 ? '服务器错误，请稍后重试' : text || '请求失败' };
  }

  try {
    return JSON.parse(text);
  } catch {
    return { error: '服务器返回了无效响应' };
  }
}
