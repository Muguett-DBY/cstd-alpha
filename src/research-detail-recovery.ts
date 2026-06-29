export type ResearchDetailRecoverySection = "thesis" | "catalysts" | "activity";

export type ResearchDetailRecoveryCopy = {
  title: string;
  body: string;
  actionLabel: string;
};

export function describeResearchDetailRecovery(section: ResearchDetailRecoverySection): ResearchDetailRecoveryCopy {
  if (section === "thesis") {
    return {
      title: "论点读取失败",
      body: "当前研究项的论点暂时无法读取，已保留其他研究信息。",
      actionLabel: "重试读取论点",
    };
  }
  if (section === "catalysts") {
    return {
      title: "跟踪项读取失败",
      body: "催化剂和反证清单暂时无法读取，阶段与论点仍可继续查看。",
      actionLabel: "重试读取跟踪项",
    };
  }
  return {
    title: "动态读取失败",
    body: "最近动态暂时无法读取，已保留本地可推断的时间线。",
    actionLabel: "重试读取动态",
  };
}
