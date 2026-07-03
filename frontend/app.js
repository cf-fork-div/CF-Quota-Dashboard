import { setupNavAuth, authFetch, redirectToLogin } from './auth.js';

const API_BASE = window.location.origin;

const GROUPS = [
  {
    title: 'Compute & Runtime',
    keys: [
      'workers_requests', 'pages_requests', 'workers_build_minutes',
      'pages_builds', 'workflows_invocations', 'browser_minutes', 'ai_neurons',
    ],
  },
  {
    title: 'Storage & Databases',
    keys: [
      'd1_reads', 'd1_writes', 'd1_storage_gb',
      'kv_reads', 'kv_writes', 'kv_deletes', 'kv_lists', 'kv_storage_gb',
      'r2_storage_gb', 'r2_class_a', 'r2_class_b',
      'durable_objects_requests', 'durable_objects_duration',
      'durable_objects_rows_read', 'durable_objects_rows_written', 'durable_objects_sql_storage_gb',
    ],
  },
  {
    title: 'Messaging & Data Plane',
    keys: ['queues_ops', 'hyperdrive_queries', 'vectorize_queried_dims', 'vectorize_stored_dims'],
  },
  {
    title: 'Analytics',
    keys: ['analytics_engine_writes'],
  },
];

const SUMMARY_KEYS = [
  'workers_requests',
  'pages_requests',
  'workers_build_minutes',
  'pages_builds',
  'd1_reads',
  'kv_reads',
  'r2_storage_gb',
  'ai_neurons',
];

function barLevel(pct) {
  if (pct >= 80) return 'high';
  if (pct >= 60) return 'medium';
  return 'low';
}

function pctClass(pct) {
  if (pct >= 80) return 'metric-row__pct--high';
  if (pct >= 60) return 'metric-row__pct--medium';
  return '';
}

function calcPct(used, limit) {
  if (!limit || limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 1000) / 10);
}

function formatUsed(metric) {
  if (!metric.available) return 'N/A';
  if (metric.unit === 'GB') return `${metric.used} / ${metric.limit} GB`;
  if (metric.unit === 'bytes') return `${metric.used.toLocaleString()} B`;
  return `${metric.used.toLocaleString()} / ${metric.limit.toLocaleString()} ${metric.unit}`;
}

function renderMetric(key, metric) {
  if (!metric) return '';
  const pct = metric.available ? metric.pct : 0;
  const width = metric.available ? Math.min(100, pct) : 0;
  const note = metric.note ? `<p class="metric-row__note">${metric.note}</p>` : '';
  return `
    <div class="metric-row">
      <div class="metric-row__header">
        <span class="metric-row__label">${metric.label}</span>
        <span class="metric-row__pct ${metric.available ? pctClass(pct) : ''}">${metric.available ? `${pct}%` : 'unavailable'} · ${metric.period}</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill progress-fill--${barLevel(pct)}" style="width:${width}%"></div>
      </div>
      <p class="metric-row__detail">${formatUsed(metric)}</p>
      ${note}
    </div>
  `;
}

function aggregateMetrics(accounts) {
  const okAccounts = accounts.filter((a) => a.status === 'ok');
  const metrics = {};

  for (const key of SUMMARY_KEYS) {
    let totalUsed = 0;
    let totalLimit = 0;
    let label = key;
    let unit = '';
    let period = '';
    let availableCount = 0;

    for (const acc of okAccounts) {
      const m = acc.quotas?.[key];
      if (m?.available) {
        totalUsed += m.used;
        totalLimit += m.limit;
        label = m.label;
        unit = m.unit;
        period = m.period;
        availableCount++;
      }
    }

    if (availableCount > 0) {
      metrics[key] = {
        used: totalUsed,
        limit: totalLimit,
        pct: calcPct(totalUsed, totalLimit),
        label,
        unit,
        period,
        available: true,
      };
    }
  }

  const alerts = [];
  for (const acc of okAccounts) {
    for (const m of Object.values(acc.quotas ?? {})) {
      if (m.available && m.pct >= 70) {
        alerts.push({ account: acc.accountName, metric: m });
      }
    }
  }

  return {
    accountCount: accounts.length,
    okCount: okAccounts.length,
    errorCount: accounts.filter((a) => a.status === 'error').length,
    metrics,
    alerts,
  };
}

function renderSummaryCard(summary) {
  const metricRows = SUMMARY_KEYS
    .filter((k) => summary.metrics[k])
    .map((k) => {
      const m = summary.metrics[k];
      const pct = m.pct;
      return `
        <div class="metric-row">
          <div class="metric-row__header">
            <span class="metric-row__label">${m.label}</span>
            <span class="metric-row__pct ${pctClass(pct)}">${pct}%</span>
          </div>
          <div class="progress-track progress-track--sm">
            <div class="progress-fill progress-fill--${barLevel(pct)}" style="width:${Math.min(100, pct)}%"></div>
          </div>
          <p class="metric-row__detail">${formatUsed(m)} · ${summary.okCount} accounts</p>
        </div>
      `;
    })
    .join('');

  const alertBlock = summary.alerts.length
    ? `<div class="alert-box alert-box--danger">
        <p><strong>${summary.alerts.length} metric(s) ≥ 70%</strong></p>
        <ul>
          ${summary.alerts.slice(0, 8).map((a) =>
            `<li>${a.account}: ${a.metric.label} (${a.metric.pct}%)</li>`,
          ).join('')}
          ${summary.alerts.length > 8 ? `<li>…and ${summary.alerts.length - 8} more</li>` : ''}
        </ul>
      </div>`
    : '';

  return `
    <article class="col-span-full glass-card glass-card--hero">
      <div class="mb-4">
        <h2 class="glass-card__title">Cross-Account Summary</h2>
        <p class="glass-card__subtitle">
          ${summary.accountCount} account(s) · ${summary.okCount} OK · ${summary.errorCount} error
        </p>
      </div>
      <div class="summary-grid">
        ${metricRows}
      </div>
      ${alertBlock}
    </article>
  `;
}

function renderAccountCard(account) {
  const statusBadge = account.status === 'error'
    ? `<span class="chip chip--danger">Error</span>`
    : `<span class="chip chip--success">OK</span>`;

  const errorBlock = account.error
    ? `<p class="text-error mb-3">${account.error}</p>`
    : '';

  const groups = GROUPS.map((g) => {
    const metrics = g.keys
      .map((k) => renderMetric(k, account.quotas[k]))
      .filter(Boolean)
      .join('');
    if (!metrics) return '';
    return `
      <div>
        <h4 class="metric-group__title">${g.title}</h4>
        ${metrics}
      </div>
    `;
  }).join('');

  return `
    <article class="glass-card glass-card--interactive">
      <div class="flex items-center justify-between mb-3">
        <h3 class="glass-card__title">${account.accountName}</h3>
        ${statusBadge}
      </div>
      <p class="list-item__meta mb-2">${account.accountId}</p>
      ${errorBlock}
      ${groups}
    </article>
  `;
}

async function fetchSnapshot() {
  const resp = await fetch(`${API_BASE}/api/snapshot`);
  return resp.json();
}

async function refreshQuotas() {
  const btn = document.getElementById('refresh-btn');
  const statsEl = document.getElementById('refresh-stats');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Refreshing…';
  }
  if (statsEl) statsEl.textContent = '';
  try {
    const resp = await authFetch(`${API_BASE}/cron/fetch`, { method: 'POST' });
    const data = await resp.json();
    await loadDashboard();
    if (statsEl && data.refreshStats) {
      const s = data.refreshStats;
      statsEl.textContent = `Refresh: ${s.refreshed} updated, ${s.cached} cached, ${s.failed} failed, ${s.skippedByLimit} skipped (budget), ${s.subrequestsUsed} subrequests used`;
      statsEl.className = 'page-meta';
    }
  } catch (err) {
    if (err.status === 401) {
      if (confirm('Login required for manual refresh. Go to login page?')) {
        redirectToLogin('/');
      }
    } else if (statsEl) {
      statsEl.textContent = err.message || 'Refresh failed';
      statsEl.className = 'form-message form-message--error';
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Manual Refresh';
    }
  }
}

async function loadDashboard() {
  const data = await fetchSnapshot();
  const updated = document.getElementById('last-updated');
  const grid = document.getElementById('accounts-grid');

  if (updated) {
    updated.textContent = data.lastUpdated
      ? new Date(data.lastUpdated).toLocaleString()
      : 'Never';
  }

  if (!grid) return;

  if (!data.accounts?.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">📊</div>
        <p>No quota data yet.</p>
        <p><a href="/admin">Add an account</a> or click Manual Refresh.</p>
      </div>`;
    return;
  }

  const summary = aggregateMetrics(data.accounts);
  grid.innerHTML = renderSummaryCard(summary) + data.accounts.map(renderAccountCard).join('');
}

let editingAccountId = null;

function resetAccountForm() {
  const form = document.getElementById('account-form');
  if (!form) return;
  form.reset();
  editingAccountId = null;
  const title = document.getElementById('form-title');
  const submitBtn = document.getElementById('submit-btn');
  const cancelBtn = document.getElementById('cancel-edit-btn');
  const tokenInput = form.apiToken;
  if (title) title.textContent = 'Add Account';
  if (submitBtn) submitBtn.textContent = 'Save Account';
  if (cancelBtn) cancelBtn.classList.add('hidden');
  if (tokenInput) tokenInput.required = true;
}

function startEditAccount(account) {
  const form = document.getElementById('account-form');
  if (!form) return;
  editingAccountId = account.id;
  form.name.value = account.name;
  form.accountId.value = account.accountId;
  form.apiToken.value = '';
  form.apiToken.required = false;
  form.apiToken.placeholder = `Leave blank to keep ${account.apiToken}`;

  const title = document.getElementById('form-title');
  const submitBtn = document.getElementById('submit-btn');
  const cancelBtn = document.getElementById('cancel-edit-btn');
  if (title) title.textContent = `Edit Account · ${account.name}`;
  if (submitBtn) submitBtn.textContent = 'Update Account';
  if (cancelBtn) cancelBtn.classList.remove('hidden');

  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function verifyAccountForm() {
  const form = document.getElementById('account-form');
  const msg = document.getElementById('form-message');
  if (!form) return;

  const accountId = form.accountId.value.trim();
  const apiToken = form.apiToken.value.trim();
  if (!accountId || !apiToken) {
    if (msg) {
      msg.textContent = 'Enter Account ID and API Token to verify.';
      msg.className = 'form-message form-message--error';
    }
    return;
  }

  const verifyBtn = document.getElementById('verify-btn');
  if (verifyBtn) {
    verifyBtn.disabled = true;
    verifyBtn.textContent = 'Verifying…';
  }

  try {
    const resp = await authFetch(`${API_BASE}/api/accounts/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, apiToken }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      throw new Error(data.error || 'Verification failed');
    }
    if (msg) {
      const nameHint = data.accountName ? ` (${data.accountName})` : '';
      msg.textContent = `Credentials verified${nameHint}.`;
      msg.className = 'form-message form-message--success';
    }
    if (data.accountName && !form.name.value.trim()) {
      form.name.value = data.accountName;
    }
  } catch (err) {
    if (msg) {
      if (err.status === 401) {
        msg.textContent = 'Login required. Redirecting…';
        msg.className = 'form-message form-message--error';
        redirectToLogin('/admin');
        return;
      }
      msg.textContent = err.message || 'Verification failed';
      msg.className = 'form-message form-message--error';
    }
  } finally {
    if (verifyBtn) {
      verifyBtn.disabled = false;
      verifyBtn.textContent = 'Verify Credentials';
    }
  }
}

async function loadAdmin() {
  const list = document.getElementById('accounts-list');
  if (!list) return;

  const resp = await authFetch(`${API_BASE}/api/accounts`);
  const accounts = await resp.json();

  if (!accounts.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">👤</div>
        <p>No accounts configured.</p>
      </div>`;
    return;
  }

  list.innerHTML = accounts.map((a) => `
    <div class="list-item">
      <div class="min-w-0 flex-1">
        <div class="list-item__header">
          <p class="list-item__title">${a.name}</p>
          <span class="chip ${a.enabled ? 'chip--success' : 'chip--muted'}">
            ${a.enabled ? 'Enabled' : 'Disabled'}
          </span>
        </div>
        <p class="list-item__meta">${a.accountId}</p>
        <p class="list-item__meta">Token: ${a.apiToken}</p>
      </div>
      <div class="list-item__actions">
        <button data-id="${a.id}" data-action="edit" class="edit-btn btn btn-ghost btn-sm">Edit</button>
        <button data-id="${a.id}" data-enabled="${a.enabled}" data-action="toggle" class="toggle-btn btn btn-ghost btn-sm">
          ${a.enabled ? 'Disable' : 'Enable'}
        </button>
        <button data-id="${a.id}" data-action="delete" class="delete-btn btn btn-danger btn-sm">Delete</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const action = btn.getAttribute('data-action');
      const account = accounts.find((a) => a.id === id);

      if (action === 'edit' && account) {
        startEditAccount(account);
        return;
      }

      if (action === 'toggle' && account) {
        await authFetch(`${API_BASE}/api/accounts/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !account.enabled }),
        });
        loadAdmin();
        return;
      }

      if (action === 'delete') {
        if (!confirm('Delete this account?')) return;
        await authFetch(`${API_BASE}/api/accounts/${id}`, { method: 'DELETE' });
        if (editingAccountId === id) resetAccountForm();
        loadAdmin();
      }
    });
  });
}

async function submitAccountForm(e) {
  e.preventDefault();
  const form = e.target;
  const msg = document.getElementById('form-message');
  const payload = {
    name: form.name.value.trim(),
    accountId: form.accountId.value.trim(),
    apiToken: form.apiToken.value.trim(),
  };

  try {
    let resp;
    if (editingAccountId) {
      const body = { name: payload.name, accountId: payload.accountId };
      if (payload.apiToken) body.apiToken = payload.apiToken;
      resp = await authFetch(`${API_BASE}/api/accounts/${editingAccountId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      resp = await authFetch(`${API_BASE}/api/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.error || 'Failed to save account');
    }

    const wasEdit = !!editingAccountId;
    resetAccountForm();
    if (msg) {
      msg.textContent = wasEdit ? 'Account updated.' : 'Account added successfully.';
      msg.className = 'form-message form-message--success';
    }
    loadAdmin();
  } catch (err) {
    if (msg) {
      if (err.status === 401) {
        msg.textContent = 'Login required. Redirecting…';
        msg.className = 'form-message form-message--error';
        redirectToLogin('/admin');
        return;
      }
      msg.textContent = err.message;
      msg.className = 'form-message form-message--error';
    }
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const nav = document.getElementById('nav-auth');
  if (nav) setupNavAuth(nav);

  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshQuotas);

  if (document.getElementById('accounts-grid')) loadDashboard();

  const form = document.getElementById('account-form');
  if (form) {
    const { requirePageAuth } = await import('./auth.js');
    await requirePageAuth();
    form.addEventListener('submit', submitAccountForm);
    loadAdmin();

    const verifyBtn = document.getElementById('verify-btn');
    if (verifyBtn) verifyBtn.addEventListener('click', verifyAccountForm);

    const cancelBtn = document.getElementById('cancel-edit-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', resetAccountForm);
  }
});

export { loadDashboard, loadAdmin, refreshQuotas };
