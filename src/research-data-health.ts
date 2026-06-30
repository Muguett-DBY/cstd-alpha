export type ResearchQueueRecoveryInput = {
  items?: unknown[];
  skippedItems?: number;
  totalItems?: number;
};

export type ResearchQueueRecoveryNotice = {
  title: string;
  body: string;
  actionLabel: string;
};

export function describeResearchQueueRecovery(input: ResearchQueueRecoveryInput): ResearchQueueRecoveryNotice | null {
  const skippedItems = Number.isFinite(input.skippedItems) ? Math.max(0, Math.trunc(input.skippedItems ?? 0)) : 0;
  if (skippedItems <= 0) return null;

  const fallbackTotal = skippedItems + (Array.isArray(input.items) ? input.items.length : 0);
  const totalItems = Number.isFinite(input.totalItems) ? Math.max(skippedItems, Math.trunc(input.totalItems ?? fallbackTotal)) : fallbackTotal;
  const retainedItems = Math.max(0, totalItems - skippedItems);

  return {
    title: "研究队列已自动跳过异常记录",
    body: `本次读取跳过 ${skippedItems} 条无法显示的记录，已保留 ${retainedItems} 条可用记录。刷新或检查数据源后会自动恢复。`,
    actionLabel: "重新读取",
  };
}
