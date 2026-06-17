# CSTD Alpha - Iteration Log

## Round 23 — 2026-06-18

**旗舰级主改动:** 实时公司搜索建议

**完成内容:**
- 公司搜索输入框新增实时搜索建议下拉菜单
- 300ms 防抖搜索，输入 2+ 字符后自动触发
- 最多显示 8 个建议项，每项显示公司名/代码/上市地
- 点击建议项直接选中公司，无需弹窗确认
- 下拉菜单有圆角边框、阴影和悬停效果
- 输入框聚焦时显示建议，失焦 200ms 后隐藏

**用户可见增量:**
- 搜索从"输入→提交→等待→弹窗选择"4步变为"输入→点击建议"2步
- 搜索体验更快速、更现代，像 Google 搜索一样即时反馈
- 产品感觉更专业、更成熟

**验证:**
- npm test: 756 passed ✅
- npm run lint: 0 errors ✅
- npm run build: 成功 ✅
- git push origin main: 成功 ✅

**遗留风险:**
- 搜索建议依赖后端 API，网络慢时有延迟
- 建议项没有键盘导航（上下箭头选择）

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
| R22 | Collapsible Report Sections | 财务表+风险矩阵可折叠 |
| R23 | Live Search Suggestions | 公司搜索实时建议下拉 |
