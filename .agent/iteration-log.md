# CSTD Alpha - Iteration Log

## Round 27 — 2026-06-18

**承接上一轮方向:** R26 建议研究工作台批量操作

**本轮完成:**
- 研究队列看板卡片新增复选框，Shift+点击切换选中状态
- 批量操作栏：显示选中数量、全选当前筛选、取消选择、批量移动阶段
- 使用 Promise.allSettled 并行处理，显示成功/失败数量
- 选中卡片使用 teal 边框高亮
- 阶段变更后自动刷新队列并清空选择

**验证:**
- npm test: 756 passed ✅
- npm run lint: 0 errors ✅
- npm run build: 成功 ✅
- git push origin main: 成功 ✅

**遗留风险:**
- 批量操作仅支持阶段变更，不支持批量删除或批量生成论点
- Shift+点击在移动端不可用（触摸设备无 shift 键）

**下一轮方向:**
1. App.tsx 拆分 — 将 RadarView 等内联组件抽离为独立文件
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
