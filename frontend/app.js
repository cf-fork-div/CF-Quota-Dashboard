import { setupNavAuth, authFetch, redirectToLogin } from './auth.js';

const API_BASE = window.location.origin;

const LABEL_ZH = {
  workers_requests: 'Workers 请求数',
  pages_requests: 'Pages 请求',
  workers_build_minutes: 'Workers Builds（构建分钟）',
  workers_build_concurrent: 'Workers Builds（并发槽位）',
  pages_builds: 'Pages Builds（构建次数）',
  workflows_invocations: 'Workflows 调用（工作流）',
  browser_minutes: 'Browser Run（分钟）',
  ai_neurons: 'Workers AI（Neurons）',
  workers_cpu_ms: 'Workers CPU（单次请求）',
  d1_databases: 'D1 数据库',
  d1_reads: 'D1 读取（行）',
  d1_writes: 'D1 写入（行）',
  d1_storage_gb: 'D1 存储',
  kv_reads: 'KV 读取',
  kv_writes: 'KV 写入',
  kv_deletes: 'KV 删除',
  kv_lists: 'KV 列表',
  kv_storage_gb: 'KV 存储',
  r2_storage_gb: 'R2 存储',
  r2_class_a: 'R2 Class A 操作（写入类）',
  r2_class_b: 'R2 Class B 操作（读取类）',
  durable_objects_requests: 'Durable Objects 请求',
  durable_objects_duration: 'Durable Objects Duration（GB-s）',
  durable_objects_rows_read: 'Durable Objects 读取（行）',
  durable_objects_rows_written: 'Durable Objects 写入（行）',
  durable_objects_sql_storage_gb: 'Durable Objects SQL 存储',
  queues_ops: 'Queues 操作',
  hyperdrive_queries: 'Hyperdrive 查询',
  vectorize_queried_dims: 'Vectorize 查询（维度）',
  vectorize_stored_dims: 'Vectorize 存储（维度）',
  analytics_engine_writes: 'Analytics Engine 写入',
  workers_logs_events: 'Workers Logs 事件',
  workers_logs_bytes: 'Workers Logs 写入（字节）',
};

const PERIOD_ZH = { daily: '今日', monthly: '本月', total: '总计' };

const SERVICE_GROUPS = [
  {
    id: 'kv',
    title: 'KV',
    keys: ['kv_reads', 'kv_writes', 'kv_deletes', 'kv_lists', 'kv_storage_gb'],
    metaFn: () => '',
  },
  {
    id: 'd1',
    title: 'D1',
    keys: ['d1_reads', 'd1_writes', 'd1_storage_gb'],
    metaFn: (quotas) => {
      const db = quotas?.d1_databases;
      if (db?.available) return `${db.used.toLocaleString()} 个数据库`;
      if (db?.note) return db.note;
      return '';
    },
  },
  {
    id: 'r2',
    title: 'R2',
    keys: ['r2_storage_gb', 'r2_class_a', 'r2_class_b'],
    metaFn: () => '',
  },
];

const OVERVIEW_SUMMARY_KEYS = [
  'workers_build_minutes',
  'pages_builds',
  'd1_reads',
  'kv_reads',
  'r2_storage_gb',
  'ai_neurons',
];

const OTHER_GROUPS = [
  {
    title: '计算与运行时',
    keys: ['workers_build_minutes', 'pages_builds', 'workers_requests', 'browser_minutes', 'ai_neurons'],
  },
  {
    title: 'Durable Objects',
    keys: [
      'durable_objects_requests', 'durable_objects_duration',
      'durable_objects_rows_read', 'durable_objects_rows_written', 'durable_objects_sql_storage_gb',
    ],
  },
  {
    title: '消息与数据平面',
    keys: ['queues_ops', 'hyperdrive_queries', 'vectorize_queried_dims', 'vectorize_stored_dims'],
  },
  {
    title: '分析',
    keys: ['analytics_engine_writes'],
  },
];

function getLabelZh(key, metric) {
  return LABEL_ZH[key] || metric?.label || key;
}

function getGradientColor(percent) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  let r; let g; let b;
  if (pct <= 50) {
    const t = pct / 50;
    r = Math.round(16 + (234 - 16) * t);
    g = Math.round(185 + (179 - 185) * t);
    b = Math.round(129 - 129 * t);
  } else {
    const t = (pct - 50) / 50;
    r = Math.round(234 + (239 - 234) * t);
    g = Math.round(179 - 179 * t);
    b = Math.round(8 + (68 - 8) * t);
  }
  return `rgb(${r}, ${g}, ${b})`;
}

function getGradientShadow(percent) {
  const rgb = getGradientColor(percent).match(/\d+/g);
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.4)`;
}

function applyGradientColor(container, percent) {
  if (!container) return;
  const pct = Number(percent) || 0;
  const color = getGradientColor(pct);
  const shadow = getGradientShadow(pct);
  container.style.setProperty('--gradient-color', color);
  container.style.setProperty('--gradient-color-shadow', `0 0 20px ${shadow}`);
  const bar = container.querySelector('.progress-bar-gradient');
  if (bar && pct > 0) {
    bar.style.setProperty('--bg-size', `${(100 / pct) * 100}%`);
  }
}

function calcPct(used, limit) {
  if (!limit || limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 1000) / 10);
}

function formatValue(value, unit) {
  if (unit === 'GB') return `${value} GB`;
  if (unit === 'bytes') return `${value.toLocaleString()} B`;
  return value.toLocaleString();
}

function formatQuotaMeta(metric) {
  if (!metric?.available) return '不可用';
  const used = formatValue(metric.used, metric.unit);
  const limit = formatValue(metric.limit, metric.unit);
  const period = PERIOD_ZH[metric.period] || metric.period;
  return `${used} / ${limit} · ${metric.pct}% · ${period}`;
}

function renderHeroSection(used, limit, pct) {
  const width = Math.min(100, pct);
  return `
    <div class="hero-section" data-hero-pct="${pct}">
      <div class="hero-section__header">
        <span class="hero-section__label">总请求占比</span>
        <span class="hero-section__pct">${pct}%</span>
      </div>
      <div class="progress-track progress-track--hero">
        <div class="progress-bar-gradient" style="width:${width}%"></div>
      </div>
      <p class="hero-section__detail">${used.toLocaleString()} / ${limit.toLocaleString()} 请求次数</p>
    </div>
  `;
}

function renderMiniCards(workersUsed, pagesUsed) {
  return `
    <div class="mini-cards">
      <div class="mini-card">
        <span class="mini-card__icon">🔶</span>
        <div class="mini-card__info">
          <span class="mini-card__label">Workers</span>
          <span class="mini-card__value">${workersUsed.toLocaleString()}</span>
        </div>
      </div>
      <div class="mini-card">
        <span class="mini-card__icon">⚡</span>
        <div class="mini-card__info">
          <span class="mini-card__label">Pages</span>
          <span class="mini-card__value">${pagesUsed.toLocaleString()}</span>
        </div>
      </div>
    </div>
  `;
}

function renderQuotaRow(key, metric) {
  if (!metric) return '';
  const pct = metric.available ? metric.pct : 0;
  const width = metric.available ? Math.min(100, pct) : 0;
  const color = metric.available ? getGradientColor(pct) : 'transparent';
  const note = metric.note ? `<p class="quota-row__note">${metric.note}</p>` : '';
  return `
    <div class="quota-row">
      <div class="quota-row__top">
        <span class="quota-row__label">${getLabelZh(key, metric)}</span>
        <span class="quota-row__meta">${formatQuotaMeta(metric)}</span>
      </div>
      <div class="quota-track">
        <div class="quota-fill" style="width:${width}%;background:${color}"></div>
      </div>
      ${note}
    </div>
  `;
}

function renderServiceCard(group, quotas, serviceStatus) {
  const activation = serviceStatus?.[group.id];
  if (activation === 'not_activated') {
    return `
    <div class="service-card">
      <div class="service-card__head">
        <span class="service-card__title">${group.title}</span>
      </div>
      <p class="service-card__inactive">未开通此服务</p>
    </div>`;
  }

  const rows = group.keys
    .map((k) => renderQuotaRow(k, quotas[k]))
    .filter(Boolean)
    .join('');
  if (!rows) return '';
  const meta = group.metaFn(quotas);
  const metaHtml = meta ? `<span class="service-card__meta">${meta}</span>` : '';
  return `
    <div class="service-card">
      <div class="service-card__head">
        <span class="service-card__title">${group.title}</span>
        ${metaHtml}
      </div>
      ${rows}
    </div>
  `;
}

function renderServiceSection(quotas, serviceStatus, collapsible = false) {
  const cards = SERVICE_GROUPS
    .map((g) => renderServiceCard(g, quotas, serviceStatus))
    .filter(Boolean)
    .join('');
  if (!cards) return '';
  const inner = `<div class="service-cards">${cards}</div>`;
  if (!collapsible) return inner;
  return `
    <details class="quota-details">
      <summary class="quota-details__summary">
        <span class="quota-details__title">资源额度细节</span>
        <span class="quota-details__meta">KV / D1 / R2</span>
      </summary>
      <div class="quota-details__body">${inner}</div>
    </details>
  `;
}

function renderAccountDetails(account) {
  if (!account.quotas || account.status !== 'ok') return '';

  const serviceBlock = renderServiceSection(account.quotas, account.serviceStatus, false);
  const otherBlocks = OTHER_GROUPS
    .map((g) => {
      const rows = g.keys
        .map((k) => renderQuotaRow(k, account.quotas[k]))
        .filter(Boolean)
        .join('');
      if (!rows) return '';
      return `<div class="quota-group-block"><h4 class="quota-group-block__title">${g.title}</h4>${rows}</div>`;
    })
    .filter(Boolean)
    .join('');

  const body = [serviceBlock, otherBlocks].filter(Boolean).join('');
  if (!body) return '';

  return `
    <details class="quota-details">
      <summary class="quota-details__summary">
        <span class="quota-details__title">配额详情</span>
        <span class="quota-details__meta">展开查看</span>
      </summary>
      <div class="quota-details__body">${body}</div>
    </details>
  `;
}

function getAccountRequestHero(account) {
  if (account.status !== 'ok' || !account.quotas) {
    return { totalUsed: 0, totalLimit: 0, pct: 0, workersUsed: 0, pagesUsed: 0 };
  }
  const w = account.quotas.workers_requests;
  const p = account.quotas.pages_requests;
  const workersUsed = w?.available ? w.used : 0;
  const pagesUsed = p?.available ? p.used : 0;
  const workersLimit = w?.available ? w.limit : 0;
  const pagesLimit = p?.available ? p.limit : 0;
  const totalUsed = workersUsed + pagesUsed;
  const totalLimit = workersLimit + pagesLimit;
  return {
    totalUsed,
    totalLimit,
    pct: calcPct(totalUsed, totalLimit),
    workersUsed,
    pagesUsed,
  };
}

function isR2Inactive(account) {
  return account.serviceStatus?.r2 === 'not_activated';
}

function collectAlerts(accounts) {
  const alerts = [];
  for (const acc of accounts) {
    if (acc.status !== 'ok') continue;
    for (const [key, m] of Object.entries(acc.quotas ?? {})) {
      if (key.startsWith('r2_') && isR2Inactive(acc)) continue;
      if (m.available && m.pct >= 70) {
        alerts.push({ account: acc.accountName, key, metric: m });
      }
    }
  }
  return alerts;
}

function aggregateMetrics(accounts) {
  const okAccounts = accounts.filter((a) => a.status === 'ok');
  return {
    accountCount: accounts.length,
    okCount: okAccounts.length,
    errorCount: accounts.filter((a) => a.status === 'error').length,
    alerts: collectAlerts(accounts),
  };
}

function renderStatusBadge(summary) {
  const allOk = summary.errorCount === 0 && summary.okCount > 0;
  const hasErrors = summary.errorCount > 0;
  const cls = allOk ? 'status-badge status-badge--online' : hasErrors ? 'status-badge status-badge--error' : 'status-badge';
  const label = allOk ? 'System Online' : hasErrors ? `${summary.errorCount} 个账号异常` : '等待数据';
  return `
    <div class="${cls}">
      <span class="status-badge__dot"></span>
      <span>${label}</span>
    </div>
  `;
}

function renderAlertsBlock(alerts) {
  if (!alerts.length) return '';
  return `
    <div class="alert-box alert-box--danger dashboard-alerts">
      <p><strong>${alerts.length} 项指标 ≥ 70%</strong></p>
      <ul>
        ${alerts.slice(0, 12).map((a) =>
          `<li>${a.account} · ${getLabelZh(a.key, a.metric)} · ${a.metric.pct}%</li>`,
        ).join('')}
        ${alerts.length > 12 ? `<li>…还有 ${alerts.length - 12} 项</li>` : ''}
      </ul>
    </div>
  `;
}

function renderDashboardHeader(summary) {
  const accountHint = summary.accountCount > 0
    ? `<p class="dashboard-account-hint">${summary.accountCount} 个账号</p>`
    : '';
  return accountHint;
}

function renderAccountOverview(account) {
  if (account.status !== 'ok' || !account.quotas) return '';

  const hero = getAccountRequestHero(account);
  const summaryRows = OVERVIEW_SUMMARY_KEYS
    .filter((k) => !(k.startsWith('r2_') && isR2Inactive(account)))
    .map((k) => renderQuotaRow(k, account.quotas[k]))
    .filter(Boolean)
    .join('');

  return `
    ${renderHeroSection(hero.totalUsed, hero.totalLimit, hero.pct)}
    ${renderMiniCards(hero.workersUsed, hero.pagesUsed)}
    <div class="overview-summary">${summaryRows}</div>
  `;
}

function renderAccountCard(account) {
  const statusBadge = account.status === 'error'
    ? `<span class="chip chip--danger">异常</span>`
    : '';

  const errorBlock = account.error
    ? `<p class="text-error account-card__error">${account.error}</p>`
    : '';

  const overviewBlock = renderAccountOverview(account);
  const detailsBlock = renderAccountDetails(account);

  return `
    <article class="glass-card glass-card--account">
      <div class="account-card__head">
        <h3 class="account-card__title">${account.accountName}</h3>
        ${statusBadge}
      </div>
      ${errorBlock}
      ${overviewBlock}
      ${detailsBlock}
    </article>
  `;
}

function applyHeroGradients(root) {
  if (!root) return;
  requestAnimationFrame(() => {
    root.querySelectorAll('[data-hero-pct]').forEach((el) => {
      applyGradientColor(el, parseFloat(el.dataset.heroPct));
    });
  });
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
    btn.classList.add('icon-btn--spin');
  }
  if (statsEl) statsEl.textContent = '';
  try {
    const resp = await authFetch(`${API_BASE}/cron/fetch`, { method: 'POST' });
    const data = await resp.json();
    await loadDashboard();
    if (statsEl && data.refreshStats) {
      const s = data.refreshStats;
      statsEl.textContent = ` · 刷新 ${s.refreshed}/${s.refreshed + s.cached + s.failed}`;
    }
  } catch (err) {
    if (err.status === 401) {
      if (confirm('手动刷新需要登录，是否前往登录页？')) {
        redirectToLogin('/');
      }
    } else if (statsEl) {
      statsEl.textContent = ` · ${err.message || '刷新失败'}`;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('icon-btn--spin');
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
      : '从未更新';
  }

  if (!grid) return;

  if (!data.accounts?.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">📊</div>
        <p>暂无配额数据。</p>
        <p><a href="/admin">添加账号</a> 或点击「手动刷新」。</p>
      </div>`;
    return;
  }

  const summary = aggregateMetrics(data.accounts);
  const statusEl = document.getElementById('dashboard-status');
  const headerHintEl = document.getElementById('dashboard-header-hint');
  if (statusEl) statusEl.innerHTML = renderStatusBadge(summary);
  if (headerHintEl) headerHintEl.innerHTML = renderDashboardHeader(summary);

  const alertsBlock = renderAlertsBlock(summary.alerts);
  const accountCards = data.accounts.map(renderAccountCard).join('');

  grid.innerHTML = alertsBlock + accountCards;
  applyHeroGradients(grid);
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
