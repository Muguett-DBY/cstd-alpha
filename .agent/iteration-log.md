# CSTD Alpha - Iteration Log

## Round 29 — 2026-06-18

**承接上一轮方向:** R28 建议 App.tsx 拆分、D1 清理、批量论点生成

**本轮完成:**
- 批量论点生成：研究工作台批量操作栏新增"批量生成论点"按钮
- 选中多个研究项后点击按钮，Promise.allSettled 并行生成论点
- 显示成功/失败数量 toast，失败项自动刷新队列
- D1 登录记录清理已有实现（10% 概率清理），无需额外改动

**验证:**
- npm test: 756 passed ✅
- npm run lint: 0 errors ✅
- npm run build: 成功 ✅
- git push origin main: 成功 ✅

**遗留风险:**
- 批量论点生成是并行的，大量项可能触发 API 限流
- App.tsx 仍有 2500+ 行，RadarView 拆分是下一轮重点

**下一轮方向:**
1. App.tsx 拆分 — 将 RadarView (~1200行) 抽离为独立文件
2. D1 登录记录自动清理 — 增加定时清理机制
3. 研究工作台导出功能 — 支持导出研究队列为 CSV/JSON

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
| R29 | Batch Thesis Generation | 研究工作台批量论点生成 |
