# CSTD Alpha - Iteration Log

## Round 22 — 2026-06-18

**旗舰级主改动:** 报告视图可折叠区块扩展

**完成内容:**
- 十年财务数据表改为 `<details>`/`<summary>` 可折叠，默认展开
- 风险清单与反证条件改为 `<details>`/`<summary>` 可折叠，默认折叠
- 新增 `.wide-section summary` 样式适配 details/summary 结构
- 修复 RiskSection JSX 标签不匹配问题

**用户可见增量:**
- 报告的财务表格和风险矩阵现在可以折叠/展开
- 风险矩阵默认折叠，减少报告初始滚动距离
- 与 R18 的可折叠评分卡片保持一致的 UX 模式

**验证:**
- npm test: 756 passed ✅
- npm run lint: 0 errors ✅
- npm run build: 成功 ✅
- git push origin main: 成功 ✅

**遗留风险:**
- 风险矩阵默认折叠，用户可能错过重要风险信息
- `wide-section` 的 `details`/`summary` 样式需要与 `score-item-card` 保持一致

**下一轮方向:**
1. App.tsx 拆分 — 将 RadarView 等内联组件抽离为独立文件
2. D1 登录记录自动清理 — 定期清理过期 login_attempts
3. 报告比较功能 — 对比两个公司报告的差异

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
