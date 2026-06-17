# CSTD Alpha - Iteration Log

## Round 19 — 2026-06-18

**旗舰级主改动:** 研究工作台最近动态面板

**完成内容:**
- 在研究工作台右侧面板新增"最近动态"面板
- 显示选中研究项的最新论文状态、催化剂确认、估值进度、证据采集
- 彩色圆点区分不同类型的动态（teal=论文, green=确认, blue=估值, amber=证据, gray=创建）
- 使用 relativeTime 显示相对时间

**用户可见增量:**
- 研究工作台右侧面板新增实时动态信息
- 用户选中研究项即可看到"论文已生成"、"催化剂已确认"、"估值已完成"等状态

**验证:**
- npm test: 756 passed ✅
- npm run lint: 0 errors ✅
- npm run build: 成功 ✅
- git push origin main: 成功 ✅

**遗留风险:**
- 动态面板依赖 selected 项的数据，未选中项不显示动态
- catalysts 只加载了选中项的数据，跨项动态未显示

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
