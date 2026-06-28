export type AppViewLoadingTarget =
  | "opportunities"
  | "research"
  | "market"
  | "valuation"
  | "report"
  | "ranking"
  | "watchlist-ranking"
  | "mine"
  | "radar"
  | "assistant";

export interface AppViewLoadingDescription {
  label: string;
  title: string;
  detail: string;
  checkpoints: string[];
}

const descriptions: Record<AppViewLoadingTarget, AppViewLoadingDescription> = {
  opportunities: {
    label: "今日机会",
    title: "正在加载今日机会",
    detail: "正在同步市场机会、筛选状态和关注标的。",
    checkpoints: ["同步机会列表", "恢复筛选状态", "准备操作入口"],
  },
  research: {
    label: "研究",
    title: "正在加载研究工作台",
    detail: "正在恢复研究队列、公司材料和分析工作流。",
    checkpoints: ["同步研究队列", "恢复材料上下文", "准备研究工具"],
  },
  market: {
    label: "市场",
    title: "正在加载市场工作台",
    detail: "正在准备跨市场数据、排行和雷达入口。",
    checkpoints: ["连接市场数据", "准备排行视图", "恢复市场入口"],
  },
  valuation: {
    label: "估值",
    title: "正在加载估值工作台",
    detail: "正在准备量化估值模型、版本历史和预设库。",
    checkpoints: ["加载估值模型", "恢复版本上下文", "准备交互控件"],
  },
  report: {
    label: "报告",
    title: "正在加载公司报告",
    detail: "正在准备公司评分、证据链和图表模块。",
    checkpoints: ["恢复公司上下文", "准备评分模块", "加载图表入口"],
  },
  ranking: {
    label: "排行",
    title: "正在加载市场排行",
    detail: "正在同步市场范围、排名指标和公司入口。",
    checkpoints: ["同步排名数据", "恢复市场范围", "准备公司入口"],
  },
  "watchlist-ranking": {
    label: "自选排行",
    title: "正在加载自选排行",
    detail: "正在同步自选公司、最新评分和研究状态。",
    checkpoints: ["同步自选列表", "更新评分状态", "准备研究入口"],
  },
  mine: {
    label: "我的研究",
    title: "正在加载我的研究",
    detail: "正在恢复研究记录、收藏公司和历史报告。",
    checkpoints: ["同步研究记录", "恢复收藏公司", "准备历史报告"],
  },
  radar: {
    label: "雷达",
    title: "正在加载市场雷达",
    detail: "正在准备扫描结果、诊断状态和刷新任务。",
    checkpoints: ["恢复扫描结果", "同步任务状态", "准备诊断视图"],
  },
  assistant: {
    label: "助理",
    title: "正在加载研究助理",
    detail: "正在恢复对话、分析工具和深度研究任务。",
    checkpoints: ["恢复对话上下文", "加载分析工具", "准备研究任务"],
  },
};

export function describeAppViewLoading(view: AppViewLoadingTarget): AppViewLoadingDescription {
  return descriptions[view];
}
