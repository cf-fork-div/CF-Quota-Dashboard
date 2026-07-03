# CF Quota Dashboard

Cloudflare **Workers 免费套餐**多账号额度监控面板。只需在**一个** Cloudflare 账号上部署 Worker；被监控的账号通过 KV 动态添加，无需在 `wrangler.toml` 中为每个账号配置 `[env]`。

> 灵感参考：[UsagePanel](https://github.com/Cloudflare-MrWang/UsagePanel) 等社区额度监控方案。本项目采用单 Worker + KV 多账号架构，并扩展了通知渠道、管理认证与刷新预算控制。

## 功能特性

- **多账号 KV 管理**：添加 / 编辑 / 删除 / 启用 / 禁用；保存前 **Verify Credentials** 验证 Token
- **28 项免费额度指标**（27 项可 API 采集），含 `pages_requests`（Pages Functions 日请求）
- **跨账号汇总**：仪表盘顶部聚合 Workers、Pages、D1、KV、R2、AI 等用量及 ≥ 阈值告警列表
- **多通道告警**（`/channels`）：企业微信、飞书、钉钉、Webhook、Telegram、Email
- **Cron 定时刷新**：`0 */6 * * *`（每 6 小时）+ 仪表盘手动刷新
- **刷新预算**：`ACCOUNT_CHECK_INTERVAL_MINUTES`、`MAX_EXTERNAL_SUBREQUESTS_PER_RUN`，响应含 `refreshStats`
- **管理认证**：`PASSWORD` / `USERNAME`，`/login` 登录；未设置 `PASSWORD` 时为 **Dev 模式**
- **公开 API**：`GET /api/public/snapshot?token=` 供外部集成
- **UI**：Glassmorphism 毛玻璃风格，右下角 **明/暗主题切换**（`localStorage` 持久化，首次访问跟随系统偏好）
- **GitHub Actions**：推送到 `main` 自动部署

## 架构

```mermaid
flowchart TB
  subgraph Client["浏览器 / 外部集成"]
    UI["仪表盘 / 管理页 / 通知渠道"]
    PubAPI["GET /api/public/snapshot?token="]
  end

  subgraph Worker["CF Quota Dashboard Worker (Hono)"]
    API["REST API + 静态资源 (Assets)"]
    Cron["Cron 0 */6 * * *"]
    Fetch["fetcher.ts — GraphQL + REST"]
    Notify["notifier.ts — 多通道告警"]
  end

  subgraph KV["KV Namespace"]
    ACC["ACCOUNTS"]
    SNAP["QUOTA_SNAPSHOT"]
    CH["NOTIFICATION_CHANNELS"]
    SESS["session:*"]
  end

  subgraph CF["被监控账号 Cloudflare API"]
    GQL["GraphQL Analytics"]
    REST["REST (Pages 等)"]
  end

  UI --> API
  PubAPI --> API
  Cron --> Fetch
  API --> Fetch
  Fetch --> GQL
  Fetch --> REST
  API --> KV
  Fetch --> Notify
  Notify --> CH
```

```
┌──────────────┐   Cron 0 */6 * * *    ┌─────────────────────┐
│ Hono Worker  │ ────────────────────► │ 各账号 CF GraphQL   │
│ (单次部署)    │   + 手动 POST /cron   │ + REST API          │
└──────┬───────┘                       └─────────────────────┘
       │
       ▼
  KV: ACCOUNTS · QUOTA_SNAPSHOT · NOTIFICATION_CHANNELS · session:*
       │
       ▼
  frontend/ (Assets) — index · admin · channels · login
```

## 本地预览

### 前置条件

- [Node.js](https://nodejs.org/) 18+
- Cloudflare 账号（本地 dev 也需要 KV binding，wrangler 会使用远程 KV 或本地模拟）

### 步骤

```powershell
cd e:\code\CF-Quota-Dashboard\worker
npm install
```

在 `worker/` 目录创建 `.dev.vars`（已被 `.gitignore` 忽略，**勿提交**）：

```env
PASSWORD=your-local-dev-password
# 可选
# USERNAME=admin
# WEBHOOK_URL=https://...
```

```powershell
npm run dev
```

浏览器访问 **http://localhost:8787**。

| 场景 | 行为 |
|------|------|
| **未设置 `PASSWORD`** | Dev 模式：写操作（增删账号、渠道、手动刷新）无需登录；导航栏显示 `Dev mode` |
| **设置了 `PASSWORD`** | 访问 `/admin`、`/channels` 及写 API 需先登录 `/login` |
| **主题** | 右下角太阳/月亮按钮切换明/暗色，偏好保存在浏览器 |

> 本地开发前请先在 `wrangler.toml` 中填入有效的 KV namespace `id`（见下方生产部署步骤 1）。

## 生产部署

### 1. 前置条件

- Cloudflare 账号（**托管 Worker 的账号**，与被监控账号可以不同）
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)（项目已包含在 `worker` 依赖中）
- 为每个被监控账号准备 **只读 API Token**（见 [API Token 权限](#api-token-权限)）

### 2. 创建 KV 命名空间

```powershell
cd e:\code\CF-Quota-Dashboard\worker
npx wrangler kv namespace create KV
```

将输出中的 `id` 写入 `worker/wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "KV"
id = "<your-kv-namespace-id>"
```

### 3. 设置 Secret

**必须**（生产环境）：

```powershell
npx wrangler secret put PASSWORD
# 按提示输入管理员密码
```

**可选**：

```powershell
npx wrangler secret put PUBLIC_API_TOKEN
# 自定义公开 API token；不设置则从 PASSWORD+USERNAME 派生 HMAC
```

> Secret 无法写在 `wrangler.toml` 的 `[vars]` 中，必须通过 `wrangler secret put` 或 Cloudflare Dashboard 配置。

### 4. 配置环境变量

编辑 `worker/wrangler.toml` 的 `[vars]` 段：

```toml
[vars]
WEBHOOK_URL = ""                    # 可选：无 KV 渠道时的旧版企微 webhook 回退
ALERT_THRESHOLD = "70"              # 告警阈值（百分比）
USERNAME = "admin"                  # 登录用户名
ACCOUNT_CHECK_INTERVAL_MINUTES = "20"
MAX_EXTERNAL_SUBREQUESTS_PER_RUN = "50"
# FREE_TIER_LIMITS = '{"workers_requests":{"limit":100000}}'  # 可选 JSON 覆盖
# PUBLIC_API_TOKEN = ""             # 也可用 secret 设置
```

### 5. 部署

```powershell
cd e:\code\CF-Quota-Dashboard\worker
npm install
npm run typecheck
npx wrangler deploy
```

部署成功后终端会输出 Worker URL，例如 `https://cf-quota-dashboard.<subdomain>.workers.dev`。

### 6. 首次使用

1. 打开 Worker URL → 仪表盘（`/`）
2. 若已设置 `PASSWORD` → 访问 **账号管理**（`/admin`）会跳转 `/login` 登录
3. **添加被监控账号**：Account Name、Account ID、只读 API Token → **Verify Credentials** → **Save**
4. **配置通知渠道**（`/channels`）：添加渠道 → **测试** → 启用
5. 等待 Cron（每 6 小时）或点击 **Refresh Now** 手动拉取数据

### 7. 可选：KV 预置测试账号

```powershell
npx wrangler kv key put --binding=KV ACCOUNTS "[{\"id\":\"test-1\",\"name\":\"Test\",\"accountId\":\"YOUR_ACCOUNT_ID\",\"apiToken\":\"YOUR_TOKEN\",\"enabled\":true}]"
```

手动触发抓取（已配置 `PASSWORD` 时需先登录并带 Cookie，或使用 Dev 模式）：

```powershell
curl.exe -X POST "https://your-worker.workers.dev/cron/fetch" -H "Cookie: cfqd_session=..."
```

## 环境变量

| 变量 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `PASSWORD` | Secret | *(空)* | 管理员密码。**未设置 = Dev 模式**，写 API 无需认证 |
| `USERNAME` | Var | `admin` | 登录用户名 |
| `ALERT_THRESHOLD` | Var | `70` | 任一 **available** 指标 `pct ≥ 阈值` 时触发告警 |
| `FREE_TIER_LIMITS` | Var | 内置默认 | JSON 覆盖 `worker/src/free-tier-limits.ts` 中的限额 |
| `WEBHOOK_URL` | Var | *(空)* | 旧版单 webhook；**仅当 KV 无 `NOTIFICATION_CHANNELS` 时**作为隐式企微渠道 |
| `ACCOUNT_CHECK_INTERVAL_MINUTES` | Var | `20` | 距上次检查不足此分钟数的账号使用缓存，不发起 API 请求 |
| `MAX_EXTERNAL_SUBREQUESTS_PER_RUN` | Var | `50`（上限 50） | 单次 cron/手动刷新最多对外 subrequest 数（Workers 单次调用上限 50） |
| `PUBLIC_API_TOKEN` | Secret/Var | HMAC 派生 | `GET /api/public/snapshot?token=` 的鉴权 token |

## API 路由

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/` | — | 仪表盘 |
| GET | `/admin` | 页面需登录* | 账号管理 |
| GET | `/channels` | 页面需登录* | 通知渠道管理 |
| GET | `/login` | — | 登录页 |
| GET | `/api/me` | — | 会话状态；Dev 模式返回 `devMode: true` |
| POST | `/api/login` | — | 登录，设置 `cfqd_session` Cookie（24h，KV） |
| POST | `/api/logout` | — | 登出 |
| GET | `/api/snapshot` | — | 最新配额快照 |
| GET | `/api/public/snapshot?token=` | Token | 公开快照（外部集成） |
| GET | `/api/public/token` | 需登录 | 查看/派生公开 API token |
| GET | `/api/accounts` | — | 账号列表（Token 掩码） |
| POST | `/api/accounts` | 需登录† | 添加账号 |
| POST | `/api/accounts/verify` | 需登录† | 验证 Account ID + Token |
| PUT | `/api/accounts/:id` | 需登录† | 更新名称 / Token / 启用状态 |
| DELETE | `/api/accounts/:id` | 需登录† | 删除账号 |
| GET | `/api/channels` | — | 渠道列表（敏感字段掩码） |
| POST | `/api/channels` | 需登录† | 添加渠道 |
| PUT | `/api/channels/:id` | 需登录† | 更新渠道 |
| DELETE | `/api/channels/:id` | 需登录† | 删除渠道 |
| PATCH | `/api/channels/:id/toggle` | 需登录† | 启用/禁用切换 |
| POST | `/api/channels/:id/test` | 需登录† | 发送测试消息 |
| POST | `/cron/fetch` | 需登录† | 手动刷新；响应含 `refreshStats` |

\* 页面级：`authEnabled && !authenticated` 时前端重定向 `/login`。  
† API 级：未配置 `PASSWORD` 时 `requireAuth` 直接放行（Dev 模式）。

### 刷新预算响应示例

```json
{
  "lastUpdated": "2026-07-03T12:00:00.000Z",
  "accounts": [ "..." ],
  "refreshStats": {
    "refreshed": 2,
    "failed": 0,
    "cached": 1,
    "skippedByLimit": 0,
    "subrequestsUsed": 10
  },
  "alerted": false
}
```

每个账号约消耗 **5** 次 subrequest（`SUBREQUESTS_PER_ACCOUNT = 5`）。

## 通知渠道配置

在 **`/channels`**（通知渠道管理）添加。KV key：`NOTIFICATION_CHANNELS`。  
当 KV 中存在渠道时，**优先于** `WEBHOOK_URL`；KV 为空且设置了 `WEBHOOK_URL` 时，告警仍走隐式企微渠道（不在 UI 显示）。

| 类型 | 配置字段 | 说明 |
|------|----------|------|
| **wecom** 企业微信 | `webhookUrl` | 群机器人 Webhook，Markdown 消息 |
| **feishu** 飞书 | `webhookUrl` | 群机器人 Webhook，纯文本 |
| **dingtalk** 钉钉 | `webhookUrl` | 自定义机器人 Webhook，Markdown |
| **webhook** | `webhookUrl`，可选 `customHeaders`（JSON） | 通用 JSON：`title`、`content`、`markdown`、`alerts[]` |
| **telegram** | `botToken`，`chatId` | Telegram Bot API `sendMessage` |
| **email** | `to`，`webhookUrl` | HTTP 邮件中继（Resend、Mailgun、自建 API）；Workers **不支持 SMTP** |

各渠道支持：**测试发送**、**启用/禁用**、API 返回敏感字段掩码（`first4...last4`）。

### Webhook  payload 示例

```json
{
  "title": "CF Quota Alert (≥70%)",
  "content": "...",
  "markdown": "...",
  "threshold": 70,
  "alerts": [
    { "account": "主账号", "label": "Workers Requests", "used": 80000, "limit": 100000, "pct": 80, "unit": "requests", "period": "daily" }
  ]
}
```

## GitHub Actions CI/CD

工作流：`.github/workflows/deploy.yml`  
触发：`push` 到 `main`，或手动 `workflow_dispatch`。

### 所需 Repository Secrets

| Secret | 说明 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | 托管账号的 API Token，需 **Workers 部署** 权限 |
| `CLOUDFLARE_ACCOUNT_ID` | 托管 Worker 的 Account ID |

### 流程

1. `npm ci`（在 `worker/`）
2. `npm run typecheck`
3. `npx wrangler deploy`

> **注意**：GitHub Actions **不会**自动设置 `PASSWORD` 等 Worker Secret。首次 CI 部署后，仍需在本地或 Dashboard 执行 `wrangler secret put PASSWORD`。KV namespace `id` 需已写入仓库中的 `wrangler.toml`。

## 免费额度默认值

定义于 `worker/src/free-tier-limits.ts`，可通过 `FREE_TIER_LIMITS` 环境变量（JSON）覆盖。

| 指标 | 免费上限 | 周期 |
|------|----------|------|
| Workers 请求 | 100,000 | 日 (UTC) |
| Pages 构建 | 500 | 月 |
| Pages Functions 请求 | 100,000 | 日 |
| D1 读/写行 | 5,000,000 / 100,000 | 日 |
| D1 存储 | 5 GB | 总量 |
| KV 读/写/删/列 | 100,000 / 1,000 ×3 | 日 |
| KV 存储 | 1 GB | 总量 |
| R2 存储 | 10 GB | 月 |
| R2 Class A / B | 1,000,000 / 10,000,000 | 月 |
| Workers AI neurons | 10,000 | 日 |
| Queues 操作 | 10,000 | 日 |
| Vectorize 查询/存储维度 | 30M / 5M | 月 / 总量 |
| Hyperdrive 查询 | 100,000 | 日 |
| Workflows 调用 | 100,000 | 日 |
| Durable Objects 请求/时长/读写/SQL | 100k / 13k GB-s / 5M·100k / 5 GB | 见代码 |
| Browser Rendering | 10 分钟 | 日 |
| Analytics Engine 写入 | 100,000 points | 日 |

参考：[Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)、[D1](https://developers.cloudflare.com/d1/platform/pricing/)、[R2](https://developers.cloudflare.com/r2/pricing/)、[Pages 限制](https://developers.cloudflare.com/pages/platform/limits/)。

## 指标 API 覆盖

### 可采集（GraphQL / REST）

| 服务 | 指标 | API |
|------|------|-----|
| Workers | 请求数 | `workersInvocationsAdaptive` |
| D1 | 读/写行、存储 | `d1AnalyticsAdaptiveGroups`、`d1StorageAdaptiveGroups` |
| KV | 读/写/删/列、存储 | `kvOperationsAdaptiveGroups`、`kvStorageAdaptiveGroups` |
| R2 | 存储、Class A/B | `r2StorageAdaptiveGroups`、`r2OperationsAdaptiveGroups` |
| Pages | 月构建、Functions 日请求 | REST `/pages/projects` + `/deployments`；GraphQL `pagesFunctionsInvocationsAdaptiveGroups` |
| Workers AI | Neurons | `aiInferenceAdaptiveGroups` |
| Queues | 计费操作 | `queueMessageOperationsAdaptiveGroups` |
| Vectorize | 查询/存储维度 | `vectorizeQueriesAdaptiveGroups`、`vectorizeStorageAdaptiveGroups` |
| Hyperdrive | 查询 | `hyperdriveQueriesAdaptiveGroups` |
| Workflows | 调用 | `workflowsAdaptiveGroups` |
| Durable Objects | 请求、时长、读写、SQL 存储 | `durableObjects*Groups` |
| Browser Rendering | 会话分钟 | `browserRenderingBrowserTimeUsageAdaptiveGroups` |
| Analytics Engine | 写入点数 | `workersAnalyticsEngineAdaptiveGroups` |

### 部分可用 / 不可用

| 服务 | 状态 |
|------|------|
| Workers CPU 时间 (10 ms) | 仅单次分位数，无账户级日累计 |
| Workers Logs 事件数 (200k/天) | 仅采集 **bytes**（`logExplorerIngestionAdaptiveGroups`），`workers_logs_bytes` 标记 `available: false`，不参与告警 |
| Analytics Engine 读查询 (10k/天) | GraphQL 无读计数 |
| Email Routing / Email Sending | 免费套餐无用量 API，需手动关注 |
| Workers subrequests (50/次调用) | 无账户级日配额 API |

## API Token 权限

为**被监控账号**创建 **只读** Token，建议权限：

- Account Analytics: Read
- Cloudflare Pages: Read
- Workers Scripts: Read
- Workers KV Storage: Read
- Workers R2 Storage: Read
- D1: Read
- Queues: Read
- Hyperdrive: Read（若使用）
- Account Settings: Read（可选，用于 Verify 显示账号名）

## 安全说明

1. **生产环境必须设置 `PASSWORD`**。未设置时所有写 API 对公网开放（Dev 模式）。
2. 被监控账号的 API Token 存于 KV；API 响应仅返回掩码（`abcd...wxyz`）。
3. Session：`cfqd_session` HttpOnly + Secure + SameSite=Strict，24 小时 TTL，存 KV `session:*`。
4. 公开快照 API 需 `token` 参数；token 默认为 `PASSWORD`+`USERNAME` 的 HMAC，或通过 `PUBLIC_API_TOKEN` 显式指定。
5. 告警只针对 `available: true` 的指标；不可用指标不会误报。
6. **托管 Worker 的** `CLOUDFLARE_API_TOKEN`（CI 用）与被监控账号 Token 职责分离，勿混用。

## 项目结构

```
CF-Quota-Dashboard/
├── worker/
│   ├── src/
│   │   ├── index.ts           # Hono 路由 + Cron 入口
│   │   ├── auth.ts            # 登录 / Session / 公开 API token
│   │   ├── kv-store.ts        # ACCOUNTS / SNAPSHOT / CHANNELS
│   │   ├── fetcher.ts         # GraphQL + REST 抓取
│   │   ├── calculator.ts
│   │   ├── notifier.ts        # 告警聚合 + 多渠道发送
│   │   ├── channels/          # wecom · feishu · dingtalk · webhook · telegram · email
│   │   ├── free-tier-limits.ts
│   │   └── types.ts
│   ├── wrangler.toml
│   └── package.json
├── frontend/
│   ├── index.html             # 仪表盘 + 跨账号汇总
│   ├── admin.html             # 账号管理
│   ├── channels.html          # 通知渠道
│   ├── login.html
│   ├── styles.css             # Glassmorphism + 主题变量
│   ├── theme.js               # 明/暗切换
│   ├── app.js                 # 仪表盘 + admin 逻辑
│   ├── auth.js
│   └── channels.js
├── .github/workflows/deploy.yml
├── README.md
└── 1.md                       # 内部规格说明
```

## 故障排查 FAQ

### 仪表盘无数据 / 账号显示 Error

- 确认账号 **已启用**（Enabled）
- 在 `/admin` 使用 **Verify Credentials** 检查 Token 是否有效、权限是否足够
- 查看账号卡片上的 `error` 信息（Token 过期、Account ID 错误等）
- 手动 **Refresh Now** 或等待 Cron；检查响应中 `refreshStats.skippedByLimit` 是否因预算耗尽跳过

### 手动刷新后部分账号仍是旧数据

- `ACCOUNT_CHECK_INTERVAL_MINUTES`（默认 20）内会使用缓存，计入 `refreshStats.cached`
- 单次最多刷新约 `MAX_EXTERNAL_SUBREQUESTS_PER_RUN / 5` 个账号（默认约 10 个），其余 `skippedByLimit` 需下次 Cron/手动刷新

### 登录失败 / 写操作 401

- 确认已通过 `wrangler secret put PASSWORD` 设置密码（非 `[vars]`）
- 本地 dev 检查 `worker/.dev.vars` 是否包含 `PASSWORD`
- Cookie 需同源；勿跨域调用写 API

### `/login` 返回 503 "Auth not configured"

- 未设置 `PASSWORD` 时不应使用登录 API；此时为 Dev 模式，直接访问管理页即可

### 告警未收到

- 检查 `/channels` 渠道是否 **已启用**
- 确认指标 `pct` 已达 `ALERT_THRESHOLD` 且 `available: true`
- 使用渠道 **测试** 按钮排查 Webhook / Bot Token 配置
- 若仅配置了 `WEBHOOK_URL` 且无 KV 渠道，告警走隐式企微通道

### 公开 API 403 / 503

- 503：未设置 `PASSWORD` 且未设置 `PUBLIC_API_TOKEN`
- 403：`token` 不匹配；登录后访问 `GET /api/public/token` 获取正确 token

### `wrangler dev` 启动失败

- 确认 `wrangler.toml` 中 KV `id` 已替换 `YOUR_KV_NAMESPACE_ID`
- 在 `worker/` 目录运行，而非仓库根目录

### GitHub Actions 部署成功但线上无密码保护

- Actions 不会同步 Worker Secrets；部署后执行 `npx wrangler secret put PASSWORD`

## License

MIT
