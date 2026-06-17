# CSTD Alpha - Iteration Log

## Round 20 — 2026-06-18

**旗舰级主改动:** 研究工作台指标概览条

**完成内容:**
- 研究工作台顶部新增指标概览条，显示 5 项关键指标
- 研究项总数、进行中数量、已生成论点数、已完成估值数、7天内更新数
- 绿色色调背景，视觉上与看板区域区分
- 无研究项时不显示指标条

**用户可见增量:**
- 打开研究工作台即可看到组合全貌，无需切换到其他视图
- 一眼了解：有多少研究项、多少有论点、多少已完成估值

**验证:**
- npm test: 756 passed ✅
- npm run lint: 0 errors ✅
- npm run build: 成功 ✅
- git push origin main: 成功 ✅

**遗留风险:**
- 指标条依赖已加载的数据（items + valuationRuns），不包含未加载项
- 7天更新时间使用 mount 时的快照，不会随时间变化

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
