# CSTD Alpha - Iteration Log

## Round 26 — 2026-06-18

**旗舰级主改动:** 研究工作台快速添加研究项

**完成内容:**
- 研究工作台筛选栏下方新增"快速添加"搜索区
- 输入公司名称或代码，300ms 防抖搜索，显示最多 6 个建议
- 点击建议项直接添加到研究队列（screening 阶段）
- 添加后自动刷新队列、选中新项、清空搜索、显示 toast
- 使用 addResearchItem API，无需切换到其他视图

**用户可见增量:**
- 研究工作台无需切换视图即可添加新研究项
- 从"输入→搜索→点击添加"全流程在工作区内完成
- 工作流更顺畅：研究工作台成为一站式研究中心

**验证:**
- npm test: 756 passed ✅
- npm run lint: 0 errors ✅
- npm run build: 成功 ✅
- git push origin main: 成功 ✅

**遗留风险:**
- 快速添加只支持公司类型，不支持行业类型
- 搜索建议依赖后端 API，网络慢时有延迟
- 添加后无 loading 指示器（仅 toast 反馈）

**下一轮方向:**
1. App.tsx 拆分 — 将 RadarView 等内联组件抽离为独立文件
2. D1 登录记录自动清理 — 定期清理过期 login_attempts
3. 研究工作台批量操作 — 多选研究项进行批量阶段变更

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
