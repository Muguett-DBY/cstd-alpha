import type { CompanyCandidate } from "./shared/report";
import type { ResearchWorkbenchItem } from "./shared/research-workbench";

export type ResearchQuickAddCandidate = CompanyCandidate & {
  existingItemId?: string;
};

export function decorateResearchQuickAddCandidates(
  candidates: CompanyCandidate[],
  items: ResearchWorkbenchItem[],
): ResearchQuickAddCandidate[] {
  const existingByEntity = new Map(
    items
      .filter((item) => item.entityType === "company")
      .map((item) => [item.entityId.trim().toLowerCase(), item.id]),
  );
  return candidates.map((candidate) => ({
    ...candidate,
    ...(existingByEntity.get(candidate.id.trim().toLowerCase())
      ? { existingItemId: existingByEntity.get(candidate.id.trim().toLowerCase()) }
      : {}),
  }));
}

export function upsertResearchWorkspaceItem(
  items: ResearchWorkbenchItem[],
  item: ResearchWorkbenchItem,
): ResearchWorkbenchItem[] {
  const index = items.findIndex((entry) => entry.id === item.id);
  if (index < 0) return [item, ...items];
  return items.map((entry) => entry.id === item.id ? item : entry);
}
