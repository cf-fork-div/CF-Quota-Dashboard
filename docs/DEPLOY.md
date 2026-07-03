# 部署文档

> 用户向概览与使用说明见 [README.md](../README.md)

**生产站点示例：** https://cf-quota-dashboard.1732330472.workers.dev

---

## 首次部署检查清单

部署前请逐项确认（生产环境建议全部勾选）：

| # | 步骤 | 说明 |
|---|------|------|
| 1 | Wrangler 登录 | `npx wrangler login`（浏览器 OAuth）；本地 CLI 部署**必须**先登录 |
| 2 | 验证目标账号 | `npx wrangler whoami` 查看 Account ID 与邮箱；与 Dashboard 右侧栏 **Account ID** 比对，避免多账号误部署 |
| 3 | （可选）锁定账号 | 在 `wrangler.toml` 设置 `account_id`，或导出 `CLOUDFLARE_ACCOUNT_ID` 环境变量 |
| 4 | 创建 KV 命名空间 | 执行 `wrangler kv namespace create CF-Quota-Dashboard`，记下返回的 `id` |
| 5 | 绑定 KV 到 Worker | Dashboard 或 `wrangler.toml` 中 `binding = "KV"`，填入上述命名空间 `id` |
| 6 | 设置 `PASSWORD` Secret | `wrangler secret put PASSWORD` 或 Dashboard 加密变量；**未设置 = Dev 模式** |
| 7 | 配置 `[vars]`（可选） | `USERNAME`、`ALERT_THRESHOLD`、刷新间隔等已有默认值 |
| 8 | 确认 Cron 触发器 | `0 */6 * * *`（每 6 小时兜底刷新，已在 `wrangler.toml` 配置） |
| 9 | 部署 Worker | 仓库根目录 `npm run deploy`（或 `cd worker && npm run deploy`） |
| 10 | 访问并验证 | 打开 `/` 看仪表盘；设置密码后访问 `/admin` 登录 |
| 11 | 添加被监控账号 | `/admin` → Verify Credentials → Save |

---

## 方法一：通过 Wrangler CLI 部署（推荐）

### 1. 克隆仓库并安装依赖

```bash
git clone https://github.com/cf-fork-div/CF-Quota-Dashboard.git
cd CF-Quota-Dashboard
npm install
```

### 2. 登录 Wrangler 并验证账号（⚠️ 必须）

本地使用 `npx wrangler` 部署前**必须先登录**，并确认当前 CLI 会话指向目标 Cloudflare 账号（多账号用户尤其重要）。

**登录（浏览器 OAuth）：**

```bash
npx wrangler login
```

命令会打开浏览器完成 Cloudflare 授权；授权成功后终端显示已登录。

**验证当前账号：**

```bash
npx wrangler whoami
```

输出示例：

```
Getting User settings...
👋 You are logged in with an OAuth Token, associated with the email 'you@example.com'!
┌──────────────────────────────┬──────────────────────────────────┐
│ Account Name                 │ Account ID                       │
├──────────────────────────────┼──────────────────────────────────┤
│ My Account                   │ 6d7***************************90 │
└──────────────────────────────┴──────────────────────────────────┘
```

> **部署前核对：** 将 `whoami` 中的 **Account ID** 与 [Cloudflare Dashboard](https://dash.cloudflare.com/) 右侧栏显示的 **Account ID** 逐项比对；不一致则说明 CLI 登录了错误账号，需切换账号后重新 `wrangler login`。

**（可选）锁定目标账号，防止误部署：**

仓库模板 `wrangler.toml` **未**预设 `account_id`（便于 Fork 后填入自己的 ID）。若你管理多个 Cloudflare 账号，建议在本地部署配置中显式指定：

```toml
# wrangler.toml 或 wrangler.deploy.toml 顶部
account_id = "6d7***************************90"   # 替换为 whoami / Dashboard 中的 Account ID
```

或通过环境变量（Wrangler 同样识别）：

```bash
export CLOUDFLARE_ACCOUNT_ID="6d7***************************90"   # Linux / macOS
# PowerShell: $env:CLOUDFLARE_ACCOUNT_ID = "6d7***************************90"
```

设置后，Wrangler 会拒绝向其他账号部署，避免 KV / Worker 建错账号。

> **GitHub Actions：** CI 不使用 `wrangler login`，而是通过 Repository Secret **`CLOUDFLARE_ACCOUNT_ID`** 指定目标账号（见 [方法三](#方法三github-actions-自动部署)）。本地与 CI 应使用**同一 Account ID**。

### 3. 创建 KV 命名空间（⚠️ 必须）

KV 命名空间**默认不存在**，部署前需手动创建：

```bash
npx wrangler kv namespace create CF-Quota-Dashboard
```

命令输出中的 `id` 即为命名空间 UUID（例如 `cf1d02c604e0491f8b99c1fca40c5a7b`），下一步写入 `wrangler.toml`。

> **绑定名 vs 显示名**
>
> - **`binding = "KV"`**（`wrangler.toml` / Worker 变量）：代码中访问 KV 的变量名，**必须大写 `KV`**，不可修改。
> - **命名空间显示名**（Dashboard / `wrangler kv namespace list` 的 `title`）：可为 **`CF-Quota-Dashboard`**，与 Worker 名称一致即可；二者不是同一个概念。

若已创建过同名命名空间，可列出已有 ID：

```bash
npx wrangler kv namespace list
# 在输出中找到 title 为 CF-Quota-Dashboard 对应的 id
```

### 4. 写入 KV 命名空间 ID

仓库根目录 `wrangler.toml` 使用占位符，本地部署前需替换为上一节查到的 `id`（例如 `cf1d02c604e0491f8b99c1fca40c5a7b`）：

```toml
[[kv_namespaces]]
binding = "KV"          # ⚠️ Worker 绑定变量名必须是大写 KV，不可修改
id = "YOUR_KV_NAMESPACE_ID"   # 替换为 CF-Quota-Dashboard（或所选命名空间）的 id
```

**推荐：使用本地配置文件（不修改仓库模板）**

```bash
cp wrangler.toml wrangler.deploy.toml
# 编辑 wrangler.deploy.toml，将 YOUR_KV_NAMESPACE_ID 改为真实 id
```

后续部署使用：

```bash
npm run typecheck
npx wrangler deploy --config wrangler.deploy.toml
# 或：npm run deploy -- --config wrangler.deploy.toml
```

> `wrangler.deploy.toml` 含真实 ID，建议加入 `.gitignore`，勿提交到公开仓库。

在 `worker/` 目录内单独部署时，也可复制 `worker/wrangler.toml` 为 `worker/wrangler.deploy.toml` 并替换 ID，然后 `cd worker && npx wrangler deploy --config wrangler.deploy.toml`。

### 5. 设置 Secret（生产环境必须）

```bash
npx wrangler secret put PASSWORD --config wrangler.toml
# 按提示输入管理员登录码（唯一凭据，登录页无需用户名）
```

可选：

```bash
npx wrangler secret put PUBLIC_API_TOKEN --config wrangler.toml
# 自定义公开 API token；不设置则从 PASSWORD+USERNAME 派生
```

> Secret 不能写在 `wrangler.toml` 的 `[vars]` 中，只能通过 `wrangler secret put` 或 Dashboard 加密变量设置。

### 6. 配置环境变量（可选）

根目录 `wrangler.toml` 的 `[vars]` 段已有默认值，可按需修改：

```toml
[vars]
WEBHOOK_URL = ""                    # 可选：无 KV 渠道时的企微 webhook 回退
ALERT_THRESHOLD = "70"              # 告警阈值回退值（百分比）
USERNAME = "admin"                  # 内部会话标识（登录 UI 不展示）
ACCOUNT_CHECK_INTERVAL_MINUTES = "20"
MAX_EXTERNAL_SUBREQUESTS_PER_RUN = "50"
```

Cron 已在 `[triggers]` 中配置：`crons = ["0 */6 * * *"]`（每 6 小时执行一次兜底刷新）。

### 7. 部署

```bash
npm run typecheck
npm run deploy
# 若使用 wrangler.deploy.toml：
# npm run deploy -- --config wrangler.deploy.toml
# 或在 worker/ 内：cd worker && npm run deploy
```

部署成功后终端会输出 Worker URL，例如 `https://cf-quota-dashboard.<subdomain>.workers.dev`。

### 8. 本地开发（可选）

创建 `worker/.dev.vars`（已被 `.gitignore` 忽略）：

```env
PASSWORD=your-local-dev-password
```

```bash
npm run dev
# 访问 http://localhost:8787
```

| 场景 | 行为 |
|------|------|
| 未设置 `PASSWORD` | Dev 模式：写操作无需登录 |
| 设置了 `PASSWORD` | `/admin`、`/channels` 及写 API 需先登录 |

---

## 方法二：通过 Cloudflare Dashboard 部署

### 1. 创建 Worker

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 **Workers & Pages** → **创建应用程序** → **创建 Worker**
3. 命名（例如 `cf-quota-dashboard`）并部署

### 2. 连接 GitHub（推荐）

在 Worker 设置中连接 [cf-fork-div/CF-Quota-Dashboard](https://github.com/cf-fork-div/CF-Quota-Dashboard) 仓库。**无需指定子路径** — 根目录 `wrangler.toml` 会正确引用 `worker/src/index.ts` 与 `frontend/` 静态资源。

也可手动上传代码。

### 3. 创建 KV 命名空间（⚠️ 必须）

KV 命名空间**默认不存在**，需手动创建：

1. 左侧菜单 **Workers & Pages** → **KV**
2. 点击 **创建命名空间**，命名为 **`CF-Quota-Dashboard`**
3. 创建后记下 **命名空间 ID**（GitHub Actions 中可写入 `KV_NAMESPACE_ID` Secret）

### 4. 绑定 KV 到 Worker（⚠️ 必须）

1. Worker 页面 → **设置** → **变量**
2. **KV 命名空间绑定** → **添加绑定**
   - **变量名称**：`KV`（⚠️ Worker 绑定变量名必须大写 `KV`，与命名空间显示名无关）
   - **KV 命名空间**：选择 **`CF-Quota-Dashboard`**（或你实际使用的命名空间）
3. 保存并部署

### 5. 设置环境变量与 Secret（⚠️ 必须）

在 **设置** → **变量** 中：

| 变量名 | 类型 | 是否必须 | 说明 |
|--------|------|---------|------|
| `PASSWORD` | Secret（加密） | ✅ 生产必须 | 管理员登录码；未设置 = Dev 模式 |
| `USERNAME` | 环境变量 | ⚪ 可选 | 默认 `admin`，参与公开 API token 派生 |
| `ALERT_THRESHOLD` | 环境变量 | ⚪ 可选 | 默认 `70` |
| `ACCOUNT_CHECK_INTERVAL_MINUTES` | 环境变量 | ⚪ 可选 | 默认 `20` |
| `MAX_EXTERNAL_SUBREQUESTS_PER_RUN` | 环境变量 | ⚪ 可选 | 默认 `50`，上限 50 |

**添加 `PASSWORD` 步骤：**

1. 点击 **添加变量**
2. 变量名填 `PASSWORD`，勾选 **加密**
3. 输入强密码（建议 16+ 字符）
4. 保存并部署

### 6. 配置 Cron 触发器（⚠️ 必须）

1. Worker 页面 → **触发器** → **Cron Triggers**
2. 添加：`0 */6 * * *`（每 6 小时）
3. 保存

> 若通过 Git 连接部署，`wrangler.toml` 中的 `[triggers]` 会在下次部署时同步。

### 7. 验证部署

1. 访问 `https://<your-worker>.workers.dev/` — 应显示仪表盘
2. 访问 `/admin` — 若已设 `PASSWORD`，应跳转 `/login`
3. 登录后添加第一个被监控账号并 **Verify Credentials**

---

## 方法三：GitHub Actions 自动部署

工作流文件：`.github/workflows/deploy.yml`  
触发条件：推送到 `master` 分支，或 Actions 页手动 **Run workflow**（`workflow_dispatch`）。

### 1. Fork / 克隆仓库

Fork [cf-fork-div/CF-Quota-Dashboard](https://github.com/cf-fork-div/CF-Quota-Dashboard) 到你的 GitHub 账号，或使用已有仓库。

### 2. 创建 Cloudflare API Token

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens)
2. **Create Token** → **Edit Cloudflare Workers** 模板（或自定义）
3. 权限至少包含：**Account → Workers Scripts → Edit**、**Account → Workers KV Storage → Edit**
4. 复制 Token

### 3. 获取并核对 Account ID

GitHub Actions **不会**执行 `wrangler login`，而是通过 Secret **`CLOUDFLARE_ACCOUNT_ID`** 锁定部署目标账号（与本地 `npx wrangler whoami` 显示的 Account ID 应为同一个）。

获取方式（任选其一，建议交叉核对）：

1. **Dashboard：** 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → 右侧栏 **Account ID**
2. **本地 CLI：** `npx wrangler whoami` → 输出表格中的 **Account ID**

> 多账号环境下，务必确认 Secret 中的 ID 与预期账号一致，否则 Worker / KV 会部署到错误账号。

### 4. 配置 Repository Secrets

仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**：

| Secret | 是否必须 | 说明 |
|--------|---------|------|
| `CLOUDFLARE_API_TOKEN` | ✅ 必须 | 上一步创建的 API Token |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ 必须 | 托管 Worker 的 Account ID；等同 Wrangler 的 `account_id` / `whoami` 输出，用于 CI 锁定目标账号 |
| `KV_NAMESPACE_ID` | ⚪ 可选 | 创建 **`CF-Quota-Dashboard`** 命名空间后填入其 ID；**未设置时 CI 自动查找或创建**标题为 **`CF-Quota-Dashboard`** 的命名空间（见下方说明） |
| `PASSWORD` | ⚪ 可选 | 管理员登录码；见下方「自动同步 PASSWORD」 |

### 5. CI 部署流程

推送代码到 `master` 后，Actions 依次执行：

1. `npm ci` 安装依赖
2. `npm run typecheck` 类型检查
3. **Resolve KV namespace** — 解析 KV ID 并将根目录 `wrangler.toml` 中 `YOUR_KV_NAMESPACE_ID` 替换为真实 ID：
   - 若配置了 `KV_NAMESPACE_ID` Secret → 直接使用（**推荐**：先 `wrangler kv namespace create` 创建后填入 `id`）
   - 若未配置 → 调用 Cloudflare API 查找标题为 **`CF-Quota-Dashboard`** 的命名空间；找不到则自动创建标题为 **`CF-Quota-Dashboard`** 的新命名空间
4. `npx wrangler deploy --config ../wrangler.toml` 部署 Worker（`wrangler.toml` 中 `binding = "KV"` 不变）
5. **（可选）** 若配置了 `PASSWORD` Secret，自动执行 `wrangler secret put PASSWORD`

> 若使用自定义命名空间显示名（非 **`CF-Quota-Dashboard`**），请在 GitHub Secrets 中设置 **`KV_NAMESPACE_ID`** 为该命名空间的 ID。

### 6. 首次 CI 部署后必做事项

> ⚠️ **重要**：若**未**在 GitHub Secrets 中配置 `PASSWORD`，CI **不会**设置 Worker 登录码，部署后 Worker 处于 **Dev 模式**。

**方式 A — 手动设置（默认）**

```bash
npx wrangler secret put PASSWORD --config wrangler.toml
```

或在 Cloudflare Dashboard → Worker → **设置** → **变量** → 添加加密变量 `PASSWORD`。

**方式 B — 通过 GitHub Secret 自动同步（可选）**

1. 在 Repository Secrets 中添加 `PASSWORD`（你的管理员登录码）
2. 下次 Actions 部署时会自动执行 `wrangler secret put PASSWORD`
3. 修改登录码后，重新触发 workflow 或推送 commit 即可更新

> Worker Secret 与 GitHub Secret 相互独立；仅在 CI 步骤中显式同步时才会写入 Cloudflare。

### 7. 验证 CI 部署

1. Actions 页确认 workflow 绿色通过
2. 访问 `https://cf-quota-dashboard.<your-subdomain>.workers.dev/`
3. 确认 `/admin` 需登录（若已设置 `PASSWORD`）
4. 添加测试账号并验证数据刷新

---

## 环境变量

| 变量名 | 类型 | 是否必须 | 默认值 | 说明 |
|--------|------|---------|--------|------|
| `PASSWORD` | Secret | ✅ 生产必须 | *(空)* | 管理员登录码。**未设置 = Dev 模式**，写 API 无需认证 |
| `USERNAME` | String | ⚪ 可选 | `admin` | 内部会话标识（登录页不展示；参与公开 API token HMAC 派生） |
| `ALERT_THRESHOLD` | String | ⚪ 可选 | `70` | 规范化告警规则时的阈值回退值 |
| `FREE_TIER_LIMITS` | String | ⚪ 可选 | 内置默认 | JSON 覆盖 `worker/src/free-tier-limits.ts` 中的限额 |
| `WEBHOOK_URL` | String | ⚪ 可选 | *(空)* | 旧版单 webhook；**仅当 KV 无通知渠道时**作为隐式企微渠道 |
| `ACCOUNT_CHECK_INTERVAL_MINUTES` | String | ⚪ 可选 | `20` | 快照缓存 TTL 回退值（分钟） |
| `MAX_EXTERNAL_SUBREQUESTS_PER_RUN` | String | ⚪ 可选 | `50` | 单次刷新最多对外 subrequest 数（Workers 单次调用上限 50） |
| `PUBLIC_API_TOKEN` | Secret/Var | ⚪ 可选 | HMAC 派生 | `GET /api/public/snapshot?token=` 的鉴权 token。**生产环境推荐显式设置**，与登录码分离 |
| `ENCRYPTION_KEY` | Secret | ⚪ 可选 | PBKDF2(`PASSWORD`) | KV 中 `apiToken` 与渠道敏感字段的 AES-GCM 加密密钥（64 位 hex 或任意字符串经 SHA-256） |

每个账号刷新约消耗 **10** 个外部 subrequest；默认 50 的预算通常可刷新约 **5** 个账号。响应中的 `refreshStats` 会显示实际消耗与跳过情况。

**⚠️ 重要提示：**

- 生产环境**必须**设置 `PASSWORD`，否则 Worker 处于 Dev 模式，所有写 API 对公网开放
- **推荐**设置独立 `PUBLIC_API_TOKEN` 供外部集成，避免将登录码或 HMAC 派生 token 直接分享给第三方
- **推荐**设置独立 `ENCRYPTION_KEY`（`openssl rand -hex 32`），避免 KV 加密密钥与登录码绑定
- Secret 必须通过 `wrangler secret put` 或 Dashboard 加密变量设置，不能写在 `wrangler.toml` 的 `[vars]` 中

---

## KV 命名空间绑定

**⚠️ 这是最关键的配置步骤！**

### 绑定名 vs 命名空间显示名

| 概念 | 值 | 说明 |
|------|-----|------|
| Worker 绑定变量名 | **`KV`** | `wrangler.toml` 的 `binding = "KV"` 与 Dashboard 绑定的**变量名称**；代码通过 `env.KV` 访问，**不可改名** |
| KV 命名空间显示名 | **`CF-Quota-Dashboard`**（推荐） | Dashboard / `wrangler kv namespace list` 中的 `title`；需手动创建，与 Worker 同名即可 |
| `wrangler.toml` 中的 `id` | 命名空间 UUID | 占位符 `YOUR_KV_NAMESPACE_ID` 需替换为真实 ID；GitHub Actions 会在部署前自动 patch |

### 绑定要求

- **Worker 变量名称必须是**：`KV`（大写，不能改）
- **命名空间显示名**：推荐 **`CF-Quota-Dashboard`**，也可使用其他名称，只要 `id` 与 Dashboard 绑定一致
- **绑定类型**：KV 命名空间
- **用途**：存储以下数据

| KV Key | 说明 |
|--------|------|
| `ACCOUNTS` | 被监控账号配置（含 `alertRules`） |
| `QUOTA_SNAPSHOT` | 最新配额快照 |
| `NOTIFICATION_CHANNELS` | 通知渠道配置 |
| `DASHBOARD_CONFIG` | 仪表盘刷新间隔等配置 |
| `ALERT_COOLDOWN` | 告警推送去重状态 |
| `session:*` | 登录 Session |

### KV 数据结构示例

**`ACCOUNTS`**（账号配置）：

```json
[
  {
    "id": "acc-1",
    "name": "主账号",
    "accountId": "6d7***************************90",
    "apiToken": "enc:v1:Base64IvAndCiphertext...",
    "enabled": true,
    "alertRules": [
      { "metricKey": "workers_requests", "enabled": true, "thresholdPercent": 80 }
    ]
  }
]
```

> **KV 字段加密**：当设置了 `PASSWORD` 或 `ENCRYPTION_KEY` 时，`apiToken` 与通知渠道敏感字段（`webhookUrl`、`botToken`、`chatId`、`customHeaders`）在写入 KV 前经 AES-GCM 加密，存储格式为 `enc:v1:<base64>`。API 响应仍返回掩码值，前端无感知。
>
> - **密钥优先级**：`ENCRYPTION_KEY` Secret > 从 `PASSWORD` PBKDF2 派生
> - **`ENCRYPTION_KEY` 格式**：推荐 64 位十六进制（`openssl rand -hex 32`）；也可为任意字符串（经 SHA-256 哈希为 256 位密钥）
> - **迁移**：旧版明文数据在读取时照常解密为明文供 Worker 使用；下次保存账号/渠道时自动重加密
> - **Dev 模式**：未设置 `PASSWORD` 且无 `ENCRYPTION_KEY` 时不加密（仅本地开发）

设置加密密钥：

```bash
npx wrangler secret put ENCRYPTION_KEY
# 粘贴 openssl rand -hex 32 的输出
```

**`QUOTA_SNAPSHOT`**（配额快照，字段见下方示例）：

```json
{
  "lastUpdated": "2026-07-03T12:00:00.000Z",
  "accounts": [
    {
      "accountId": "6d7...90",
      "accountName": "主账号",
      "status": "ok",
      "quotas": {
        "workers_requests": {
          "used": 80000,
          "limit": 100000,
          "pct": 80,
          "unit": "requests",
          "period": "daily",
          "label": "Workers Requests",
          "available": true
        }
      },
      "lastCheckTime": "2026-07-03T12:00:00.000Z"
    }
  ]
}
```

---

## wrangler.toml 关键配置

**仓库根目录（GitHub Actions、`npm run deploy`、Dashboard Connect Git）：**

```toml
name = "cf-quota-dashboard"
main = "worker/src/index.ts"
compatibility_date = "2026-01-15"
# account_id = "YOUR_ACCOUNT_ID"   # 可选：锁定部署账号，见「登录 Wrangler 并验证账号」

[[kv_namespaces]]
binding = "KV"                    # Worker 变量名（不可改）
id = "YOUR_KV_NAMESPACE_ID"       # CF-Quota-Dashboard 命名空间的 UUID；CI 可自动 patch

[assets]
directory = "frontend"
binding = "ASSETS"

[triggers]
crons = ["0 */6 * * *"]

[vars]
WEBHOOK_URL = ""
ALERT_THRESHOLD = "70"
USERNAME = "admin"
ACCOUNT_CHECK_INTERVAL_MINUTES = "20"
MAX_EXTERNAL_SUBREQUESTS_PER_RUN = "50"
```

**`worker/wrangler.toml`（仅在 `cd worker` 内本地部署时使用）：** 与上相同，但 `main = "src/index.ts"`、`[assets] directory = "../frontend"`。

---

## 部署故障排查

### 1. 部署后无法访问管理面板?

**检查清单：**

- ✅ 是否通过 `wrangler secret put PASSWORD` 或 Dashboard 加密变量设置了登录码？
- ✅ GitHub Actions 部署后是否执行了上述步骤（或配置了 `PASSWORD` Repository Secret）？
- ✅ 是否绑定了 KV 命名空间？
- ✅ KV 绑定的变量名是否为 `KV`（大写）？
- ✅ `wrangler.toml` 中 KV `id` 是否为真实 ID（非 `YOUR_KV_NAMESPACE_ID`）？
- ✅ Worker 是否成功部署？Cron `0 */6 * * *` 是否已生效？

### 2. GitHub Actions 部署成功但线上无密码保护?

Actions **默认不会**同步 Worker Secrets（除非在 Repository Secrets 中配置了 `PASSWORD`）。

**手动设置：**

```bash
npx wrangler secret put PASSWORD --config wrangler.toml
```

**或自动同步：** 在 GitHub → Settings → Secrets 添加 `PASSWORD`，重新运行 workflow。

### 3. CI 报 KV 或 `YOUR_KV_NAMESPACE_ID` 相关错误?

**原因：** `Resolve KV namespace` 步骤失败，或 `CLOUDFLARE_API_TOKEN` 缺少 KV 权限。

**解决：**

1. 确认 Secrets 中 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 正确
2. Token 需含 **Workers KV Storage → Edit** 权限
3. 先创建命名空间：`npx wrangler kv namespace create CF-Quota-Dashboard`，将其 `id` 写入 Secret `KV_NAMESPACE_ID`（**推荐**）
4. 或依赖 CI 自动查找/创建标题为 **`CF-Quota-Dashboard`** 的命名空间（需 Token 含 KV Edit 权限）
5. 本地验证：`npx wrangler kv namespace list`

### 4. 提示 KV 相关错误?

**解决方法：**

1. 创建命名空间：`npx wrangler kv namespace create CF-Quota-Dashboard`
2. 将输出中的 `id` 写入 `wrangler.toml` 的 `[[kv_namespaces]]`（替换 `YOUR_KV_NAMESPACE_ID`）
3. 在 Worker 设置中绑定 KV，**变量名称必须是 `KV`**（显示名可以是 `CF-Quota-Dashboard`）
4. 保存并重新部署；GitHub Actions 部署时可将 `id` 写入 Secret `KV_NAMESPACE_ID`

### 5. 登录失败 / 写操作 401?

- 确认已通过 `wrangler secret put PASSWORD` 设置登录码（非 `[vars]`）
- 登录页只需输入 **管理员登录码**，无需账号名
- 本地 dev 检查 `worker/.dev.vars` 是否包含 `PASSWORD`
- 清除浏览器 Cookie 后重试

### 6. `/login` 返回 503 "Auth not configured"?

未设置 `PASSWORD` 时不应使用登录 API；此时为 Dev 模式，直接访问 `/admin` 即可。

### 7. 如何迁移到新的 Worker?

```bash
# 导出
npx wrangler kv key get --binding=KV ACCOUNTS > accounts.json
npx wrangler kv key get --binding=KV NOTIFICATION_CHANNELS > channels.json

# 导入到新 Worker
npx wrangler kv key put --binding=KV ACCOUNTS --path=accounts.json
npx wrangler kv key put --binding=KV NOTIFICATION_CHANNELS --path=channels.json
```

---

<div align="center">

**[⬆ 返回 README](../README.md)** · **[⬆ 回到顶部](#部署文档)**

</div>
