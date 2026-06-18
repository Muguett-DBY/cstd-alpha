# CSTD Alpha - Iteration Log

## Round 40 — 2026-06-18

**承接上一轮方向:** R39 建议搜索结果高亮 + 批量操作增强

**本轮决策:**
- 搜索高亮：在研究队列搜索时高亮匹配的标题和子标题文字
- 批量删除：新增后端 delete API + 前端批量删除按钮（带确认弹窗）
- 两个改动都直接提升研究工作台的使用效率

**完成内容:**
- 搜索高亮：新增 highlightMatch 函数，搜索时标题和子标题匹配文字用 <mark> 高亮
- CSS：新增 .search-highlight 样式（琥珀色背景）
- 批量删除后端：deleteResearchItems 函数 + POST /api/research-items/delete 端点
- 批量删除前端：deleteResearchItems API 函数 + batchDeleteItems handler
- 批量删除 UI：批量操作栏新增红色"批量删除"按钮（带确认弹窗）
- CSS：新增 .danger-button 样式（红色边框和文字）

**验证:**
- npm test: 757 passed ✅
- npm run build: 成功 ✅
- git push origin main: 成功 ✅
- GitHub Actions: ✅ 全部通过

**遗留风险:**
- App.tsx 仍有 1343 行，可继续拆分
- 批量删除操作不可撤销，仅通过确认弹窗保护

**下一轮方向:**
1. 继续 App.tsx 进一步拆分（如 ReportView 提取）
2. 研究工作台批量操作增强（批量拖拽到新阶段）
3. 研究工作台活动日志增强

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
| R31 | Company Profile Card + Focus Trap | 报告页公司概览卡片 + 弹窗焦点修复 |
| R32 | Recent Search History | 公司搜索最近历史记录 |
| R33 | Market Hot Topics | 市场工作区今日热点 |
| R34 | Market Health Visualization | 市场健康度可视化条 |
| R35 | Project Health Check | 竞争条件修复 + 错误边界 + RadarView 拆分 |
| R36 | Financial Table Enhancement | 财务表排序/年份筛选 + 快速跳转按钮组 |
| R37 | App.tsx RadarView Extraction | RadarView 提取为独立文件，App.tsx -50% |
| R38 | D1 Login Cleanup + Drag-and-Drop | 登录清理确定性化 + 研究队列拖拽排序 |
| R39 | Cross-Stage Drag-and-Drop | 跨阶段拖拽 + sort_order 后端支持 + 移动端适配 |
| R40 | Search Highlight + Batch Delete | 搜索结果高亮 + 批量删除功能 |
