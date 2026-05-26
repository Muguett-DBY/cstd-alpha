# CSTD Alpha ─ Reasonix Context

## Stack

- **Language** — TypeScript (~6.0.2) + React (19.2.5)
- **Build** — Vite 8 + `@vitejs/plugin-react`
- **Test** — Vitest 4 (colocated `*.test.ts` / `*.test.tsx` files)
- **Lint** — ESLint 10 + `typescript-eslint` + `eslint-plugin-react-hooks` + `eslint-plugin-react-refresh`
- **Server** — Cloudflare Pages Functions (`wrangler 4`, D1 + R2 + KV bindings)
- **Key deps** — `@tanstack/react-table`, `@tanstack/react-virtual`, `echarts`, `lightweight-charts`, `docx`, `jsonrepair`

## Layout

- `functions/` — Cloudflare Pages Functions (API endpoints at `api/*.ts`, shared logic in `_shared/`)
- `src/` — React frontend (TSX components, CSS, app logic)
- `src/shared/` — Types/validators consumed by both frontend and functions
- `migrations/` — D1 SQL migrations (numbered `0001_*.sql` … `0008_*.sql`)
- `scripts/` — Utility scripts (regression tests, data collection, report batch tools)
- `public/` — PWA static assets (icons, manifest, service worker)
- `.wrangler/` — Generated Wrangler state (do not edit)

## Commands

| Command | Action |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc -b && vite build` |
| `npm run test` | `vitest run` |
| `npm run lint` | `eslint .` |
| `npm run preview` | `vite preview` |
| `npm run pages:dev` | `wrangler pages dev dist` |
| `npm run pages:deploy` | Deploy to Cloudflare Pages |
| `npm run typecheck:functions` | `tsc -p tsconfig.functions.json` |

## Conventions

- **Named exports only** — no `export default` anywhere in the codebase.
- **Type-only imports** used for type-only deps (`import type { X } from "./x"`).
- **Tests colocated** — every `*.ts`/`*.tsx` can have a `*.test.ts`/`*.test.tsx` sibling; no separate `__tests__` dir.
- **Relative imports** — no path aliases; all imports are relative (`./api`, `../shared/report`).
- **Functions API pattern** — Pages Functions use `export const onRequestGet` / `onRequestPost`.
- **Chinese‑first** — README, API error messages, and default report language are `zh-CN`.

## Watch out for

- **`.dev.vars` is required locally** — copy from `.dev.vars.example` with keys: `REPORT_PASSWORD`, `AUTH_SECRET`, `DEEPSEEK_API_KEY`, `GITHUB_RADAR_DISPATCH_TOKEN`, `ANYSEARCH_API_KEY`, `SEARXNG_ENDPOINTS`, `EXA_API_KEY`.
- **Functions need Cloudflare bindings** — `wrangler.jsonc` expects D1 (`REPORT_LIBRARY_DB`), R2 (`REPORT_LIBRARY_BUCKET`), and KV (`REPORT_CACHE`); local dev requires matching those via `wrangler pages dev --d1 ... --r2 ... --kv ...` or a dev account.
- **`.tmp/` contains regression artifacts** — committed to the repo, not gitignored; do not edit manually.
