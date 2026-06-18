export type ResearchQueueOrderItem = {
  id: string;
  stage: string;
};

export type ResearchQueueOrderUpdate = {
  id: string;
  stage: string;
  sortOrder: number;
};

type MoveResult = {
  nextOrder: Record<string, string[]>;
  updates: ResearchQueueOrderUpdate[];
  sourceStage: string;
  targetStage: string;
};

type MoveParams = {
  items: ResearchQueueOrderItem[];
  itemOrder: Record<string, string[]>;
  sourceId: string;
  targetStage: string;
};

type MoveBeforeTargetParams = MoveParams & {
  targetId: string;
};

function stageOrderIds(items: ResearchQueueOrderItem[], itemOrder: Record<string, string[]>, stage: string) {
  const stageIds = items.filter((item) => item.stage === stage).map((item) => item.id);
  const knownStageIds = new Set(stageIds);
  const ordered = (itemOrder[stage] ?? []).filter((id) => knownStageIds.has(id));
  const missing = stageIds.filter((id) => !ordered.includes(id));
  return [...ordered, ...missing];
}

function buildUpdates(sourceStage: string, targetStage: string, sourceId: string, sourceOrder: string[], targetOrder: string[]): ResearchQueueOrderUpdate[] {
  const updates: ResearchQueueOrderUpdate[] = [];
  const updatedIds = new Set<string>();
  if (sourceStage !== targetStage) {
    updates.push({ id: sourceId, stage: targetStage, sortOrder: targetOrder.indexOf(sourceId) });
    updatedIds.add(sourceId);
    sourceOrder.forEach((id, index) => {
      updates.push({ id, stage: sourceStage, sortOrder: index });
      updatedIds.add(id);
    });
  }
  targetOrder.forEach((id, index) => {
    if (!updatedIds.has(id)) updates.push({ id, stage: targetStage, sortOrder: index });
  });
  return updates;
}

export function moveResearchItemBeforeTarget({ items, itemOrder, sourceId, targetId, targetStage }: MoveBeforeTargetParams): MoveResult | null {
  if (!sourceId || sourceId === targetId) return null;

  const sourceItem = items.find((item) => item.id === sourceId);
  const targetItem = items.find((item) => item.id === targetId);
  if (!sourceItem || !targetItem) return null;

  const sourceStage = sourceItem.stage;
  const sourceOrder = stageOrderIds(items, itemOrder, sourceStage);
  const targetOrder = sourceStage === targetStage ? sourceOrder : stageOrderIds(items, itemOrder, targetStage);
  if (!targetOrder.includes(targetId)) return null;

  const nextSourceOrder = sourceOrder.filter((id) => id !== sourceId);
  const nextTargetOrder = sourceStage === targetStage
    ? nextSourceOrder
    : targetOrder.filter((id) => id !== sourceId);
  nextTargetOrder.splice(nextTargetOrder.indexOf(targetId), 0, sourceId);

  return {
    nextOrder: {
      ...itemOrder,
      [sourceStage]: sourceStage === targetStage ? nextTargetOrder : nextSourceOrder,
      [targetStage]: nextTargetOrder,
    },
    updates: buildUpdates(sourceStage, targetStage, sourceId, nextSourceOrder, nextTargetOrder),
    sourceStage,
    targetStage,
  };
}

export function moveResearchItemToStageEnd({ items, itemOrder, sourceId, targetStage }: MoveParams): MoveResult | null {
  if (!sourceId) return null;

  const sourceItem = items.find((item) => item.id === sourceId);
  if (!sourceItem) return null;

  const sourceStage = sourceItem.stage;
  const sourceOrder = stageOrderIds(items, itemOrder, sourceStage);
  const targetOrder = sourceStage === targetStage ? sourceOrder : stageOrderIds(items, itemOrder, targetStage);
  if (sourceStage === targetStage && sourceOrder[sourceOrder.length - 1] === sourceId) return null;

  const nextSourceOrder = sourceOrder.filter((id) => id !== sourceId);
  const nextTargetOrder = [...(sourceStage === targetStage ? nextSourceOrder : targetOrder.filter((id) => id !== sourceId)), sourceId];

  return {
    nextOrder: {
      ...itemOrder,
      [sourceStage]: sourceStage === targetStage ? nextTargetOrder : nextSourceOrder,
      [targetStage]: nextTargetOrder,
    },
    updates: buildUpdates(sourceStage, targetStage, sourceId, nextSourceOrder, nextTargetOrder),
    sourceStage,
    targetStage,
  };
}
