import { requirePageAuth, setupNavAuth, authFetch } from './auth.js';

const API_BASE = window.location.origin;

const TYPE_LABELS = {
  wecom: '企业微信',
  feishu: '飞书',
  dingtalk: '钉钉',
  webhook: 'Webhook',
  telegram: 'Telegram',
  email: 'Email',
};

const TYPE_BADGE = {
  wecom: 'chip--wecom',
  feishu: 'chip--feishu',
  dingtalk: 'chip--dingtalk',
  webhook: 'chip--webhook',
  telegram: 'chip--telegram',
  email: 'chip--email',
};

const CONFIG_FIELDS = {
  wecom: [
    { key: 'webhookUrl', label: 'Webhook URL', type: 'password', required: true, placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...' },
  ],
  feishu: [
    { key: 'webhookUrl', label: 'Webhook URL', type: 'password', required: true, placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/...' },
  ],
  dingtalk: [
    { key: 'webhookUrl', label: 'Webhook URL', type: 'password', required: true, placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...' },
  ],
  webhook: [
    { key: 'webhookUrl', label: 'Webhook URL', type: 'password', required: true, placeholder: 'https://your-service.com/webhook' },
    { key: 'customHeaders', label: 'Custom Headers (JSON)', type: 'text', required: false, placeholder: '{"Authorization":"Bearer xxx"}' },
  ],
  telegram: [
    { key: 'botToken', label: 'Bot Token', type: 'password', required: true, placeholder: '123456:ABC-DEF...' },
    { key: 'chatId', label: 'Chat ID', type: 'text', required: true, placeholder: '-1001234567890' },
  ],
  email: [
    { key: 'to', label: '收件人邮箱', type: 'email', required: true, placeholder: 'alerts@example.com' },
    { key: 'webhookUrl', label: '邮件中继 Webhook URL', type: 'password', required: true, placeholder: 'https://api.resend.com/emails or custom relay' },
  ],
};

function renderConfigFields(type, values = {}) {
  const container = document.getElementById('config-fields');
  const fields = CONFIG_FIELDS[type] || [];
  container.innerHTML = fields.map((f) => `
    <div class="form-group">
      <label class="form-label form-label--sm">${f.label}</label>
      <input
        name="config_${f.key}"
        type="${f.type}"
        ${f.required ? 'required' : ''}
        class="glass-input glass-input--mono"
        placeholder="${f.placeholder || ''}"
        value="${values[f.key] || ''}"
      />
    </div>
  `).join('');
}

function showForm(type, channel = null) {
  const section = document.getElementById('channel-form-section');
  const form = document.getElementById('channel-form');
  const title = document.getElementById('form-title');

  section.classList.remove('hidden');
  form.reset();
  form.id.value = channel?.id || '';
  form.type.value = channel?.type || type;
  form.name.value = channel?.name || '';
  form.enabled.checked = channel ? channel.enabled : true;

  title.textContent = channel ? `编辑渠道 · ${TYPE_LABELS[channel.type]}` : `新建渠道 · ${TYPE_LABELS[type]}`;
  renderConfigFields(channel?.type || type, channel?.config || {});
}

function hideForm() {
  document.getElementById('channel-form-section').classList.add('hidden');
}

async function fetchChannels() {
  const resp = await fetch(`${API_BASE}/api/channels`);
  return resp.json();
}

function renderChannelCard(channel) {
  const badgeClass = TYPE_BADGE[channel.type] || 'chip--muted';
  const configSummary = Object.entries(channel.config)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');

  return `
    <div class="list-item">
      <div class="min-w-0 flex-1">
        <div class="list-item__header">
          <p class="list-item__title">${channel.name}</p>
          <span class="chip ${badgeClass}">${TYPE_LABELS[channel.type]}</span>
          <span class="chip ${channel.enabled ? 'chip--success' : 'chip--muted'}">
            ${channel.enabled ? '已启用' : '已禁用'}
          </span>
        </div>
        <p class="list-item__meta truncate">${configSummary}</p>
      </div>
      <div class="list-item__actions">
        <button data-action="toggle" data-id="${channel.id}" class="btn btn-ghost btn-sm">
          ${channel.enabled ? '禁用' : '启用'}
        </button>
        <button data-action="test" data-id="${channel.id}" class="btn btn-ghost btn-sm">测试</button>
        <button data-action="edit" data-id="${channel.id}" class="btn btn-ghost btn-sm">编辑</button>
        <button data-action="delete" data-id="${channel.id}" class="btn btn-danger btn-sm">删除</button>
      </div>
    </div>
  `;
}

async function loadChannels() {
  const list = document.getElementById('channels-list');
  const countEl = document.getElementById('enabled-count');
  const channels = await fetchChannels();

  if (countEl) {
    countEl.textContent = String(channels.filter((c) => c.enabled).length);
  }

  if (!channels.length) {
    list.innerHTML = `
      <div class="empty-state glass-card">
        <div class="empty-state__icon">🔔</div>
        <p>尚未配置通知渠道。</p>
        <p class="form-hint">从左侧选择渠道类型开始添加。</p>
      </div>`;
    return;
  }

  list.innerHTML = channels.map(renderChannelCard).join('');

  list.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => handleAction(btn));
  });
}

async function handleAction(btn) {
  const action = btn.getAttribute('data-action');
  const id = btn.getAttribute('data-id');
  const channels = await fetchChannels();
  const channel = channels.find((c) => c.id === id);
  if (!channel) return;

  if (action === 'edit') {
    showForm(channel.type, channel);
    return;
  }

  if (action === 'delete') {
    if (!confirm(`删除渠道「${channel.name}」？`)) return;
    await authFetch(`${API_BASE}/api/channels/${id}`, { method: 'DELETE' });
    loadChannels();
    return;
  }

  if (action === 'toggle') {
    await authFetch(`${API_BASE}/api/channels/${id}/toggle`, { method: 'PATCH' });
    loadChannels();
    return;
  }

  if (action === 'test') {
    btn.disabled = true;
    btn.textContent = '发送中…';
    try {
      const resp = await authFetch(`${API_BASE}/api/channels/${id}/test`, { method: 'POST' });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Test failed');
      alert('测试消息已发送');
    } catch (err) {
      alert(`测试失败: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '测试';
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
  const form = e.target;
  const msg = document.getElementById('form-message');
  const id = form.id.value;
  const type = form.type.value;
  const payload = {
    type,
    name: form.name.value.trim(),
    enabled: form.enabled.checked,
    config: collectConfig(type, form),
  };

  try {
    const url = id ? `${API_BASE}/api/channels/${id}` : `${API_BASE}/api/channels`;
    const method = id ? 'PUT' : 'POST';
    const resp = await authFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Save failed');

    if (msg) {
      msg.textContent = '保存成功';
      msg.className = 'form-message form-message--success';
    }
    hideForm();
    loadChannels();
  } catch (err) {
    if (msg) {
      msg.textContent = err.message;
      msg.className = 'form-message form-message--error';
    }
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const nav = document.getElementById('nav-auth');
  if (nav) setupNavAuth(nav);
  await requirePageAuth();

  document.querySelectorAll('.type-btn').forEach((btn) => {
    btn.addEventListener('click', () => showForm(btn.getAttribute('data-type')));
  });

  document.getElementById('cancel-form')?.addEventListener('click', hideForm);
  document.getElementById('channel-form')?.addEventListener('submit', submitChannelForm);

  loadChannels();
});
