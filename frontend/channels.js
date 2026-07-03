import { requirePageAuth, setupNavAuth, authFetch, parseJsonResponse, redirectToLogin } from './auth.js';
import { startRateLimitCountdown } from './rate-limit.js';
import { escapeHtml } from './utils.js';

const API_BASE = window.location.origin;

const TYPE_INFO = {
  wecom: {
    iconClass: 'fab fa-weixin',
    colorClass: 'channel-icon--wecom',
    bgClass: 'channel-icon-bg--wecom',
    label: '企业微信',
    desc: '适合企业微信群机器人',
  },
  feishu: {
    iconClass: 'fas fa-paper-plane',
    colorClass: 'channel-icon--feishu',
    bgClass: 'channel-icon-bg--feishu',
    label: '飞书',
    desc: '适合飞书群机器人',
  },
  dingtalk: {
    iconClass: 'fas fa-comment-dots',
    colorClass: 'channel-icon--dingtalk',
    bgClass: 'channel-icon-bg--dingtalk',
    label: '钉钉',
    desc: '适合钉钉自定义机器人',
  },
  webhook: {
    iconClass: 'fas fa-link',
    colorClass: 'channel-icon--webhook',
    bgClass: 'channel-icon-bg--webhook',
    label: 'Webhook',
    desc: '推送到自定义 HTTP 接口',
  },
  telegram: {
    iconClass: 'fab fa-telegram',
    colorClass: 'channel-icon--telegram',
    bgClass: 'channel-icon-bg--telegram',
    label: 'Telegram',
    desc: '通过 Bot 推送到聊天',
    badge: '海外',
  },
  email: {
    iconClass: 'fas fa-envelope',
    colorClass: 'channel-icon--email',
    bgClass: 'channel-icon-bg--email',
    label: 'Email',
    desc: '通过邮件中继发送告警',
    badge: '海外',
  },
};

const CONFIG_FIELDS = {
  wecom: [
    { key: 'webhookUrl', label: 'Webhook URL', type: 'password', required: true, placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...', secret: true },
  ],
  feishu: [
    { key: 'webhookUrl', label: 'Webhook URL', type: 'password', required: true, placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/...', secret: true },
  ],
  dingtalk: [
    { key: 'webhookUrl', label: 'Webhook URL', type: 'password', required: true, placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...', secret: true },
  ],
  webhook: [
    { key: 'webhookUrl', label: 'Webhook URL', type: 'password', required: true, placeholder: 'https://your-service.com/webhook', secret: true },
    { key: 'customHeaders', label: 'Custom Headers (JSON)', type: 'text', required: false, placeholder: '{"Authorization":"Bearer xxx"}' },
  ],
  telegram: [
    { key: 'botToken', label: 'Bot Token', type: 'password', required: true, placeholder: '123456:ABC-DEF...', secret: true },
    { key: 'chatId', label: 'Chat ID', type: 'text', required: true, placeholder: '-1001234567890' },
  ],
  email: [
    { key: 'to', label: '收件人邮箱', type: 'email', required: true, placeholder: 'alerts@example.com' },
    { key: 'webhookUrl', label: '邮件中继 Webhook URL', type: 'password', required: true, placeholder: 'https://api.resend.com/emails or custom relay', secret: true },
  ],
};

const SECRET_KEYS = ['secret', 'token', 'access_token', 'bot_token', 'key', 'api_key', 'webhookurl', 'webhook_url'];

let channels = [];
let channelsLoading = false;
let editingId = null;
let testingId = null;
let togglingId = null;
let deletingId = null;
let saving = false;

function getTypeInfo(type) {
  return TYPE_INFO[type] || {
    iconClass: 'fas fa-bell',
    colorClass: 'channel-icon--muted',
    bgClass: 'channel-icon-bg--muted',
    label: type || '未知渠道',
    desc: '自定义通知渠道',
  };
}

function isEnabled(ch) {
  return ch.enabled === true || Number(ch.enabled) === 1;
}

function renderChannelIcon(type, size = 'md') {
  const info = getTypeInfo(type);
  return `
    <span class="channel-icon channel-icon--${size} ${info.bgClass}" aria-hidden="true">
      <i class="${info.iconClass} ${info.colorClass}"></i>
    </span>
  `;
}

function renderTypeButton(type, info, { selected = false, picker = false } = {}) {
  const selectedClass = selected ? ' type-btn--selected' : '';
  const badge = info.badge ? `<span class="type-btn__badge">${info.badge}</span>` : '';
  return `
    <button type="button" data-type="${type}" class="type-btn type-btn--uptime${selectedClass}" ${picker ? 'data-picker="form"' : ''}>
      <i class="${info.iconClass} ${info.colorClass} type-btn__icon"></i>
      <span class="type-btn__label">${info.label}</span>
      ${badge}
    </button>
  `;
}

function renderTypeButtons(containerId, { picker = false, selectedType = null } = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = Object.entries(TYPE_INFO).map(([type, info]) =>
    renderTypeButton(type, info, { selected: selectedType === type, picker }),
  ).join('');

  container.querySelectorAll('.type-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.getAttribute('data-type');
      if (btn.getAttribute('data-picker') === 'form') {
        selectFormType(type);
      } else {
        startCreate(type);
      }
    });
  });
}

function cleanConfigForEdit(config = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(config)) {
    const isSecret = SECRET_KEYS.some((s) => key.toLowerCase().includes(s));
    clean[key] = (isSecret || (typeof value === 'string' && value.includes('****'))) ? '' : (value || '');
  }
  return clean;
}

function showPickerPanel() {
  editingId = null;
  document.getElementById('channels-picker-panel')?.classList.remove('hidden');
  document.getElementById('channels-form-panel')?.classList.add('hidden');
  renderChannelList();
}

function startCreate(type = 'wecom') {
  editingId = 'new';
  showFormPanel({ type, name: '', config: {}, enabled: true });
}

function selectFormType(type) {
  const form = document.getElementById('channel-form');
  if (!form || form.id.value) return;
  form.type.value = type;
  updateFormTypeIcon(type);
  renderFormTypeState(type, false);
  renderConfigFields(type, {});
}

function updateFormTypeIcon(type) {
  const el = document.getElementById('form-type-icon');
  if (!el) return;
  const info = getTypeInfo(type);
  el.className = `channel-icon channel-icon--md ${info.bgClass}`;
  el.innerHTML = `<i class="${info.iconClass} ${info.colorClass}"></i>`;
}

function showFormPanel(channel) {
  const isEdit = Boolean(channel.id);
  editingId = isEdit ? channel.id : 'new';

  document.getElementById('channels-picker-panel')?.classList.add('hidden');
  document.getElementById('channels-form-panel')?.classList.remove('hidden');

  const form = document.getElementById('channel-form');
  const title = document.getElementById('form-title');
  const subtitle = document.getElementById('form-subtitle');
  const typePicker = document.getElementById('form-type-picker');
  const saveLabel = document.getElementById('save-channel-label');
  const msg = document.getElementById('form-message');

  form.reset();
  form.id.value = channel.id || '';
  form.type.value = channel.type;
  form.name.value = channel.name || '';
  form.enabled.checked = channel.enabled !== false;

  const info = getTypeInfo(channel.type);
  if (title) title.textContent = isEdit ? '编辑渠道' : '添加渠道';
  if (subtitle) subtitle.textContent = `${info.label} 通知配置`;
  updateFormTypeIcon(channel.type);
  if (saveLabel) saveLabel.textContent = isEdit ? '保存修改' : '添加渠道';
  if (msg) {
    msg.textContent = '';
    msg.className = 'form-message';
  }

  typePicker?.classList.toggle('hidden', isEdit);
  renderFormTypeState(channel.type, isEdit);
  renderConfigFields(channel.type, channel.config || {}, isEdit);
  renderChannelList();
}

function renderFormTypeState(type, isEdit) {
  const container = document.getElementById('form-type-buttons');
  if (!container || isEdit) return;
  container.innerHTML = Object.entries(TYPE_INFO).map(([t, info]) =>
    renderTypeButton(t, info, { selected: t === type, picker: true }),
  ).join('');
  container.querySelectorAll('.type-btn').forEach((btn) => {
    btn.addEventListener('click', () => selectFormType(btn.getAttribute('data-type')));
  });
}

function renderConfigFields(type, values = {}, isEdit = false) {
  const container = document.getElementById('config-fields');
  const fields = CONFIG_FIELDS[type] || [];
  container.innerHTML = fields.map((f) => {
    const placeholder = isEdit && f.secret
      ? '留空则保留原密钥'
      : (f.placeholder || '');
    const required = isEdit && f.secret ? false : f.required;
    return `
      <div class="form-group">
        <label class="form-label form-label--sm">${f.label}${!f.required && f.secret ? ' <span class="form-label__optional">可选</span>' : ''}</label>
        <input
          name="config_${f.key}"
          type="${f.type}"
          ${required ? 'required' : ''}
          class="glass-input glass-input--mono"
          placeholder="${placeholder}"
          value="${values[f.key] || ''}"
          autocomplete="off"
        />
      </div>
    `;
  }).join('');
}

function hideForm() {
  showPickerPanel();
}

function editChannel(channel) {
  showFormPanel({
    id: channel.id,
    type: channel.type,
    name: channel.name,
    enabled: channel.enabled,
    config: cleanConfigForEdit(channel.config),
  });
}

async function fetchChannels() {
  const resp = await authFetch(`${API_BASE}/api/channels`);
  if (!resp.ok) throw new Error('通知渠道加载失败');
  return resp.json();
}

function updateChannelCounts() {
  const enabledEl = document.getElementById('enabled-count');
  const totalEl = document.getElementById('total-count');
  const enabled = channels.filter((c) => isEnabled(c)).length;
  if (enabledEl) enabledEl.textContent = String(enabled);
  if (totalEl) totalEl.textContent = String(channels.length);
}

function renderToggleSwitch(channel) {
  const on = isEnabled(channel);
  const onClass = on ? ' toggle-switch--on' : '';
  const label = on ? '停用渠道' : '启用渠道';
  const disabled = togglingId === channel.id ? ' disabled' : '';
  return `
    <button
      type="button"
      data-action="toggle"
      data-id="${channel.id}"
      class="toggle-switch toggle-switch--lg${onClass}${disabled}"
      aria-label="${label}：${escapeHtml(channel.name)}"
      aria-pressed="${on}"
      title="${label}"
      role="switch"
    >
      <span class="toggle-switch__track" aria-hidden="true">
        <span class="toggle-switch__thumb"></span>
      </span>
    </button>
  `;
}

function renderChannelCard(channel) {
  const info = getTypeInfo(channel.type);
  const activeClass = editingId === channel.id ? ' channel-card--active' : '';
  const enabled = isEnabled(channel);
  const statusClass = enabled ? 'channel-status-pill--enabled' : 'channel-status-pill--disabled';
  const statusLabel = enabled ? '已启用' : '已停用';
  const testing = testingId === channel.id;
  const deleting = deletingId === channel.id;

  return `
    <article class="channel-card channel-card--uptime${activeClass}" data-id="${escapeHtml(channel.id)}">
      <div class="channel-card__clickable" tabindex="0" role="button" aria-label="编辑通知渠道：${escapeHtml(channel.name)}">
        ${renderChannelIcon(channel.type, 'lg')}
        <div class="channel-card__info">
          <div class="channel-card__title-row">
            <h3 class="channel-card__title">${escapeHtml(channel.name)}</h3>
            <span class="channel-type-badge">${escapeHtml(info.label)}</span>
            <span class="channel-status-pill ${statusClass}">
              <span class="channel-status-pill__dot" aria-hidden="true"></span>
              ${statusLabel}
            </span>
          </div>
          <p class="channel-card__desc">${escapeHtml(info.desc)}</p>
        </div>
      </div>
      <div class="channel-card__actions">
        ${renderToggleSwitch(channel)}
        <button type="button" data-action="test" data-id="${escapeHtml(channel.id)}" class="btn-test-outline"${testing ? ' disabled' : ''} aria-label="测试通知渠道：${escapeHtml(channel.name)}">
          <i class="fas ${testing ? 'fa-spinner fa-spin' : 'fa-paper-plane'}" aria-hidden="true"></i>
          测试
        </button>
        <button type="button" data-action="edit" data-id="${escapeHtml(channel.id)}" class="icon-btn icon-btn--sm icon-btn--edit" aria-label="编辑 ${escapeHtml(channel.name)}" title="编辑">
          <i class="fas fa-pen" aria-hidden="true"></i>
        </button>
        <button type="button" data-action="delete" data-id="${escapeHtml(channel.id)}" class="icon-btn icon-btn--sm icon-btn--danger"${deleting ? ' disabled' : ''} aria-label="删除 ${escapeHtml(channel.name)}" title="删除">
          <i class="fas ${deleting ? 'fa-spinner fa-spin' : 'fa-trash'}" aria-hidden="true"></i>
        </button>
      </div>
    </article>
  `;
}

function renderEmptyState() {
  return `
    <div class="channels-empty-dashed">
      <div class="channels-empty-dashed__icon" aria-hidden="true">
        <i class="fas fa-bell-slash"></i>
      </div>
      <h3 class="channels-empty-dashed__title">还没有通知渠道</h3>
      <p class="channels-empty-dashed__desc">添加一个渠道后，配额异常和恢复消息会推送到这里。</p>
      <button type="button" id="empty-add-channel-btn" class="btn channels-btn-add">
        <i class="fas fa-plus" aria-hidden="true"></i>
        添加第一个渠道
      </button>
    </div>
  `;
}

function renderSkeleton() {
  return `
    <div class="channels-skeleton">
      <div class="channels-skeleton__item"></div>
      <div class="channels-skeleton__item"></div>
      <div class="channels-skeleton__item"></div>
    </div>
  `;
}

function setChannelError(message) {
  const banner = document.getElementById('channel-error');
  const text = document.getElementById('channel-error-text');
  if (!banner || !text) return;
  if (message) {
    text.textContent = message;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
    text.textContent = '';
  }
}

function renderChannelList() {
  const list = document.getElementById('channels-list');
  if (!list) return;

  if (channelsLoading && channels.length === 0) {
    list.innerHTML = renderSkeleton();
    return;
  }

  if (!channels.length) {
    list.innerHTML = renderEmptyState();
    document.getElementById('empty-add-channel-btn')?.addEventListener('click', () => startCreate());
    return;
  }

  list.innerHTML = channels.map(renderChannelCard).join('');
  bindChannelCardEvents(list);
}

async function loadChannels(options = {}) {
  const { refreshBtn } = options;
  channelsLoading = true;
  setChannelError('');

  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.querySelector('i')?.classList.add('icon-btn--spin');
  }

  if (channels.length === 0) renderChannelList();

  try {
    channels = await fetchChannels();
    updateChannelCounts();
    renderChannelList();
  } catch (err) {
    if (err.status === 401) {
      redirectToLogin('/channels');
      return;
    }
    setChannelError(err.message || '通知渠道加载失败');
    const list = document.getElementById('channels-list');
    if (list && channels.length === 0) {
      list.innerHTML = '';
    }
  } finally {
    channelsLoading = false;
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.querySelector('i')?.classList.remove('icon-btn--spin');
    }
  }
}

function bindChannelCardEvents(list) {
  list.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleAction(btn);
    });
  });

  list.querySelectorAll('.channel-card__clickable').forEach((el) => {
    const card = el.closest('.channel-card');
    const openEdit = () => {
      const id = card?.getAttribute('data-id');
      const channel = channels.find((c) => c.id === id);
      if (channel) editChannel(channel);
    };

    el.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      openEdit();
    });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openEdit();
      }
    });
  });
}

function renderAlertTestResults(container, resultChannels) {
  if (!container) return;
  if (!resultChannels?.length) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  container.classList.remove('hidden');
  container.innerHTML = resultChannels.map((ch) => {
    const info = getTypeInfo(ch.channelType);
    const statusClass = ch.ok ? 'alert-test-result--ok' : 'alert-test-result--fail';
    const statusLabel = ch.ok ? '成功' : '失败';
    const errorLine = ch.error ? true : false;
    return `
      <div class="alert-test-result ${statusClass}">
        <span><strong>${escapeHtml(ch.channelName)}</strong> · ${escapeHtml(info.label)}</span>
        <span class="chip ${ch.ok ? 'chip--success' : 'chip--danger'}">${statusLabel}</span>
        ${errorLine ? `<span class="alert-test-result__error">${escapeHtml(ch.error)}</span>` : ''}
      </div>
    `;
  }).join('');
}

async function sendTestAlert(options = {}) {
  const { messageEl, resultsEl, buttonEl } = options;
  if (messageEl) {
    messageEl.textContent = '';
    messageEl.className = 'form-message channels-test-message hidden';
  }
  if (resultsEl) {
    resultsEl.classList.add('hidden');
    resultsEl.innerHTML = '';
  }

  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> 发送中…';
  }

  let rateLimited = false;
  try {
    const resp = await authFetch(`${API_BASE}/api/alerts/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await parseJsonResponse(resp);

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
      messageEl.className = `form-message channels-test-message ${data.ok ? 'form-message--success' : 'form-message--error'}`;
    }
    renderAlertTestResults(resultsEl, data.channels);
  } catch (err) {
    if (messageEl) {
      messageEl.textContent = err.message || '发送失败';
      messageEl.className = 'form-message channels-test-message form-message--error';
    }
  } finally {
    if (buttonEl && !rateLimited) {
      buttonEl.disabled = false;
      buttonEl.innerHTML = '<i class="fas fa-paper-plane" aria-hidden="true"></i> 发送测试告警';
    }
  }
}

async function handleAction(btn) {
  const action = btn.getAttribute('data-action');
  const id = btn.getAttribute('data-id');
  const channel = channels.find((c) => c.id === id);
  if (!channel) return;

  if (action === 'edit') {
    editChannel(channel);
    return;
  }

  if (action === 'delete') {
    if (!confirm(`确定删除通知渠道「${channel.name}」？`)) return;
    deletingId = id;
    renderChannelList();
    try {
      await authFetch(`${API_BASE}/api/channels/${id}`, { method: 'DELETE' });
      if (editingId === id) hideForm();
      await loadChannels();
    } finally {
      deletingId = null;
      renderChannelList();
    }
    return;
  }

  if (action === 'toggle') {
    togglingId = id;
    renderChannelList();
    try {
      await authFetch(`${API_BASE}/api/channels/${id}/toggle`, { method: 'PATCH' });
      await loadChannels();
    } finally {
      togglingId = null;
    }
    return;
  }

  if (action === 'test') {
    testingId = id;
    renderChannelList();
    let rateLimited = false;
    try {
      const resp = await authFetch(`${API_BASE}/api/channels/${id}/test`, { method: 'POST' });
      const data = await parseJsonResponse(resp);
      if (resp.status === 429) {
        rateLimited = true;
        await startRateLimitCountdown({
          buttonEl: btn,
          retryAfterSeconds: data.retryAfterSeconds,
          buttonLabel: '测试',
        });
        return;
      }
      if (!resp.ok) throw new Error(data.error || '测试失败');
      alert(data.message || '测试消息已发送');
    } catch (err) {
      alert(`测试失败: ${err.message}`);
    } finally {
      testingId = null;
      if (!rateLimited) renderChannelList();
    }
  }
}

function collectConfig(type, form) {
  const config = {};
  for (const field of CONFIG_FIELDS[type] || []) {
    const value = form[`config_${field.key}`]?.value?.trim();
    if (value) config[field.key] = value;
  }
  return config;
}

async function submitChannelForm(e) {
  e.preventDefault();
  if (saving) return;

  const form = e.target;
  const msg = document.getElementById('form-message');
  const saveBtn = document.getElementById('save-channel-btn');
  const id = form.id.value;
  const type = form.type.value;
  const isEdit = Boolean(id);

  const payload = {
    type,
    name: form.name.value.trim(),
    enabled: form.enabled.checked,
    config: collectConfig(type, form),
  };

  if (!payload.name) {
    if (msg) {
      msg.textContent = '请填写渠道名称';
      msg.className = 'form-message form-message--error';
    }
    return;
  }

  saving = true;
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i><span>保存中…</span>';
  }

  try {
    const url = isEdit ? `${API_BASE}/api/channels/${id}` : `${API_BASE}/api/channels`;
    const method = isEdit ? 'PUT' : 'POST';
    const resp = await authFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '保存失败');

    if (msg) {
      msg.textContent = isEdit ? '渠道已更新' : '渠道已添加';
      msg.className = 'form-message form-message--success';
    }
    hideForm();
    await loadChannels();
  } catch (err) {
    if (msg) {
      msg.textContent = err.message;
      msg.className = 'form-message form-message--error';
    }
  } finally {
    saving = false;
    if (saveBtn) {
      saveBtn.disabled = false;
      const label = isEdit ? '保存修改' : '添加渠道';
      saveBtn.innerHTML = `<i class="fas fa-save" aria-hidden="true"></i><span id="save-channel-label">${label}</span>`;
    }
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const nav = document.getElementById('nav-auth');
  if (nav) setupNavAuth(nav);
  await requirePageAuth();

  renderTypeButtons('type-buttons');

  document.getElementById('cancel-form')?.addEventListener('click', hideForm);
  document.getElementById('close-form-btn')?.addEventListener('click', hideForm);
  document.getElementById('channel-form')?.addEventListener('submit', submitChannelForm);
  document.getElementById('add-channel-btn')?.addEventListener('click', () => startCreate());

  document.getElementById('refresh-channels-btn')?.addEventListener('click', () => {
    loadChannels({ refreshBtn: document.getElementById('refresh-channels-btn') });
  });

  document.getElementById('retry-channels-btn')?.addEventListener('click', () => {
    loadChannels({ refreshBtn: document.getElementById('refresh-channels-btn') });
  });

  document.getElementById('test-all-alerts-btn')?.addEventListener('click', () => {
    sendTestAlert({
      messageEl: document.getElementById('test-all-message'),
      resultsEl: document.getElementById('test-all-results'),
      buttonEl: document.getElementById('test-all-alerts-btn'),
    });
  });

  await loadChannels();
});
