# CSTD Alpha - Iteration Log

## Round 28 — 2026-06-18

**承接上一轮方向:** R27 建议 App.tsx 拆分、D1 清理、批量论点生成

**本轮决策:**
- App.tsx 拆分范围过大（RadarView ~1200 行），单轮风险高，保留到下一轮
- 本轮选择"研究工作台键盘快捷键"作为用户可见增量
- 本轮额外修复 CSS `--line-strong` 变量未定义问题

**完成内容:**
- 研究工作台新增 Ctrl+←/→ 键盘快捷键，在研究项之间快速切换
- 研究队列头部显示键盘快捷键提示
- 修复 App.css 中 `.radar-diagnostics` 使用的 `--line-strong` CSS 变量未定义问题
- 将 `--line-strong` 定义添加到 index.css

**验证:**
- npm test: 756 passed ✅
- npm run lint: 0 errors ✅
- npm run build: 成功 ✅
- git push origin main: 成功 ✅

**遗留风险:**
- App.tsx 仍有 2500+ 行，RadarView 拆分是下一轮重点
- D1 登录记录清理仍未执行

**下一轮方向:**
1. App.tsx 拆分 — 将 RadarView (~1200行) 抽离为独立文件
2. D1 登录记录自动清理 — 定期清理过期 login_attempts
3. 研究工作台批量论点生成 — 选中多项后批量生成论点

---

## 历史迭代记录

| 轮次 | 旗舰主改动 | 关键用户增量 |
|------|-----------|-------------|
| R13 | Portfolio Health Dashboard | 首页显示研究组合健康度 |
| R14 | Rich Research Kanban Cards | 看板卡片显示论点/证据/来源/时间 |
| R15 | Valuation Integration | 研究工作台直接显示估值状态 |
| R16 | Report Section Navigation | 报告页 sticky 章节导航 + scroll spy |
| R17 | Branded Login Experience | 品牌化加载屏幕 + 渐变登录页 |
| R18 | Collapsible Score Items | 20 项评分卡片可折叠，减少 80% 滚动 |
| R19 | Activity Feed | 研究工作台最近动态面板 |
| R20 | Research Metrics Bar | 研究工作台指标概览条 |
| R21 | Research Queue Filters | 研究队列阶段/论点/排序筛选 |
| R22 | Collapsible Report Sections | 财务表+风险矩阵可折叠 |
| R23 | Live Search Suggestions | 公司搜索实时建议下拉 |
| R24 | Report Comparison | 公司报告并排对比视图 |
| R25 | Market Workspace Upgrade | 市场工作台数据内容升级 |
| R26 | Quick Add Research Item | 研究工作台快速添加研究项 |
| R27 | Batch Stage Operations | 研究队列批量阶段变更 |
| R28 | Keyboard Shortcuts + CSS Fix | 研究工作台键盘导航 + CSS 变量修复 |
