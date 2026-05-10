# CSTD Alpha

中文优先的私人公司研究工具。输入公司名后先确认上市主体，再用公开财务数据和 DeepSeek V4 Pro 生成 CQS + IAS 深度评分报告。

## 工作流

1. 密码门保护网页和 API。
2. 用户输入公司名或代码，系统返回候选公司：公司名、代码、上市地、交易所。
3. 用户选择候选公司后，Cloudflare Pages Function 读取公开行情和财务数据。
4. DeepSeek `deepseek-v4-pro` 使用 thinking mode 和 `reasoning_effort: "max"` 生成完整报告。
5. 前端实时显示 NDJSON 进度流，并支持 DOCX/JSON 导出。

## API

- `GET /api/company-search?q=万科A`：返回候选公司列表。
- `POST /api/report`：请求体为 `{ "company": CompanyCandidate }`，响应为 NDJSON 进度流。

## 本地开发

从 `.dev.vars.example` 创建 `.dev.vars`：

```env
DEEPSEEK_API_KEY="..."
REPORT_PASSWORD="..."
AUTH_SECRET="..."
```

然后运行：

```bash
npm install
npm test
npm run build
npm run pages:dev
```

## 部署

生产环境通过 GitHub Actions 使用 Cloudflare Pages Direct Upload。

GitHub 仓库 secrets：

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Cloudflare Pages secrets：

- `DEEPSEEK_API_KEY`
- `REPORT_PASSWORD`
- `AUTH_SECRET`

项目：

- GitHub: `Muguett-DBY/cstd-alpha`
- Cloudflare Pages: `cstd-alpha`
- Custom domain: `alpha.custard.top`

## 安全声明

报告仅用于学习、研究和个人复盘，不构成任何买卖建议。公开数据不可用时，系统必须标明数据缺口，不能编造事实。
