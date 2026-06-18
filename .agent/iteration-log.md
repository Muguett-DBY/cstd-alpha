# CSTD Alpha - Iteration Log

## Round 37 — 2026-06-18

**承接上一轮方向:** R36 建议 App.tsx 拆分（RadarView ~1200行）作为 #1 优先方向

**本轮决策:**
- R36 再次建议 App.tsx 拆分，已连续 17 轮 deferred，本轮必须完成
- 选择 RadarView 提取作为旗舰主改动——这是 App.tsx 最大的独立模块
- App.tsx 从 2679 行降至 1343 行（-50%），显著提升可维护性

**完成内容:**
- 新建 src/RadarView.tsx（1210 行），包含全部 28 个 Radar 组件 + 辅助函数
- App.tsx 清理：移除 RadarPhase 类型定义、Radar 相关代码、未使用的 imports
- 移除 TanStack table/virtual、RadarVisualCharts、radar-ui 工具函数等不再需要的导入
- 保留 listItems 工具函数（ReportView 仍在使用）
- 保留 radarRefreshFallbackMessage（App 主流程仍在使用）

**验证:**
- npm test: 756 passed ✅
- npm run build: 成功 ✅
- git push origin main: 成功 ✅
- GitHub Actions: ✅ 全部通过

**遗留风险:**
- App.tsx 仍有 1343 行，但已从 "巨大" 降至 "中等"
- D1 登录记录自动清理、研究工作台拖拽排序仍未做

**下一轮方向:**
1. D1 登录记录自动清理 — 增加定时清理机制
2. 研究工作台拖拽排序 — 支持拖拽研究项调整顺序
3. 继续 App.tsx 进一步拆分（如 ReportView 提取）

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
