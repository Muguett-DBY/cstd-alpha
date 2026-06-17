# CSTD Alpha - Iteration Log

## Round 21 — 2026-06-18

**旗舰级主改动:** 研究队列筛选与排序

**完成内容:**
- 研究工作台看板区域新增筛选栏（阶段、论点、排序）
- 3 个筛选下拉框：阶段筛选、论点状态筛选、排序方式
- 阶段筛选：全部/待初筛/深入研究/等待催化/已形成观点/归档
- 论点筛选：全部/已有论点/未生成
- 排序方式：最近更新/按名称/按阶段
- 筛选结果实时更新看板列数量

**用户可见增量:**
- 研究队列支持多维度筛选，管理 20+ 项更高效
- 可按阶段快速定位特定研究项
- 可按论点状态筛选"已完成"或"待生成"
- 可按更新时间排序找到最活跃的研究项

**验证:**
- npm test: 756 passed ✅
- npm run lint: 0 errors ✅
- npm run build: 成功 ✅
- git push origin main: 成功 ✅

**遗留风险:**
- 筛选器状态不持久化（刷新后重置）
- 无 URL 参数同步（无法分享筛选状态）

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
