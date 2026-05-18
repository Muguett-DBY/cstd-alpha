# CSTD Alpha

中文优先的私人公司研究工具。输入公司名后先确认上市主体，再用公开财务数据和 DeepSeek Flash Max 生成“公司质量评分（CQS）+ 投资吸引力评分（IAS）”深度评分报告。

## 工作流

1. 固定账号登录保护网页和 API；账号保存在 D1，密码只保存哈希，session token 只保存哈希。
2. 用户输入公司名或代码，系统返回候选公司：公司名、代码、上市地、交易所。
3. 用户选择候选公司后，Cloudflare Pages Function 读取公开行情和财务数据。
4. 在线生成和行业雷达使用 DeepSeek Direct API `deepseek-v4-flash`，并保持 `reasoning_effort: "max"`；行业雷达会先做公开来源聚合与证据摘要，再交给模型综合判断。
5. 前端实时显示 NDJSON 进度流；已生成报告写入 D1/R2 报告库后可秒开。
6. 登录用户可把公司加入“我的”，进入公司工作台生成 10 个模板专项深度报告或全面分析。

批量导入报告库仍可使用 OpenCode CLI 或 Direct API 生成报告，再导入 D1/R2 报告库；在线功能不再接 OpenCode Zen 免费模型。

## API

- `GET /api/company-search?q=万科A`：返回候选公司列表。
- `POST /api/report`：请求体为 `{ "company": CompanyCandidate }`，响应为 NDJSON 进度流。
- `GET/POST/DELETE /api/session`：固定账号登录、读取和退出。
- `GET/POST/DELETE /api/watchlist`：按 `user_id` 隔离的自选股。
- `GET/POST /api/template-analysis`：模板专项报告元数据存在 D1，正文 Markdown 存在 R2。
- `GET/POST /api/radar-scan`：读取或刷新行业雷达；结果缓存长期保留，刷新时复用短期来源缓存与证据摘要缓存。

## 本地开发

从 `.dev.vars.example` 创建 `.dev.vars`：

```env
REPORT_PASSWORD="..."
AUTH_SECRET="..."
DEEPSEEK_API_KEY="..."
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

GitHub 仓库 secrets：

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Cloudflare Pages secrets：

- `REPORT_PASSWORD`
- `AUTH_SECRET`
- `DEEPSEEK_API_KEY`

项目：

- GitHub: `Muguett-DBY/cstd-alpha`
- Cloudflare Pages: `cstd-alpha`
- Custom domain: `alpha.custard.top`

## 安全声明

报告仅用于学习、研究和个人复盘，不构成任何买卖建议。公开数据不可用时，系统必须标明数据缺口，不能编造事实。
