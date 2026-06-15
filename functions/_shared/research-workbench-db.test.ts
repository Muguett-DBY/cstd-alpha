import { describe, expect, test } from "vitest";
import { claimValuationRun } from "./research-workbench-db";

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
