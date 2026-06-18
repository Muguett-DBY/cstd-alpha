# CSTD Alpha - Iteration Log

## Round 39 — 2026-06-18

**承接上一轮方向:** R38 建议研究工作台跨阶段拖拽（需要后端 API 支持 sort_order 字段）

**本轮决策:**
- 跨阶段拖拽是 R38 留下的核心未完成项，需要全栈改动
- 后端：新增 sort_order 列 + reorder API + 更新查询排序
- 前端：移除 "同阶段限制"，支持跨阶段拖放并同步到后端
- 额外：研究队列移动端响应式优化（720px 以下单列布局）

**完成内容:**
- Migration 0014：research_items 新增 sort_order 列 + 索引
- 后端：listResearchItems 改为按 sort_order ASC 排序
- 后端：confirmResearchStage 支持可选 sortOrder 参数
- 后端：新增 reorderResearchItems 批量排序函数
- 后端：新增 /api/research-items/reorder 批量排序端点
- 前端：updateResearchItemStage 支持 sortOrder 参数
- 前端：新增 reorderResearchItems API 函数
- 前端：handleDrop 支持跨阶段拖放，实时更新本地状态 + 异步同步后端
- CSS：研究队列 720px 以下单列布局 + 筛选栏纵向排列

**验证:**
- npm test: 757 passed ✅
- npm run build: 成功 ✅
- git push origin main: 成功 ✅
- GitHub Actions: ✅ 全部通过

**遗留风险:**
- App.tsx 仍有 1343 行，可继续拆分
- 跨阶段拖放依赖乐观更新，后端失败时前端状态可能不一致

**下一轮方向:**
1. 继续 App.tsx 进一步拆分（如 ReportView 提取）
2. 研究工作台批量操作增强（批量拖拽、批量删除）
3. 研究工作台搜索结果高亮

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
