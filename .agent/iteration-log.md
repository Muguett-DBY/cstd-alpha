# CSTD Alpha - Iteration Log

## Round 38 — 2026-06-18

**承接上一轮方向:** R37 建议 D1 登录记录自动清理 + 研究工作台拖拽排序

**本轮决策:**
- D1 登录清理：将 probabilistic cleanup (10% random) 改为 deterministic (每 20 次清理一次)，并在成功登录时也清理
- login_attempts 清理窗口从 2 分钟扩大到 10 分钟，避免旧记录堆积
- 研究工作台拖拽排序：纯前端实现（localStorage 持久化），无需后端 API 变更

**完成内容:**
- D1 登录清理：cleanupOldLoginAttempts 改为确定性触发（每 20 次失败尝试），成功登录时也清理
- 新增 shouldCleanupLoginAttempts() 函数 + 测试
- 研究工作台拖拽排序：卡片支持 drag/drop，同阶段内可拖拽调整顺序
- 拖拽顺序通过 localStorage 持久化（key: cstd_research_item_order）
- 拖拽视觉反馈：拖动中卡片半透明，目标位置显示顶部边框高亮

**验证:**
- npm test: 757 passed ✅（+1 新测试）
- npm run build: 成功 ✅
- git push origin main: 成功 ✅
- GitHub Actions: ✅ 全部通过

**遗留风险:**
- 拖拽排序仅限同阶段内，跨阶段拖拽暂不支持（需要后端 API 支持）
- App.tsx 仍有 1343 行，可继续拆分

**下一轮方向:**
1. 研究工作台跨阶段拖拽 — 需要后端 API 支持 sort_order 字段
2. 继续 App.tsx 进一步拆分（如 ReportView 提取）
3. 研究工作台移动端体验优化

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
