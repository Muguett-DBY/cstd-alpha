# CSTD Alpha - Iteration Log

## Round 30 — 2026-06-18

**承接上一轮方向:** R29 建议 App.tsx 拆分、D1 清理、研究工作台导出功能

**本轮完成:**
- 研究工作台导出 CSV：批量操作栏新增"导出 CSV"按钮
- 导出当前筛选后的研究项列表为 CSV 文件
- CSV 包含：名称、实体类型、副标题、阶段、来源、论点、证据、创建/更新时间
- UTF-8 BOM 编码确保中文在 Excel 中正确显示
- 文件名包含日期：研究队列_YYYY-MM-DD.csv
- Toast 显示导出成功

**验证:**
- npm test: 756 passed ✅
- npm run lint: 0 errors ✅
- npm run build: 成功 ✅
- git push origin main: 成功 ✅

**遗留风险:**
- App.tsx 仍有 2500+ 行，RadarView 拆分是下一轮重点
- CSV 导出不包含论点内容（仅元数据）

**下一轮方向:**
1. App.tsx 拆分 — 将 RadarView (~1200行) 抽离为独立文件
2. D1 登录记录自动清理 — 增加定时清理机制
3. 研究工作台增强 — 添加研究项拖拽排序

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
| R30 | CSV Export | 研究工作台 CSV 导出 |
