import { setupNavAuth, authFetch, redirectToLogin } from './auth.js';
import { startRateLimitCountdown } from './rate-limit.js';

const API_BASE = window.location.origin;

const REFRESH_INTERVAL_LABELS = {
  15: '15 分钟',
  20: '20 分钟',
  30: '30 分钟',
  60: '1 小时',
  120: '2 小时',
  360: '6 小时',
};

let dashboardConfig = { refreshIntervalMinutes: 20 };
let autoRefreshTimer = null;
let autoRefreshHintTimer = null;
let nextAutoRefreshAt = null;

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
  kv_namespaces: 'KV 命名空间',
  d1_reads: 'D1 读取（行）',
  d1_writes: 'D1 写入（行）',
  d1_storage_gb: 'D1 存储',
  kv_reads: 'KV 读取',
  kv_writes: 'KV 写入',
  kv_deletes: 'KV 删除',
  kv_lists: 'KV 列表',
  kv_storage_gb: 'KV 存储',
  r2_buckets: 'R2 存储桶',
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
    metaFn: (quotas) => {
      const ns = quotas?.kv_namespaces;
      if (ns?.available) return `${ns.used.toLocaleString()} 个命名空间`;
      if (ns?.note) return ns.note;
      return '';
    },
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
    metaFn: (quotas) => {
      const buckets = quotas?.r2_buckets;
      if (buckets?.available) return `${buckets.used.toLocaleString()} 个存储桶`;
      if (buckets?.note) return buckets.note;
      return '';
    },
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

const METRIC_ICONS = {
  workers_requests: '🔶',
  pages_requests: '⚡',
  workers_build_minutes: '🔨',
  pages_builds: '📦',
  d1_reads: '🗄️',
  kv_reads: '🔑',
  r2_storage_gb: '☁️',
  ai_neurons: '🤖',
};

const SERVICE_ICONS = {
  kv: '🔑',
  d1: '🗄️',
  r2: '☁️',
};

const GROUP_ICONS = {
  '计算与运行时': '⚙️',
  'Durable Objects': '💠',
  '消息与数据平面': '📨',
  '分析': '📈',
};

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
    keys: ['analytics_engine_writes', 'workers_logs_events', 'workers_logs_bytes'],
  },
];

const DEFAULT_ALERT_THRESHOLD = 80;

let alertServiceGroups = [];

async function loadAlertServiceGroups() {
  if (alertServiceGroups.length) return alertServiceGroups;
  try {
    const resp = await fetch(`${API_BASE}/api/alert-service-groups`);
    const data = await resp.json();
    alertServiceGroups = data.groups ?? [];
  } catch {
    alertServiceGroups = [
      { id: 'workers', title: 'Workers', keys: ['workers_requests', 'workers_build_minutes'] },
      { id: 'pages', title: 'Pages', keys: ['pages_requests', 'pages_builds'] },
      { id: 'd1', title: 'D1', keys: ['d1_reads', 'd1_writes', 'd1_storage_gb'] },
      { id: 'kv', title: 'KV', keys: ['kv_reads', 'kv_writes', 'kv_storage_gb'] },
      { id: 'r2', title: 'R2', keys: ['r2_storage_gb', 'r2_class_a', 'r2_class_b'] },
    ];
  }
  return alertServiceGroups;
}

function getGroupStateFromRules(group, alertRules = []) {
  const rulesByKey = new Map((alertRules ?? []).map((r) => [r.metricKey, r]));
  const groupRules = group.keys.map((k) => rulesByKey.get(k)).filter(Boolean);
  const enabledRules = groupRules.filter((r) => r.enabled);
  if (!enabledRules.length) {
    return { enabled: false, thresholdPercent: DEFAULT_ALERT_THRESHOLD };
  }
  return {
    enabled: true,
    thresholdPercent: enabledRules[0].thresholdPercent ?? DEFAULT_ALERT_THRESHOLD,
  };
}

function renderAlertRulesGrid(alertRules = []) {
  const grid = document.getElementById('alert-rules-grid');
  if (!grid) return;

  if (!alertServiceGroups.length) {
    grid.innerHTML = '<p class="form-hint">加载服务列表…</p>';
    return;
  }

  grid.innerHTML = alertServiceGroups.map((group) => {
    const state = getGroupStateFromRules(group, alertRules);
    return `
      <div class="alert-service-row" data-group-id="${group.id}">
        <label class="alert-service-row__enable">
          <input type="checkbox" name="alertService" value="${group.id}" ${state.enabled ? 'checked' : ''} />
          <span class="alert-service-row__title">${group.title}</span>
        </label>
        <div class="alert-service-row__threshold">
          <input
            type="number"
            name="alertThreshold_${group.id}"
            class="glass-input glass-input--sm alert-threshold-input"
            min="1"
            max="100"
            step="1"
            value="${state.thresholdPercent}"
            aria-label="${group.title} 告警阈值"
          />
          <span class="alert-service-row__unit">%</span>
        </div>
      </div>
    `;
  }).join('');
}

function setAlertFormValues(alertRules) {
  renderAlertRulesGrid(alertRules ?? []);
}

function readAlertFormValues() {
  const form = document.getElementById('account-form');
  if (!form || !alertServiceGroups.length) return [];

  const rules = [];
  for (const group of alertServiceGroups) {
    const checkbox = form.querySelector(`input[name="alertService"][value="${group.id}"]`);
    if (!checkbox?.checked) continue;

    const thresholdInput = form.querySelector(`input[name="alertThreshold_${group.id}"]`);
    let threshold = parseInt(thresholdInput?.value ?? String(DEFAULT_ALERT_THRESHOLD), 10);
    if (!Number.isFinite(threshold) || threshold < 1) threshold = 1;
    if (threshold > 100) threshold = 100;

    for (const metricKey of group.keys) {
      rules.push({ metricKey, enabled: true, thresholdPercent: threshold });
    }
  }
  return rules;
}

function summarizeAlertRules(alertRules) {
  if (!alertRules?.length) return '告警：未配置';
  const enabled = alertRules.filter((r) => r.enabled);
  if (!enabled.length) return '告警：未配置';

  const groupTitles = [];
  for (const group of alertServiceGroups) {
    const state = getGroupStateFromRules(group, enabled);
    if (state.enabled) {
      groupTitles.push(`${group.title} ≥${state.thresholdPercent}%`);
    }
  }
  if (!groupTitles.length) return `告警：${enabled.length} 项指标`;
  return `告警：${groupTitles.slice(0, 4).join(' · ')}${groupTitles.length > 4 ? ' …' : ''}`;
}

const CHANNEL_TYPE_LABELS = {
  wecom: '企业微信',
  feishu: '飞书',
  dingtalk: '钉钉',
  webhook: 'Webhook',
  telegram: 'Telegram',
  email: 'Email',
};

function renderAdminAlertTestResults(container, channels) {
  if (!container) return;
  if (!channels?.length) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  container.classList.remove('hidden');
  container.innerHTML = channels.map((ch) => {
    const typeLabel = CHANNEL_TYPE_LABELS[ch.channelType] || ch.channelType;
    const statusClass = ch.ok ? 'alert-test-result--ok' : 'alert-test-result--fail';
    const statusLabel = ch.ok ? '成功' : '失败';
    const errorLine = ch.error
      ? `<span class="alert-test-result__error">${ch.error}</span>`
      : '';
    return `
      <div class="alert-test-result ${statusClass}">
        <span><strong>${ch.channelName}</strong> · ${typeLabel}</span>
        <span class="chip ${ch.ok ? 'chip--success' : 'chip--danger'}">${statusLabel}</span>
        ${errorLine}
      </div>
    `;
  }).join('');
}

async function sendAdminTestAlert() {
  const messageEl = document.getElementById('alert-test-message');
  const resultsEl = document.getElementById('alert-test-results');
  const buttonEl = document.getElementById('test-alert-btn');

  if (messageEl) {
    messageEl.textContent = '';
    messageEl.className = 'form-message';
  }
  if (resultsEl) {
    resultsEl.classList.add('hidden');
    resultsEl.innerHTML = '';
  }

  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.dataset.originalText = buttonEl.dataset.originalText || buttonEl.textContent;
    buttonEl.textContent = '发送中…';
  }

  let rateLimited = false;
  try {
    const payload = editingAccountId ? { accountId: editingAccountId } : {};
    const resp = await authFetch(`${API_BASE}/api/alerts/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();

    if (resp.status === 429) {
      rateLimited = true;
      await startRateLimitCountdown({
        buttonEl,
        messageEl,
        retryAfterSeconds: data.retryAfterSeconds,
        buttonLabel: '发送测试告警',
      });
      return;
    }
    if (!resp.ok) throw new Error(data.error || '发送失败');

    if (messageEl) {
      messageEl.textContent = data.message || '测试告警已发送';
      messageEl.className = `form-message ${data.ok ? 'form-message--success' : 'form-message--error'}`;
    }
    renderAdminAlertTestResults(resultsEl, data.channels);
  } catch (err) {
    if (messageEl) {
      if (err.status === 401) {
        messageEl.textContent = '需要登录，正在跳转…';
        messageEl.className = 'form-message form-message--error';
        redirectToLogin('/admin');
        return;
      }
      messageEl.textContent = err.message || '发送失败';
      messageEl.className = 'form-message form-message--error';
    }
  } finally {
    if (buttonEl && !rateLimited) {
      buttonEl.disabled = false;
      buttonEl.textContent = buttonEl.dataset.originalText || '发送测试告警';
    }
  }
}

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
  container.style.setProperty('--ring-color', color);
  const bar = container.querySelector('.progress-bar-gradient');
  if (bar && pct > 0) {
    bar.style.setProperty('--bg-size', `${(100 / pct) * 100}%`);
  }
  const ringFill = container.querySelector('.ring-progress__fill');
  if (ringFill) {
    ringFill.setAttribute('stroke', color);
  }
}

function formatPctDisplay(pct) {
  const n = Number(pct) || 0;
  return n % 1 === 0 ? String(n) : n.toFixed(1);
}

function renderRingProgress(pct, size = 56) {
  const stroke = 5;
  const clampedPct = Math.max(0, Math.min(100, Number(pct) || 0));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clampedPct / 100);
  const color = getGradientColor(clampedPct);
  const cx = size / 2;

  return `
    <div class="ring-progress" data-hero-pct="${clampedPct}" style="--ring-size:${size}px;--ring-color:${color}">
      <svg class="ring-progress__svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
        <circle class="ring-progress__track" cx="${cx}" cy="${cx}" r="${radius}" stroke-width="${stroke}" />
        <circle class="ring-progress__fill" cx="${cx}" cy="${cx}" r="${radius}" stroke-width="${stroke}"
          stroke="${color}" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" />
      </svg>
      <span class="ring-progress__label">${formatPctDisplay(clampedPct)}%</span>
    </div>
  `;
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

function renderMetricRingCard(metricKey, metric, ringSize = 48, overrides = {}) {
  const showWhenUnavailable = overrides.showWhenUnavailable ?? false;
  if (!showWhenUnavailable && !metric?.available) return '';

  const icon = overrides.icon ?? METRIC_ICONS[metricKey] ?? '📊';
  const label = overrides.label ?? getLabelZh(metricKey, metric);
  const used = metric?.used ?? 0;
  const limit = metric?.limit ?? 0;
  const unit = metric?.unit;
  const pct = Number(metric?.pct) || calcPct(used, limit);
  const formatNum = (v) => (overrides.rawNumbers ? v.toLocaleString() : formatValue(v, unit));
  const usedDisplay = formatNum(used);
  const detail = limit > 0 ? `${formatNum(used)} / ${formatNum(limit)}` : '不可用';

  return `
    <div class="mini-card mini-card--quota mini-card--ring" data-hero-pct="${pct}">
      <span class="mini-card__icon">${icon}</span>
      <div class="mini-card__body">
        <span class="mini-card__label">${label}</span>
        <span class="mini-card__value">${usedDisplay}</span>
        <p class="mini-card__detail">${detail}</p>
      </div>
      ${renderRingProgress(pct, ringSize)}
    </div>
  `;
}

function renderRequestQuotaCard(icon, label, used, limit, pct) {
  const key = label === 'Workers' ? 'workers_requests' : 'pages_requests';
  return renderMetricRingCard(key, { available: true, used, limit, pct }, 56, {
    icon,
    label,
    rawNumbers: true,
    showWhenUnavailable: true,
  });
}

function renderOverviewSummaryCards(quotas, account) {
  const cards = OVERVIEW_SUMMARY_KEYS
    .filter((k) => !(k.startsWith('r2_') && isR2Inactive(account)))
    .map((k) => renderMetricRingCard(k, quotas[k]))
    .filter(Boolean)
    .join('');

  if (!cards) return '';
  return `<div class="mini-cards mini-cards--metrics">${cards}</div>`;
}

function renderRequestQuotaOverview(quotas) {
  return `
    <div class="mini-cards mini-cards--quota">
      ${renderRequestQuotaCard('🔶', 'Workers', quotas.workersUsed, quotas.workersLimit, quotas.workersPct)}
      ${renderRequestQuotaCard('⚡', 'Pages', quotas.pagesUsed, quotas.pagesLimit, quotas.pagesPct)}
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

function renderServiceCardHead(group, metaHtml = '') {
  const icon = SERVICE_ICONS[group.id] ?? GROUP_ICONS[group.title] ?? '📊';
  return `
      <div class="service-card__head">
        <div class="service-card__heading">
          <span class="service-card__icon" aria-hidden="true">${icon}</span>
          <span class="service-card__title">${group.title}</span>
        </div>
        ${metaHtml}
      </div>`;
}

function renderServiceCard(group, quotas, serviceStatus) {
  const activation = group.id ? serviceStatus?.[group.id] : undefined;
  if (activation === 'not_activated') {
    return `
    <div class="service-card">
      ${renderServiceCardHead(group)}
      <p class="service-card__inactive">未开通此服务</p>
    </div>`;
  }

  const rows = group.keys
    .map((k) => renderQuotaRow(k, quotas[k]))
    .filter(Boolean)
    .join('');
  if (!rows) return '';
  const meta = group.metaFn?.(quotas);
  const metaHtml = meta ? `<span class="service-card__meta">${meta}</span>` : '';
  return `
    <div class="service-card">
      ${renderServiceCardHead(group, metaHtml)}
      ${rows}
    </div>
  `;
}

function renderServiceSection(quotas, serviceStatus, collapsible = false) {
  const cards = [...SERVICE_GROUPS, ...OTHER_GROUPS]
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

  const body = renderServiceSection(account.quotas, account.serviceStatus, false);
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
    return {
      workersUsed: 0,
      workersLimit: 0,
      workersPct: 0,
      pagesUsed: 0,
      pagesLimit: 0,
      pagesPct: 0,
    };
  }
  const w = account.quotas.workers_requests;
  const p = account.quotas.pages_requests;
  const workersUsed = w?.available ? w.used : 0;
  const pagesUsed = p?.available ? p.used : 0;
  const workersLimit = w?.available ? w.limit : 0;
  const pagesLimit = p?.available ? p.limit : 0;
  return {
    workersUsed,
    workersLimit,
    workersPct: w?.available ? w.pct : 0,
    pagesUsed,
    pagesLimit,
    pagesPct: p?.available ? p.pct : 0,
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
  const summaryCards = renderOverviewSummaryCards(account.quotas, account);

  return `
    ${renderRequestQuotaOverview(hero)}
    ${summaryCards}
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

async function loadDashboardConfig() {
  try {
    const resp = await fetch(`${API_BASE}/api/config`);
    if (!resp.ok) return dashboardConfig;
    const data = await resp.json();
    dashboardConfig = {
      refreshIntervalMinutes: data.refreshIntervalMinutes ?? 20,
    };
    return dashboardConfig;
  } catch {
    return dashboardConfig;
  }
}

function formatIntervalLabel(minutes) {
  return REFRESH_INTERVAL_LABELS[minutes] || `${minutes} 分钟`;
}

function updateAutoRefreshHint() {
  const hintEl = document.getElementById('auto-refresh-hint');
  if (!hintEl || !nextAutoRefreshAt) return;

  const remainingMs = nextAutoRefreshAt - Date.now();
  if (remainingMs <= 0) {
    hintEl.textContent = ` · 访问刷新：每 ${formatIntervalLabel(dashboardConfig.refreshIntervalMinutes)}（即将检查）`;
    return;
  }

  const totalSec = Math.ceil(remainingMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const countdown = min > 0 ? `${min} 分 ${sec} 秒` : `${sec} 秒`;
  hintEl.textContent = ` · 访问刷新：每 ${formatIntervalLabel(dashboardConfig.refreshIntervalMinutes)}（${countdown} 后检查）`;
}

function clearAutoRefreshTimers() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  if (autoRefreshHintTimer) {
    clearInterval(autoRefreshHintTimer);
    autoRefreshHintTimer = null;
  }
}

async function runAutoRefreshCycle() {
  await loadDashboard();
}

function setupDashboardAutoRefresh() {
  clearAutoRefreshTimers();

  const hintEl = document.getElementById('auto-refresh-hint');
  if (!document.getElementById('accounts-grid')) return;

  const intervalMs = dashboardConfig.refreshIntervalMinutes * 60 * 1000;
  nextAutoRefreshAt = Date.now() + intervalMs;
  updateAutoRefreshHint();

  autoRefreshHintTimer = setInterval(updateAutoRefreshHint, 1000);
  autoRefreshTimer = setInterval(async () => {
    nextAutoRefreshAt = Date.now() + intervalMs;
    await runAutoRefreshCycle();
  }, intervalMs);

  if (hintEl) {
    hintEl.textContent = ` · 访问刷新：每 ${formatIntervalLabel(dashboardConfig.refreshIntervalMinutes)}（过期时自动拉取）`;
  }
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
  const statsEl = document.getElementById('refresh-stats');

  if (updated) {
    updated.textContent = data.lastUpdated
      ? new Date(data.lastUpdated).toLocaleString()
      : '从未更新';
  }

  if (statsEl && data.refreshStats) {
    const s = data.refreshStats;
    statsEl.textContent = ` · 已刷新 ${s.refreshed}/${s.refreshed + s.cached + s.failed}`;
  }

  if (!grid) return;

  if (!data.accounts?.length) {
    grid.classList.remove('accounts-grid--single');
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">📊</div>
        <p>暂无配额数据。</p>
        <p><a href="/admin">添加账号</a> 或点击「手动刷新」。</p>
      </div>`;
    return;
  }

  grid.classList.toggle('accounts-grid--single', data.accounts.length === 1);

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
  if (title) title.textContent = '添加账号';
  if (submitBtn) submitBtn.textContent = '保存账号';
  if (cancelBtn) cancelBtn.classList.add('hidden');
  if (tokenInput) {
    tokenInput.required = true;
    tokenInput.placeholder = 'Cloudflare API Token';
  }
  setAlertFormValues(null);
}

function startEditAccount(account) {
  const form = document.getElementById('account-form');
  if (!form) return;
  editingAccountId = account.id;
  form.name.value = account.name;
  form.accountId.value = account.accountId;
  form.apiToken.value = '';
  form.apiToken.required = false;
  form.apiToken.placeholder = `留空则保留 ${account.apiToken}`;
  setAlertFormValues(account.alertRules);

  const title = document.getElementById('form-title');
  const submitBtn = document.getElementById('submit-btn');
  const cancelBtn = document.getElementById('cancel-edit-btn');
  if (title) title.textContent = `编辑账号 · ${account.name}`;
  if (submitBtn) submitBtn.textContent = '更新账号';
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
      msg.textContent = '请先填写 Account ID 和 API Token 再验证。';
      msg.className = 'form-message form-message--error';
    }
    return;
  }

  const verifyBtn = document.getElementById('verify-btn');
  if (verifyBtn) {
    verifyBtn.disabled = true;
    verifyBtn.textContent = '验证中…';
  }

  try {
    const resp = await authFetch(`${API_BASE}/api/accounts/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, apiToken }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      throw new Error(data.error || '验证失败');
    }
    if (msg) {
      const nameHint = data.accountName ? `（${data.accountName}）` : '';
      msg.textContent = `凭据验证通过${nameHint}。`;
      msg.className = 'form-message form-message--success';
    }
    if (data.accountName && !form.name.value.trim()) {
      form.name.value = data.accountName;
    }
  } catch (err) {
    if (msg) {
      if (err.status === 401) {
        msg.textContent = '需要登录，正在跳转…';
        msg.className = 'form-message form-message--error';
        redirectToLogin('/admin');
        return;
      }
      msg.textContent = err.message || '验证失败';
      msg.className = 'form-message form-message--error';
    }
  } finally {
    if (verifyBtn) {
      verifyBtn.disabled = false;
      verifyBtn.textContent = '验证凭据';
    }
  }
}

async function loadDashboardSettings() {
  const form = document.getElementById('settings-form');
  if (!form) return;

  try {
    const resp = await authFetch(`${API_BASE}/api/config`);
    const data = await resp.json();
    if (form.refreshIntervalMinutes) {
      form.refreshIntervalMinutes.value = String(data.refreshIntervalMinutes ?? 20);
    }
  } catch (err) {
    const msg = document.getElementById('settings-message');
    if (msg && err.status === 401) {
      msg.textContent = '需要登录才能修改设置，正在跳转…';
      msg.className = 'form-message form-message--error';
      redirectToLogin('/admin');
    }
  }
}

async function submitSettingsForm(e) {
  e.preventDefault();
  const form = e.target;
  const msg = document.getElementById('settings-message');
  const minutes = parseInt(form.refreshIntervalMinutes.value, 10);

  try {
    const resp = await authFetch(`${API_BASE}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshIntervalMinutes: minutes }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || '保存失败');
    }

    dashboardConfig.refreshIntervalMinutes = data.refreshIntervalMinutes;
    if (msg) {
      msg.textContent = `已保存：每 ${formatIntervalLabel(data.refreshIntervalMinutes)} 访问时检查缓存。`;
      msg.className = 'form-message form-message--success';
    }
    setupDashboardAutoRefresh();
  } catch (err) {
    if (msg) {
      if (err.status === 401) {
        msg.textContent = '需要登录，正在跳转…';
        msg.className = 'form-message form-message--error';
        redirectToLogin('/admin');
        return;
      }
      msg.textContent = err.message || '保存失败';
      msg.className = 'form-message form-message--error';
    }
  }
}

async function reorderAccounts(accountIds) {
  const resp = await authFetch(`${API_BASE}/api/accounts/reorder`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountIds }),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw Object.assign(new Error(err.error || '排序失败'), { status: resp.status });
  }
  return resp.json();
}

function renderAdminAccountItem(account) {
  const alertSummary = summarizeAlertRules(account.alertRules);

  return `
    <div class="list-item list-item--sortable" data-id="${account.id}" draggable="false">
      <button type="button" class="account-drag-handle" aria-label="拖动排序" title="拖动排序">
        <span class="drag-handle-dots" aria-hidden="true">
          <span></span><span></span><span></span><span></span><span></span><span></span>
        </span>
      </button>
      <div class="list-item__body">
        <div class="list-item__content">
          <div class="list-item__header">
            <p class="list-item__title">${account.name}</p>
            <span class="chip ${account.enabled ? 'chip--success' : 'chip--muted'}">
              ${account.enabled ? '已启用' : '已禁用'}
            </span>
          </div>
          <p class="list-item__meta">${account.accountId}</p>
          <p class="list-item__meta">Token: ${account.apiToken}</p>
          <p class="list-item__meta">${alertSummary}</p>
        </div>
      </div>
      <div class="list-item__actions">
        <button data-id="${account.id}" data-action="edit" class="edit-btn btn btn-ghost btn-sm">编辑</button>
        <button data-id="${account.id}" data-enabled="${account.enabled}" data-action="toggle" class="toggle-btn btn btn-ghost btn-sm">
          ${account.enabled ? '禁用' : '启用'}
        </button>
        <button data-id="${account.id}" data-action="delete" class="delete-btn btn btn-danger btn-sm">删除</button>
      </div>
    </div>
  `;
}

function setupAccountDragDrop(list, getAccountIds, onReordered) {
  let draggedId = null;

  list.querySelectorAll('.list-item').forEach((item) => {
    const id = item.dataset.id;
    const handle = item.querySelector('.account-drag-handle');

    handle?.addEventListener('mousedown', () => {
      item.draggable = true;
    });
    item.addEventListener('dragend', () => {
      item.draggable = false;
      item.classList.remove('list-item--dragging');
      list.querySelectorAll('.list-item').forEach((el) => el.classList.remove('list-item--drag-over'));
      draggedId = null;
    });

    item.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer) return;
      draggedId = id;
      item.classList.add('list-item--dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (draggedId && draggedId !== id) {
        item.classList.add('list-item--drag-over');
      }
    });

    item.addEventListener('dragleave', (e) => {
      if (!item.contains(e.relatedTarget)) {
        item.classList.remove('list-item--drag-over');
      }
    });

    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      item.classList.remove('list-item--drag-over');
      if (!draggedId || draggedId === id) return;

      const ids = getAccountIds();
      const fromIdx = ids.indexOf(draggedId);
      const toIdx = ids.indexOf(id);
      if (fromIdx === -1 || toIdx === -1) return;

      const nextIds = [...ids];
      nextIds.splice(fromIdx, 1);
      nextIds.splice(toIdx, 0, draggedId);

      list.classList.add('accounts-sortable-list--busy');
      try {
        await onReordered(nextIds);
      } catch (err) {
        if (err.status === 401) {
          redirectToLogin('/admin');
          return;
        }
        alert(err.message || '排序失败');
        loadAdmin();
      } finally {
        list.classList.remove('accounts-sortable-list--busy');
      }
    });
  });
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
        <p>尚未配置账号。</p>
      </div>`;
    return;
  }

  list.className = 'accounts-sortable-list';
  list.innerHTML = accounts.map(renderAdminAccountItem).join('');

  setupAccountDragDrop(
    list,
    () => [...list.querySelectorAll('.list-item')].map((el) => el.dataset.id),
    async (accountIds) => {
      await reorderAccounts(accountIds);
      loadAdmin();
    },
  );

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
        if (!confirm('确定删除此账号？')) return;
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
  const alertRules = readAlertFormValues();
  const payload = {
    name: form.name.value.trim(),
    accountId: form.accountId.value.trim(),
    apiToken: form.apiToken.value.trim(),
    alertRules,
  };

  try {
    let resp;
    if (editingAccountId) {
      const body = {
        name: payload.name,
        accountId: payload.accountId,
        alertRules: payload.alertRules,
      };
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
      throw new Error(err.error || '保存账号失败');
    }

    const wasEdit = !!editingAccountId;
    resetAccountForm();
    if (msg) {
      msg.textContent = wasEdit ? '账号已更新。' : '账号添加成功。';
      msg.className = 'form-message form-message--success';
    }
    loadAdmin();
  } catch (err) {
    if (msg) {
      if (err.status === 401) {
        msg.textContent = '需要登录，正在跳转…';
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

  if (document.getElementById('accounts-grid')) {
    await loadDashboardConfig();
    await loadDashboard();
    setupDashboardAutoRefresh();
  }

  const form = document.getElementById('account-form');
  if (form) {
    const { requirePageAuth } = await import('./auth.js');
    await requirePageAuth();
    await loadAlertServiceGroups();
    renderAlertRulesGrid();
    form.addEventListener('submit', submitAccountForm);
    loadAdmin();
    loadDashboardSettings();

    const settingsForm = document.getElementById('settings-form');
    if (settingsForm) settingsForm.addEventListener('submit', submitSettingsForm);

    const verifyBtn = document.getElementById('verify-btn');
    if (verifyBtn) verifyBtn.addEventListener('click', verifyAccountForm);

    const cancelBtn = document.getElementById('cancel-edit-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', resetAccountForm);

    const testAlertBtn = document.getElementById('test-alert-btn');
    if (testAlertBtn) testAlertBtn.addEventListener('click', sendAdminTestAlert);
  }
});

export { loadDashboard, loadAdmin, refreshQuotas };
