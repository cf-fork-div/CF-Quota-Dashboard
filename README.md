# ☁️ CF-Quota-Dashboard

<div align="center">

**基于 Cloudflare Workers + KV + Hono 的多账号免费额度监控面板**

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange.svg)](https://workers.cloudflare.com/)
[![Hono](https://img.shields.io/badge/Hono-Framework-e36002.svg)](https://hono.dev/)
[![GitHub stars](https://img.shields.io/github/stars/jia0327/CF-Quota-Dashboard?style=flat&logo=github)](https://github.com/jia0327/CF-Quota-Dashboard)

</div>

---

## 💡 核心理念

**只部署一次 Worker，监控任意多个 Cloudflare 账号。**

被监控账号的 API Token 与 Account ID 存入 KV，无需为每个账号单独维护 `wrangler.toml`。打开仪表盘或调用 API 时自动拉取最新配额，6 小时 Cron 兜底无人访问时的更新。

---

## 🚀 在线 Demo

👉 **[https://cf-quota-dashboard.itellme.workers.dev](https://cf-quota-dashboard.itellme.workers.dev/)**

| 路径 | 说明 |
|------|------|
| [`/`](https://cf-quota-dashboard.itellme.workers.dev/) | 公开仪表盘 — 跨账号汇总配额 |
| [`/admin`](https://cf-quota-dashboard.itellme.workers.dev/admin) | 账号管理 — 登录码 **`admin`** |
| [`/channels`](https://cf-quota-dashboard.itellme.workers.dev/channels) | 通知渠道 — 需登录后配置 |

> Demo 仅供体验。部署自己的实例见下方 [部署](#-部署) 与 [docs/DEPLOY.md](docs/DEPLOY.md)。

---

## ✨ 功能特性

### 35 项免费额度指标

| 分类 | 指标 | 重置周期 |
|------|------|----------|
| **Workers** | Requests、Builds、Build Slots、CPU/req、Logs Events、Logs Ingestion | 日 / 月 / 总计 |
| **Pages** | Functions Requests、Builds | 日 / 月 |
| **D1** | Rows Read/Written、Storage、Total Databases | 日 / 总计 |
| **KV** | Reads/Writes/Deletes/Lists、Storage、Namespaces | 日 / 总计 |
| **R2** | Storage、Class A/B Ops、Buckets | 月 / 总计 |
| **Workers AI** | Neurons | 日 |
| **Queues** | Operations | 日 |
| **Vectorize** | Queried Dims、Stored Dims | 月 / 总计 |
| **Hyperdrive** | Queries | 日 |
| **Workflows** | Invocations | 日 |
| **Durable Objects** | Requests、Duration、Rows Read/Written、SQL Storage | 日 / 总计 |
| **Browser Run** | Minutes | 日 |
| **Analytics Engine** | Writes | 日 |

- 可视化进度条与跨账号汇总；部分指标在账号未开通对应产品时 `available: false`
- 限额定义见 `worker/src/free-tier-limits.ts`，可通过 `FREE_TIER_LIMITS` 环境变量覆盖

### 其他能力

| 能力 | 说明 |
|------|------|
| **多账号 KV 管理** | 添加 / 编辑 / 删除 / 启停；保存前 Verify Credentials |
| **访问触发刷新** | 快照过期时 `GET /api/snapshot` 自动拉取；Cron `0 */6 * * *` 兜底 |
| **刷新预算** | 每账号约 10 次 subrequest，单次最多 50（约 5 个账号） |
| **按账号告警** | 按服务勾选阈值；默认不启用，需手动配置 |
| **多通道通知** | 企业微信、飞书、钉钉、Webhook、Telegram、Email |
| **公开 API** | `GET /api/public/snapshot?token=` 供外部集成 |
| **GitHub Actions** | 推送 `master` 自动部署，效果与一键部署相同 |

---

## 🔐 多账号管理

- 在 `/admin` 动态增删被监控账号，无需重新部署 Worker
- 保存前 **Verify Credentials** 校验 Account ID 与 API Token
- 账号变更后立即触发配额刷新
- API 响应中 Token 仅返回掩码（`abcd...wxyz`）
- **静态加密**：`apiToken` 与渠道敏感字段写入 KV 前 AES-GCM 加密
  - 推荐设置 `ENCRYPTION_KEY`（64 位 hex）或依赖 `PASSWORD` 派生密钥
  - 未配置密钥时明文存储（不推荐生产环境）

---

## 🔔 智能告警

- 在 `/admin` 编辑账号时，按服务（Workers、D1、KV、R2 等）勾选指标与阈值百分比
- 每个账号可绑定独立通知渠道
- **推送去重**：同一 UTC 日/月内同一指标最多推送一次；用量超过上次告警值时仍会再次推送
- 支持渠道测试与 `/channels` 批量测试告警

| 渠道 | 类型标识 |
|------|----------|
| 企业微信 | `wecom` |
| 飞书 | `feishu` |
| 钉钉 | `dingtalk` |
| 通用 Webhook | `webhook` |
| Telegram | `telegram` |
| Email（HTTP 中继） | `email` |

---

## 🖥️ 仪表盘

- **Glassmorphism** 毛玻璃风格，亮色 / 暗色主题（右下角 🌙/☀️ 切换）
- 跨账号汇总卡片 + 各账号明细进度条
- 响应式布局，适配桌面与移动端
- 手动刷新按钮（↻）与刷新间隔配置（15 / 20 / 30 / 60 / 120 / 360 分钟）

---

## 🛠️ 部署

支持 **一键部署**（本地 `npm run quick-deploy`）与 **GitHub Actions**（推送 `master` 自动更新），流程与效果相同。

👉 **完整步骤见 [docs/DEPLOY.md](docs/DEPLOY.md)** — 含前置条件（API Token）、一键部署命令、GitHub Secrets 配置与部署后验证。

| 方式 | 文档 |
|------|------|
| 一键部署 | [§1 运行一键部署](docs/DEPLOY.md#1-一键部署) |
| GitHub Actions | [§2 GitHub Actions 部署](docs/DEPLOY.md#2-github-actions-部署) |

---

## ⚙️ 配置被监控账号

1. 设置 `PASSWORD` 后访问 `/admin` 并登录（登录页仅一个字段，无需用户名）
2. 点击 **添加账号**，填写账号名称、Account ID、只读 API Token
3. **Verify Credentials** 验证通过后，按需配置告警规则
4. 在 `/channels` 添加并启用通知渠道

**最低 Token 权限**（缺一不可）：

| 权限 | 用途 |
|------|------|
| Account → Account Analytics → Read | GraphQL 用量（Workers、D1、KV、R2 等） |
| Account → D1 → Read | REST 查询 D1 数据库个数 |

**建议一并勾选**：Pages、Workers Scripts、KV/R2 Storage、Queues、Hyperdrive、Vectorize、Account Settings 的 Read 权限。

> 未设置 `PASSWORD` 时写操作与管理读 API 返回 **503**；`GET /api/snapshot` 仍可公开读取。

---

## 🏗️ 技术架构

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  Frontend   │────▶│  Hono Worker     │────▶│  Cloudflare APIs    │
│  (Assets)   │     │  + KV Store      │     │  GraphQL + REST     │
└─────────────┘     └──────────────────┘     └─────────────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  Cron 6h     │
                    │  Notifier    │
                    └──────────────┘
```

| 层级 | 技术 |
|------|------|
| 运行时 | Cloudflare Workers（Hono） |
| 存储 | Cloudflare KV（AES-GCM 字段加密） |
| 前端 | 原生 HTML + CSS + JS（Workers Assets） |
| 数据采集 | Cloudflare GraphQL Analytics + REST API |
| CI/CD | Wrangler + GitHub Actions |

---

## 📄 License

本项目基于 [MIT License](LICENSE) 开源。

---

## 🙏 致谢

- [Cloudflare](https://www.cloudflare.com/) 平台
- 设计灵感：[CF-Workers-UsagePanel](https://github.com/cmliu/CF-Workers-UsagePanel)
- 渠道管理 UI 参考：[Uptime-Monitor](https://github.com/cmliu/Uptime-Monitor)

---

<div align="center">

**[⬆ 回到顶部](#-cf-quota-dashboard)** · **[📦 部署文档](docs/DEPLOY.md)**

Made with ❤️ by [jia0327](https://github.com/jia0327)

</div>
