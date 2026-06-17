# CSTD Alpha - Iteration Log

## Round 24 — 2026-06-18

**旗舰级主改动:** 公司报告对比视图

**完成内容:**
- 报告页新增"保存对比"按钮
- 点击保存当前报告为对比基准
- 再次点击另一个报告的"保存对比"按钮，显示对比视图
- 对比视图并排显示两个公司的：公司名/CQS/IAS/结论/估值判断/建议仓位/投资期限
- 点击已保存的报告可取消对比
- 对比视图使用 teal 边框和背景色区分
- CSS 新增 .report-comparison、.comparison-grid、.comparison-metric 样式

**用户可见增量:**
- 报告页支持两个公司报告的并排对比
- 用户可以直观看到两个公司在关键指标上的差异
- 投资决策支持：直接对比 CQS/IAS/结论

**验证:**
- npm test: 756 passed ✅
- npm run lint: 0 errors ✅
- npm run build: 成功 ✅
- git push origin main: 成功 ✅

**遗留风险:**
- 对比状态不持久化（刷新后丢失）
- 只支持 2 个报告对比，不支持多报告对比
- 对比视图是简单的并排网格，没有差异高亮

**下一轮方向:**
1. App.tsx 拆分 — 将 RadarView 等内联组件抽离为独立文件
2. D1 登录记录自动清理 — 定期清理过期 login_attempts
3. 对比视图增强 — 差异高亮、多报告支持、持久化

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
