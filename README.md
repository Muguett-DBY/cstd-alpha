# CSTD Alpha

中文优先的私人公司研究工具。输入公司名后先确认上市主体，再用公开财务数据和 DeepSeek Flash Max 生成“公司质量评分（CQS）+ 投资吸引力评分（IAS）”深度评分报告。

## 工作流

1. 固定账号登录保护网页和 API；账号保存在 D1，密码只保存哈希，session token 只保存哈希。
2. 用户输入公司名或代码，系统返回候选公司：公司名、代码、上市地、交易所。
3. 用户选择候选公司后，Cloudflare Pages Function 读取公开行情和财务数据。
4. 在线公司报告使用 DeepSeek Direct API `deepseek-v4-flash`；行业雷达由 GitHub Actions 定时滚动生成公开证据库，用户手动点击刷新时再触发后台 Action 调用 DeepSeek 做深度综合。
5. 前端实时显示 NDJSON 进度流；已生成报告写入 D1/R2 报告库后可秒开。
6. 登录用户可把公司加入“我的”，进入公司工作台生成 10 个模板专项深度报告或全面分析。

批量导入报告库仍可使用 OpenCode CLI 或 Direct API 生成报告，再导入 D1/R2 报告库；在线功能不再接 OpenCode Zen 免费模型。

## API

- `GET /api/company-search?q=万科A`：返回候选公司列表。
- `POST /api/report`：请求体为 `{ "company": CompanyCandidate }`，响应为 NDJSON 进度流。
- `GET/POST/DELETE /api/session`：固定账号登录、读取和退出。
- `GET/POST/DELETE /api/watchlist`：按 `user_id` 隔离的自选股。
- `GET/POST /api/template-analysis`：模板专项报告元数据存在 D1，正文 Markdown 存在 R2。
- `POST /api/company-evidence-refresh`：受 `COMPANY_EVIDENCE_REFRESH_TOKEN` 保护的公司证据包刷新入口，供 GitHub Actions 每日刷新“我的”自选股证据包。
- `GET/POST /api/radar-scan`：读取或刷新行业雷达；`POST` 只创建后台分析 job 并触发 GitHub Action，页面继续显示旧缓存并轮询 job 状态，DeepSeek 不在 Cloudflare Pages 请求内运行。

## 本地开发

从 `.dev.vars.example` 创建 `.dev.vars`：

```env
REPORT_PASSWORD="..."
AUTH_SECRET="..."
DEEPSEEK_API_KEY="..."
GITHUB_RADAR_DISPATCH_TOKEN="..."
```

然后运行：

```bash
npm install
npm test
npm run build
npm run pages:dev
```

创建或重置固定账号：

```bash
CSTD_USER_PASSWORD="..." node scripts/create-fixed-user.mjs --username=alice --displayName=Alice --role=admin
```

不提供公开注册页。生产库没有任何账号时，可以用 `REPORT_PASSWORD` 登录任意首个账号完成一次管理员引导；之后建议用脚本维护固定账号。

## 部署

生产环境通过 GitHub Actions 使用 Cloudflare Pages Direct Upload。

行业雷达证据库由 `.github/workflows/radar-evidence.yml` 每 6 小时运行一次：Python 脚本 `scripts/collect_radar_evidence.py` 抓取 AKShare、BaoStock、东方财富财报/业绩预告、商品价格、行业统计、板块行情和公开新闻线索，生成 `radar-evidence.json` 与压缩产物，再写入现有 `REPORT_CACHE` KV 的 `radar-evidence:v1:latest`。这个步骤不读取也不调用 `DEEPSEEK_API_KEY`。

“我的”模板分析使用公司级证据包：加入自选股时会尽力预抓一次，`.github/workflows/company-evidence.yml` 每日调用线上刷新入口，把公司财报、行情、公告、公开搜索线索归一化为 D1/R2 证据包。模板报告按“模板版本 + 公司证据指纹”复用缓存；证据无实质变化时不会重复调用 DeepSeek。模板分析和模板补全都走 DeepSeek 官方 API，正式模板报告使用 `reasoning_effort: "max"`。

行业雷达深度分析由 `.github/workflows/radar-analysis.yml` 在用户点击“雷达扫描”时触发：Pages Function 只写入 `radar-analysis:job:*` 并调用 GitHub workflow dispatch；Action 读取完整证据库和上次报告，调用 DeepSeek，完成后写回 `radar-scan:v2:latest`。

GitHub 仓库 secrets：

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `DEEPSEEK_API_KEY`

Cloudflare Pages secrets：

- `REPORT_PASSWORD`
- `AUTH_SECRET`
- `DEEPSEEK_API_KEY`（公司报告仍在 Pages Function 中使用）
- `GITHUB_RADAR_DISPATCH_TOKEN`（fine-grained token，允许触发本仓库 Actions workflow）

项目：

- GitHub: `Muguett-DBY/cstd-alpha`
- Cloudflare Pages: `cstd-alpha`
- Custom domain: `alpha.custard.top`

## 安全声明

报告仅用于学习、研究和个人复盘，不构成任何买卖建议。公开数据不可用时，系统必须标明数据缺口，不能编造事实。
