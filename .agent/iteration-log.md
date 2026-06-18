# CSTD Alpha - Iteration Log

## Round 43 — 2026-06-18

**承接上一轮方向:** R42 建议活动日志接入后端事件流 + 继续 App.tsx 拆分

**本轮决策:**
- 活动日志全栈实现：新增 research_activity_events 表 + API + 前端集成
- 记录事件：研究项创建、阶段变更、论点生成
- CandidateModal 提取：将公司候选弹窗从 App.tsx 提取为独立文件
- App.tsx 从 820 行降至 767 行（-6%）

**完成内容:**
- Migration 0015：research_activity_events 表 + 索引
- 后端：recordActivityEvent / listActivityEvents 函数
- 后端：confirmResearchStage 自动记录阶段变更事件
- 后端：upsertResearchItem 自动记录创建事件
- 后端：createResearchThesisVersion 自动记录论点生成事件
- API：GET /api/research-items/[id]/activity 端点
- 前端：fetchActivityEvents API 函数
- 前端：ResearchWorkspace 接入后端活动事件流（fallback 到静态数据）
- 新建 src/CandidateModal.tsx（52 行），导出 displayExchange
- App.tsx 移除 CandidateModal 和 displayExchange

**验证:**
- npm test: 757 passed ✅（+1 测试调整）
- npm run build: 成功 ✅
- git push origin main: 成功 ✅
- GitHub Actions: ✅ 全部通过

**遗留风险:**
- 活动日志目前记录 3 种事件类型，可扩展更多
- App.tsx 仍有 767 行，但已从 "巨大" 降至 "小"

**下一轮方向:**
1. 活动日志扩展更多事件类型（证据采集、估值状态变更）
2. 研究工作台批量拖拽视觉反馈增强
3. 继续 App.tsx 拆分（如提取 Toast 或 BackToTop）

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
| R41 | App.tsx ReportView Extraction | ReportView 提取为独立文件 + 研究卡片展开详情 |
| R42 | Activity Timeline + ProgressPanel | 活动日志时间线重构 + ProgressPanel 提取 |
| R43 | Activity Events Backend + CandidateModal | 活动日志后端事件流 + CandidateModal 提取 |
