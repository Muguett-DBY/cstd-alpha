# CSTD Alpha - Iteration Log

## Round 63 — 2026-06-28 (Long Cycle: IMPROVE → IMPROVE → UIUX → IMPROVE → CHECK → IMPROVE)

### Stage 1/6 IMPROVE — Login Shell Risk Hardening

- **承接方向:** 先修复当前真实风险和线上可见问题：未登录 session 探测 401 噪声、Pyodide 运行时版本错配、Wrangler audit 风险、安全/缓存 headers 缺失、登录壳首屏预加载过重、无效恢复来源备注污染。
- **旗舰:** 登录壳和运行时风险硬化：`/api/session` 未登录返回 200 envelope，重型视图懒加载，Vite 首页 modulepreload 只保留 runtime 与 React vendor，ECharts 改为 named loader，Pyodide CDN 版本锁定到已安装版本，Cloudflare Pages `_headers` 补齐安全与缓存策略。
- **真实问题修复:** 登录页不再产生预期内 401 失败响应；构建不再出现 Pyodide Node builtin externalization 和大 chunk warning；生产静态资源获得 immutable cache；无效 `restoredPresetLibrary` 不再生成 `恢复 V0 预设库。` 自动备注。
- **验证:** 先写失败测试覆盖 session、Pyodide helper、Pages headers、懒加载边界、无效来源备注、ECharts loader、首页 modulepreload；修复后 `npm ci`、`npm test` 862 tests passed、`npm run lint`、`npm run typecheck:functions`、`npm run build`、`npm audit --json`、`npm audit --omit=dev --json`、`git diff --check` 均通过。
- **数据验证:** 远程 D1 只读检查 `valuation_forecast_versions`：`total_versions=2`、`invalid_json=0`、`source_rows=0`，无需生产数据迁移。
- **浏览器验证:** 本地 `wrangler pages dev dist --port 43261 --local` 与生产 `https://alpha.custard.top` 均通过 Playwright 桌面 1366px / 移动 390px 验证；登录页标题、H1、进入按钮正常，`/api/session` 返回 200 `{ authenticated:false,user:null }`，console errors 为空，无失败响应，无横向溢出，首页 modulepreload 仅 runtime + `vendor-react`。
- **生产验证:** `https://alpha.custard.top` 返回 HTTP 200，安全 headers 包含 HSTS、X-Frame-Options、X-Content-Type-Options、Referrer-Policy、Permissions-Policy；入口 JS asset 返回 `max-age=31536000, immutable`。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28305205002`)。
- **Commit:** `1ababfd fix: harden login shell performance and runtime risks`
- **风险记录:** 本阶段没有加入 CSP，避免在未完成策略设计前破坏 Pyodide CDN ESM/WASM；后续可单独做 CSP 设计与验证。
- **下一阶段:** Stage 2/6 IMPROVE，继续在当前生产基线上做用户可见的产品改进，并保持每阶段本地门禁、浏览器验证、push、CI 与日志闭环。

### Stage 2/6 IMPROVE — Strict CSP Deployment Policy

- **承接方向:** 收口阶段 1 明确留下的 CSP 安全风险，在不破坏 Pyodide CDN ESM/WASM、首屏主题脚本和 Cloudflare Web Analytics 的前提下加固生产响应策略。
- **旗舰:** Pages `_headers` 新增 Content-Security-Policy：默认仅允许 self；Pyodide 只放行 `cdn.jsdelivr.net` 和 WASM 编译；首屏主题 inline script 使用 SHA-256 hash 放行；Cloudflare Insights 只放行 `static.cloudflareinsights.com` 与 `cloudflareinsights.com`；继续禁止 object、base-uri 外部注入和 frame 嵌入。
- **真实问题修复:** 生产从无 CSP 变为明确 allowlist；第一次生产验证发现 Cloudflare Analytics beacon 被 CSP 拦截，随后补充 Cloudflare Insights allowlist 并重新验证通过。
- **验证:** 先写失败测试复现缺少 CSP；修复后 `src/deployment-headers.test.ts` passed，且测试会从 `index.html` 计算主题脚本 hash；全量 `npm test` 862 tests passed；`npm run lint` passed；`npm run typecheck:functions` passed；`npm run build` passed；`git diff --check` passed。
- **浏览器验证:** 本地 `wrangler pages dev dist --port 43262 --local` 解析 2 条 header 规则；Playwright 检查 CSP header、`/api/session` 200 envelope、桌面无横向溢出、首屏 modulepreload 仍仅 runtime + `vendor-react`，console CSP violation 为空。
- **生产验证:** `https://alpha.custard.top` 返回 CSP header；Playwright 桌面 1366px / 移动 390px 均无 CSP violation、无失败响应，Cloudflare Insights 不再被拦截。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, runs `28305499510` / `28305624592`)。
- **Commit:** `2005313 feat: add CSP for pages deployment`；`87d90c6 fix: allow Cloudflare analytics in CSP`
- **风险记录:** `style-src` 仍保留 `'unsafe-inline'` 以兼容现有样式注入/内联样式；如要进一步收紧，需要单独做样式 nonce/hash 迁移。
- **下一阶段:** Stage 3/6 UIUX，利用阶段 1 的懒加载基础改善 authenticated view 加载体验，避免重型视图懒加载后出现过于简陋的空状态。

## Round 62 — 2026-06-26 (Long Cycle: IMPROVE → IMPROVE → UIUX → IMPROVE → CHECK → IMPROVE)

### Stage 1/6 IMPROVE — Persist Restored Preset Source

- **承接方向:** 直接处理 Round 61 遗留风险：恢复来源不能只依赖自动备注，否则用户手写版本说明会覆盖来源审计。
- **旗舰:** 保存 API 客户端和后端 merge 链路新增 `restoredPresetLibrary`，合法恢复来源会进入保存后的 `draft_json`。
- **真实问题修复:** 手写 decision note 与结构化恢复来源现在可以并存，历史版本快照不会丢失“预设库来自 Vx”的来源。
- **验证:** 先写失败测试；851 tests passed；lint passed；functions typecheck passed；build passed；`git diff --check` passed。
- **浏览器验证:** Playwright + `wrangler pages dev dist --port 43180` 恢复 V4 后填写手写备注保存，API 读取最新 V6 确认 `draft.restoredPresetLibrary.version=4` 且 `decisionNote` 保持手写备注；1365px 与 800px 均无横向溢出。
- **截图证据:** `C:\Users\12031\AppData\Local\Temp\cstd-alpha-round62-stage1-persist-source-desktop.png`；`C:\Users\12031\AppData\Local\Temp\cstd-alpha-round62-stage1-persist-source-800.png`。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28238460530`)。
- **Commit:** `cc2661d feat: persist restored valuation preset sources`
- **下一阶段:** Stage 2/6 IMPROVE，将已持久化的来源显示到版本时间线和版本对比区。

### Stage 2/6 IMPROVE — Show Persisted Version Source

- **承接方向:** 接续阶段 1 的结构化来源持久化，把已保存来源展示到用户可见的版本复盘界面。
- **旗舰:** 新增 `describeQuantitativeVersionSourceSummary`；版本时间线显示 `预设来源 V4` pill，对比区显示“该版本的预设库由 V4 恢复后保存。”
- **真实问题修复:** 来源不再只是隐藏在 `draft_json` 中，用户能在历史版本复盘时直接看到预设库来源。
- **验证:** 先写失败测试；852 tests passed；lint passed；functions typecheck passed；build passed；`git diff --check` passed。
- **浏览器验证:** Playwright + `wrangler pages dev dist --port 43180` 验证时间线和对比区来源展示；1365px 与 800px 均无横向溢出。
- **截图证据:** `C:\Users\12031\AppData\Local\Temp\cstd-alpha-round62-stage2-version-source-desktop.png`；`C:\Users\12031\AppData\Local\Temp\cstd-alpha-round62-stage2-version-source-800.png`。
- **下一阶段:** Stage 3/6 UIUX，优化版本复盘区在多版本、多来源状态下的信息层级和扫描效率。

## Round 61 — 2026-06-26 (Long Cycle: IMPROVE → IMPROVE → UIUX → IMPROVE → CHECK → IMPROVE)

### Stage 1/6 IMPROVE — Version Preset Delta Summary

- **承接方向:** 延续 Round 60 的量化估值预设版本追溯闭环，让版本对比区不仅显示历史版本携带多少预设，还能说明当前草稿与历史版本的预设库差异。
- **旗舰:** 新增版本预设差异摘要，统计新增、移除、重命名、更新预设，并在版本对比区显示 changed/synced 状态。
- **真实问题修复:** 之前版本复盘只能看到“Vx 有 N 个预设”，无法判断当前草稿相比历史版本的预设库变化；现在能直接看到 `预设库有 3 项差异：新增 3 个方案。`
- **验证:** 先写失败测试；843 tests passed；lint passed；functions typecheck passed；build passed；`git diff --check` passed。
- **浏览器验证:** Playwright + `wrangler pages dev dist --port 43179` 验证版本对比区预设差异摘要、桌面和 800px 无横向溢出。仅有登录前既有 `/api/session` 401。
- **截图证据:** `C:\Users\12031\AppData\Local\Temp\cstd-alpha-round61-stage1-preset-delta-desktop.png`；`C:\Users\12031\AppData\Local\Temp\cstd-alpha-round61-stage1-preset-delta-800.png`。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28221019125`)。
- **Commit:** `74d250e feat: summarize valuation preset version deltas`
- **下一阶段:** Stage 2/6 IMPROVE，继续把预设版本复盘推进到更强的可恢复/可操作闭环。

### Stage 2/6 IMPROVE — Restore Historical Preset Library

- **承接方向:** 在阶段 1 的预设库差异摘要基础上，补齐历史预设库的可恢复操作。
- **旗舰:** 版本对比区现在可一键“恢复 Vx 预设库”，只替换 presets，不覆盖当前估值假设，恢复后进入草稿历史并提示保存新版本。
- **真实问题修复:** 之前取回旧预设必须载入整个历史版本，容易覆盖用户当前估值调整；现在预设库可单独恢复。
- **验证:** 先写失败测试；844 tests passed；lint passed；functions typecheck passed；build passed；`git diff --check` passed。
- **浏览器验证:** Playwright + `wrangler pages dev dist --port 43179` 验证恢复 V4 预设库、toast、预设库一致状态、桌面和 800px 无横向溢出。仅有登录前既有 `/api/session` 401。
- **截图证据:** `C:\Users\12031\AppData\Local\Temp\cstd-alpha-round61-stage2-restore-presets-desktop.png`；`C:\Users\12031\AppData\Local\Temp\cstd-alpha-round61-stage2-restore-presets-800.png`。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28221495431`)。
- **Commit:** `227a5d9 feat: restore historical valuation preset libraries`
- **下一阶段:** Stage 3/6 UIUX，围绕版本对比操作区做更清晰的视觉层级、按钮布局和响应式体验。

### Stage 3/6 UIUX — Version Restore Action Panel

- **承接方向:** 在阶段 2 的“恢复历史预设库”操作基础上，降低用户误解恢复范围的风险。
- **旗舰:** 版本对比区新增“选择恢复范围”操作面板，明确只恢复预设库不会覆盖当前估值假设，载入整版会替换草稿。
- **体验修复:** 原来两个按钮缺少上下文，用户难以判断“恢复预设库”和“载入历史版本”的风险边界；现在说明和按钮成为一个完整操作组。
- **验证:** 新增操作提示状态测试；845 tests passed；lint passed；functions typecheck passed；build passed；`git diff --check` passed。
- **浏览器验证:** Playwright + `wrangler pages dev dist --port 43179` 验证面板文案、按钮存在、桌面/800px 无横向溢出，800px 按钮高度均为 44px。仅有登录前既有 `/api/session` 401。
- **截图证据:** `C:\Users\12031\AppData\Local\Temp\cstd-alpha-round61-stage3-version-action-panel-desktop.png`；`C:\Users\12031\AppData\Local\Temp\cstd-alpha-round61-stage3-version-action-panel-800.png`。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28221969458`)；`Build Radar Evidence` run `28230639906` passed。
- **Commit:** `619b86a feat: clarify valuation version restore actions`
- **下一阶段:** Stage 4/6 IMPROVE，继续扩展预设复盘闭环，优先考虑保存前/恢复后的预设变更审计说明。

### Stage 4/6 IMPROVE — Restored Preset Source Audit Trail

- **承接方向:** 在阶段 2/3 的历史预设库恢复操作基础上，把恢复来源带入保存前审计摘要。
- **旗舰:** 新增 `restoredPresetLibrary` 草稿元数据；恢复历史预设库时记录来源版本和恢复时间；自动决策说明显示 `恢复 V4 预设库。`
- **真实问题修复:** 只恢复历史预设库后，保存新版本前能看到预设库来源，避免版本历史只记录关键假设变化而丢失恢复动作上下文。
- **验证:** 先写失败测试；846 tests passed；lint passed；functions typecheck passed；build passed；`git diff --check` passed。
- **浏览器验证:** Playwright + `wrangler pages dev dist --port 43179` 验证点击 `恢复 V4 预设库` 后自动审计说明和 toast 可见；1365px 与 800px 均无横向溢出。
- **截图证据:** `C:\Users\12031\AppData\Local\Temp\cstd-alpha-round61-stage4-preset-source-desktop.png`；`C:\Users\12031\AppData\Local\Temp\cstd-alpha-round61-stage4-preset-source-800.png`。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28233190992`)。
- **Commit:** `efdeaa2 feat: audit restored valuation preset sources`
- **下一阶段:** Stage 5/6 CHECK，检查恢复来源在后续预设库编辑中的一致性与 stale source 风险。

### Stage 5/6 CHECK — Restored Preset Source Lifecycle

- **检查方向:** 验证阶段 4 的 `restoredPresetLibrary` 是否会在后续预设库编辑后残留，避免保存审计备注误导。
- **发现并修复:** 新建预设后旧恢复来源仍然存在；新增 `clearRestoredPresetLibrarySource`，在新建、重命名、删除预设和生成内置模板时清理来源。
- **真实问题修复:** 预设库被二次编辑后，自动备注不再继续显示 `恢复 V4 预设库。`，只在预设库仍完整来自历史版本时保留来源说明。
- **验证:** 先写失败测试；847 tests passed；lint passed；functions typecheck passed；build passed；`git diff --check` passed。
- **浏览器验证:** Playwright + `wrangler pages dev dist --port 43179` 先恢复 V4，再生成内置模板；确认旧来源备注消失、模板生成 toast 和预设库变更提示可见；1365px 与 800px 均无横向溢出。
- **截图证据:** `C:\Users\12031\AppData\Local\Temp\cstd-alpha-round61-stage5-clear-stale-source-desktop.png`；`C:\Users\12031\AppData\Local\Temp\cstd-alpha-round61-stage5-clear-stale-source-800.png`。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28234090775`)。
- **Commit:** `203a746 fix: clear stale valuation preset source audits`
- **下一阶段:** Stage 6/6 IMPROVE，在恢复来源生命周期上增加更清晰的保存前状态表达。

### Stage 6/6 IMPROVE — Restored Preset Source Save Strip

- **承接方向:** 在第 5 阶段修复来源生命周期后，把“当前预设库是否仍来自历史版本”做成保存区的显式状态。
- **旗舰:** 新增 `describeRestoredPresetLibrarySource`；保存状态条在来源有效时显示 `预设库来源 V4` 和来源说明，来源被后续预设编辑清理后提示自动消失。
- **真实问题修复:** 用户不再只能通过自动备注框判断恢复来源；保存前状态区直接显示来源是否仍有效。
- **验证:** 先写失败测试；848 tests passed；lint passed；functions typecheck passed；build passed；`git diff --check` passed。
- **浏览器验证:** Playwright + `wrangler pages dev dist --port 43179` 恢复 V4 后确认来源块可见，再生成内置模板确认来源块和自动来源备注消失；1365px 与 800px 均无横向溢出。
- **截图证据:** `C:\Users\12031\AppData\Local\Temp\cstd-alpha-round61-stage6-source-chip-desktop.png`；`C:\Users\12031\AppData\Local\Temp\cstd-alpha-round61-stage6-source-chip-cleared-800.png`。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28234536344`)。
- **Commit:** `de162e1 feat: show restored valuation preset sources`

### Round 61 Final

- **状态:** 6/6 completed。
- **功能 commits:** `74d250e`, `227a5d9`, `619b86a`, `efdeaa2`, `203a746`, `de162e1`。
- **最终验证:** 848 tests passed；lint passed；functions typecheck passed；build passed；`git diff --check` passed；本地 Playwright 覆盖恢复来源显示和清理后的 1365px/800px 布局。
- **CI:** 所有阶段功能 commit 与日志 commit 的 `Deploy Cloudflare Pages` runs 均 passed。

## Round 60 — 2026-06-26 (Long Cycle: IMPROVE → IMPROVE → UIUX → IMPROVE → CHECK → IMPROVE)

### Stage 1/6 IMPROVE — Valuation Preset Management

- **承接方向:** 接续 Round 59 的预设库能力，先处理“预设无法整理/删除”的真实工作流缺口。
- **旗舰:** 量化估值预设卡片现在提供独立的“载入 / 重命名 / 删除”操作；重命名为内联编辑，删除有确认并可通过撤销历史恢复草稿。
- **真实问题修复:** 之前用户一旦生成或保存错误预设，只能继续保留在草稿里；现在可重命名修正，也可删除过期方案。
- **验证:** 先写失败测试；836 tests passed；lint passed；functions typecheck passed；build passed；`git diff --check` passed。
- **浏览器验证:** Playwright + `wrangler pages dev dist --port 43175` 验证生成模板、重命名“谨慎下修”、删除“谨慎复核 QA”、桌面和 800px 无横向溢出；800px 操作按钮最小高度 44px。仅有登录前既有 `/api/session` 401。
- **截图证据:** `C:\Users\12031\AppData\Local\Temp\cstd-alpha-round60-stage1-preset-management-desktop.png`；`C:\Users\12031\AppData\Local\Temp\cstd-alpha-round60-stage1-preset-management-800.png`。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28217985652`)。
- **Commit:** `96b6597 feat: manage valuation presets`
- **下一阶段:** Stage 2/6 IMPROVE，为预设库管理增加更明确的保存/未保存提示，避免用户误以为重命名或删除已经持久化到历史版本。

### Stage 2/6 IMPROVE — Preset Library Save Awareness

- **承接方向:** 延续阶段 1 的预设管理能力，补齐“整理预设后是否已经保存”的关键反馈。
- **旗舰:** 新增预设库差异摘要，生成/重命名/删除/更新预设后，面板显示“预设库变更待保存”，保存条显示“准备保存预设库变更”及变更明细。
- **真实问题修复:** 之前 preset-only 变更不会改变假设值，保存条仍像普通审计快照，用户容易误以为预设整理已经持久化；现在保存闭环明确覆盖预设库。
- **验证:** 先写失败测试；838 tests passed；lint passed；functions typecheck passed；build passed；`git diff --check` passed。
- **浏览器验证:** Playwright + `wrangler pages dev dist --port 43175` 验证删除模板后显示“预设库变更待保存”和“准备保存预设库变更”；桌面/800px 均无横向溢出。仅有登录前既有 `/api/session` 401。
- **截图证据:** `C:\Users\12031\AppData\Local\Temp\cstd-alpha-round60-stage2-preset-unsaved-desktop.png`；`C:\Users\12031\AppData\Local\Temp\cstd-alpha-round60-stage2-preset-unsaved-800.png`。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28218283357`)。
- **Commit:** `1007e51 feat: flag unsaved valuation preset changes`
- **下一阶段:** Stage 3/6 UIUX，围绕预设库、保存条、版本区做更清晰的信息层级和响应式整合。

### Stage 3/6 UIUX — Valuation Action Center

- **承接方向:** 把阶段 1-2 的预设管理和待保存反馈整合成一个更成熟的估值工作流界面。
- **旗舰:** 新增“估值行动中心”，用说明/预设/保存三步状态条统领版本备注、保存状态和预设库，用户第一眼能看到当前保存闭环走到哪一步。
- **配套体验:** 去掉内部重复卡片边框，减少堆叠感；1100px 以下行动区和保存条单列；900px 以下流程步骤单列并保持触控高度；步骤 tooltip 保留完整状态说明。
- **验证:** 新增 `describeQuantitativeWorkflowSteps` 测试；839 tests passed；lint passed；functions typecheck passed；build passed；`git diff --check` passed。
- **浏览器验证:** Playwright + `wrangler pages dev dist --port 43176` 验证桌面/1100px/800px 行动中心无横向溢出，800px 步骤最小高度 52px。仅有登录前既有 `/api/session` 401。
- **截图证据:** `C:\Users\12031\AppData\Local\Temp\cstd-alpha-round60-stage3-action-center-desktop.png`；`C:\Users\12031\AppData\Local\Temp\cstd-alpha-round60-stage3-action-center-1100.png`；`C:\Users\12031\AppData\Local\Temp\cstd-alpha-round60-stage3-action-center-800.png`。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28218883995`)。
- **Commit:** `b378f99 feat: add valuation action center`
- **下一阶段:** Stage 4/6 IMPROVE，继续补齐估值版本可追溯能力，优先考虑保存后版本历史中展示预设库变更摘要。

### Stage 4/6 IMPROVE — Version Preset Provenance

- **承接方向:** 在行动中心和预设保存提示之后，补齐历史版本中的预设库追溯。
- **旗舰:** 版本时间线现在显示每个版本携带的预设数量，版本对比区显示所选版本的预设库摘要和代表性方案名。
- **真实问题修复:** 之前用户保存预设库后，历史版本只能看到决策备注和假设差异，无法判断该版本当时有没有预设上下文。
- **验证:** 新增版本预设摘要测试；840 tests passed；lint passed；functions typecheck passed；build passed；`git diff --check` passed。
- **浏览器验证:** Playwright + `wrangler pages dev dist --port 43177` 验证时间线预设 pill、版本对比预设摘要、桌面和 800px 无横向溢出。仅有登录前既有 `/api/session` 401。
- **截图证据:** `C:\Users\12031\AppData\Local\Temp\cstd-alpha-round60-stage4-version-preset-summary-desktop.png`；`C:\Users\12031\AppData\Local\Temp\cstd-alpha-round60-stage4-version-preset-summary-800.png`。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28219172524`)。
- **Commit:** `3e5c92c feat: show valuation version preset provenance`
- **下一阶段:** Stage 5/6 CHECK，验证保存 API 返回的版本历史是否真实携带 presets 快照，并修复发现的真实问题。

### Stage 5/6 CHECK — Valuation Preset API Invariants

- **承接方向:** 检查阶段 1-4 打通的预设保存和版本追溯链路，优先保证后端快照不会返回前端无法稳定处理的 preset key。
- **检查发现:** 保存 API 会清洗 `presets`，但没有对规范化后的 preset id 去重；重复 id 可进入 `draft_json`，导致版本预设计数、React key、重命名/删除操作都存在歧义。
- **真实问题修复:** 后端预设归一化现在同一 id 只保留最新一条，再截取最近 12 个预设，保存后的版本快照保持唯一 preset id。
- **验证:** 先写失败测试复现重复 id；定向 8 tests passed；全量 841 tests passed；lint passed；functions typecheck passed；build passed；`git diff --check` passed。
- **下一阶段:** Stage 6/6 IMPROVE，基于保存 API 的唯一性约束继续增强前端保存后的确认反馈。

### Stage 6/6 IMPROVE — Preset Save Confirmation

- **承接方向:** 在后端保证 preset id 唯一之后，把保存后的预设快照状态反馈到用户可见层。
- **旗舰:** 保存成功 toast 现在基于服务端返回的最新 draft 显示“携带 N 个预设 / 未携带预设”，确认当前版本是否真的保存了预设库。
- **真实问题修复:** 之前保存提示只说明版本已保存，无法确认预设库是否随版本进入历史；现在保存动作、版本预设追溯和 API 去重约束形成闭环。
- **验证:** 先写失败测试；842 tests passed；lint passed；functions typecheck passed；build passed；`git diff --check` passed。
- **浏览器验证:** Playwright + `wrangler pages dev dist --port 43178` 验证生成 3 个内置模板后保存，新 toast 显示 `估值版本已保存，携带 3 个预设。`，桌面/800px 均无横向溢出。仅有登录前既有 `/api/session` 401。
- **截图证据:** `C:\Users\12031\AppData\Local\Temp\cstd-alpha-round60-stage6-save-toast-desktop.png`；`C:\Users\12031\AppData\Local\Temp\cstd-alpha-round60-stage6-save-toast-800.png`。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28219832841`)。
- **Commit:** `b940b39 feat: confirm saved valuation preset count`

## Round 59 — 2026-06-26 (Long Cycle: IMPROVE → IMPROVE → UIUX → IMPROVE → CHECK → IMPROVE)

### Stage 1/6 IMPROVE — Reusable Valuation Scenario Presets

- **承接方向:** 直接承接 Round 58 的下一轮旗舰建议，为量化估值增加可保存、可命名、可复用的情景预设。
- **旗舰:** 用户可把当前手动锁定的关键假设保存为命名预设，并在工作区内一键载入；预设随版本保存进入 `draft_json`，后续版本可继续复用。
- **真实问题修复:** 服务端保存链路原本只接收 assumption edits，无法保留用户在工作区沉淀的方案状态；现在保存时会归一化并持久化预设。
- **验证:** 先写失败测试；828 tests passed；lint passed；functions typecheck passed；build passed；Browser 验证桌面创建/载入预设、无横向溢出和无 console error；800px 验证预设面板单列、按钮 44px、`scrollWidth=clientWidth`。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28205255004`)。
- **Commit:** `56cd3ef feat: add reusable valuation scenario presets`
- **下一阶段:** Stage 2/6 IMPROVE，围绕预设做更强的对比摘要、当前草稿差异提示和误载入防护。

### Stage 2/6 IMPROVE — Valuation Preset Impact Preview

- **承接方向:** 在阶段 1 的可复用预设基础上，补齐载入前的影响判断，避免用户盲点预设。
- **旗舰:** 每个预设卡现在显示载入后会调整几项关键假设、基准估值变化金额和百分比；当预设已经等于当前草稿时自动标为“已是当前假设组合”并禁用。
- **真实问题修复:** 原预设卡只能显示名称和假设数量，无法判断载入后会改变什么，也容易重复载入当前组合。
- **验证:** 先写失败测试；830 tests passed；lint passed；functions typecheck passed；build passed；Browser 验证桌面当前组合禁用、影响摘要可见、无 console error；800px `scrollWidth=clientWidth=785`。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28205591523`)。
- **Commit:** `ce9c797 feat: show valuation preset impact before applying`
- **下一阶段:** Stage 3/6 UIUX，将预设、保存、决策区整合成更清晰的工作流视觉层级。

### Stage 3/6 UIUX — Valuation Preset Library Status

- **承接方向:** 在阶段 2 的预设影响摘要上，补齐预设库的整体状态，让用户先看到可载入、当前匹配和总方案数量。
- **旗舰:** 新增 `describeQuantitativePresetLibrary` UI 状态契约；预设区域升级为“情景预设库”，在创建表单中显示“当前匹配/可载入”摘要和方案数量。
- **体验修复:** 原预设区域只能逐卡查看状态，无法快速判断当前草稿是否已有匹配方案；现在顶部摘要直接给出全局判断，减少误点和重复保存。
- **验证:** 先写失败测试；831 tests passed；lint passed；functions typecheck passed；build passed；`git diff --check` passed。Browser 插件出现 CDP 超时后，按总控要求 fallback 到 Playwright。
- **浏览器验证:** Playwright + `wrangler pages dev dist --port 43174`；桌面创建“阶段三预设库”后摘要为 `1 个当前匹配方案 / 1 个方案 · 0 个可载入 · 1 个当前匹配`，`scrollWidth=clientWidth=1365`；800px 下摘要保留、创建区单列、保存按钮 44px、`scrollWidth=clientWidth=800`。仅有登录前既有 `/api/session` 401。
- **截图证据:** `C:\Users\12031\AppData\Local\Temp\cstd-alpha-round59-stage3-desktop.png`；`C:\Users\12031\AppData\Local\Temp\cstd-alpha-round59-stage3-800.png`。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28206550454`)。
- **Commit:** `8d4d5f3 feat: upgrade valuation preset library UX`
- **下一阶段:** Stage 4/6 IMPROVE，继续围绕预设库做更主动的方案模板/初始化能力。

### Stage 4/6 IMPROVE — Built-In Valuation Starter Templates

- **承接方向:** 在预设库状态摘要完成后，避免空库需要用户从零创建方案，提供可一键生成的内置模板。
- **旗舰:** 新增 `buildQuantitativeStarterPresets`，基于当前草稿生成“基准复核 / 谨慎下修 / 压力测试”三套预设；工作区新增“生成内置模板”入口，生成后继续复用影响摘要和一键载入链路。
- **真实问题修复:** 新用户此前必须先手动改参数再命名保存，才能得到基准、谨慎、压力测试等常见方案；现在可以先生成模板，再按影响摘要选择应用。
- **验证:** 先写失败测试；832 tests passed；lint passed；functions typecheck passed；build passed；`git diff --check` passed。
- **浏览器验证:** Playwright 验证桌面生成 3 个模板，摘要为 `3 个方案 · 2 个可载入 · 1 个当前匹配`；载入“压力测试”后收入增速变为 `6.175`；桌面 `scrollWidth=clientWidth=1365`，800px `scrollWidth=clientWidth=800`，模板按钮 44px。仅有登录前既有 `/api/session` 401。
- **截图证据:** `C:\Users\12031\AppData\Local\Temp\cstd-alpha-round59-stage4-starters-desktop.png`；`C:\Users\12031\AppData\Local\Temp\cstd-alpha-round59-stage4-starters-800.png`。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28208795705`)。
- **Commit:** `cd22474 feat: add valuation starter preset templates`
- **下一阶段:** Stage 5/6 CHECK，做针对性健康检查并修复量化估值保存链路中的真实缺陷。

### Stage 5/6 CHECK — Yearly Forecast Override Persistence

- **检查方向:** 聚焦量化估值保存链路中最容易丢数据的高级年度假设编辑，验证前端传入 `forecastYear` 后服务端是否保存到计算输入。
- **发现问题:** `mergeUserAssumptions` 只遍历已有 assumptions；当用户新增年度覆盖项时，后端会丢弃该 edit，也不会写入 `operating.forecastOverrides`。
- **修复:** 缺失的年度假设会从基础假设克隆并锁定为 user edit；`revenueGrowth / ebitMargin / capexRate / workingCapitalRate` 年度覆盖会同步合并进 `forecastOverrides`。
- **验证:** 先写失败测试；833 tests passed；lint passed；functions typecheck passed；build passed；`git diff --check` passed。
- **API 验证:** 本地 Pages API POST 年度 EBIT 率覆盖后，新版本 `58949bed-a03d-4723-b81d-d73af83def74` 的 draft 包含 `forecastOverrides[{year:2, ebitMargin:0.2}]` 和锁定的年度假设。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28209077808`)。
- **Commit:** `8b11c67 fix: persist yearly valuation forecast overrides`
- **下一阶段:** Stage 6/6 IMPROVE，在 CHECK 修复后继续增强年度覆盖的用户可见确认。

### Stage 6/6 IMPROVE — Yearly Override Save Summary

- **承接方向:** 接住 CHECK 阶段修复，把“年度覆盖会被保存”变成用户保存前可见的确认信息。
- **旗舰:** 新增 `describeYearlyOverrideSummary`；保存状态条增加“逐年覆写”摘要，显示年度覆盖数量和前几项明细。
- **真实问题修复:** 后端已能持久化年度覆盖，但用户保存前仍只能看到普通关键假设备注；现在保存按钮旁直接显示例如 `1 项逐年覆写 / 第 2 年 EBIT 利润率 20%`。
- **验证:** 先写失败测试；834 tests passed；lint passed；functions typecheck passed；build passed；`git diff --check` passed。
- **浏览器验证:** Playwright 验证保存条显示年度覆盖摘要；桌面 `scrollWidth=clientWidth=1365`，800px `scrollWidth=clientWidth=800`，保存按钮 44px。仅有登录前既有 `/api/session` 401。
- **截图证据:** `C:\Users\12031\AppData\Local\Temp\cstd-alpha-round59-stage6-yearly-summary-desktop.png`；`C:\Users\12031\AppData\Local\Temp\cstd-alpha-round59-stage6-yearly-summary-800.png`。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28210407049`)。
- **Commit:** `384d56b feat: summarize yearly valuation overrides before saving`
- **最终状态:** 6/6 阶段完成；全部功能 commit 推送到 `origin/main` 且对应 Pages CI 通过。

## Round 58 — 2026-06-26 (Short Sprint: IMPROVE → UIUX)

### Stage 1/2 IMPROVE — Actionable DCF Sensitivity Matrix

- **承接方向:** 在版本备注和保存状态闭环后，继续把量化估值从“可复盘”推进到“可直接辅助决策”。
- **旗舰:** 静态敏感性表升级为可选矩阵；用户可查看组合估值与相对市价结果，并一键写入基准 WACC / 永续增长率，自动进入撤销和版本审计链。
- **真实问题修复:** 修复敏感性百分比写回时出现 `3.5000000000000004` 的浮点展示噪音。
- **验证:** 822 tests passed；lint passed；functions typecheck passed；build passed；桌面和 800px 验证 9 个矩阵点、应用、撤销、2 项保存变更和无横向溢出。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28201143665`)。
- **Commit:** `4a3f054 feat: make valuation sensitivity matrix actionable`
- **下一阶段:** UIUX 专项重构即时估值结果区和敏感性矩阵的视觉层级、选中反馈、触控与中等宽度体验。

### Stage 2/2 UIUX — Valuation Decision Cockpit

- **旗舰:** 即时结果区升级为全宽决策台，直接给出基准相对市价的上行/下行结论、保守/乐观边界、当前价格、基准价值和估值区间。
- **配套体验:** 图表与三情景卡片形成稳定阅读路径；矩阵默认定位当前基准，区分当前/待应用；每个点显示估值和上/下行；重复应用被禁用。
- **响应式与可访问性:** 900px 下结果单列；应用按钮 44px、矩阵单元格 48px；800px `scrollWidth=clientWidth=800`，完整保留 9 个组合和可见 selected 状态。
- **验证:** 824 tests passed；lint passed；functions typecheck passed；build passed；Playwright 验证桌面和 800px 关键交互与控制台健康。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28203811079`)。
- **Commit:** `18453c3 feat: upgrade valuation decision cockpit UX`
- **下一轮旗舰建议:** 为量化估值增加可保存的情景预设/命名方案，支持在“基准、谨慎、压力测试”等方案之间快速切换和比较。

## Round 57 — 2026-06-26 (Short Sprint: IMPROVE → UIUX)

### Stage 1/2 IMPROVE — Valuation Version Decision Notes

- **承接方向:** 延续 Round 56 的 A 股量化估值版本审计链，补齐“保存版本时记录变更原因/决策备注并在历史中可追溯”。
- **旗舰:** 保存新版本时新增“本次版本说明”；留空会自动写入关键假设变化摘要，版本时间线和对比区直接展示备注。
- **真实问题修复:** 原版本历史只能说明数值变了，无法说明为什么调整；现在保存动作带有可复盘的决策语境。
- **验证:** 817 tests passed；lint passed；functions typecheck passed；build passed；Pages dev + browser/Playwright 验证桌面保存备注和 800px 无横向溢出。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28195320241`)。
- **Commit:** `83bb621 feat: add valuation version decision notes`
- **下一阶段:** UIUX 专项升级量化估值工作区的信息层级、响应式布局和保存/历史状态体验。

## Round 56 — 2026-06-26 (Six-Stage Reinforcement Cycle)

### Stage 1/6 IMPROVE — Quantitative Valuation Version Review

- **承接方向:** 延续 A 股量化估值的可编辑、可审计版本链，不再增加低价值统计卡。
- **旗舰:** 版本时间线升级为可选择的草稿对比工作流，展示三情景估值差异、百分比和关键假设变化，并可将旧版本载入为新草稿。
- **真实问题修复:** 首次编辑现在可撤回初始值；三情景柱状图改用稳定像素高度，修复柱体塌缩和标签重叠。
- **浏览器验收:** 本地 Pages 下验证 V2 vs V1 差异、编辑实时重算、首次撤销、载入 V1；桌面和 800px 无横向溢出或相关控制台错误。
- **下一阶段:** 保存版本时记录变更原因/决策备注，并在版本历史中可追溯。

## Round 55 — 2026-06-22 (Production Hotfix: Tencent Market-Cap Units)

- **触发:** 线上贵州茅台真实估值生成后，总股本被计算为 `1.25e-7 亿股`，导致每股估值异常放大。
- **修复:** 腾讯行情市值字段按“亿元”转换为 CNY 元；量化基线同时兼容无单位标记的旧腾讯证据包。
- **回归:** 使用真实形态的旧腾讯行情数据，验证总股本归一到约 `12.5 亿股`。

## Round 54 — 2026-06-22 (Production Hotfix: Large Evidence Snapshots)

- **触发:** 线上 A 股估值真实回归发现 `SQLITE_TOOBIG`；完整公司证据包不能直接写入 D1 快照字段。
- **修复:** 快照改为只保存估值所需的公司标识、年度财务行、行情、来源哈希与警告；原始证据继续留在既有证据存储链路。
- **回归:** 新增 3 MB 原始正文的回归用例，断言 D1 快照小于 200 KB 且不会保存原始 `evidence` 正文。
- **验证:** 72 个 Vitest 文件、802 个测试通过；ESLint、Functions TypeScript、生产构建和 `git diff --check` 通过。

## Round 53 — 2026-06-22 (A 股量化估值工作区)

- **范围:** 为已加入研究队列的 A 股经营型公司生成来源快照与五年 FCFF DCF 自动基线；银行、保险和周期股继续使用现有专用估值卡。
- **可编辑预测:** 保守/基准/乐观三情景、九项关键驱动、五年逐年覆写、WACC/永续增长硬校验与浏览器即时确定性重算。
- **审计链:** 数据快照、不可变预测版本、用户锁定优先级、计算哈希、敏感性矩阵，以及财报刷新后的预测/实际误差复盘。
- **完整流程:** 创建任务 → 自动基线 V1 → 手动编辑并即时重算 → 保存后继 V2（保留 V1）→ 刷新证据 → 写入实际值复盘。
- **自动验证:** 72 个 Vitest 文件、801 个测试通过；ESLint、Functions TypeScript、生产构建和 `git diff --check` 通过。
- **浏览器验收:** 本地 Pages 登录态下验证工作区加载、非法 WACC 禁止保存、修改收入增速后基准每股价值由 CNY 829.94 即时更新为 CNY 858.28、保存 V2 并保留 V1、高级五年表展开；控制台无错误。内置浏览器截图与 390px 视口覆盖本次不可用，移动端视觉截图未作为通过项。

## Round 52 — 2026-06-20 (Short Sprint: IMPROVE → UIUX)

### Stage 1/2 IMPROVE — Research Readiness Indicators
- **承接方向:** 研究队列最近几轮已完成筛选重置、助手预填充、移动触摸优化；本阶段继续强化研究工作台的卡片决策反馈。
- **旗舰:** 研究就绪度：卡片和详情页统一显示百分比、状态标签（待补齐/可推进/就绪）和缺口下一步。
- **真实问题修复:** 修复中断改动里的重复内联百分比计算和 `.agent/orchestrator-state.json` 的 `},,` 语法问题。
- **验证:** `npm ci` clean install passed；769 tests passed；lint passed；functions typecheck passed；build passed。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `27855753035`)。
- **Commit:** `b84d33a feat: add research readiness indicators to workbench cards`

### Stage 2/2 UIUX — Research Detail Stage Progress
- **承接方向:** 研究详情页已有就绪度提示；本阶段把“当前阶段、下一站、资产缺口”做成详情首屏的连续反馈。
- **旗舰:** 阶段进度条 + 阶段路径 + 研究资产检查清单，用户可直接看到 `阶段 1/5`、下一站和论点/证据/来源状态。
- **真实问题修复:** 将阶段进度抽成 `describeResearchStageProgress` 并用测试锁定阶段顺序、百分比和最终态。
- **验证:** 770 tests passed；lint passed；functions typecheck passed；build passed；Pages dev + Playwright verified desktop and 800px responsive layout.
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `27856500579`)。
- **Commit:** `f0c6f69 feat: upgrade research detail stage UX`

### Stage 2/2 UIUX — Quantitative Valuation Save Workflow
- **承接方向:** 阶段 1 已让版本历史可记录决策备注；本阶段把保存前的状态、备注预览和阻塞原因前置到同一个工作流。
- **旗舰:** `describeQuantitativeSaveGuidance` + 保存状态条，显示 `准备保存新版本`、变更数量、手动/自动备注预览，并把主保存按钮放到版本说明下方。
- **真实问题修复:** 用户保存前不再需要从顶部按钮、备注框和警告列表之间来回确认；参数错误、保存中、无变化快照都有可测状态。
- **验证:** 先写失败测试；821 tests passed；lint passed；functions typecheck passed；build passed；`git diff --check` passed。
- **浏览器验收:** `wrangler pages dev dist --port 43174`；Playwright 验证桌面与 800px 视口保存状态条联动，800px `scrollWidth=clientWidth=800`，保存按钮 44px，无新增相关 console error。
- **截图证据:** `C:\Users\12031\AppData\Local\Temp\cstd-alpha-stage2\valuation-save-strip-desktop.png`；`C:\Users\12031\AppData\Local\Temp\cstd-alpha-stage2\valuation-save-strip-tablet800.png`。
- **CI:** ✅ passed (`Deploy Cloudflare Pages`, run `28196231187`)。
- **Commit:** `3fe1e8f feat: improve valuation save workflow UX`

## Round 51 — 2026-06-19 (Triple Loop: 18 Phases Completed)

**循环模式:** 三循环超级版 Agent 总控执行模式 (18 phases total)
**状态:** ✅ COMPLETED

### Cycle 1 (Phases 1-6)
- **Phase 1 IMPROVE:** 暗色模式设计令牌审计 - sentiment/stage/assistant 颜色统一
- **Phase 2 IMPROVE:** 筛选器和批量操作栏视觉升级
- **Phase 3 IMPROVE:** 暗色模式剩余硬编码颜色统一 (11处)
- **Phase 4 UIUX:** 移动端触摸目标和可访问性升级 (32-44px)
- **Phase 5 IMPROVE:** 暗色模式视觉巡检完成 (15+ hardcoded colors)
- **Phase 6 IMPROVE:** 研究卡片进度指示器

### Cycle 2 (Phases 7-12)
- **Phase 7 IMPROVE:** 键盘快捷键系统 (Ctrl+Arrow, Escape, Enter, Ctrl+A)
- **Phase 8 IMPROVE:** 筛选状态持久化 (localStorage)
- **Phase 9 UIUX:** 机会仪表板视觉体验升级
- **Phase 10 IMPROVE:** 报告页面操作按钮升级
- **Phase 11 CHECK:** 全项目健康检查 (764 tests passed)
- **Phase 12 IMPROVE:** 助手输入栏升级 (44px touch targets)

### Cycle 3 (Phases 13-18)
- **Phase 13 IMPROVE:** 估值实验室摘要升级
- **Phase 14 IMPROVE:** 排行榜工具和分页升级
- **Phase 15 UIUX:** 移动端底部导航升级 (44px, active states)
- **Phase 16 IMPROVE:** Toast 通知系统升级 (icons, backdrop-filter)
- **Phase 17 CHECK:** 全项目健康检查 (764 tests passed)
- **Phase 18 IMPROVE:** 主题切换控件升级

### 累计成果
- **Commits:** 18 个独立 commit
- **All pushed to main:** ✅
- **All CI passed:** ✅
- **Tests:** 764 tests passed
- **TypeScript:** passed
- **Build:** passed

---

## Round 50 — 2026-06-18 (Cycle Loop: IMPROVE-IMPROVE-UIUX-IMPROVE-CHECK-IMPROVE)

**循环模式:** 单循环自动执行总控模式

### Stage 1/6 IMPROVE — Drag-and-Drop Enhancement
- **旗舰:** 研究工作台拖拽位置指示器 (before/after/inside) + 键盘可访问排序 (Alt+↑↓ 排序, Alt+←→ 移动阶段)
- **验证:** 764 tests passed, lint clean, build passed, CI passed
- **Commit:** `feat: enhance research queue drag-and-drop with position indicators and keyboard reorder`

### Stage 2/6 IMPROVE — Dark Mode Token Unification
- **旗舰:** 将 8 处硬编码颜色替换为 CSS 变量，新增 `--info-soft` 令牌
- **验证:** 764 tests passed, lint clean, build passed, CI passed
- **Commit:** `feat: unify dark mode design tokens for status badges and risk indicators`

### Stage 3/6 UIUX — Research Queue UX Upgrade
- **旗舰:** 阶段看板滚动条美化、卡片 hover 微动效、移动端批量操作栏触控优化、空状态视觉升级
- **验证:** lint clean, build passed, CI passed
- **Commit:** `feat: upgrade research queue UX with scroll indicators, card hover states, and mobile batch bar`

### Stage 4/6 IMPROVE — Research Detail Panel Polish
- **旗舰:** 详情面板视觉层级优化、阶段操作按钮组交互反馈、论点/催化剂区块样式统一
- **验证:** lint clean, build passed, CI passed
- **Commit:** `feat: refine research detail panel visual hierarchy and stage action feedback`

### Stage 5/6 CHECK — System Health Check
- **检查:** 764 tests passed, TypeScript passed, build passed
- **发现:** RadarVisualCharts.tsx 有预存 ESLint parser 错误（非本次改动引入）
- **结论:** 无新增 P0/P1 问题

### Stage 6/6 IMPROVE — Metrics Bar & Hero Polish
- **旗舰:** 指标栏 hover 交互反馈、Hero 区域字间距优化
- **验证:** build passed, CI passed
- **Commit:** `feat: polish research metrics bar and workbench hero typography`

---

## Round 62 — 2026-06-26 (6 Stage Main V2, completed)

### Stage 1/6 IMPROVE — Persist Restored Preset Sources
- **旗舰:** `restoredPresetLibrary` 从前端草稿进入保存 API 和版本 `draft_json`，手写备注不会再覆盖结构化来源审计。
- **验证:** 851 tests passed；lint passed；functions typecheck passed；build passed；browser/API verified on `qa-valuation-stage3` V6；CI run `28238460530` passed。
- **Commit:** `cc2661d feat: persist restored valuation preset sources`

### Stage 2/6 IMPROVE — Show Persisted Preset Sources
- **旗舰:** 历史版本时间线和对比区显示 `预设来源 Vx` 与来源说明，让隐藏 draft 字段变成可复盘信息。
- **验证:** 852 tests passed；lint passed；functions typecheck passed；build passed；browser verified timeline/comparison source display；CI run `28238930120` passed。
- **Commit:** `e1e46ec feat: show persisted valuation preset sources`

### Stage 3/6 UIUX — Version Review Summary Strip
- **旗舰:** `describeQuantitativeVersionReviewSummary` + 四项摘要条，将关键假设、预设库、来源、备注聚合到版本对比顶部。
- **验证:** 先写失败测试；853 tests passed；lint passed；functions typecheck passed；build passed；Playwright verified desktop/800px no overflow and zero console errors；CI run `28239666887` passed。
- **Commit:** `98cfc9d feat: summarize valuation version reviews`

### Stage 4/6 IMPROVE — Source-backed Version Filter
- **旗舰:** 历史版本时间线新增 `仅看来源版本`，一键定位由历史预设库恢复后保存的版本，并同步对比面板。
- **验证:** 先写失败测试；854 tests passed；lint passed；functions typecheck passed；build passed；Playwright verified 6→1 source filter, desktop/800px no overflow and zero console errors；CI run `28298188048` passed。
- **Commit:** `e9003c1 feat: filter valuation versions by preset source`

### Stage 5/6 CHECK — Invalid Source Guard
- **修复:** 展示层忽略 `version <= 0`、`NaN` 或无效 `restoredAt` 的历史来源，避免出现 `预设来源 V0/V-1/VNaN` 并污染来源筛选。
- **验证:** 先写失败测试；854 tests passed；lint passed；functions typecheck passed；build passed；Playwright verified valid V4 source still displays；CI run `28298394625` passed。
- **Commit:** `a1a7bc8 fix: ignore invalid valuation preset sources`

### Stage 6/6 IMPROVE — Source Timestamp Audit
- **旗舰:** 来源说明新增 UTC 恢复时间，历史版本不只显示 `预设来源 Vx`，还显示恢复发生时间。
- **验证:** 先写失败测试；854 tests passed；lint passed；functions typecheck passed；build passed；Playwright verified source timestamp, desktop/800px no overflow and zero console errors；CI run `28298594792` passed。
- **Commit:** `42c18d1 feat: show valuation preset source timestamps`

### Final Closure
- **状态:** 6/6 completed；六个功能 commits 与各阶段日志 commits 已推送至 `main`，阶段 CI 全部通过。
- **最终门禁:** 74 test files / 854 tests passed；lint、functions typecheck、build、diff check passed。
- **生产验收:** `alpha.custard.top` 与 `cstd-alpha.pages.dev` 均 HTTP 200；Playwright 确认两条入口的登录界面可见且结构完整。
- **遗留:** 既有 pyodide externalization / chunk-size warnings；旧版本无结构化来源时按设计不参与来源筛选；无效历史来源仅隐藏、未迁移；时间按 UTC 展示。

## Round 63 — 2026-06-28 (6 Stage Main V2, in progress)

### Stage 3/6 UIUX — Authenticated Workspace Loading Feedback
- **旗舰:** 10 个 authenticated views 使用视图特定加载标题、说明和三项检查点；`Suspense` fallback 提供 `role=status` / `aria-live=polite`，桌面三列、移动端单列，并保持稳定最小高度。
- **真实问题修复:** 替换通用 hero 级 `正在加载` 空状态；移动端管理员自动进入助理时显示正确模块信息；`prefers-reduced-motion` 下停止加载动画。
- **验证:** TDD 两轮红绿；81 files / 864 tests passed；lint、functions typecheck、build、dev/prod audit、diff check passed；构建无 warning。
- **浏览器验收:** 内置 Browser 验证登录壳桌面/移动端；Playwright 延迟真实动态分块，验证桌面今日机会、移动端研究助理，均无 console issue、failed request 或横向溢出。
- **生产:** 三条 Pages/自定义域入口 HTTP 200 且使用 `index-B5KzBXur.js`；生产加载态与 CSP/HSTS 验证通过；CI run `28306117860` passed。
- **Commit:** `c757a69 feat: improve lazy workspace loading feedback`

### Stage 4/6 IMPROVE — Stale Chunk Recovery
- **旗舰:** 入口安装 `vite:preloadError` 恢复监听器，旧部署动态 chunk 失效时自动刷新一次并用 `sessionStorage` 防止 30 秒内刷新循环。
- **真实问题修复:** 解决 Pages 部署切换后用户仍持有旧入口/旧分块引用时可能卡在坏页的问题；storage 不可用或刷新后仍失败时不吞掉错误。
- **验证:** TDD 红绿；`src/preload-recovery.test.ts` 5 tests passed；82 files / 869 tests passed；lint、functions typecheck、build、dev/prod audit、diff check passed。
- **浏览器验收:** 本地 Pages 预览和生产入口触发合成 `vite:preloadError`：首次 `defaultPrevented=true` 且 reload，第二次在恢复窗口内不 reload；干净线上加载无 console issue 或 failed request。
- **生产:** Pages deployment `eaf03ac9-1c86-4594-ab10-bea436ac3d6a` source `3588ed8`；`alpha.custard.top` 和部署域均使用 `index-CqMzFA_0.js`；CI run `28307103541` passed。
- **Commit:** `3588ed8 fix: recover from stale preload chunks`

### Stage 5/6 CHECK — Browser Storage Fallbacks
- **检查:** 复核 workflow、提交历史、依赖锁、生产部署和敏感信息；未发现 P0/P1 或真实 secret。
- **真实问题修复:** 主题初始化和 PWA 安装提示不再直接信任 `window.localStorage`；浏览器禁用/拦截本地存储时降级为无持久化，不影响登录页渲染或 `beforeinstallprompt` 处理。
- **验证:** TDD 红绿；83 files / 873 tests passed；lint、functions typecheck、build、dev/prod audit、diff check passed；`npm ci` 在停止本仓库本地 Pages 预览后通过。
- **浏览器验收:** 本地与生产移动端注入 `window.localStorage` getter 抛 `SecurityError`，登录页正常、`/api/session` 200 envelope、`beforeinstallprompt.defaultPrevented=true`、无 console issue / failed request / 横向溢出。
- **生产:** Pages deployment `25c0fb2f-7fea-4a23-bd87-824909c02536` source `6867e49`；`alpha.custard.top` 和部署域均使用 `index-DhsoxLAL.js`；CI run `28311421691` passed。
- **Commit:** `6867e49 fix: harden browser storage fallbacks`

### Stage 6/6 IMPROVE — Safe Recent Search Persistence
- **旗舰:** 新增 recent-search storage adapter；安全读取、去重、8 项限长、写入降级和可用性探针统一处理，并在登录壳/工作区显示本地缓存状态。
- **真实问题修复:** 成功公司搜索不再因 `localStorage.setItem` 抛错而转成失败；持久化不可用时，最近搜索仍保留在当前页面并向用户明确说明限制。
- **验证:** TDD 红绿；84 files / 877 tests passed；lint、functions typecheck、build、dev/prod audit、staged diff check passed；Vite build 无 warning。
- **浏览器验收:** 内置 Browser 验证线上页面身份、非空 DOM、console health 和主题交互；Playwright 在 desktop 1280×800 / mobile 390×844、两条生产入口注入 storage `SecurityError`，唯一降级提示可见，无 console/page/request issue 或横向溢出。
- **生产:** Pages deployment `824fdb85-83f3-4ab2-9768-a40a4b2a819e` source `564577b`；自定义域和部署域均使用 `index-CWX3gczo.js`；CI run `28312771084` passed。
- **Commit:** `564577b feat: surface browser cache fallback`

### Final Closure
- **状态:** 6/6 completed；7 个功能 commits 与前五阶段日志 commits 已推送至 `main`，对应阶段 CI 全部通过。
- **最终门禁:** `npm ci`、84 test files / 877 tests、lint、functions typecheck、build、开发/生产 audit、diff check 全部通过。
- **生产验收:** `alpha.custard.top` 与最新部署域 HTTP 200；桌面/移动端页面、API、CSP、动态分块恢复和受限存储降级均验证通过。
- **遗留:** storage 被禁用时本地偏好/缓存不会跨页；CSP `style-src` 仍保留 `'unsafe-inline'`；npm allow-scripts 待未来依赖治理单独审批。
- **下一建议:** 将剩余可选浏览器存储消费者逐步统一到同一 adapter，并增加带实际 Pages 认证测试夹具的登录后搜索端到端用例。

## Round 64 — 2026-06-28 (6 Stage Main V2, in progress)

### Stage 1/6 IMPROVE — Local Cache Persistence Checks
- **承接方向:** 延续 Round 63 的 storage 降级主线，把剩余本地缓存消费者逐步统一到安全 adapter。
- **旗舰:** 新增通用 `browser-storage` helper，并让报告缓存、图表缓存、最近报告和导入榜单缓存使用同一套安全读取/写入/探针。
- **真实问题修复:** 本地缓存降级提示现在覆盖“导入榜单”，不会再只提示最近搜索和报告缓存。
- **验证:** TDD 红绿；85 files / 885 tests passed；lint、functions typecheck、build、diff check passed；`npm ci` 0 vulnerabilities。
- **CI:** `Deploy Cloudflare Pages` run `28320091168` passed。
- **Commit:** `82b5a01 feat: unify local cache persistence checks`
- **下一阶段:** 统一研究工作台筛选和排序持久化，继续收口剩余 storage 直接访问。

### Stage 2/6 IMPROVE — Research Workspace Preferences
- **承接方向:** 继续收口剩余直接 `localStorage` 访问，把研究工作台筛选、排序、视图和卡片顺序迁移到安全 adapter。
- **旗舰:** 新增 `research-workspace-preferences` adapter；搜索、阶段、论点、排序、活动时间、视图模式和 item order 统一安全读取/保存，并验证活动时间和紧凑视图可跨刷新恢复。
- **真实问题修复:** 无效 storage 值不会污染受控 select；损坏 item order 不会触发 `.map/.includes` 崩溃；只改排序或活动时间时也会出现“重置所有筛选”入口。
- **验证:** TDD 红绿；86 files / 891 tests passed；lint、functions typecheck、build、开发/生产 audit、diff check 全部通过；`npm ci` 0 vulnerabilities。
- **浏览器验收:** Playwright + Edge + 本地 Pages 8793 登录本地 QA，验证 4 个筛选控件、`week` 日期偏好刷新恢复、紧凑视图 active、重置后恢复 `all`，无 console issue。
- **CI:** `Deploy Cloudflare Pages` run `28321385076` passed。
- **Commit:** `708793a feat: persist research workspace preferences`
- **下一阶段:** Stage 3/6 UIUX，优化研究队列筛选/视图状态的可见反馈和移动端操作密度。

### Stage 3/6 UIUX — Research Filter Summary Strip
- **承接方向:** 在阶段 2 持久化筛选、排序和视图偏好后，补齐用户可见的当前队列条件反馈。
- **旗舰:** 新增 `describeResearchWorkspacePreferenceSummary`，并在研究队列控制台显示可见数量、活动条件数，以及搜索/阶段/论点/时间/排序/视图 chips。
- **真实问题修复:** 用户不再需要逐个回看 select 和视图按钮来判断当前队列为什么过滤成当前结果；排序也会以 active chip 形式和重置行为对齐。
- **验证:** TDD 红绿；86 files / 893 tests passed；lint、functions typecheck、build、开发/生产 audit、diff check 全部通过；`npm ci` 0 vulnerabilities。
- **浏览器验收:** Playwright + Edge + 本地 Pages 8794 登录本地 QA；1365px 与 800px 验证摘要条、active chips、800px chip 34px、`scrollWidth=clientWidth`，无 console issue。
- **CI:** `Deploy Cloudflare Pages` run `28363267568` passed。
- **Commit:** `522828c feat: summarize research workspace filters`
- **下一阶段:** Stage 4/6 IMPROVE，继续收口剩余本地偏好或研究工作台真实稳定性问题。

### Stage 4/6 IMPROVE — My Research Cache Persistence
- **承接方向:** 继续统一 storage 降级链路，将“我的研究”的最近模板和新闻缓存迁移到安全 adapter。
- **旗舰:** 新增 `my-research-storage` adapter；最近模板规范化、去重和限长，新闻缓存 key/load/save 统一处理；全局提示覆盖最近模板与新闻缓存。
- **真实问题修复:** storage getter、损坏 JSON 或 quota 失败不再中断“我的研究”，页面明确展示缓存仅当前页有效。
- **验证:** TDD 红绿；87 files / 897 tests passed；lint、functions typecheck、build、开发/生产 audit、diff check 全部通过；`npm ci` 0 vulnerabilities。
- **浏览器验收:** Playwright + Edge + 本地 Pages 8795 在 storage getter 抛 `SecurityError` 时登录并打开模板研究；页面、降级提示、1365px 无溢出和 console health 均正常。
- **CI:** `Deploy Cloudflare Pages` run `28364546258` passed。
- **Commit:** `da31ffb fix: harden my research cache persistence`
- **下一阶段:** Stage 5/6 CHECK，系统检查剩余 storage 消费者及研究状态一致性。

### Stage 5/6 CHECK — Storage-Blocked Research Flow Audit
- **检查:** 复核 workflow、依赖、lockfile、secret patterns、剩余 storage 使用点、preload recovery 和 MyResearch 最近模板状态流；P0 none。
- **真实问题修复:** `sessionStorage` getter 被拦截时不再阻止应用启动；最近模板由父组件控制，生成后当前页立即显示、清除后 UI 和 storage 同步；recent searches、theme、PWA install prompt 收敛到统一 `browser-storage` helper。
- **验证:** TDD 红绿；87 files / 899 tests passed；lint、functions typecheck、build、开发/生产 audit、secret scan、diff check 全部通过；`npm ci` 0 vulnerabilities。
- **浏览器验收:** 内置 Browser 验证本地 Pages 页面身份、非空 DOM、console health 和 Research -> MyResearch；Playwright fallback 验证移动端 storage-blocked 启动无溢出、桌面最近模板生成中即时显示/清除、无 console/page/request issue。
- **CI:** `Deploy Cloudflare Pages` run `28366164962` passed。
- **Commit:** `d7c5c40 fix: stabilize storage-blocked research flows`
- **下一阶段:** Stage 6/6 IMPROVE，做最后一轮产品稳定性增量并完成生产收口。

### Stage 6/6 IMPROVE — Visible Preload Recovery
- **承接方向:** 完成 storage-blocked / stale chunk 恢复链路，让旧分块失败在受限浏览器里也能恢复并给用户明确反馈。
- **旗舰:** preload recovery 增加 `history.state` guard 与内存 fallback；App 检测最近恢复后展示“已刷新到最新版”toast，loading/auth/app 三种状态都能承载全局提示。
- **真实问题修复:** 禁用 `sessionStorage` 时旧 chunk 失败不再只能放行错误；未登录页不会吞掉恢复提示；移动端 toast 不遮挡主题控件、不横向溢出。
- **验证:** TDD 红绿；87 files / 900 tests passed；lint、functions typecheck、build、开发/生产 audit、secret scan、diff check 全部通过；`npm ci` 0 vulnerabilities。
- **浏览器验收:** 内置 Browser 验证本地 Pages 页面身份、非空 DOM 和 console health；Playwright fallback 验证桌面 storage-blocked preload recovery reload/toast/TTL guard，移动端 390px toast 可见、无 console/page/request issue 或横向溢出。
- **生产:** Pages deployment `39e15152-2144-4961-bae5-d180f78be8b7` source `522311b`；`alpha.custard.top`、`/api/session` 和直连部署域均 HTTP 200；CI run `28369161211` passed。
- **Commit:** `522311b feat: surface preload recovery status`

### Round 64 Final Closure
- **状态:** 6/6 completed；功能 commits `82b5a01`、`708793a`、`522828c`、`da31ffb`、`d7c5c40`、`522311b` 均已推送至 `main`，对应阶段 CI 全部通过。
- **最终门禁:** `npm ci`、87 files / 900 tests、lint、functions typecheck、build、开发/生产 audit、secret scan、diff check 全部通过。
- **生产验收:** Cloudflare Pages 最新 production source `522311b`；自定义域、API envelope、直连部署域均 200；桌面/移动端 storage-blocked preload recovery 体验已验证。
- **遗留:** storage 被禁用时本地偏好/缓存不跨页面；history/storage 都不可写时恢复无法安全防循环；CSP `unsafe-inline` 与 npm allow-scripts 审批留作后续治理。
- **下一建议:** 下一轮优先建设真实 Pages 认证夹具下的登录后 E2E，覆盖搜索、加入自选、模板研究和线上恢复提示。

## Round 65 — 2026-06-30 (6 Stage Main V2, in progress)

### Stage 1/6 IMPROVE — Watchlist Upsert Feedback And Research Handoff
- **承接方向:** 落实真实登录后核心流程验收，先修复搜索、生成报告、加入自选和进入“我的研究”之间的状态断点。
- **旗舰:** 自选股 POST 现在返回 `created/updated` 状态，报告页区分新加入与已存在公司，并在成功后直接提供“查看研究”入口。
- **真实问题修复:** 旧记录 ID 与当前确定性 ID 不一致时，upsert 后不再按错误 ID 读回空值；从“我的研究”或排行榜打开公司时不再错误显示未加入自选。
- **验证:** TDD 红绿；定向 4 files / 41 tests passed；lint、functions typecheck、build、diff check passed；CI 全量 89 files / 904 tests passed。
- **浏览器验收:** 本地 Pages 登录夹具完整走通搜索贵州茅台、生成报告、重复加入自选、识别“已加入自选”、显示同步提示、点击“查看研究”并在列表找到公司；无 console/page/request issue。
- **生产:** Pages deployment `2cc17496.cstd-alpha.pages.dev`；CI run `28389155914` passed。
- **Commit:** `f5d6524 fix: clarify watchlist upsert flows`
- **下一阶段:** Stage 2/6 IMPROVE，补齐从搜索/报告直接进入时的既有自选状态校验，避免重复操作后才发现已存在。
