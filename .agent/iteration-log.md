# CSTD Alpha - Iteration Log

## Round 25 — 2026-06-18

**旗舰级主改动:** 市场工作台内容升级

**完成内容:**
- 市场工作台从 5 按钮导航页升级为有实质内容的工作台
- 新增"市场概览"卡片：显示最近雷达扫描的行业统计数据
  - 扫描行业总数、扎实增长数、泡沫风险数、衰退数
  - 增长=teal, 泡沫=amber, 衰退=red 颜色编码
- 新增"自选股排行前列"卡片：显示综合评分最高的 5 只自选股
  - 显示排名、公司名、代码、市场、综合分
- 保留原有的 5 个导航按钮
- 使用 Promise.allSettled 并行加载，任一失败不影响另一个

**用户可见增量:**
- 市场工作台不再只是按钮索引页，有了实质数据内容
- 用户打开市场 tab 即可看到雷达行业统计和自选股排行
- 5 个 tab 全部有实质内容，产品不再有明显空白区域

**验证:**
- npm test: 756 passed ✅
- npm run lint: 0 errors ✅
- npm run build: 成功 ✅
- git push origin main: 成功 ✅

**遗留风险:**
- 雷达数据和排行数据依赖 API 调用，网络失败时显示空内容
- 无加载状态（数据加载中时显示空白）

**下一轮方向:**
1. App.tsx 拆分 — 将 RadarView 等内联组件抽离为独立文件
2. D1 登录记录自动清理 — 定期清理过期 login_attempts
3. 对比视图增强 — 差异高亮、持久化

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
