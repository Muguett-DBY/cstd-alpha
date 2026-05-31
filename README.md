# CSTD Alpha

中文优先的私人公司研究工具。输入公司名后先确认上市主体，再用公开财务数据和 DeepSeek Flash Max 生成“公司质量评分（CQS）+ 投资吸引力评分（IAS）”深度评分报告。

## 工作流

1. 固定账号登录保护网页和 API；账号保存在 D1，密码只保存哈希，session token 只保存哈希。
2. 用户输入公司名或代码，系统返回候选公司：公司名、代码、上市地、交易所。
3. 用户选择候选公司后，Cloudflare Pages Function 读取公开行情和财务数据。
4. 在线公司报告、模板报告、自选排行和雷达分析统一按 OpenCode Go、OpenCode Zen Free、DeepSeek 官方 API 的顺序调用 DeepSeek Flash Max；行业雷达由 GitHub Actions 定时滚动生成公开证据库，用户手动点击刷新时再触发后台 Action 调用模型做深度综合。
5. 前端实时显示 NDJSON 进度流；已生成报告写入 D1/R2 报告库后可秒开。
6. 登录用户可把公司加入“我的”，进入公司工作台生成 10 个模板专项深度报告或全面分析。

批量导入报告库仍可使用 OpenCode CLI 或 Direct API 生成报告，再导入 D1/R2 报告库。线上模型调用保留多级 fallback，避免单一路由限流时直接失败。

## API

- `GET /api/company-search?q=万科A`：返回候选公司列表。
- `POST /api/report`：请求体为 `{ "company": CompanyCandidate }`，响应为 NDJSON 进度流。
- `GET/POST/DELETE /api/session`：固定账号登录、读取和退出。
- `GET/POST/DELETE /api/watchlist`：按 `user_id` 隔离的自选股。
- `GET/POST /api/template-analysis`：模板专项报告元数据存在 D1，正文 Markdown 存在 R2。
- `POST /api/company-evidence-refresh`：受 `COMPANY_EVIDENCE_REFRESH_TOKEN` 保护的公司证据包刷新入口，供 GitHub Actions 每日刷新“我的”自选股证据包。
- `GET/POST /api/template-analysis-job`：受 `TEMPLATE_ANALYSIS_WORKER_TOKEN` 保护的后台模板分析任务接口，供 GitHub Actions 读取 queued/running 任务并回写结果。
- `GET/POST /api/radar-scan`：读取或刷新行业雷达；`POST` 只创建后台分析 job 并触发 GitHub Action，页面继续显示旧缓存并轮询 job 状态，DeepSeek 不在 Cloudflare Pages 请求内运行。

## 本地开发

从 `.dev.vars.example` 创建 `.dev.vars`：

```env
REPORT_PASSWORD="..."
AUTH_SECRET="..."
DEEPSEEK_API_KEY="..."
OPENCODE_GO_API_KEY="..."
OPENCODE_ZEN_API_KEY="..."
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

“我的”模板分析使用公司级证据包：加入自选股时会尽力预抓一次，`.github/workflows/company-evidence.yml` 每日调用线上刷新入口，把公司财报、行情、公告、公开搜索线索归一化为 D1/R2 证据包。模板报告按“模板版本 + 公司证据指纹”复用缓存；证据无实质变化时不会重复调用模型。模板分析和模板补全沿用统一 fallback 路由，正式模板报告使用 `reasoning_effort: "max"`。

模板深度报告由 `.github/workflows/template-analysis.yml` 在用户点击模板生成时触发：Pages Function 只创建/复用 running 任务并触发 GitHub workflow dispatch；Action 读取受保护任务接口，调用 DeepSeek，完成后通过同一接口写回 D1/R2。定时公司证据刷新不会调用 DeepSeek。

行业雷达深度分析由 `.github/workflows/radar-analysis.yml` 在用户点击“雷达扫描”时触发：Pages Function 只写入 `radar-analysis:job:*` 并调用 GitHub workflow dispatch；Action 读取完整证据库和上次报告，调用 DeepSeek，完成后写回 `radar-scan:v2:latest`。

GitHub 仓库 secrets：

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `CHECKOUT_PAT`（可选；私有仓库 checkout 或跨仓库场景需要）
- `OPENCODE_GO_API_KEY`
- `OPENCODE_ZEN_API_KEY`
- `OPENCODE_API_KEY`（兼容旧配置，可选）
- `DEEPSEEK_API_KEY`
- `ANYSEARCH_API_KEY`（外部搜索增强，可选但建议配置）
- `SEARXNG_ENDPOINTS`（逗号或换行分隔的 SearXNG base URL；需实例启用 JSON 输出）
- `EXA_API_KEY`（助手高价值外部检索增强，可选）
- `TUSHARE_TOKEN`（A 股结构化公开数据增强）
- `RADAR_EVIDENCE_R2_BUCKET`（可选；归档雷达证据压缩包）
- `COMPANY_EVIDENCE_REFRESH_URL`
- `COMPANY_EVIDENCE_REFRESH_TOKEN`
- `TEMPLATE_ANALYSIS_WORKER_TOKEN`
- `TEMPLATE_ANALYSIS_WORKER_URL`（可选，默认 `https://alpha.custard.top/api/template-analysis-job`）
- `WATCHLIST_RANKING_WORKER_TOKEN`（可选；缺省复用 `TEMPLATE_ANALYSIS_WORKER_TOKEN`）
- `WATCHLIST_RANKING_WORKER_URL`（可选，默认 `https://alpha.custard.top/api/watchlist-ranking-job`）

Cloudflare Pages secrets：

- `REPORT_PASSWORD`
- `AUTH_SECRET`
- `OPENCODE_GO_API_KEY`
- `OPENCODE_ZEN_API_KEY`
- `OPENCODE_API_KEY`（兼容旧配置，可选）
- `DEEPSEEK_API_KEY`（最终 fallback）
- `GITHUB_RADAR_DISPATCH_TOKEN`（fine-grained token，允许触发本仓库 Actions workflow）
- `GITHUB_TEMPLATE_DISPATCH_TOKEN`（可选；缺省复用 `GITHUB_RADAR_DISPATCH_TOKEN`）
- `GITHUB_WATCHLIST_RANKING_DISPATCH_TOKEN`（可选；缺省复用模板或雷达 dispatch token）
- `TEMPLATE_ANALYSIS_WORKER_TOKEN`（和 GitHub secret 保持一致，仅供后台模板 Action 读写任务）
- `COMPANY_EVIDENCE_REFRESH_TOKEN`（和 GitHub secret 保持一致，仅供后台公司证据刷新）
- `ANYSEARCH_API_KEY`（模板分析和助手的外部搜索增强）
- `SEARXNG_ENDPOINTS`（助手、模板分析的免费元搜索增强；SearXNG API 使用 `/search?q=...&format=json`）
- `EXA_API_KEY`（助手在高价值、最新或全球/英文证据场景的增强搜索）
- `TAVILY_API_KEY`（助手外部搜索增强，可选）
- `BRAVE_SEARCH_API_KEY`（助手外部搜索增强，可选）
- `TUSHARE_TOKEN`（A 股结构化数据增强）

常用本地/运维脚本环境变量：

- `CSTD_ALPHA_ACCESS_FILE` / `CSTD_ALPHA_ACCESS_PATH`：本地脚本读取账号、密码、URL 等访问配置的文件路径。
- `CSTD_ALPHA_BASE_URL`：覆盖本地审计和回归脚本访问的站点地址。
- `CSTD_ALPHA_AUDIT_DIR`：报告库复核或重跑候选输出目录。
- `FINANCIAL_AGENT_PROMPT_FILE`：助手投研 Prompt 回归测试集路径。
- `ASSISTANT_REGRESSION_COOKIE`：线上助手回归测试使用的已登录 cookie。
- `RADAR_DEBUG_SUSTAIN`：雷达后台分析调试开关，仅用于本地或一次性排查。

项目：

- GitHub: `Muguett-DBY/cstd-alpha`
- Cloudflare Pages: `cstd-alpha`
- Custom domain: `alpha.custard.top`

## 安全声明

报告仅用于学习、研究和个人复盘，不构成任何买卖建议。公开数据不可用时，系统必须标明数据缺口，不能编造事实。
