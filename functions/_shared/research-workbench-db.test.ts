import { describe, expect, test } from "vitest";
import { claimValuationRun, createResearchThesisVersion, deleteResearchItems, updateResearchCatalystStatus, upsertResearchCatalystDrafts, upsertResearchItem } from "./research-workbench-db";

type ResearchItemTestRow = {
  id: string;
  user_key: string;
  entity_type: string;
  entity_id: string;
  title: string;
  subtitle: string | null;
  stage: string;
  status: string;
  source: string;
  evidence_hash: string | null;
  current_thesis_version_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

describe("upsertResearchItem", () => {
  test("returns the stored legacy id and updated status for an existing entity", async () => {
    const db = researchItemDb({
      id: "legacy-research-id",
      user_key: "user-1",
      entity_type: "company",
      entity_id: "eastmoney:1.600519",
      title: "旧名称",
      subtitle: "600519 / A股",
      stage: "screening",
      status: "active",
      source: "manual",
      evidence_hash: null,
      current_thesis_version_id: null,
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
      archived_at: null,
    });

    const result = await upsertResearchItem(db, {
      userKey: "user-1",
      entityType: "company",
      entityId: "eastmoney:1.600519",
      title: "贵州茅台",
      subtitle: "600519 / A股",
      source: "eastmoney",
    });

    expect(result.status).toBe("updated");
    expect(result.item).toMatchObject({ id: "legacy-research-id", title: "贵州茅台" });
  });

  test("returns created status and the new item", async () => {
    const db = researchItemDb();

    const result = await upsertResearchItem(db, {
      userKey: "user-1",
      entityType: "company",
      entityId: "eastmoney:1.600519",
      title: "贵州茅台",
      source: "eastmoney",
    });

    expect(result.status).toBe("created");
    expect(result.item).toMatchObject({ entityId: "eastmoney:1.600519", title: "贵州茅台" });
  });
});

describe("claimValuationRun", () => {
  test("claims only queued or failed runs and reports whether the atomic update won", async () => {
    const executed: string[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async run() {
                executed.push(sql);
                return { meta: { changes: sql.includes("status IN ('queued', 'failed')") ? 1 : 0 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(claimValuationRun(db, "run-1")).resolves.toBe(true);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain("status IN ('queued', 'failed')");
  });

  test("returns false when another consumer already claimed the run", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async run() {
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(claimValuationRun(db, "run-1")).resolves.toBe(false);
  });
});

describe("deleteResearchItems", () => {
  test("cascades user-scoped research item children before deleting parent rows", async () => {
    const executed: Array<{ sql: string; bindings: unknown[] }> = [];
    const db = {
      async batch(statements: Array<{ sql?: string; bindings?: unknown[] }>) {
        for (const statement of statements) executed.push({ sql: statement.sql ?? "", bindings: statement.bindings ?? [] });
        return [];
      },
      prepare(sql: string) {
        return {
          sql,
          bind(...bindings: unknown[]) {
            return {
              sql,
              bindings,
              async run() {
                executed.push({ sql, bindings });
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await deleteResearchItems(db, "user-1", ["research-1", "research-2"]);

    const deleteStatements = executed.filter(({ sql }) => sql.trim().startsWith("DELETE"));
    expect(deleteStatements.some(({ sql }) => sql.includes("valuation_model_results"))).toBe(true);
    expect(deleteStatements.some(({ sql }) => sql.includes("valuation_assumption_values"))).toBe(true);
    expect(deleteStatements.some(({ sql }) => sql.includes("valuation_actual_reviews"))).toBe(true);
    expect(deleteStatements.some(({ sql }) => sql.includes("valuation_forecast_versions"))).toBe(true);
    expect(deleteStatements.some(({ sql }) => sql.includes("valuation_source_snapshots"))).toBe(true);
    expect(deleteStatements.some(({ sql }) => sql.includes("valuation_runs"))).toBe(true);
    expect(deleteStatements.some(({ sql }) => sql.includes("research_activity_events"))).toBe(true);
    expect(deleteStatements.some(({ sql }) => sql.includes("research_thesis_versions"))).toBe(true);
    expect(deleteStatements.at(-1)?.sql).toContain("DELETE FROM research_items");
    expect(deleteStatements.every(({ bindings }) => bindings[0] === "user-1")).toBe(true);
  });
});

describe("createResearchThesisVersion", () => {
  test("stores the next version and updates the research item's current pointer", async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = [];
    const db = {
      batch: async () => [],
      prepare(sql: string) {
        return {
          bind(...bindings: unknown[]) {
            statements.push({ sql, bindings });
            return {
              async first() {
                if (sql.includes("MAX(version)")) return { next_version: 3 };
                if (sql.includes("FROM research_thesis_versions")) {
                  return {
                    id: "thesis-3",
                    user_key: "admin",
                    item_id: "research-1",
                    version: 3,
                    thesis_markdown: "# 主判断\n看好",
                    core_citations_json: '["E1"]',
                    counter_evidence_json: '["需求下滑"]',
                    evidence_hash: "hash-3",
                    created_by: "ai",
                    created_at: "2026-06-15T00:00:00.000Z",
                  };
                }
                return null;
              },
              async run() {
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const thesis = await createResearchThesisVersion(db, {
      userKey: "admin",
      itemId: "research-1",
      thesisMarkdown: "# 主判断\n看好",
      coreCitations: ["E1"],
      counterEvidence: ["需求下滑"],
      evidenceHash: "hash-3",
      createdBy: "ai",
    });

    expect(thesis.version).toBe(3);
    expect(thesis.coreCitations).toEqual(["E1"]);
    expect(statements.some(({ sql }) => sql.includes("INSERT INTO research_thesis_versions"))).toBe(true);
    expect(statements.some(({ sql }) => sql.includes("current_thesis_version_id"))).toBe(true);
  });

  test("retries a concurrent version conflict instead of losing the generated thesis", async () => {
    let batchCalls = 0;
    const db = {
      async batch() {
        batchCalls += 1;
        if (batchCalls === 2) throw new Error("UNIQUE constraint failed: research_thesis_versions.item_id, research_thesis_versions.version");
        return [];
      },
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (!sql.includes("FROM research_thesis_versions")) return null;
                return {
                  id: "thesis-retried",
                  user_key: "admin",
                  item_id: "research-1",
                  version: 4,
                  thesis_markdown: "# 主判断\n中性观察",
                  core_citations_json: '["E2"]',
                  counter_evidence_json: '["需求下滑"]',
                  evidence_hash: "hash-4",
                  created_by: "ai",
                  created_at: "2026-06-15T00:00:00.000Z",
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const thesis = await createResearchThesisVersion(db, {
      userKey: "admin",
      itemId: "research-1",
      thesisMarkdown: "# 主判断\n中性观察",
      coreCitations: ["E2"],
      counterEvidence: ["需求下滑"],
      evidenceHash: "hash-4",
    });

    expect(batchCalls).toBe(4);
    expect(thesis.version).toBe(4);
  });
});

describe("upsertResearchCatalystDrafts", () => {
  test("stores deterministic catalyst tracking items and returns normalized rows", async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = [];
    const batchSizes: number[] = [];
    const db = {
      async batch(batchStatements: unknown[]) {
        batchSizes.push(batchStatements.length);
        return [];
      },
      prepare(sql: string) {
        return {
          bind(...bindings: unknown[]) {
            statements.push({ sql, bindings });
            return {
              async all() {
                if (!sql.includes("FROM research_catalysts")) return { results: [] };
                return {
                  results: [
                    {
                      id: "cat-1",
                      item_id: "research-1",
                      title: "催化：订单放量",
                      description: "订单放量验证收入加速（E1）。",
                      due_at: null,
                      status: "open",
                      evidence_refs_json: '["E1"]',
                      created_at: "2026-06-15T00:00:00.000Z",
                      updated_at: "2026-06-15T00:00:00.000Z",
                    },
                  ],
                };
              },
              async run() {
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const catalysts = await upsertResearchCatalystDrafts(db, {
      userKey: "admin",
      itemId: "research-1",
      drafts: [
        { title: "催化：订单放量", description: "订单放量验证收入加速（E1）。", evidenceRefs: ["E1"] },
        { title: "催化：订单放量", description: "重复项应去重。", evidenceRefs: ["E1"] },
        { title: "反证：订单延期", description: "订单延期说明需求不及预期（E2）。", evidenceRefs: ["E2"] },
      ],
    });

    expect(statements.some(({ sql }) => sql.includes("INSERT INTO research_catalysts"))).toBe(true);
    expect(batchSizes).toContain(2);
    expect(catalysts[0]).toMatchObject({ title: "催化：订单放量", evidenceRefs: ["E1"], status: "open" });
  });
});

describe("updateResearchCatalystStatus", () => {
  test("updates a catalyst status only for the current user and returns the normalized row", async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = [];
    const db = {
      async batch() {
        return [];
      },
      prepare(sql: string) {
        return {
          bind(...bindings: unknown[]) {
            statements.push({ sql, bindings });
            return {
              async first() {
                if (!sql.includes("FROM research_catalysts")) return null;
                return {
                  id: "cat-1",
                  item_id: "research-1",
                  title: "反证：订单延期",
                  description: "订单延期说明需求不及预期（E2）。",
                  due_at: null,
                  status: "confirmed",
                  evidence_refs_json: '["E2"]',
                  created_at: "2026-06-15T00:00:00.000Z",
                  updated_at: "2026-06-16T00:00:00.000Z",
                };
              },
              async run() {
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const catalyst = await updateResearchCatalystStatus(db, {
      userKey: "admin",
      itemId: "research-1",
      catalystId: "cat-1",
      status: "confirmed",
    });

    expect(statements.some(({ sql }) => sql.includes("UPDATE research_catalysts"))).toBe(true);
    expect(statements.find(({ sql }) => sql.includes("UPDATE research_catalysts"))?.bindings).toEqual([
      "admin",
      "research-1",
      "cat-1",
      "confirmed",
      expect.any(String),
    ]);
    expect(catalyst).toMatchObject({ id: "cat-1", status: "confirmed", evidenceRefs: ["E2"] });
  });

  test("rejects unsupported catalyst status values", async () => {
    const db = {
      async batch() {
        return [];
      },
      prepare() {
        throw new Error("should not query db for invalid status");
      },
    } as unknown as D1Database;

    await expect(updateResearchCatalystStatus(db, {
      userKey: "admin",
      itemId: "research-1",
      catalystId: "cat-1",
      status: "done",
    })).rejects.toThrow("invalid research catalyst status");
  });
});

function researchItemDb(initialRow: ResearchItemTestRow | null = null) {
  let storedRow = initialRow ? { ...initialRow } : null;
  return {
    async batch() {
      return [];
    },
    prepare(sql: string) {
      let bindings: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bindings = values;
          return statement;
        },
        async run() {
          if (sql.includes("INSERT INTO research_items")) {
            const [id, userKey, entityType, entityId, title, subtitle, stage, source, evidenceHash, now] = bindings as string[];
            storedRow = {
              id: storedRow?.id ?? id,
              user_key: userKey,
              entity_type: entityType,
              entity_id: entityId,
              title,
              subtitle: subtitle || null,
              stage: storedRow?.stage ?? stage,
              status: storedRow?.status ?? "active",
              source,
              evidence_hash: evidenceHash || storedRow?.evidence_hash || null,
              current_thesis_version_id: storedRow?.current_thesis_version_id ?? null,
              created_at: storedRow?.created_at ?? now,
              updated_at: now,
              archived_at: storedRow?.archived_at ?? null,
            };
          }
          return { meta: { changes: 1 } };
        },
        async first<T>() {
          if (!sql.includes("FROM research_items") || !storedRow) return null as T;
          if (sql.includes("entity_type = ?2") && sql.includes("entity_id = ?3")) {
            const [userKey, entityType, entityId] = bindings;
            return storedRow.user_key === userKey && storedRow.entity_type === entityType && storedRow.entity_id === entityId ? storedRow as T : null as T;
          }
          if (sql.includes("id = ?2")) {
            const [userKey, id] = bindings;
            return storedRow.user_key === userKey && storedRow.id === id ? storedRow as T : null as T;
          }
          return null as T;
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}
