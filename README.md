# CSTD Alpha

Private AI-assisted company research workspace for generating CQS + IAS scoring reports from public financial data and DeepSeek V4 Pro.

## Workflow

1. Password gate protects the app and API.
2. User enters company name plus optional ticker and market.
3. Cloudflare Pages Function fetches latest available public financial/profile data.
4. DeepSeek `deepseek-v4-pro` runs with thinking enabled and `reasoning_effort: "max"`.
5. The app renders a structured report and exports DOCX/JSON.

## Local Development

Create `.dev.vars` from `.dev.vars.example`:

```env
DEEPSEEK_API_KEY="..."
REPORT_PASSWORD="..."
AUTH_SECRET="..."
```

Then run:

```bash
npm install
npm test
npm run build
npm run pages:dev
```

## Deployment

Production is designed for Cloudflare Pages Direct Upload through GitHub Actions.

Required GitHub repository secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Required Cloudflare Pages secrets:

- `DEEPSEEK_API_KEY`
- `REPORT_PASSWORD`
- `AUTH_SECRET`

Project:

- GitHub: `Muguett-DBY/cstd-alpha`
- Cloudflare Pages: `cstd-alpha`
- Custom domain: `alpha.custard.top`

## Safety

The report is for learning, research, and personal review only. It is not investment advice. When public data is unavailable, the app must show the gap instead of inventing facts.
