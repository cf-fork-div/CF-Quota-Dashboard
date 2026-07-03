# 部署文档

将 CF-Quota-Dashboard 部署到 Cloudflare Workers + KV。

> 功能概览见 [README.md](../README.md)

---

## 选择部署方式

| 方式 | 适合场景 | 预计耗时 |
|------|----------|----------|
| **[一键部署](#1-一键部署)** | 本地首次安装 | 5～10 分钟 |
| **[GitHub Actions](#2-github-actions-部署)** | Fork 后推送自动更新 | 10～15 分钟（首次配置） |

---

## 前置条件

- [ ] 已登录 [Cloudflare](https://dash.cloudflare.com/) 账号
- [ ] 已创建 **API Token**（一键部署与 GitHub Actions 共用，见下方步骤）

**API Token 创建步骤：**

1. 打开 [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. **使用模板** → **Edit Cloudflare Workers**
3. 令牌名称建议改为 `cf-quota-dashboard`
4. **必须保持 Edit**（GitHub 部署上传 Worker 与静态资源需要）：
   - Account → **Workers Scripts → Edit**
   - Account → **Workers KV Storage → Edit**
5. 其余权限改为 **Read**；**增加** Account → **D1 → Read**
6. 创建令牌并复制 Token 值

- 一键部署：设为 `QUICK_DEPLOY_API_TOKEN`
- GitHub Actions：设为 `CLOUDFLARE_API_TOKEN`

---

## 1. 一键部署

需 [Node.js 18+](https://nodejs.org/)。整段复制粘贴对应代码块（Mac / Linux / Git Bash → Bash，Windows → PowerShell）。

### Mac/Linux/Git Bash

```bash
# 运行前修改下方密码、API Token 与语言（zh/en）。
# 运行中会打开浏览器完成 wrangler 登录。
# 部署成功后脚本会自动添加当前 Cloudflare 账号为监控账号。
git clone https://github.com/cf-fork-div/CF-Quota-Dashboard.git
cd CF-Quota-Dashboard
npm install
export QUICK_DEPLOY_PASSWORD='your-strong-password'  # ← 修改密码（/admin 登录用）
export QUICK_DEPLOY_API_TOKEN='your-api-token'       # ← 修改 API Token（拉取配额用）
export QUICK_DEPLOY_LANG=zh                          # ← 修改语言（zh 或 en）
npm run quick-deploy
```

### Windows PowerShell

```powershell
# 运行前修改下方密码、API Token 与语言（zh/en）。
# 运行中会打开浏览器完成 wrangler 登录。
# 部署成功后脚本会自动添加当前 Cloudflare 账号为监控账号。
git clone https://github.com/cf-fork-div/CF-Quota-Dashboard.git
cd CF-Quota-Dashboard
npm install
$env:QUICK_DEPLOY_PASSWORD='your-strong-password'  # ← 修改密码（/admin 登录用）
$env:QUICK_DEPLOY_API_TOKEN='your-api-token'     # ← 修改 API Token（拉取配额用）
$env:QUICK_DEPLOY_LANG='zh'                       # ← 修改语言（zh 或 en）
npm run quick-deploy
```

---

## 2. GitHub Actions 部署

与一键部署效果相同：自动解析 KV → 部署 Worker → 上传 `PASSWORD` → 自动添加监控账号。  
推送 `master` 或 Actions 页 **Run workflow** 触发。

### 2.1 Fork 并配置 Secrets

1. Fork [cf-fork-div/CF-Quota-Dashboard](https://github.com/cf-fork-div/CF-Quota-Dashboard)
2. 获取 Account ID：Dashboard 右侧栏
3. 仓库 **Settings → Secrets and variables → Actions** 添加：

| Secret | 必填 | 说明 |
|--------|------|------|
| `CLOUDFLARE_API_TOKEN` | ✅ | 上方「前置条件」创建的 API Token |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ | Cloudflare 账号 ID |
| `PASSWORD` | ✅ | `/admin` 登录码 |

KV 命名空间会自动查找或创建，无需额外配置。

> 若 Actions 日志出现 `assets-upload-session` + `Authentication error [code: 10000]`，说明 `CLOUDFLARE_API_TOKEN` 缺少 **Workers Scripts → Edit** 权限（常见原因：把 Scripts 改成了 Read）。

### 2.2 触发部署

```bash
git push origin master
```

或在 GitHub **Actions → Deploy CF Quota Dashboard → Run workflow**。

部署完成后访问 `https://cf-quota-dashboard.<你的子域>.workers.dev`。

---

## 3. 部署后验证

1. **仪表盘** — 打开 `https://*.workers.dev/`，确认配额数据正常显示
2. **管理后台** — 访问 `/admin`，使用部署时设置的密码登录
3. **通知渠道**（可选）— 在 `/channels` 配置告警推送

如需监控其他 Cloudflare 账号，在 `/admin` [添加被监控账号](../README.md#-配置被监控账号)。

---

**[⬆ 返回 README](../README.md)** · **[⬆ 回到顶部](#部署文档)**
